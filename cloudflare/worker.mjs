import {createDocumentState} from './document-state.mjs';
import {createApp} from './app.mjs';
export class CasaNissiDashboard {
 constructor(ctx,env){
  this.ctx=ctx;this.env=env;this.app=null;this.origin=null;
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  this.state=createDocumentState(ctx.storage.sql);
 }
 init(origin){
  if(this.app)return;
  // Canonical origin comes from the Worker entry point, never a caller header.
  this.origin=this.env.APP_BASE_URL||origin||this.state.get('app-origin');
  if(!this.origin)throw Error('missing_origin');this.state.put('app-origin',this.origin);
  this.app=createApp({env:{...this.env,APP_BASE_URL:this.origin},state:this.state,schedule:when=>this.ctx.waitUntil(this.schedule(when))});
 }
 async fetch(request){
  this.init(new URL(request.url).origin);
  const url=new URL(request.url),headers=Object.fromEntries(request.headers);
  const body=['POST','PUT','PATCH'].includes(request.method)?await request.text():'';
  if(body.length>8192)return new Response('Requisição muito grande',{status:413});
  const req={method:request.method,url:url.pathname+url.search,headers,async *[Symbol.asyncIterator](){if(body)yield body;}};
  let status=200,outHeaders={},content='';
  const res={writeHead(code,values){status=code;outHeaders=values;},end(value=''){content=value;}};
  await this.app(req,res);
  const responseHeaders=new Headers();for(const [key,value] of Object.entries(outHeaders)){for(const item of Array.isArray(value)?value:[value])responseHeaders.append(key,item);}
  return new Response(request.method==='HEAD'?null:content,{status,headers:responseHeaders});
 }
 async schedule(when){
  const at=Math.max(Date.now()+5000,when),pending=await this.ctx.storage.getAlarm();
  if(pending===null||pending<=Date.now()||at<pending)await this.ctx.storage.setAlarm(at);
 }
 async alarm(){this.init();await this.app.alarm();}

}
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/favicon.ico')return new Response(null,{status:204});
  // One company instance shares the same authorized account across browsers.
  const id=env.DASHBOARD.idFromName('casa-nissi');
  return env.DASHBOARD.get(id).fetch(request);
 }
};
