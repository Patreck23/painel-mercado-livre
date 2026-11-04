import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from './app.mjs';
import {createPersistentAnalytics} from './persistent-analytics.mjs';
import {aggregate} from '../backend/analytics.mjs';
const memory=()=>{const docs=new Map();return {get:k=>structuredClone(docs.get(k)),put:(k,v)=>docs.set(k,structuredClone(v)),delete:k=>docs.delete(k),list:p=>[...docs].filter(([k])=>k.startsWith(p)).map(([k,v])=>[k,structuredClone(v)])};};
const request=async(app,path)=>{let result;await app({method:'GET',url:path,headers:{}},{writeHead(status,headers){result={status,headers};},end(body){result.body=body;}});return result;};
test('Bling OAuth state and encrypted session survive restart without browser cookies',async()=>{
 const state=memory(),env={BLING_CLIENT_ID:'client',BLING_CLIENT_SECRET:'secret',APP_BASE_URL:'https://painel.example.workers.dev'};let exchanges=0;
 const fetcher=async(url,options)=>{if(url.includes('/oauth/token')){exchanges++;assert.equal(options.body.get('redirect_uri'),env.APP_BASE_URL+'/auth/bling/callback');return {ok:true,json:async()=>({access_token:'private-bling-token',refresh_token:'private-bling-refresh',expires_in:3600})};}return {ok:true,json:async()=>({data:[]})};};
 let app=createApp({state,env,fetcher}),home=await request(app,'/');const startLink=home.body.match(/href="(\/auth\/bling\/start\?ticket=[^"]+)"/)[1];
 const start=await request(app,startLink),auth=new URL(start.headers.Location);assert.equal(start.status,303);assert.equal(auth.searchParams.get('redirect_uri'),env.APP_BASE_URL+'/auth/bling/callback');
 app=createApp({state,env,fetcher});const path='/auth/bling/callback?state='+auth.searchParams.get('state')+'&code=example';assert.equal((await request(app,path)).status,303);assert.equal(exchanges,1);
 assert.ok(!JSON.stringify(state.list('')).includes('private-bling-token'));
 app=createApp({state,env,fetcher});assert.equal((await request(app,path)).status,400);const orders=await request(app,'/pedidos');assert.equal(orders.status,200);assert.ok(orders.body.includes('Pedidos registrados'));
});
test('Mercado Livre authorization survives restart independently of Bling',async()=>{
 const state=memory(),env={ML_CLIENT_ID:'app',ML_CLIENT_SECRET:'secret',APP_BASE_URL:'https://painel.example.workers.dev'};let exchanges=0;
 const fetcher=async(url,options)=>{if(url.endsWith('/oauth/token')){exchanges++;assert.ok(options.body.get('code_verifier'));return {ok:true,json:async()=>({access_token:'private-ml-token',refresh_token:'private-ml-refresh',expires_in:21600,user_id:42})};}return {ok:true,json:async()=>({id:42,nickname:'CASA_NISSI',site_id:'MLB'})};};
 let app=createApp({state,env,fetcher}),home=await request(app,'/mercado-livre');const link=home.body.match(/href="(\/auth\/mercado-livre\/start\?ticket=[^"]+)"/)[1],start=await request(app,link),auth=new URL(start.headers.Location);
 app=createApp({state,env,fetcher});const callback='/auth/mercado-livre/callback?state='+auth.searchParams.get('state')+'&code=example';assert.equal((await request(app,callback)).status,303);
 assert.ok(!JSON.stringify(state.list('')).includes('private-ml-token'));
 app=createApp({state,env,fetcher});const confirmed=await request(app,'/mercado-livre');assert.equal(confirmed.status,200);assert.ok(confirmed.body.includes('CASA_NISSI'));assert.equal(exchanges,1);assert.equal((await request(app,callback)).status,400);
});
test('product import resumes across restarts in batches without double counting',async()=>{
 const state=memory(),clock=()=>Date.parse('2026-11-03T15:00:00Z'),schedules=[];let details=0;
 const summaries=Array.from({length:31},(_,i)=>({id:i+1,data:'2026-11-03',situacao:{id:i===30?2:1}}));
 const args={state,clock,schedule:t=>schedules.push(t),request:async resource=>{if(resource.startsWith('pedidos/vendas?'))return {data:summaries};details++;const id=Number(resource.split('/').at(-1));return {data:{...summaries[id-1],itens:[{produto:{id:7},descricao:'Produto real',quantidade:1,valor:10}],loja:{id:3}}};},channels:async()=>({mapping:new Map([['3',{name:'Site',group:'Site'}]]),complete:true}),classifyOrders:async orders=>({mapping:new Map([['1',{known:true,name:'Atendido',cancelled:false}],['2',{known:true,name:'Cancelado',cancelled:true}]]),unknown:[],accepted:orders.filter(o=>o.id!==31),cancelled:orders.filter(o=>o.id===31)})};
 let analytics=createPersistentAnalytics(args);analytics.get(30);
 for(let n=0;n<4;n++){analytics=createPersistentAnalytics(args);await analytics.tick();}
 const job=analytics.get(30).job;assert.equal(job.finished,true);assert.equal(job.orders.length,31);assert.equal(details,31);assert.equal(aggregate(job.orders,job.range).total,300);assert.equal(job.cancelledCount,1);assert.ok(schedules.length>=4);await analytics.tick();assert.equal(details,31);
});
test('Bling 401 triggers one token renewal and persists the replacement',async()=>{
 const state=memory(),env={BLING_CLIENT_ID:'client',BLING_CLIENT_SECRET:'secret',APP_BASE_URL:'https://painel.example.workers.dev'};let exchanges=0;
 const fetcher=async(url,options)=>{if(url.includes('/oauth/token')){exchanges++;return {ok:true,json:async()=>({access_token:'token-'+exchanges,refresh_token:'refresh-'+exchanges,expires_in:3600})};}if(options.headers.Authorization==='Bearer token-1')return {ok:false,status:401};if(url.includes('/situacoes/'))return {ok:true,json:async()=>({data:{nome:'Atendido',idHerdado:0}})};if(url.includes('/canais-venda'))return {ok:true,json:async()=>({data:[]})};return {ok:true,json:async()=>({data:[]})};};
 const app=createApp({state,env,fetcher}),home=await request(app,'/'),link=home.body.match(/href="(\/auth\/bling\/start\?ticket=[^"]+)"/)[1],start=await request(app,link),auth=new URL(start.headers.Location);
 await request(app,'/auth/bling/callback?state='+auth.searchParams.get('state')+'&code=example');const overview=await request(app,'/visao-geral');assert.equal(overview.status,200);assert.equal(exchanges,2);
 const restarted=createApp({state,env,fetcher});assert.equal((await request(restarted,'/pedidos')).status,200);assert.equal(exchanges,2);
});
