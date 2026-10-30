import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createApp,vault} from './server.mjs';

test('encrypted tokens detect tampering',()=>{const v=vault('a'.repeat(40));const encoded=v.encrypt({access_token:'private'});assert.equal(v.decrypt(encoded).access_token,'private');const b=Buffer.from(encoded,'base64');b[30]^=1;assert.throws(()=>v.decrypt(b.toString('base64')));});
test('protected OAuth validates origin, browser binding, one-time state and refresh',async()=>{
 let payload;const states=new Set();
 const store={read:async()=>payload,saveState:async s=>states.add(s),consumeState:async s=>{const ok=states.has(s);states.delete(s);return ok;},locked:async fn=>{const result=await fn(payload);if(result.payload)payload=result.payload;return result.value;}};
 const env={PANEL_PASSWORD:'test-password-12345678',APP_SECRET:'a'.repeat(40),BLING_CLIENT_ID:'client',BLING_CLIENT_SECRET:'secret',APP_BASE_URL:'https://example.com'};
 let calls=0,now=Date.now();
 const fetcher=async(url,options)=>{calls++;if(url.includes('/oauth/token')){assert.equal(options.method,'POST');return {ok:true,json:async()=>({access_token:'access-'+calls,refresh_token:'refresh-'+calls,expires_in:3600})};}assert.equal(options.method,undefined);return {ok:true,json:async()=>({data:[{id:1}]})};};
 const server=createServer(createApp({env,store,fetcher,clock:()=>now}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const auth='Basic '+Buffer.from('casa-nissi:'+env.PANEL_PASSWORD).toString('base64');
 const request=(path,options={})=>fetch(base+path,{...options,redirect:'manual'});
 try{
 assert.equal((await request('/')).status,401);assert.equal((await request('/health')).status,200);
 const home=await request('/',{headers:{Authorization:auth}});assert.equal(home.status,200);const c=home.headers.get('set-cookie').split(';')[0];const html=await home.text();const csrf=html.match(/name="csrf" value="([^"]+)/)[1];
 assert.equal((await request('/auth/bling/start',{method:'POST',headers:{Authorization:auth,Cookie:c,Origin:'https://evil.com'},body:'csrf='+csrf})).status,403);
 const start=await request('/auth/bling/start',{method:'POST',headers:{Authorization:auth,Cookie:c,Origin:env.APP_BASE_URL},body:'csrf='+csrf});assert.equal(start.status,303);
 const state=new URL(start.headers.get('location')).searchParams.get('state'),oauthCookie=start.headers.get('set-cookie').split(';')[0];
 assert.equal((await request('/auth/bling/callback?code=test&state='+state)).status,400);assert.equal(calls,0);
 const callback='/auth/bling/callback?code=test&state='+state;
 assert.equal((await request(callback,{headers:{Cookie:oauthCookie}})).status,303);assert.equal(calls,1);assert.ok(payload);assert.ok(!payload.includes('access-'));
 assert.equal((await request(callback,{headers:{Cookie:oauthCookie}})).status,400);assert.equal(calls,1);
 assert.equal((await request('/test/bling')).status,401);
 assert.equal((await request('/test/bling',{headers:{Authorization:auth}})).status,200);assert.equal(calls,2);
 now+=3600000;
 assert.equal((await request('/test/bling',{headers:{Authorization:auth}})).status,200);assert.equal(calls,4);
 }finally{await new Promise(r=>server.close(r));}
});
test('fails closed without database',async()=>{
 const server=createServer(createApp({env:{PANEL_PASSWORD:'password-1234567890'}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const res=await fetch('http://127.0.0.1:'+server.address().port+'/',{headers:{Authorization:'Basic '+Buffer.from('casa-nissi:password-1234567890').toString('base64')}});assert.equal(res.status,503);assert.ok((await res.text()).includes('DATABASE_URL'));}finally{await new Promise(r=>server.close(r));}
});
