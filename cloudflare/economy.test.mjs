import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createDocumentState} from './document-state.mjs';
import {sealStore} from './state.mjs';
import {missingRanges,addCoverage} from './sales-cache.mjs';
import {monthRange,salesSummary,renderHome,renderMonthly,monthlyQuality} from './portal.mjs';
import {createPersistentAnalytics} from './persistent-analytics.mjs';
const now=Date.parse('2026-11-06T15:00:00Z');
const memory=()=>{const d=new Map();return {get:k=>structuredClone(d.get(k)),put:(k,v)=>d.set(k,structuredClone(v)),delete:k=>d.delete(k),list:p=>[...d].filter(([k])=>k.startsWith(p)).map(([k,v])=>[k,structuredClone(v)])};};
test('SQLite adapter skips identical writes and repeated reads, keeps prefix lists coherent and survives restart',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE documents(key TEXT PRIMARY KEY,value TEXT NOT NULL)');let reads=0,writes=0;
 const sql={exec(q,...args){if(q.startsWith('SELECT')){reads++;return {toArray:()=>db.prepare(q).all(...args)};}writes++;db.prepare(q).run(...args);}};
 const s=createDocumentState(sql);s.put('order:1',{total:40});s.list('order:');const checkpoint={reads,writes};
 for(let i=0;i<100;i++){assert.equal(s.get('order:1').total,40);assert.equal(s.put('order:1',{total:40}),false);assert.equal(s.list('order:').length,1);}
 assert.deepEqual({reads,writes},checkpoint);s.put('order:2',{total:10});assert.equal(s.list('order:').length,2);s.delete('order:1');assert.equal(s.list('order:').length,1);assert.equal(createDocumentState(sql).get('order:2').total,10);db.close();
});
test('unchanged encrypted sessions do not generate ciphertext or database writes',()=>{
 const state=memory();let encryptions=0;const vault={encrypt:v=>{encryptions++;return JSON.stringify(v);},decrypt:JSON.parse},store=sealStore(state,vault,'token');store.set({access:'test'});for(let i=0;i<100;i++){store.get();store.set({access:'test'});}assert.equal(encryptions,1);store.set({access:'replacement'});assert.equal(encryptions,2);
});
test('coverage requests only missing dates and merges adjacent imported windows',()=>{
 const s=memory();addCoverage(s,'ml','2026-09-01','2026-10-31');assert.deepEqual(missingRanges(s.get('ml-coverage'),'2026-09-15','2026-11-01'),[{start:'2026-11-01',end:'2026-11-01'}]);addCoverage(s,'ml','2026-11-01','2026-11-01');assert.deepEqual(s.get('ml-coverage'),[{start:'2026-09-01',end:'2026-11-01'}]);
});
test('closed October compares with calendar September, not a rolling 31-day window',()=>{
 const r=monthRange('2026-10',now);assert.deepEqual(r,{start:'2026-10-01',end:'2026-10-31',previousStart:'2026-09-01',previousEnd:'2026-09-30',days:31,calendar:true});assert.throws(()=>monthRange('2026-11',now));assert.throws(()=>monthRange('2026-13',now));
});
test('ML total excludes freight already; cancellations, unpaid orders and foreign currencies are excluded',()=>{
 const range=monthRange('2026-10',now),row=(id,status='paid',more={})=>({id,date:'2026-10-10',status,currency:'BRL',total:100,freight:null,items:[{id:'MLB1',title:'Produto',qty:2,price:50}],...more});
 const s=salesSummary('ml',[row('1'),row('2','cancelled'),row('3','confirmed'),row('4','paid',{currency:'USD'}),row('5','paid',{date:'2026-09-10',total:200,items:[{id:'MLB1',qty:4,price:50}]})],range);
 assert.equal(s.orders,1);assert.equal(s.goods,100);assert.equal(s.freight,null);assert.equal(s.total,null);assert.equal(s.best[0].growth,-0.5);assert.equal(s.falls.length,1);assert.equal(s.cancelled,1);
});
test('Bling total subtracts confirmed freight and unknown shipping is not treated as shipped',()=>{
 const r=monthRange('2026-10',now),s=salesSummary('bling',[{id:'1',date:'2026-10-01',status:'1',finance:{total:120,freight:20,withoutFreight:100},items:[{key:'p',name:'Produto',qty:1,unit:100}]},{id:'2',date:'2026-10-02',status:'2',items:[]}],r,{statuses:new Map([['1',{name:'Atendido',cancelled:false}],['2',{name:'Cancelado',cancelled:true}]])});assert.equal(s.goods,100);assert.equal(s.sent,0);assert.equal(s.shippingUnknown,1);assert.equal(s.processed,1);assert.equal(s.orders,1);
});
test('persisted historical Bling data opens without another API request, live refresh uses modification feed',async()=>{
 const state=memory();state.put('bling-canonical-v1',true);addCoverage(state,'bling','2026-09-01','2026-11-06');state.put('bling-sync-since',now-1800000);let calls=[];
 const a=createPersistentAnalytics({state,clock:()=>now,schedule:()=>{},request:async p=>{calls.push(p);return {data:[]};},channels:async()=>({mapping:new Map(),complete:true}),classifyOrders:async()=>({mapping:new Map(),unknown:[]})});
 assert.equal(a.get(monthRange('2026-10',now)).job.finished,true);await a.tick();assert.equal(calls.length,0);
 a.get({start:'2026-11-06',end:'2026-11-06',previousStart:'2026-11-05',previousEnd:'2026-11-05'});for(let i=0;i<5;i++)await a.tick();assert.equal(calls.length,1);const q=new URLSearchParams(calls[0].split('?')[1]);assert.ok(q.has('dataAlteracaoInicial'));assert.ok(!q.has('dataInicial'));
});
test('monthly quality never invents unavailable historical scores and home keeps sources distinct',()=>{
 const range=monthRange('2026-10',now),quality=monthlyQuality(memory(),range),summary=salesSummary('ml',[],range),data={connected:true,job:{finished:true,updated:now},summary};assert.equal(quality.count,0);const html=renderMonthly({...data,source:'ml',month:'2026-10',range,quality});assert.ok(html.includes('Não calculado'));assert.ok(html.includes('Não existem notas de qualidade'));
 const home=renderHome({bling:data,ml:data,now,connectBling:'/auth/bling/start'});assert.ok(home.includes('/bling'));assert.ok(home.includes('/mercado-livre'));
});
