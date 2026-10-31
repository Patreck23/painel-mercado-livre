import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createApp,vault} from './server.mjs';
test('token encryption rejects modification',()=>{const v=vault('test-secret');const x=v.encrypt({token:'secret'});assert.equal(v.decrypt(x).token,'secret');const b=Buffer.from(x,'base64');b[29]^=1;assert.throws(()=>v.decrypt(b.toString('base64')));});
test('OAuth works without cookies and rejects invalid state and replay',async()=>{
 const env={BLING_CLIENT_ID:'test-client',BLING_CLIENT_SECRET:'test-secret',APP_BASE_URL:'https://example.com'};
 let now=Date.now(),exchanges=0,reads=0;
 const fetcher=async(url,options)=>{if(url.includes('/oauth/token')){exchanges++;assert.equal(options.method,'POST');return {ok:true,json:async()=>({access_token:'access-'+exchanges,refresh_token:'refresh-'+exchanges,expires_in:3600})};}reads++;assert.ok(options.headers.Authorization.startsWith('Bearer access-'));assert.equal(options.method,undefined);return {ok:true,json:async()=>({data:url.includes('/produtos')?[{nome:'Produto <seguro>',codigo:'SKU',preco:10}]:[{id:1,numero:7,data:'2026-10-30',total:100,situacao:{id:9}}]})};};
 const handler=createApp({env,fetcher,clock:()=>now}),server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port,request=(path,opts={})=>fetch(base+path,{...opts,redirect:'manual'});
 try{
 assert.equal((await request('/mercado-livre')).status,200);assert.equal((await request('/produtos')).status,303);assert.equal((await request('/pedidos')).status,303);assert.equal(reads,0);
 const home=await request('/');assert.equal(home.status,200);const homeCookie=home.headers.get('set-cookie').split(';')[0],csrf=(await home.text()).match(/ticket=([^"&]+)/)[1];
 assert.equal((await request('/auth/bling/start',{method:'POST',headers:{Origin:'https://evil.com','Sec-Fetch-Site':'cross-site',Cookie:''},body:'csrf='+csrf})).status,403);
 const start=await request('/auth/bling/start',{method:'POST',headers:{Origin:'https://alternate-render-domain.example','Sec-Fetch-Site':'same-origin',Cookie:homeCookie},body:'csrf='+csrf});assert.equal(start.status,303);
 const state=new URL(start.headers.get('location')).searchParams.get('state'),bound=start.headers.get('set-cookie').split(';')[0],callback='/auth/bling/callback?state='+state+'&code=test';
 assert.equal((await request('/auth/bling/callback?state=invalid&code=test')).status,400);assert.equal(exchanges,0);
 const done=await request(callback);assert.equal(done.status,303);assert.equal(exchanges,1);
 assert.equal((await request(callback,{headers:{Cookie:bound}})).status,400);
 const sessionCookies=done.headers.getSetCookie().filter(s=>s.startsWith('__Host-nissi-session-')).map(s=>s.split(';')[0]).join('; ');assert.ok(sessionCookies);assert.ok(!sessionCookies.includes('access-'));
 const products=await request('/produtos?catalogo=1');assert.equal(products.status,200);assert.ok((await products.text()).includes('Produto &lt;seguro&gt;'));assert.equal(products.headers.get('set-cookie'),null);
 const orders=await request('/pedidos');assert.equal(orders.status,200);assert.ok((await orders.text()).includes('Pedidos registrados'));assert.equal(reads,2);
 const dash=await request('/dashboard');assert.equal(dash.status,200);const dashboard=await dash.text();assert.ok(dashboard.includes('content="60"'));assert.ok(dashboard.includes('100,00'));assert.ok(dashboard.includes('Total dos pedidos'));assert.equal(reads,3);
 await request('/dashboard');assert.equal(reads,3);
 now+=3600000;
 await Promise.all([request('/pedidos'),request('/produtos?catalogo=1')]);assert.equal(exchanges,2);
 assert.equal((await request('/pedidos?pagina=NaN')).status,400);
 const restarted=createServer(createApp({env,fetcher,clock:()=>now}));await new Promise(r=>restarted.listen(0,'127.0.0.1',r));try{const origin='http://127.0.0.1:'+restarted.address().port;assert.equal((await fetch(origin+'/pedidos',{redirect:'manual'})).status,303);assert.equal((await fetch(origin+'/',{headers:{Cookie:sessionCookies}})).status,200);}finally{await new Promise(r=>restarted.close(r));}
 }finally{await new Promise(r=>server.close(r));}
});
