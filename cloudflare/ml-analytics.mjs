const DAY=86400000,TTL=1800000;
export const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const money=n=>Number(n).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const date=n=>new Date(n).toISOString().slice(0,10);
export const shift=(s,n)=>date(Date.parse(s+'T12:00:00Z')+n*DAY);
export function period(params,now=Date.now()){
 const today=new Date(now).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'}),end=params.get('fim')||today,start=params.get('inicio')||shift(end,-29);
 for(const s of [start,end])if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T12:00:00Z'))||date(Date.parse(s+'T12:00:00Z'))!==s)throw Error('invalid_period');
 const days=Math.round((Date.parse(end)-Date.parse(start))/DAY)+1;if(days<1||days>150||end>today)throw Error('invalid_period');
 return {start,end,days,previousStart:shift(start,-days),previousEnd:shift(start,-1)};
}
export function pendingActions(performance){
 const actions=[];
 for(const bucket of performance?.buckets||[])for(const variable of bucket.variables||[])for(const rule of variable.rules||[]){
  if(rule.status!=='PENDING')continue;
  const w=rule.wordings||{};actions.push({key:rule.key,title:w.title||variable.title||bucket.title||rule.key,mode:rule.mode||'OPPORTUNITY',link:w.link||null});
 }
 return actions;
}
const cleanOrder=o=>({id:String(o.id),date:new Date(o.date_created).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'}),status:o.status,currency:o.currency_id,items:(o.order_items||[]).map(i=>({id:String(i.item?.id||''),title:i.item?.title||'',qty:Number(i.quantity),price:Number(i.unit_price),fee:Number.isFinite(Number(i.sale_fee))?Number(i.sale_fee):null}))});
const metadata=i=>({id:i.id,title:i.title,price:i.price,currency:i.currency_id,status:i.status,sub_status:i.sub_status||[],stock:i.available_quantity,sku:i.seller_custom_field||(i.attributes||[]).find(a=>a.id==='SELLER_SKU')?.value_name||'',photo:i.pictures?.[0]?.secure_url||i.secure_thumbnail||i.thumbnail||'',link:i.permalink,updated:i.last_updated,shipping:i.shipping?.logistic_type,listing:i.listing_type_id,catalog:!!i.catalog_listing,variations:(i.variations||[]).length});
export function summarize(job,items,orders){
 const products=new Map(items.map(i=>[i.id,{...i,qty:0,revenue:0,previous:0,orders:new Set(),cancelled:new Set(),daily:{},fees:0}]));let invalid=0;
 for(const o of orders){if(o.date<job.range.previousStart||o.date>job.range.end)continue;const current=o.date>=job.range.start;
  for(const line of o.items){if(!line.id||!Number.isFinite(line.qty)||!Number.isFinite(line.price)||line.qty<=0||line.price<0||o.currency!=='BRL'){invalid++;continue;}
   if(!products.has(line.id))products.set(line.id,{id:line.id,title:line.title,status:'unknown',qty:0,revenue:0,previous:0,orders:new Set(),cancelled:new Set(),daily:{},fees:0});const p=products.get(line.id);
   if(o.status==='cancelled'){if(current)p.cancelled.add(o.id);continue;}if(o.status!=='paid')continue;
   if(current){p.qty+=line.qty;p.revenue+=line.price*line.qty;p.orders.add(o.id);p.daily[o.date]=(p.daily[o.date]||0)+line.price*line.qty;p.fees+=line.fee||0;}else p.previous+=line.price*line.qty;
  }
 }
 const list=[...products.values()].sort((a,b)=>b.revenue-a.revenue||String(a.title).localeCompare(String(b.title))),total=list.reduce((a,p)=>a+p.revenue,0);let accumulated=0;
 for(const p of list){p.abc=p.revenue<=0?'—':accumulated<.8*total?'A':accumulated<.95*total?'B':'C';accumulated+=p.revenue;p.share=total?p.revenue/total:0;p.average=p.qty?p.revenue/p.qty:null;p.growth=p.previous?(p.revenue-p.previous)/p.previous:null;p.orderCount=p.orders.size;p.cancelCount=p.cancelled.size;delete p.orders;delete p.cancelled;}
 return {products:list,total,qty:list.reduce((a,p)=>a+p.qty,0),orders:new Set(orders.filter(o=>o.status==='paid'&&o.currency==='BRL'&&o.date>=job.range.start&&o.date<=job.range.end).map(o=>o.id)).size,invalid};
}
export function createMLAnalytics({state,read,schedule,clock=()=>Date.now()}){
 const key=r=>'ml-analytics:'+r.start+':'+r.end+':',meta=k=>k+'meta';let running=null;
 function get(range,user){const k=key(range);let m=state.get(meta(k));const active=state.get('ml-active');
  if(active&&active!==k){const other=state.get(meta(active));if(other&&!other.finished)return {job:m,waiting:true,key:k};}
  if(!m||m.finished&&clock()-m.updated>=TTL){
   if(active&&active!==k){const other=state.get(meta(active));if(other&&!other.finished)return {job:m,waiting:true,key:k};}
   m={...m,range,user:String(user),generation:crypto.randomUUID(),stage:'orders',offset:0,cursor:0,metadataReady:false,ids:[],scroll:null,finished:false,complete:true,error:null,phase:'Carregando vendas do período e da comparação',updated:clock()};state.put(meta(k),m);state.put('ml-active',k);schedule(clock()+100);
  }else if(!m.finished){state.put('ml-active',k);schedule(clock()+100);}
  return {job:m,key:k};
 }
 function view(k,m){const ids=['metadata','details'].includes(m.stage)?new Set(m.ids):null;const items=state.list('ml-item:').map(([,v])=>v.item).filter(i=>!ids||ids.has(i.id));const orders=state.list(k+'order:').map(([,v])=>v);return summarize(m,items,orders);}
 async function run(){const k=state.get('ml-active'),m=k&&state.get(meta(k));if(!m||m.finished)return;const current=()=>state.get(meta(k))?.generation===m.generation;
  try{
   if(m.stage==='details'&&!m.metadataReady){const revenue=new Map();for(const [,o] of state.list(k+'order:'))if(o.status==='paid'&&o.date>=m.range.start)for(const i of o.items)revenue.set(i.id,(revenue.get(i.id)||0)+i.qty*i.price);m.ids.sort((a,b)=>(revenue.get(b)||0)-(revenue.get(a)||0));m.stage='metadata';m.cursor=0;}
   if(m.stage==='orders'){
    for(let n=0;n<8;n++){
     const q=new URLSearchParams({seller:m.user,'order.date_created.from':m.range.previousStart+'T00:00:00.000-03:00','order.date_created.to':shift(m.range.end,1)+'T00:00:00.000-03:00',sort:'date_desc',offset:String(m.offset),limit:'50'});
     const response=await read('orders/search?'+q);if(!current())return;if(!Array.isArray(response.results))throw Error('ml_orders_invalid');
     for(const o of response.results){const order=cleanOrder(o);state.put(k+'order:'+order.id,{...order,generation:m.generation});}
     m.orderTotal=Number(response.paging?.total)||response.results.length;m.offset+=response.results.length;
     if(response.results.length<50||m.offset>=m.orderTotal){for(const [id,o] of state.list(k+'order:'))if(o.generation!==m.generation)state.delete(id);m.stage='catalog';m.phase='Listando anúncios da conta';break;}
     if(m.offset>=10000){m.complete=false;m.stage='catalog';m.phase='Listagem de vendas atingiu o limite da API';break;}
    }
   }else if(m.stage==='catalog'){
    for(let n=0;n<8;n++){
     const q=new URLSearchParams({search_type:'scan',limit:'100'});if(m.scroll)q.set('scroll_id',m.scroll);
     const response=await read('users/'+m.user+'/items/search?'+q);if(!current())return;const ids=response.results||[];if(!Array.isArray(ids))throw Error('ml_items_invalid');
     m.ids=[...new Set([...m.ids,...ids])];m.scroll=response.scroll_id;m.catalogTotal=response.paging?.total||m.ids.length;
     if(ids.length<100||m.ids.length>=m.catalogTotal||!m.scroll){const sold=state.list(k+'order:').flatMap(([,o])=>o.items.map(i=>i.id));m.ids=[...new Set([...m.ids,...sold])].filter(id=>/^ML[A-Z]\d+$/.test(id));const revenue=new Map();for(const [,o] of state.list(k+'order:'))if(o.status==='paid'&&o.date>=m.range.start)for(const i of o.items)revenue.set(i.id,(revenue.get(i.id)||0)+i.qty*i.price);m.ids.sort((a,b)=>(revenue.get(b)||0)-(revenue.get(a)||0));m.stage='metadata';m.cursor=0;m.phase='Carregando fotos e cadastro dos anúncios';break;}
    }
   }else if(m.stage==='metadata'){
    m.phase='Carregando fotos e cadastro dos anúncios';
    const ids=m.ids.slice(m.cursor,m.cursor+40);
    for(let batch=0;batch<ids.length;batch+=20){const group=ids.slice(batch,batch+20);const response=await read('items/bulk?'+new URLSearchParams({ids:group.join(',')}));if(!current())return;if(!Array.isArray(response))throw Error('ml_items_invalid');for(const entry of response){const raw=entry.body;if((entry.status_code??entry.code)!==200||!raw?.id)continue;const item=metadata(raw),prior=state.get('ml-item:'+item.id)?.item,events=state.get('ml-changes:'+item.id)||[];if(prior)for(const [field,label] of [['title','Título'],['price','Preço'],['status','Situação'],['stock','Estoque informado'],['shipping','Logística']])if(JSON.stringify(prior[field])!==JSON.stringify(item[field]))events.unshift({at:clock(),label,before:prior[field]??null,after:item[field]??null});state.put('ml-changes:'+item.id,events.slice(0,50));state.put('ml-item:'+item.id,{item,updated:clock()});}}
    m.cursor+=ids.length;if(m.cursor>=m.ids.length){m.metadataReady=true;m.stage='details';m.cursor=0;m.phase='Consultando qualidade, visitas e recomendações oficiais';}
   }else if(m.stage==='details'){
    m.phase='Consultando qualidade, visitas e recomendações oficiais';
    const ids=m.ids.slice(m.cursor,m.cursor+10),missing=ids.filter(id=>{const c=state.get('ml-item:'+id);return !c||clock()-c.updated>=TTL;});
    if(missing.length){const response=await read('items/bulk?'+new URLSearchParams({ids:missing.join(',')}));if(!current())return;if(!Array.isArray(response))throw Error('ml_items_invalid');
     for(const entry of response){const raw=entry.body;if((entry.status_code??entry.code)!==200||!raw?.id)continue;const item=metadata(raw),prior=state.get('ml-item:'+item.id)?.item,events=state.get('ml-changes:'+item.id)||[];
      if(prior)for(const [field,label] of [['title','Título'],['price','Preço'],['status','Situação'],['stock','Estoque informado'],['shipping','Logística']])if(JSON.stringify(prior[field])!==JSON.stringify(item[field]))events.unshift({at:clock(),label,before:prior[field]??null,after:item[field]??null});
      state.put('ml-changes:'+item.id,events.slice(0,50));state.put('ml-item:'+item.id,{item,updated:clock()});
     }
    }
    for(const id of ids){
     let perf=state.get('ml-performance:'+id);if(!perf||clock()-perf.updated>=TTL){try{const p=await read('item/'+id+'/performance');perf={score:Number.isFinite(p.score)?p.score:null,level:p.level_wording||p.level||null,actions:pendingActions(p),calculated:p.calculated_at,updated:clock(),available:true};}catch(e){if(/ml_read_(401|429|5\d\d)|ml_read_(timeout|network|io_context)/.test(e.message))throw e;perf={available:false,reason:e.message,updated:clock()};}if(!current())return;state.put('ml-performance:'+id,perf);}
    }
    const visitsKey=k+'visits:',need=ids.filter(id=>{const v=state.get(visitsKey+id);return !v||clock()-v.updated>=TTL;});
    if(need.length){try{const response=await read('items/visits?'+new URLSearchParams({ids:need.join(','),date_from:m.range.start+'T00:00:00.000-03:00',date_to:shift(m.range.end,1)+'T00:00:00.000-03:00'}));if(!current())return;
      const data=Array.isArray(response)?response:[response];for(const id of need){const v=data.find(x=>x.item_id===id);state.put(visitsKey+id,{total:Number.isFinite(v?.total_visits)?v.total_visits:null,updated:clock(),reason:v?'':'Sem resposta para este anúncio'});}
     }catch(e){if(/ml_read_(401|429|5\d\d)|ml_read_(timeout|network|io_context)/.test(e.message))throw e;for(const id of need)state.put(visitsKey+id,{total:null,updated:clock(),reason:e.message});}
    }
    m.cursor+=ids.length;if(m.cursor>=m.ids.length){m.finished=true;m.phase='Sincronização concluída';m.completedAt=clock();}
   }
  }catch(error){m.error=/^ml_[a-z_]+(?:_\d{3})?$/.test(error.message)?error.message:'ml_consulta_indisponivel';m.finished=true;m.phase='Sincronização interrompida; dados anteriores preservados';}
  if(!current())return;m.updated=clock();state.put(meta(k),m);if(!m.finished)schedule(clock()+1000);else state.delete('ml-active');
 }
 return {get,view,extra(k,id){return {performance:state.get('ml-performance:'+id),visits:state.get(k+'visits:'+id),changes:state.get('ml-changes:'+id)||[]};},tick(){if(!running)running=run().finally(()=>running=null);return running;}};
}
