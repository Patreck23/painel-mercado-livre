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

export async function postgresStore(url) {
  const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:url,max:3,connectionTimeoutMillis:10000,idleTimeoutMillis:10000});
  // Do not print database errors: they may contain connection details.
  pool.on('error',()=>{});
  await pool.query('CREATE TABLE IF NOT EXISTS nissi_bling_tokens (id integer PRIMARY KEY CHECK(id=1), payload text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
  await pool.query('CREATE TABLE IF NOT EXISTS nissi_bling_oauth (digest text PRIMARY KEY, expires_at timestamptz NOT NULL)');
  return {
    async saveState(digest) {await pool.query('DELETE FROM nissi_bling_oauth WHERE expires_at < now()');await pool.query("INSERT INTO nissi_bling_oauth(digest,expires_at) VALUES($1,now()+interval '10 minutes')",[digest]);},
    async consumeState(digest) {return (await pool.query('DELETE FROM nissi_bling_oauth WHERE digest=$1 AND expires_at>now() RETURNING digest',[digest])).rowCount===1;},
    async read() {return (await pool.query('SELECT payload FROM nissi_bling_tokens WHERE id=1')).rows[0]?.payload;},
    // Serialize token renewal across processes, so a refresh token is used once.
    async locked(fn) {const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(84201927)');const existing=(await c.query('SELECT payload FROM nissi_bling_tokens WHERE id=1')).rows[0]?.payload;const result=await fn(existing);if(result.payload)await c.query('INSERT INTO nissi_bling_tokens(id,payload) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET payload=$1,updated_at=now()',[result.payload]);await c.query('COMMIT');return result.value;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}},
    close:()=>pool.end()
  };
}

export function createApp({env=process.env,store,fetcher=fetch,clock=()=>Date.now()}={}) {
  const secret=env.APP_SECRET||'',password=env.PANEL_PASSWORD||'';
  const base=env.APP_BASE_URL||'https://painel-mercado-livre-9hti.onrender.com';
  const missing=[];
  if(!env.BLING_CLIENT_ID)missing.push('BLING_CLIENT_ID');
  if(!env.BLING_CLIENT_SECRET)missing.push('BLING_CLIENT_SECRET');
  if(password.length<16)missing.push('PANEL_PASSWORD (mínimo 16 caracteres)');
  if(secret.length<32)missing.push('APP_SECRET (mínimo 32 caracteres aleatórios)');
  if(!store)missing.push('DATABASE_URL (banco PostgreSQL disponível)');
  if(!/^https:\/\/[^/]+$/.test(base))missing.push('APP_BASE_URL (origem HTTPS sem barra final)');
  const crypto=secret.length>=32?vault(secret):null;
  const signature=s=>createHmac('sha256',secret).update('oauth:'+s).digest('base64url');
  const sign=s=>s+'.'+signature(s);
  const verify=s=>{if(!s)return null;const [value,sig,...rest]=s.split('.');return !rest.length&&sig&&equal(sig,signature(value))?value:null;};
  let failures=0,windowStart=clock();
  async function requestTokens(params) {
    const response=await fetcher('https://api.bling.com.br/Api/v3/oauth/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(env.BLING_CLIENT_ID+':'+env.BLING_CLIENT_SECRET).toString('base64'),'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams(params),signal:AbortSignal.timeout(20000),redirect:'error'});
    if(!response.ok)throw Error('token_exchange_failed');
    const data=await response.json();
    if(typeof data.access_token!=='string'||typeof data.refresh_token!=='string'||!Number.isFinite(Number(data.expires_in))||Number(data.expires_in)<=0)throw Error('invalid_token_response');
    return {access_token:data.access_token,refresh_token:data.refresh_token,expiresAt:clock()+Number(data.expires_in)*1000};
  }
  async function accessToken() {
    return store.locked(async payload=>{if(!payload)throw Error('not_connected');let tokens=crypto.decrypt(payload);if(tokens.expiresAt>clock()+60000)return {value:tokens.access_token};tokens=await requestTokens({grant_type:'refresh_token',refresh_token:tokens.refresh_token});return {payload:crypto.encrypt(tokens),value:tokens.access_token};});
  }
  function auth(req,res) {
    if(password.length<16){send(res,503,page('<p>Configure PANEL_PASSWORD no Environment do Render (mínimo 16 caracteres).</p>'));return false;}
    if(clock()-windowStart>60000){failures=0;windowStart=clock();}
    let supplied='';const value=req.headers.authorization||'';
    if(value.startsWith('Basic '))supplied=Buffer.from(value.slice(6),'base64').toString('utf8');
    if(!equal(supplied,'casa-nissi:'+password)){failures++;send(res,failures>30?429:401,page('<p>Acesso restrito. Utilize o usuário casa-nissi e a senha configurada no Render.</p>'),failures>30?{'Retry-After':'60'}:{'WWW-Authenticate':'Basic realm="Casa Nissi", charset="UTF-8"'});return false;}
    return true;
  }
  async function handler(req,res) {
    try {
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      if(path==='/health'&&(req.method==='GET'||req.method==='HEAD'))return send(res,200,req.method==='HEAD'?'':JSON.stringify({service:'casa-nissi-bling',status:'ok'}),{'Content-Type':'application/json'});
      if(!['GET','POST'].includes(req.method))return send(res,405,'Método não permitido',{Allow:'GET, POST'});
      // Callback authenticates with an expiring, signed, browser-bound OAuth cookie,
      // not Basic credentials, which may be omitted after the cross-site redirect.
      if(path!=='/auth/bling/callback'&&!auth(req,res))return;
      if(missing.length)return send(res,503,page('<h2>Configuração pendente</h2><ul>'+missing.map(x=>'<li>'+escape(x)+'</li>').join('')+'</ul><p>Nenhuma autorização será processada até concluir a configuração.</p>'));
      const cookies=Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=')));
      const browser=verify(cookies[cookieName]);
      if(path==='/auth/bling/callback'&&req.method==='GET') {
        const state=url.searchParams.get('state');
        if(!browser||!state||!equal(state,browser)||!await store.consumeState(hash(state)))return send(res,400,page('<p>Autorização inválida, expirada ou já utilizada. Volte ao início e tente novamente.</p>'),{'Set-Cookie':cookie('',0)});
        if(url.searchParams.has('error')||!url.searchParams.get('code'))return send(res,400,page('<p>Autorização não concluída. <a href="/">Voltar</a></p>'),{'Set-Cookie':cookie('',0)});
        // A fresh authorization never silently overwrites an existing connection.
        await store.locked(async existing=>{if(existing)throw Error('already_connected');const tokens=await requestTokens({grant_type:'authorization_code',code:url.searchParams.get('code')});return {payload:crypto.encrypt(tokens),value:true};});
        return send(res,303,'',{'Location':'/','Set-Cookie':cookie('',0)});
      }
      if(path==='/'&&req.method==='GET') {
        const connected=Boolean(await store.read()),state=nonce();
        const form=connected?'<p>Autorização recebida e armazenada. A leitura de dados ainda precisa ser validada.</p><p><a href="/test/bling">Testar consulta de produtos</a></p>':'<p>Ao continuar, confira se está na conta Bling da Casa Nissi e se as permissões exibidas são somente de consulta.</p><form action="/auth/bling/start" method="post"><input type="hidden" name="csrf" value="'+state+'"><button style="padding:12px 20px;background:#f4c925;border:0;border-radius:6px">Autorizar Bling da Casa Nissi</button></form>';
        return send(res,200,page('<h2>'+ (connected?'Bling autorizado':'Conectar Bling')+'</h2>'+form+'<p>O painel demonstrativo no GitHub permanece separado. Vendas reais não são publicadas nele.</p>'),{'Set-Cookie':cookie(sign(state))});
      }
      if(path==='/auth/bling/start'&&req.method==='POST') {
        if(req.headers.origin!==base)return send(res,403,page('<p>Origem inválida.</p>'));
        let body='';for await(const chunk of req){body+=chunk;if(body.length>2048)return send(res,413,'Requisição muito grande');}
        if(!browser||!equal(new URLSearchParams(body).get('csrf')||'',browser))return send(res,403,page('<p>Sessão inválida. Volte ao início.</p>'));
        if(await store.read())return send(res,409,page('<p>Já existe uma autorização cadastrada.</p>'));
        const state=nonce();await store.saveState(hash(state));
        const target=new URL('https://www.bling.com.br/Api/v3/oauth/authorize');target.search=new URLSearchParams({response_type:'code',client_id:env.BLING_CLIENT_ID,state}).toString();
        return send(res,303,'',{'Location':target.href,'Set-Cookie':cookie(sign(state))});
      }
      if(path==='/test/bling'&&req.method==='GET') {
        const token=await accessToken();
        const response=await fetcher('https://api.bling.com.br/Api/v3/produtos?pagina=1&limite=1',{headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(20000),redirect:'error'});
        if(!response.ok)throw Error('read_failed');
        const data=await response.json();if(!Array.isArray(data.data))throw Error('invalid_read_response');
        return send(res,200,page('<h2>Consulta confirmada</h2><p>O Bling respondeu à consulta de produtos. '+(data.data.length?'Foi encontrado pelo menos um produto.':'A primeira página está vazia.')+'</p><p>Nenhum registro foi alterado no Bling. A importação de vendas para o painel é a próxima etapa.</p><p><a href="/">Voltar</a></p>'));
      }
      return send(res,404,page('<p>Página não encontrada.</p>'));
    } catch {
      // Never echo exception messages, tokens, authorization codes or URLs.
      return send(res,502,page('<p>Não foi possível concluir esta operação. A autorização pode precisar ser refeita ou o banco pode estar indisponível. Nenhuma chave será exibida aqui.</p><p><a href="/">Voltar</a></p>'));
    }
  }
  return handler;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let store;
  if(process.env.DATABASE_URL){try{store=await postgresStore(process.env.DATABASE_URL);}catch{console.error('Banco indisponível. Verifique a configuração no Render.');}}
  createServer(createApp({store})).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Servidor disponível'));
}
