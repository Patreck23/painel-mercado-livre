import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMLAnalytics,period} from './ml-analytics.mjs';
import {renderML} from './ml-ui.mjs';
import {createBlingCards} from './bling-cards.mjs';
const now=Date.parse('2026-11-06T15:00:00Z');
const memory=()=>{const m=new Map();return {get:k=>structuredClone(m.get(k)),put:(k,v)=>m.set(k,structuredClone(v)),delete:k=>m.delete(k),list:p=>[...m].filter(([k])=>k.startsWith(p)).map(([k,v])=>[k,structuredClone(v)])};};
test('ML cards stay visible from saved data while a different date range imports',()=>{
 const state=memory();state.put('ml-canonical-v1',true);state.put('ml-active','other:');state.put('other:meta',{economyVersion:1,finished:false});state.put('ml-item:MLB123',{item:{id:'MLB123',title:'Produto salvo',photo:'https://http2.mlstatic.com/photo.jpg',status:'active',sku:'ABC'}});state.put('ml-order:1',{id:'1',date:'2026-11-05',status:'paid',currency:'BRL',items:[{id:'MLB123',qty:2,price:50}]});
 const analytics=createMLAnalytics({state,clock:()=>now,schedule:()=>{},read:()=>{throw Error('render must not fetch');}}),output=renderML({analytics,url:new URL('https://example/mercado-livre'),user:{id:1,nickname:'Casa Nissi'},clock:()=>now});
 assert.ok(output.body.includes('Produto salvo'));assert.ok(output.body.includes('class="ml-product"'));assert.ok(output.body.includes('08/09/2026 a 07/10/2026'));assert.equal(state.get('ml-active'),'other:');assert.equal(output.refresh,60);
});
test('Bling cards share chart layout, exclude cancellations and fetch only visible missing photos once',async()=>{
 const state=memory(),range=period(new URLSearchParams(),now);state.put('ml-item:empty',{item:{sku:'',photo:'https://http2.mlstatic.com/wrong.jpg'}});let reads=0;
 const orders=[{id:'1',date:'2026-11-05',status:'1',store:'3',items:[{key:'id:123',name:'Produto do Bling',sku:'',qty:2,unit:50}]},{id:'2',date:'2026-11-05',cancelled:true,store:'3',items:[{key:'id:123',name:'Produto do Bling',sku:'',qty:10,unit:50}]}];
 const analytics={orders:()=>orders,get:()=>({job:{range,orders,finished:true,channels:{mapping:new Map(),complete:false}}})};
 const cards=createBlingCards({state,analytics,clock:()=>now,schedule:()=>{},request:async path=>{reads++;assert.equal(path,'produtos/123');return {data:{midia:{imagens:{internas:[{link:'https://www.bling.com.br/product.jpg'}]}}}};}}),url=new URL('https://example/bling');
 let html=cards.render(url).body;assert.ok(html.includes('class="ml-product"'));assert.ok(html.includes('class="ml-chart"'));assert.ok(html.includes('08/09/2026 a 07/10/2026'));assert.ok(!html.includes('wrong.jpg'));assert.deepEqual(state.get('bling-photo-queue'),['id:123']);await cards.tick();html=cards.render(url).body;assert.ok(html.includes('https://www.bling.com.br/product.jpg'));await cards.tick();assert.equal(reads,1);assert.deepEqual(state.get('bling-photo-queue'),[]);
});
