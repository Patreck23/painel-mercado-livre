import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalize,aggregate,dates,createAnalytics,renderAnalytics,shell} from './analytics.mjs';
const now=Date.parse('2026-10-30T19:00:00Z'),range=dates(7,now);
const order=(id,date,items,store=1,status=9)=>normalize({id,data:date,loja:{id:store},situacao:{id:status},itens:items});
const item=(id,qty,value)=>({produto:{id},codigo:'SKU-'+id,descricao:'Produto '+id,quantidade:qty,valor:value,desconto:20});
test('equal periods, including Brasília day',()=>{assert.deepEqual(range,{end:'2026-10-30',start:'2026-10-24',previousStart:'2026-10-17',previousEnd:'2026-10-23'});assert.equal(dates(7,Date.parse('2026-10-30T01:00:00Z')).end,'2026-10-29');});
test('product totals, previous comparison, order dedup, commercial kits and ABC',()=>{
 const rows=[order(1,'2026-10-30',[item(1,2,40),item(1,1,20),item(2,1,10)]),order(2,'2026-10-17',[item(1,1,50)]),order(3,'2026-10-29',[item(3,1,5)]),order(4,'2026-10-16',[item(1,100,50)])];
 const a=aggregate(rows,range);assert.equal(a.total,115);assert.equal(a.units,5);assert.equal(a.orders,2);assert.equal(a.previous,50);const first=a.products[0];assert.equal(first.current,100);assert.equal(first.orders.size,1);assert.equal(first.growth,1);assert.equal(first.abc,'A');assert.equal(a.products[1].abc,'B');assert.equal(a.products[2].abc,'C');assert.equal(first.average,100/3);
 // The unit value is already returned by Bling; do not subtract item discount again.
 assert.equal(first.current,100);
});
test('channel, status, search, missing baseline and invalid values',()=>{
 const rows=[order(1,'2026-10-30',[item(1,1,10)],1,9),order(2,'2026-10-30',[item(2,1,30)],2,6),order(3,'2026-10-30',[item(3,NaN,5)],1,9)];
 const a=aggregate(rows,range,{store:'1',status:'9',search:'SKU-1'});assert.equal(a.total,10);assert.equal(a.products.length,1);assert.equal(a.products[0].growth,null);assert.equal(a.skipped,1);
});
test('progressive import and rendering escape product content',async()=>{
 let resolveDetail;const waiting=new Promise(r=>resolveDetail=r);
 const api=async path=>path.includes('?')?{data:[{id:1,data:'2026-10-30'}]}:waiting;
 const service=createAnalytics({request:api,clock:()=>now}),state=service.get(7);
 await new Promise(r=>setTimeout(r,0));assert.equal(state.job.finished,false);assert.equal(state.job.total,1);
 resolveDetail({data:{id:1,data:'2026-10-30',itens:[{...item(1,1,10),descricao:'<script>test</script>'}]}});
 await new Promise(r=>setTimeout(r,0));assert.equal(state.job.finished,true);assert.equal(state.job.orders.length,1);
 const html=renderAnalytics(state,new URL('https://example.com/analises?dias=7'),now);assert.ok(html.includes('&lt;script&gt;test&lt;/script&gt;'));assert.ok(!html.includes('<script>test'));assert.ok(html.includes('Ranking e curva ABC'));assert.ok(html.includes('grid-template-columns'));
 const detail=renderAnalytics(state,new URL('https://example.com/analises?dias=7&produto=id%3A1'),now);assert.ok(detail.includes('Curva diária do produto'));assert.ok(detail.includes('Preço médio vendido'));
 assert.ok(shell('ok').includes('name="viewport"'));
});
