import {test} from 'node:test';
import assert from 'node:assert/strict';
import {period,summarize,pendingActions,createMLAnalytics} from './ml-analytics.mjs';
import {renderML} from './ml-ui.mjs';
const memory=()=>{const docs=new Map();return {get:k=>structuredClone(docs.get(k)),put:(k,v)=>docs.set(k,structuredClone(v)),delete:k=>docs.delete(k),list:p=>[...docs].filter(([k])=>k.startsWith(p)).map(([k,v])=>[k,structuredClone(v)])};};
const now=Date.parse('2026-11-05T15:00:00Z');
test('custom dates are inclusive in Brasília and compared to an equal previous period',()=>{
 const r=period(new URLSearchParams({inicio:'2026-03-01',fim:'2026-04-01'}),now);assert.equal(r.days,32);assert.equal(r.previousEnd,'2026-02-28');assert.equal(r.previousStart,'2026-01-28');
 for(const p of [{inicio:'2026-02-30',fim:'2026-03-01'},{inicio:'2026-04-02',fim:'2026-04-01'},{inicio:'2026-01-01',fim:'2026-11-05'},{inicio:'2026-11-05',fim:'2027-01-01'}])assert.throws(()=>period(new URLSearchParams(p),now));
});
test('ABC is portfolio-wide, includes threshold-crossing item, excludes cancelled/unpaid and sums variations',()=>{
 const range={start:'2026-11-01',end:'2026-11-05',previousStart:'2026-10-27'},items=[{id:'MLB1',title:'A'},{id:'MLB2',title:'B'},{id:'MLB3',title:'C'},{id:'MLB4',title:'Sem vendas'}];
 const row=(id,status,items,date='2026-11-02')=>({id,date,status,currency:'BRL',items});const line=(id,price,qty=1)=>({id,price,qty});
 const orders=[row('1','paid',[line('MLB1',40),line('MLB1',40)]),row('2','paid',[line('MLB2',15)]),row('3','paid',[line('MLB3',5)]),row('4','cancelled',[line('MLB1',1000)]),row('5','confirmed',[line('MLB2',1000)]),row('6','paid',[line('MLB1',40)],'2026-10-29')];
 const a=summarize({range},items,orders);assert.equal(a.total,100);assert.equal(a.qty,4);assert.equal(a.orders,3);assert.deepEqual(a.products.map(p=>p.abc),['A','B','C','—']);assert.equal(a.products[0].orderCount,1);assert.equal(a.products[0].cancelCount,1);assert.equal(a.products[0].growth,1);assert.equal(a.products[0].average,40);
});
test('official actions include only pending rules',()=>{
 const p={buckets:[{variables:[{title:'Fotos',rules:[{status:'COMPLETED',key:'done'},{status:'PENDING',key:'pending',mode:'WARNING',wordings:{title:'Melhore a foto',link:'https://www.mercadolivre.com.br/ajuda'}}]}]}]};assert.deepEqual(pendingActions(p).map(a=>a.title),['Melhore a foto']);
});
test('durable ML sync survives restart, caches API calls, updates cancellation and records changes',async()=>{
 const state=memory();let clock=now,status='paid',price=10,calls=0;
 const args={state,schedule:()=>{},clock:()=>clock,read:async path=>{calls++;
  if(path.startsWith('orders/search?'))return {paging:{total:1},results:[{id:1,date_created:'2026-11-05T12:00:00-03:00',status,currency_id:'BRL',order_items:[{item:{id:'MLB1',title:'Produto'},quantity:2,unit_price:10}]}]};
  if(path.startsWith('users/')){assert.equal(new URLSearchParams(path.split('?')[1]).get('status'),'active');return {paging:{total:1},results:['MLB1']};}
  if(path.startsWith('items/bulk?'))return [{status_code:200,body:{id:'MLB1',title:'Produto',price,currency_id:'BRL',status:'active',available_quantity:10,pictures:[{secure_url:'https://http2.mlstatic.com/test.jpg'}]}}];
  if(path==='item/MLB1/performance')return {score:90,level_wording:'Profissional',buckets:[]};
  if(path.startsWith('items/visits?')){assert.equal(new URLSearchParams(path.split('?')[1]).get('ids'),'MLB1');return {item_id:'MLB1',total_visits:25};}throw Error('unexpected_request');
 }};
 const range=period(new URLSearchParams({inicio:'2026-11-01',fim:'2026-11-05'}),clock);let a=createMLAnalytics(args);a.get(range,42);
 for(let i=0;i<12;i++){a=createMLAnalytics(args);await a.tick();}
 let result=a.get(range,42);assert.equal(result.job.finished,true);assert.equal(a.view(result.key,result.job).total,20);await a.focusVisits(range,'MLB1');assert.equal(a.extra(result.key,'MLB1').visits.total,25);const before=calls;
 a=createMLAnalytics(args);result=a.get(range,42);await a.tick();assert.equal(calls,before);
 clock+=1800000;status='cancelled';price=12;result=a.get(range,42);assert.equal(a.view(result.key,result.job).total,20);for(let i=0;i<12;i++)await a.tick();result=a.get(range,42);assert.equal(a.view(result.key,result.job).total,0);assert.equal(a.extra(result.key,'MLB1').changes[0].label,'Preço');
});
test('API failures preserve previous data and distinguish unavailable quality from a zero score',async()=>{
 const state=memory(),range=period(new URLSearchParams(),now);const a=createMLAnalytics({state,schedule:()=>{},clock:()=>now,read:async()=>{throw Error('ml_read_403');}});a.get(range,1);await a.tick();const result=a.get(range,1);assert.equal(result.job.error,'ml_read_403');assert.equal(result.job.finished,true);
});
test('product UI keeps date filters on details, escapes content and never executes upstream URLs',()=>{
 const range=period(new URLSearchParams({inicio:'2026-11-01',fim:'2026-11-05'}),now),job={range,finished:true,complete:true,ids:['MLB1'],updated:now};
 const analytics={get:()=>({key:'key',job}),view:()=>({products:[{id:'MLB1',title:'<script>alert(1)</script>',sku:'x',status:'active',qty:1,revenue:10,orderCount:1,average:10,share:1,abc:'A',daily:{},growth:null}],total:10,qty:1,orders:1}),extra:()=>({performance:{available:true,score:0,actions:[{title:'<b>Fix</b>',link:'javascript:alert(1)'}]},changes:[],visits:{total:0}})};
 const output=renderML({analytics,url:new URL('https://example.com/mercado-livre?inicio=2026-11-01&fim=2026-11-05'),user:{id:1,nickname:'CASA'},clock:()=>now});assert.equal(output.refresh,1800);assert.ok(output.body.includes('&lt;script&gt;'));assert.ok(!output.body.includes('javascript:'));assert.ok(output.body.includes('0/100'));assert.ok(output.body.includes('produto=MLB1'));assert.ok(output.body.includes('inicio=2026-11-01'));
});
test('inactive listing sales remain in history while quality and visit API calls are skipped',async()=>{
 const state=memory(),paths=[];const range=period(new URLSearchParams(),now);
 const a=createMLAnalytics({state,schedule:()=>{},clock:()=>now,read:async path=>{paths.push(path);if(path.startsWith('orders/search?'))return {paging:{total:1},results:[{id:1,status:'paid',date_created:'2026-11-05T12:00:00-03:00',currency_id:'BRL',order_items:[{item:{id:'MLB1',title:'Encerrado'},unit_price:10,quantity:1}]}]};if(path.startsWith('users/'))return {paging:{total:0},results:[]};if(path.startsWith('items/bulk?'))return [{status_code:200,body:{id:'MLB1',title:'Encerrado',status:'closed',price:10}}];throw Error('unexpected_request');}});
 a.get(range,42);for(let n=0;n<12;n++)await a.tick();const {key,job}=a.get(range,42);assert.equal(job.finished,true);assert.equal(a.view(key,job).total,10);assert.ok(paths.every(p=>!p.includes('/performance')&&!p.startsWith('items/visits?')));
});
