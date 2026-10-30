import { createAnalytics, renderAnalytics, shell } from './analytics.mjs';
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hash = s => createHash('sha256').update(s).digest('hex');
const equal = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const nonce = () => randomBytes(32).toString('base64url');
const cookieName = '__Host-nissi-oauth';
const cookie = (value, age=600) => `${cookieName}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}`;
const headers = {'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Strict-Transport-Security':'max-age=31536000','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://www.bling.com.br https://bling.com.br; frame-ancestors 'none'; base-uri 'none'"};
function send(res, code, content, extra={}) {res.writeHead(code, {...headers,'Content-Type':'text/html; charset=utf-8',...extra});res.end(content);}
const page = body => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Casa Nissi · Bling</title><body style="font:16px system-ui;background:#f6f6f4;color:#222;margin:0"><main style="max-width:1200px;margin:50px auto;padding:28px;background:white;border-top:6px solid #f4c925;border-radius:12px"><h1>Casa Nissi · Bling</h1>${body}</main></body></html>`;
export function vault(secret) {
  const key=Buffer.from(hkdfSync('sha256', secret, 'casa-nissi', 'bling-token-v1', 32));
  return {
    encrypt(value) {const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('casa-nissi-bling-v1'));const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');},
    decrypt(value) {const data=Buffer.from(value,'base64'),dec=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));dec.setAAD(Buffer.from('casa-nissi-bling-v1'));dec.setAuthTag(data.subarray(12,28));return JSON.parse(Buffer.concat([dec.update(data.subarray(28)),dec.final()]).toString('utf8'));}
  };
}

const sessionPrefix='__Host-nissi-session-';
const maxParts=4;
function parseCookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(s=>{const at=s.indexOf('=');return at<0?['','']:[s.slice(0,at).trim(),s.slice(at+1).trim()];}));}
function tokenCookies(crypto,value){
  const encoded=Buffer.from(crypto.encrypt(value),'base64').toString('base64url');
  if(encoded.length>12000)throw Error('session_too_large');
  const parts=Array.from({length:maxParts},(_,i)=>encoded.slice(i*3000,(i+1)*3000));
  return parts.map((p,i)=>`${sessionPrefix}${i}=${p}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${p?2592000:0}`);
}
export function createApp({env=process.env,fetcher:transport=fetch,clock=()=>Date.now()}={}){
  let apiQueue=Promise.resolve(),lastRequest=0;
  function fetcher(...args){const task=apiQueue.then(async()=>{const delay=Math.max(0,380-(Date.now()-lastRequest));if(delay)await new Promise(r=>setTimeout(r,delay));lastRequest=Date.now();return transport(...args);});apiQueue=task.catch(()=>{});return task;}
  const base=env.APP_BASE_URL||'https://painel-mercado-livre-9hti.onrender.com';
  // The already-configured server-side client secret supplies key material.
  // Key derivation is domain-separated from the Bling credential itself.
  const crypto=vault(env.BLING_CLIENT_SECRET||randomBytes(32));
  const usedStates=new Map(),pendingStates=new Map(),renewals=new Map();
  let sharedSession=null;
  const dashboardCache=new Map();
  const analytics=createAnalytics({clock,request:async resource=>{if(!sharedSession)throw Error('not_connected');sharedSession=await renew(sharedSession);const response=await fetcher('https://api.bling.com.br/Api/v3/'+resource,{headers:{Authorization:'Bearer '+sharedSession.access_token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('bling_read_failed');return response.json();}});
  function packed(value){return Buffer.from(crypto.encrypt(value),'base64').toString('base64url');}
  function unpack(value){return crypto.decrypt(Buffer.from(value,'base64url').toString('base64'));}
  function oauthCookie(value){return cookie(packed(value));}
  function readSession(cookies){try{const value=unpack(Array.from({length:maxParts},(_,i)=>cookies[sessionPrefix+i]||'').join(''));return value.kind==='bling-session'&&value.sessionExpires>clock()&&typeof value.access_token==='string'&&typeof value.refresh_token==='string'?value:null;}catch{return null;}}
  function readState(cookies,kind){try{const value=unpack(cookies[cookieName]||'');return value.kind===kind&&value.expires>clock()?value:null;}catch{return null;}}
  async function exchange(params){
    const response=await fetcher('https://api.bling.com.br/Api/v3/oauth/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(env.BLING_CLIENT_ID+':'+env.BLING_CLIENT_SECRET).toString('base64'),'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams(params),redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('token_exchange_failed');
    const data=await response.json();
    if(typeof data.access_token!=='string'||typeof data.refresh_token!=='string'||!(Number(data.expires_in)>0))throw Error('invalid_tokens');
    return {kind:'bling-session',access_token:data.access_token,refresh_token:data.refresh_token,expiresAt:clock()+Number(data.expires_in)*1000,sessionExpires:clock()+30*86400000};
  }
  async function renew(session){
    const key=hash(session.refresh_token),cached=renewals.get(key);
    if(cached&&cached.until>clock())return cached.promise;
    if(session.expiresAt>clock()+60000)return session;
    // A short-lived single-flight cache avoids concurrent refresh-token rotation
    // for multiple requests from one browser, including requests with old cookies.
    const promise=exchange({grant_type:'refresh_token',refresh_token:session.refresh_token});
    renewals.set(key,{promise,until:clock()+60000});
    try{return await promise;}catch(e){renewals.delete(key);throw e;}
  }
  return async function handler(req,res){
    try{
      for(const [k,v] of usedStates)if(v<=clock())usedStates.delete(k);
      for(const [k,v] of pendingStates)if(v<=clock())pendingStates.delete(k);
      for(const [k,v] of renewals)if(v.until<=clock())renewals.delete(k);
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      if(path==='/health'&&['GET','HEAD'].includes(req.method))return send(res,200,req.method==='HEAD'?'':JSON.stringify({service:'casa-nissi-bling',status:'ok',version:'0.4.0'}),{'Content-Type':'application/json'});
      if(!['GET','POST'].includes(req.method))return send(res,405,'Método não permitido',{Allow:'GET, POST'});
      if(!env.BLING_CLIENT_ID||!env.BLING_CLIENT_SECRET)return send(res,503,page('<p>Configure BLING_CLIENT_ID e BLING_CLIENT_SECRET no Environment do Render.</p>'));
      const cookies=parseCookies(req),browserSession=readSession(cookies);
      if(!sharedSession&&browserSession)sharedSession=browserSession;
      const session=sharedSession&&sharedSession.sessionExpires>clock()?sharedSession:null;
      if(path==='/'&&req.method==='GET'){
        const csrf=packed({kind:'csrf',value:nonce(),expires:clock()+600000});
        const content=session?'<h2>Bling conectado</h2><p><a href="/dashboard">Abrir dashboard</a> · <a href="/pedidos">Consultar pedidos reais</a> · <a href="/produtos">Consultar produtos reais</a></p><p>Os dados são consultados diretamente no Bling. O painel demonstrativo do GitHub permanece separado.</p>':'<h2>Conectar Casa Nissi</h2><p>Autorize a consulta de dados na conta Bling da Casa Nissi.</p><p><a href="/auth/bling/start?ticket='+csrf+'" style="display:inline-block;padding:14px;background:#f4c925;color:#222;text-decoration:none;border-radius:6px">Conectar Bling</a></p>';
        return send(res,200,page(content+'<p style="font-size:13px;color:#666">Acesso por link, sem senha adicional. Qualquer pessoa com este endereço pode consultar os dados enquanto a conexão estiver ativa. Se o serviço reiniciar, abra este endereço no navegador em que autorizou o Bling para restaurar a sessão, ou autorize novamente.</p>'),{'Set-Cookie':oauthCookie({kind:'csrf',value:csrf,expires:clock()+600000})});
      }
      if(path==='/auth/bling/start'&&['GET','POST'].includes(req.method)){
        // The encrypted browser-bound CSRF token below is authoritative. Render
        // proxies/custom domains can change Origin; reject explicit cross-site requests.
        if(req.headers['sec-fetch-site']==='cross-site')return send(res,403,page('<p>Abra a página de conexão diretamente e tente novamente.</p>'));
        let body='';if(req.method==='POST'){for await(const chunk of req){body+=chunk;if(body.length>2048)return send(res,413,'Requisição muito grande');}}
        let csrf;try{csrf=unpack(req.method==='GET'?(url.searchParams.get('ticket')||''):(new URLSearchParams(body).get('csrf')||''));}catch{}
        if(!csrf||csrf.kind!=='csrf'||csrf.expires<=clock())return send(res,403,page('<p>Sessão expirada. <a href="/">Voltar</a></p>'));
        const state=nonce(),target=new URL('https://www.bling.com.br/Api/v3/oauth/authorize');
        pendingStates.set(hash(state),clock()+600000);
        target.search=new URLSearchParams({response_type:'code',client_id:env.BLING_CLIENT_ID,state}).toString();
        return send(res,303,'',{'Location':target.href,'Set-Cookie':oauthCookie({kind:'oauth',value:state,expires:clock()+600000})});
      }
      if(path==='/auth/bling/callback'&&req.method==='GET'){
        const state=url.searchParams.get('state')||'',expires=pendingStates.get(hash(state));
        if(!state||!expires||expires<=clock()||usedStates.has(hash(state)))return send(res,400,page('<p>Autorização inválida, expirada ou já utilizada. <a href="/">Tentar novamente</a></p>'),{'Set-Cookie':cookie('',0)});
        pendingStates.delete(hash(state));
        usedStates.set(hash(state),clock()+600000);
        if(url.searchParams.has('error')||!url.searchParams.get('code'))return send(res,400,page('<p>Autorização não concluída. <a href="/">Voltar</a></p>'),{'Set-Cookie':cookie('',0)});
        const tokens=await exchange({grant_type:'authorization_code',code:url.searchParams.get('code')});
        sharedSession=tokens;
        analytics.reset();
        return send(res,303,'',{'Location':'/dashboard','Set-Cookie':[cookie('',0),...tokenCookies(crypto,tokens)]});
      }
      if(path==='/analises'&&req.method==='GET'){
        if(!session)return send(res,303,'',{'Location':'/'});
        const days=Number(url.searchParams.get('dias')||30);
        if(![7,30,90].includes(days))return send(res,400,page('<p>Período inválido.</p>'));
        sharedSession=await renew(session);
        return send(res,200,renderAnalytics(analytics.get(days),url,clock()),browserSession?{'Set-Cookie':tokenCookies(crypto,sharedSession)}:{});
      }
      if(path==='/dashboard'&&req.method==='GET'){
        if(!session)return send(res,303,'',{'Location':'/'});
        const days=Number(url.searchParams.get('dias')||30);
        if(![1,7,30].includes(days))return send(res,400,page('<p>Período inválido.</p>'));
        const current=await renew(session);sharedSession=current;
        const currentDate=new Date(clock()).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
        const first=new Date(currentDate+'T12:00:00Z');first.setUTCDate(first.getUTCDate()-days+1);
        const start=first.toISOString().slice(0,10),key=hash(current.refresh_token)+':'+days+':'+currentDate;
        let entry=dashboardCache.get(key);
        if(!entry||clock()-entry.created>60000){
          const promise=(async()=>{
            const orders=[];let complete=false;
            for(let pg=1;pg<=20;pg++){
              if(pg>1)await new Promise(resolve=>setTimeout(resolve,400));
              const query=new URLSearchParams({pagina:String(pg),limite:'100',dataInicial:start,dataFinal:currentDate});
              const response=await fetcher('https://api.bling.com.br/Api/v3/pedidos/vendas?'+query,{headers:{Authorization:'Bearer '+current.access_token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20000)});
              if(!response.ok)throw Error('orders_unavailable');
              const payload=await response.json();if(!Array.isArray(payload.data))throw Error('invalid_orders');
              orders.push(...payload.data);if(payload.data.length<100){complete=true;break;}
            }
            return {orders:[...new Map(orders.map(o=>[String(o.id),o])).values()],complete,updated:clock()};
          })();
          entry={created:clock(),promise};dashboardCache.set(key,entry);
          promise.catch(()=>dashboardCache.delete(key));
          for(const [k,v] of dashboardCache)if(clock()-v.created>300000)dashboardCache.delete(k);
        }
        const result=await entry.promise,all=result.orders;
        const loja=url.searchParams.get('loja')||'',search=(url.searchParams.get('busca')||'').toLowerCase().slice(0,100);
        const orders=all.filter(o=>(!loja||String(o.loja?.id)===loja)&&(!search||String(o.numero||o.id).toLowerCase().includes(search)));
        const sum=orders.reduce((a,o)=>a+(typeof o.total==='number'?o.total:0),0),known=orders.filter(o=>typeof o.total==='number').length;
        const money=n=>n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
        const stores=[...new Set(all.map(o=>o.loja?.id).filter(v=>v!=null))];
        const options=[1,7,30].map(v=>'<option value="'+v+'" '+(v===days?'selected':'')+'>'+(v===1?'Hoje':'Últimos '+v+' dias')+'</option>').join('');
        const storeOptions=stores.map(v=>'<option value="'+escape(v)+'" '+(String(v)===loja?'selected':'')+'>Loja '+escape(v)+'</option>').join('');
        const groups=new Map();for(const o of orders){const k=String(o.loja?.id??'Sem identificação');const group=groups.get(k)||{n:0,total:0};group.n++;group.total+=typeof o.total==='number'?o.total:0;groups.set(k,group);}
        const summary=[...groups].map(([k,v])=>'<tr><td>'+escape(k)+'</td><td>'+v.n+'</td><td>'+money(v.total)+'</td></tr>').join('');
        const rows=orders.slice().sort((a,b)=>String(b.data).localeCompare(String(a.data))).slice(0,100).map(o=>'<tr><td>'+escape(o.numero||o.id)+'</td><td>'+escape(o.data||'—')+'</td><td>'+escape(o.loja?.id??'—')+'</td><td>'+escape(o.situacao?.id??'—')+'</td><td>'+(typeof o.total==='number'?money(o.total):'Indisponível')+'</td></tr>').join('');
        const daily=Array.from({length:days},(_,i)=>{const d=new Date(start+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+i);const date=d.toISOString().slice(0,10);return {date,total:orders.filter(o=>o.data===date).reduce((a,o)=>a+(typeof o.total==='number'?o.total:0),0)};});
        const max=Math.max(1,...daily.map(d=>d.total)),w=900/days;
        const svg='<svg viewBox="0 0 900 190" role="img" aria-label="Valor total dos pedidos por dia" style="width:100%;height:190px">'+daily.map((d,i)=>'<rect fill="#3483fa" x="'+(i*w+2)+'" width="'+Math.max(1,w-4)+'" y="'+(180-d.total/max*160)+'" height="'+(d.total/max*160)+'"><title>'+d.date+': '+money(d.total)+'</title></rect>').join('')+'</svg>';
        const metric=(label,value)=>'<article style="background:#f6f6f4;padding:20px;border-radius:10px"><div style="color:#555;font-size:13px">'+label+'</div><strong style="font-size:28px;display:block;margin-top:10px">'+value+'</strong></article>';
        const content='<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><h2>Dashboard de vendas</h2><p>Dados reais do Bling · Casa Nissi</p></div><p><a href="/dashboard?dias='+days+'">Atualizar</a> · <a href="/produtos">Produtos</a></p></div><p style="font-size:13px;color:#666">Atualização automática a cada 60 segundos · Última consulta: '+new Date(result.updated).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})+'</p><form method="get" action="/dashboard" style="display:flex;gap:12px;flex-wrap:wrap;margin:24px 0"><label>Período <select name="dias">'+options+'</select></label><label>Canal (ID no Bling) <select name="loja"><option value="">Todos</option>'+storeOptions+'</select></label><label>Buscar pedido <input name="busca" value="'+escape(search)+'"></label><button>Aplicar filtros</button></form>'+(!result.complete?'<p style="background:#fff4cf;padding:12px">Consulta parcial: limite de 2.000 pedidos atingido. Os indicadores abaixo cobrem somente os registros carregados.</p>':'')+(known<orders.length?'<p>Há pedidos sem valor total disponível; eles não entram na soma.</p>':'')+'<section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px">'+metric('Total dos pedidos',money(sum))+metric('Pedidos registrados',String(orders.length))+metric('Ticket médio dos pedidos',known?money(sum/known):'—')+'</section><p style="font-size:13px;color:#666">Valores conforme o total do pedido no Bling, podendo incluir frete e outras cobranças. Inclui as situações retornadas; não equivale a vendas pagas ou faturamento líquido.</p><section style="margin:30px 0"><h3>Pedidos por dia · valor total</h3>'+svg+'<div style="display:flex;justify-content:space-between;font-size:12px"><span>'+start+'</span><span>'+currentDate+'</span></div></section><h3>Resumo por canal (ID Bling)</h3><table style="width:100%;text-align:left;border-spacing:10px"><thead><tr><th>Canal</th><th>Pedidos</th><th>Total</th></tr></thead><tbody>'+summary+'</tbody></table><h3>Pedidos recentes</h3><p style="font-size:13px">Até 100 pedidos da seleção. Situações exibidas pelo ID retornado pelo Bling.</p><div style="overflow:auto"><table style="width:100%;text-align:left;border-spacing:10px"><thead><tr><th>Pedido</th><th>Data</th><th>Canal</th><th>Situação</th><th>Total</th></tr></thead><tbody>'+(rows||'<tr><td>Sem pedidos nesta seleção.</td></tr>')+'</tbody></table></div>';
        return send(res,200,shell('<nav style="margin-bottom:20px"><a class="button primary" href="/analises">Abrir análise por produto →</a></nav>'+content,{title:'Visão geral',active:'overview'}),browserSession?{'Set-Cookie':tokenCookies(crypto,current)}:{});
      }
      if(['/pedidos','/produtos','/test/bling'].includes(path)&&req.method==='GET'){
        if(!session)return send(res,303,'',{'Location':'/'});
        const current=await renew(session),products=path!=='/pedidos';
        sharedSession=current;
        const n=Number(url.searchParams.get('pagina')||'1');
        if(!Number.isSafeInteger(n)||n<1||n>10000)return send(res,400,page('<p>Página inválida.</p>'));
        const resource=products?'produtos':'pedidos/vendas';
        const response=await fetcher('https://api.bling.com.br/Api/v3/'+resource+'?'+new URLSearchParams({pagina:String(n),limite:'50'}),{headers:{Authorization:'Bearer '+current.access_token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20000)});
        // Persist rotated tokens even if the business-data request fails.
        const extra=browserSession?{'Set-Cookie':tokenCookies(crypto,current)}:{};
        if(!response.ok){const status=Number(response.status)||502;return send(res,status===401?401:502,page('<p>O Bling não liberou esta consulta (HTTP '+status+'). Confira as permissões do aplicativo; se necessário, autorize novamente.</p><p><a href="/">Voltar</a></p>'),extra);}
        const data=await response.json();if(!Array.isArray(data.data))throw Error('invalid_response');
        const heading=products?'Produtos cadastrados':'Pedidos registrados no Bling';
        const th=products?'<th>Produto</th><th>SKU</th><th>Preço cadastrado</th>':'<th>Pedido</th><th>Data</th><th>Valor total do pedido</th><th>Situação (ID Bling)</th>';
        const brl=v=>typeof v==='number'?v.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}):'—';
        const rows=data.data.map(p=>products?'<tr><td>'+escape(p.nome||'—')+'</td><td>'+escape(p.codigo||'—')+'</td><td>'+brl(p.preco)+'</td></tr>':'<tr><td>'+escape(p.numero||p.id||'—')+'</td><td>'+escape(p.data||'—')+'</td><td>'+brl(p.total)+'</td><td>'+escape(p.situacao?.id??'—')+'</td></tr>').join('');
        const nav=(n>1?'<a href="?pagina='+(n-1)+'">Anterior</a> · ':'')+(data.data.length===50?'<a href="?pagina='+(n+1)+'">Próxima</a>':'');
        return send(res,200,page('<p><a href="/">Início</a> · <a href="/pedidos">Pedidos</a> · <a href="/produtos">Produtos</a></p><h2>'+heading+'</h2><p>Dados reais · Página '+n+' · '+data.data.length+' registros nesta página.</p>'+(products?'':'<p>Esta é uma consulta de pedidos, incluindo as situações retornadas pelo Bling. O total pode incluir frete e outros valores; ainda não representa faturamento pago sem frete.</p>')+'<div style="overflow:auto"><table style="width:100%;text-align:left;border-spacing:12px"><thead><tr>'+th+'</tr></thead><tbody>'+(rows||'<tr><td>Nenhum registro nesta página.</td></tr>')+'</tbody></table></div><p>'+nav+'</p>'),extra);
      }
      return send(res,404,page('<p>Página não encontrada.</p>'));
    }catch{
      return send(res,502,page('<p>Não foi possível concluir a consulta ou autorização. <a href="/">Volte ao início</a> e tente novamente. Se persistir, informe apenas esta mensagem; não compartilhe códigos nem chaves.</p>'));
    }
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){createServer(createApp()).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Servidor disponível · análises Bling 0.4.0'));}


