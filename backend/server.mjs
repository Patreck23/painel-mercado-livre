import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hash = s => createHash('sha256').update(s).digest('hex');
const equal = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const nonce = () => randomBytes(32).toString('base64url');
const cookieName = '__Host-nissi-oauth';
const cookie = (value, age=600) => `${cookieName}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}`;
const headers = {'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Strict-Transport-Security':'max-age=31536000','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
function send(res, code, content, extra={}) {res.writeHead(code, {...headers,'Content-Type':'text/html; charset=utf-8',...extra});res.end(content);}
const page = body => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Casa Nissi · Bling</title><body style="font:16px system-ui;background:#f6f6f4;color:#222;margin:0"><main style="max-width:720px;margin:50px auto;padding:28px;background:white;border-top:6px solid #f4c925;border-radius:12px"><h1>Casa Nissi · Bling</h1>${body}</main></body></html>`;
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
export function createApp({env=process.env,fetcher=fetch,clock=()=>Date.now()}={}){
  const base=env.APP_BASE_URL||'https://painel-mercado-livre-9hti.onrender.com';
  // The already-configured server-side client secret supplies key material.
  // Key derivation is domain-separated from the Bling credential itself.
  const crypto=vault(env.BLING_CLIENT_SECRET||randomBytes(32));
  const usedStates=new Map(),renewals=new Map();
  let sharedSession=null;
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
      for(const [k,v] of renewals)if(v.until<=clock())renewals.delete(k);
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      if(path==='/health'&&['GET','HEAD'].includes(req.method))return send(res,200,req.method==='HEAD'?'':JSON.stringify({service:'casa-nissi-bling',status:'ok',version:'0.3.0'}),{'Content-Type':'application/json'});
      if(!['GET','POST'].includes(req.method))return send(res,405,'Método não permitido',{Allow:'GET, POST'});
      if(!env.BLING_CLIENT_ID||!env.BLING_CLIENT_SECRET)return send(res,503,page('<p>Configure BLING_CLIENT_ID e BLING_CLIENT_SECRET no Environment do Render.</p>'));
      const cookies=parseCookies(req),browserSession=readSession(cookies);
      if(!sharedSession&&browserSession)sharedSession=browserSession;
      const session=sharedSession&&sharedSession.sessionExpires>clock()?sharedSession:null;
      if(path==='/'&&req.method==='GET'){
        const csrf=nonce();
        const content=session?'<h2>Bling conectado</h2><p><a href="/pedidos">Consultar pedidos reais</a> · <a href="/produtos">Consultar produtos reais</a></p><p>Os dados são consultados diretamente no Bling. O painel demonstrativo do GitHub permanece separado.</p>':'<h2>Conectar Casa Nissi</h2><p>Autorize a consulta de dados na conta Bling da Casa Nissi.</p><form method="post" action="/auth/bling/start"><input type="hidden" name="csrf" value="'+csrf+'"><button style="padding:14px;background:#f4c925;border:0;border-radius:6px">Conectar Bling</button></form>';
        return send(res,200,page(content+'<p style="font-size:13px;color:#666">Acesso por link, sem senha adicional. Qualquer pessoa com este endereço pode consultar os dados enquanto a conexão estiver ativa. Se o serviço reiniciar, abra este endereço no navegador em que autorizou o Bling para restaurar a sessão, ou autorize novamente.</p>'),{'Set-Cookie':oauthCookie({kind:'csrf',value:csrf,expires:clock()+600000})});
      }
      if(path==='/auth/bling/start'&&req.method==='POST'){
        if(req.headers.origin!==base)return send(res,403,page('<p>Origem inválida. <a href="/">Voltar</a></p>'));
        let body='';for await(const chunk of req){body+=chunk;if(body.length>2048)return send(res,413,'Requisição muito grande');}
        const csrf=readState(cookies,'csrf');
        if(!csrf||!equal(csrf.value,new URLSearchParams(body).get('csrf')||''))return send(res,403,page('<p>Sessão expirada. <a href="/">Voltar</a></p>'));
        const state=nonce(),target=new URL('https://www.bling.com.br/Api/v3/oauth/authorize');
        target.search=new URLSearchParams({response_type:'code',client_id:env.BLING_CLIENT_ID,state}).toString();
        return send(res,303,'',{'Location':target.href,'Set-Cookie':oauthCookie({kind:'oauth',value:state,expires:clock()+600000})});
      }
      if(path==='/auth/bling/callback'&&req.method==='GET'){
        const bound=readState(cookies,'oauth'),state=url.searchParams.get('state')||'';
        if(!bound||!equal(bound.value,state)||usedStates.has(hash(state)))return send(res,400,page('<p>Autorização inválida, expirada ou já utilizada. <a href="/">Tentar novamente</a></p>'),{'Set-Cookie':cookie('',0)});
        usedStates.set(hash(state),clock()+600000);
        if(url.searchParams.has('error')||!url.searchParams.get('code'))return send(res,400,page('<p>Autorização não concluída. <a href="/">Voltar</a></p>'),{'Set-Cookie':cookie('',0)});
        const tokens=await exchange({grant_type:'authorization_code',code:url.searchParams.get('code')});
        sharedSession=tokens;
        return send(res,303,'',{'Location':'/','Set-Cookie':[cookie('',0),...tokenCookies(crypto,tokens)]});
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
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){createServer(createApp()).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Servidor disponível · sessão Bling 0.3.0'));}

