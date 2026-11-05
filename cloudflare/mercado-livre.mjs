import {createMLAnalytics} from './ml-analytics.mjs';
import {renderML} from './ml-ui.mjs';
import {persistentMap,sealStore} from './state.mjs';
import {randomBytes,createHash} from 'node:crypto';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nonce=()=>randomBytes(32).toString('base64url');
const cookieName='__Host-nissi-ml';
export function createMercadoLivre({env,base,crypto,send,shell,fetcher=fetch,clock=()=>Date.now(),state,schedule=()=>{}}){
 const sessionStore=sealStore(state,crypto,'ml-session');
 const clearUser=()=>state.delete('ml-user');
 let session=sessionStore.get(),refreshing=null;
 const pending=persistentMap(state,'ml-pending:');
 const redirect=base+'/auth/mercado-livre/callback';
 const clientId=String(env.ML_CLIENT_ID||'').trim(),clientSecret=String(env.ML_CLIENT_SECRET||'').trim();
 const configured=()=>!!(clientId&&clientSecret);
 async function apiFetch(url,options,stage){try{return await fetcher(url,{...options,redirect:'manual'});}catch(error){const message=String(error?.message||'');throw Error('ml_'+stage+'_'+(/different request|I\/O|request context/i.test(message)?'io_context':error?.name==='TimeoutError'?'timeout':'network'));}}
 async function json(response,stage){try{return await response.json();}catch{throw Error('ml_'+stage+'_invalid_json');}}
 const cookie=s=>cookieName+'='+encodeURIComponent(crypto.encrypt(s))+'; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000';
 function restore(req){if(session)return;try{const raw=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='));if(raw){const data=crypto.decrypt(decodeURIComponent(raw.slice(cookieName.length+1)));if(data.kind==='mercado-livre'&&data.sessionExpires>clock())session=data;sessionStore.set(session);}}catch{}}
 async function token(params){
  const response=await apiFetch('https://api.mercadolibre.com/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,...params}).toString(),signal:AbortSignal.timeout(20000)},'token');
  if(!response.ok)throw Error('ml_token_'+response.status);
  const data=await json(response,'token');if(typeof data.access_token!=='string'||typeof data.refresh_token!=='string'||!(Number(data.expires_in)>0))throw Error('ml_invalid_token');
  return {kind:'mercado-livre',access_token:data.access_token,refresh_token:data.refresh_token,user_id:data.user_id,expiresAt:clock()+Number(data.expires_in)*1000,sessionExpires:clock()+30*86400000};
 }
 async function renew(){if(session.expiresAt>clock()+60000)return session;if(!refreshing)refreshing=token({grant_type:'refresh_token',refresh_token:session.refresh_token}).then(s=>{session=s;sessionStore.set(s);return s;}).finally(()=>refreshing=null);return refreshing;}
 async function read(path){await renew();const response=await apiFetch('https://api.mercadolibre.com/'+path,{headers:{Authorization:'Bearer '+session.access_token,Accept:'application/json'},signal:AbortSignal.timeout(20000)},'read');if(!response.ok)throw Error('ml_read_'+response.status);return json(response,'read');}
 const analytics=createMLAnalytics({state,read,schedule,clock});
 const wrap=content=>shell(content,{title:'Mercado Livre',active:'ml',refresh:0}).replace('● Bling conectado','Bling · conexão separada');
 function button(){const ticket=crypto.encrypt({kind:'ml-start',expires:clock()+600000});return '<a class="button primary" href="/auth/mercado-livre/start?ticket='+encodeURIComponent(ticket)+'">'+(session?'Renovar conexão':'Conectar Mercado Livre')+'</a>';}
 const handle=async function(req,res,url){
  if(!['/mercado-livre','/auth/mercado-livre/start','/auth/mercado-livre/callback'].includes(url.pathname))return false;
  if(req.method!=='GET'){send(res,405,'Método não permitido');return true;}
  restore(req);for(const [key,value] of pending)if(value.expires<clock())pending.delete(key);
  try{
   if(url.pathname==='/mercado-livre'){
    const heading='<div class="heading"><div><div class="eyebrow">Casa Nissi · integração direta</div><h1>Mercado Livre</h1><p class="muted">Conexão independente do Bling, no mesmo dashboard.</p></div><span class="tag">'+(session?'Conta autorizada':'Aguardando autorização')+'</span></div>';
    if(!configured()){send(res,200,wrap(heading+'<article class="card"><h2>Ativar a conexão</h2><p>Cadastre a aplicação na conta Mercado Livre da Casa Nissi e configure as credenciais nos Secrets da Cloudflare.</p><p><a class="button primary" href="https://developers.mercadolivre.com.br/devcenter" target="_blank" rel="noopener noreferrer">Abrir aplicações do Mercado Livre</a></p><p>URL de redirecionamento:</p><code style="overflow-wrap:anywhere">'+esc(redirect)+'</code><p>Secrets na Cloudflare: <strong>ML_CLIENT_ID</strong> e <strong>ML_CLIENT_SECRET</strong>.</p><p class="muted">Use Authorization Code, habilite PKCE e acesso de leitura e offline, quando disponíveis. Após salvar os Secrets e publicar, volte a esta aba para autorizar a conta.</p></article>'));return true;}
    if(!session){send(res,200,wrap(heading+'<article class="card"><h2>Autorizar a Casa Nissi</h2><p>Entre com a conta correta no Mercado Livre e confirme o acesso solicitado pela aplicação.</p>'+button()+'</article>'));return true;}
    let userCache=state.get('ml-user');
    if(!userCache||clock()-userCache.updated>=1800000){const user=await read('users/me');userCache={user:{id:user.id,nickname:user.nickname,site_id:user.site_id},updated:clock()};state.put('ml-user',userCache);}
    const output=renderML({analytics,url,user:userCache.user,clock});
    send(res,200,shell(output.body,{title:'Mercado Livre',active:'ml',refresh:output.refresh}).replace('● Bling conectado','Mercado Livre conectado').replace('Casa Nissi · Bling','Casa Nissi · Mercado Livre'),{'Set-Cookie':cookie(session)});return true;
   }
   if(!configured()){send(res,503,wrap('<h1>Configure as credenciais primeiro</h1><p><a href="/mercado-livre">Voltar à configuração</a></p>'));return true;}
   if(url.pathname==='/auth/mercado-livre/start'){
    let ticket;try{ticket=crypto.decrypt(url.searchParams.get('ticket')||'');}catch{}
    if(req.headers['sec-fetch-site']==='cross-site'||ticket?.kind!=='ml-start'||!(ticket.expires>clock())){send(res,403,wrap('<p>Link de conexão expirado. <a href="/mercado-livre">Abra a aba e tente novamente.</a></p>'));return true;}
    const state=nonce(),verifier=nonce();pending.set(state,{verifier,expires:clock()+600000});
    const query=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:redirect,state,code_challenge: createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
    send(res,303,'',{Location:'https://auth.mercadolivre.com.br/authorization?'+query});return true;
   }
   const oauthState=url.searchParams.get('state'),attempt=pending.get(oauthState);pending.delete(oauthState);
   if(!attempt||attempt.expires<clock()||url.searchParams.has('error')||!url.searchParams.get('code')){send(res,400,wrap('<h1>Autorização não concluída</h1><p><a href="/mercado-livre">Voltar e tentar novamente</a></p>'));return true;}
   session=await token({grant_type:'authorization_code',code:url.searchParams.get('code'),redirect_uri:redirect,code_verifier:attempt.verifier});
   sessionStore.set(session);clearUser();
   send(res,303,'',{Location:'/mercado-livre','Set-Cookie':cookie(session)});return true;
  }catch(error){const code=String(error?.message||'');const safe=/^ml_(token|read)_(\d{3}|network|timeout|io_context|invalid_json)$/.test(code)||code==='ml_invalid_token'?code:'ml_consulta_indisponivel';if(/_(401|400)$/.test(code)){session=null;sessionStore.set(null);}send(res,502,wrap('<h1>Não foi possível concluir a conexão</h1><p>Referência: '+esc(safe)+'</p><p><a class="button" href="/mercado-livre">Voltar à conexão Mercado Livre</a></p>'));return true;}
 };
 handle.alarm=()=>analytics.tick();
 return handle;
}

