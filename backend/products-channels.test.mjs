import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalize,aggregate,dates,renderAnalytics} from './analytics.mjs';
import {createChannels,describeChannel} from './channels.mjs';
const now=Date.parse('2026-10-30T19:00:00Z'),range=dates(7,now);
const record=(id,channel,cancelled,qty,price)=>normalize({id,data:'2026-10-30',loja:{id:channel},situacao:{id:cancelled?200:600},cancelled,itens:[{produto:{id:1},codigo:'PPF',descricao:'Produto teste',quantidade:qty,valor:price}]});
test('product sales exclude cancellations and compare channels and quality',()=>{
 const orders=[record(1,10,false,2,20),record(2,20,false,1,30),record(3,20,true,5,100)];
 const directory={complete:true,mapping:new Map([['10',{name:'Casa Nissi ML',group:'Mercado Livre'}],['20',{name:'Casa Nissi site',group:'Site'}]])};
 const a=aggregate(orders,range,{directory});const p=a.products[0];assert.equal(a.total,70);assert.equal(a.units,3);assert.equal(a.orders,2);assert.equal(p.average,70/3);assert.equal(p.cancelledOrders.size,1);assert.equal(p.cancelRate,1/3);assert.equal(p.channelStats.get('10').units,2);assert.equal(p.channelStats.get('20').value,30);
 const site=aggregate(orders,range,{directory,group:'Site'});assert.equal(site.total,30);assert.equal(site.products[0].cancelRate,0.5);
 const job={range,orders,finished:true,listComplete:true,failed:0,total:3,processed:3,channels:directory};
 const html=renderAnalytics({job},new URL('https://example.com/analises?dias=7&produto=id%3A1'));assert.ok(html.includes('Onde este produto vende'));assert.ok(html.includes('Casa Nissi site'));assert.ok(html.includes('Taxa de cancelamento'));
});
test('channel directory preserves real names and never guesses from numeric IDs',async()=>{
 const service=createChannels({request:async()=>({data:[{id:10,descricao:'Loja oficial',tipo:'MercadoLivre'},{id:20,descricao:'NissiExo',tipo:'Nuvemshop'}]})});
 const d=await service.get();assert.equal(describeChannel(d,10).group,'Mercado Livre');assert.equal(describeChannel(d,20).group,'Site');assert.equal(describeChannel(d,999).group,'Não classificado');
});
