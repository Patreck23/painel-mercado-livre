import {addCoverage,missingRanges,migrateML,todayBR} from './sales-cache.mjs';
import {captureQuality,qualityDeclines} from './ml-quality.mjs';
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
export const cleanOrder=o=>({schema:2,id:String(o.id),pack:o.pack_id?String(o.pack_id):null,modified:o.date_last_updated||o.last_updated||null,total:Number.isFinite(o.total_amount)?o.total_amount:null,freight:Number.isFinite(o.shipping_cost)?o.shipping_cost:null,shipment:o.shipping?.id?String(o.shipping.id):null,shipped:(o.tags||[]).some(t=>['shipped','delivered'].includes(t)),delivered:(o.tags||[]).includes('delivered'),date:new Date(o.date_created).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'}),status:o.status,currency:o.currency_id,items:(o.order_items||[]).map(i=>({id:String(i.item?.id||''),title:i.item?.title||'',qty:Number(i.quantity),price:Number(i.unit_price),fee:Number.isFinite(i.sale_fee)?i.sale_fee:null}))});
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
 const key=r=>'ml-analytics:'+r.start+':'+r.end+':',meta=k=>k+'meta';let running=false;
 const orders=()=>state.list('ml-order:').map(([,v])=>v);
 function get(range,user){migrateML(state,clock());const k=key(range);let m=state.get(meta(k));const active=state.get('ml-active');if(m&&!m.economyVersion)m={...m,finished:true,updated:0};
  // Finish or resume the single import already scheduled. Reading another tab never resets it.
  if(active&&active!==k){const other=state.get(meta(active));if(other&&!other.finished&&other.economyVersion)return {job:m,waiting:true,key:k};}
  const gaps=missingRanges(state.get('ml-coverage')||[],range.previousStart,range.end),historical=range.end<todayBR(clock());
  if(!m||m.finished&&(!m.error||clock()-m.updated>=3600000)&&(!historical&&clock()-m.updated>=TTL||gaps.length)){
   m={economyVersion:1,range,user:String(user),generation:crypto.randomUUID(),stage:gaps.length?'orders':'delta',segments:gaps,segment:0,offset:0,cursor:0,ids:[],changedIds:[],finished:historical&&!gaps.length,complete:true,error:null,startedAt:clock(),syncFrom:state.get('ml-sync-since')||clock()-300000,syncTo:clock(),phase:gaps.length?'Importando apenas datas ainda não salvas':'Buscando somente vendas novas ou alteradas',updated:clock()};state.put(meta(k),m);if(!m.finished){state.put('ml-active',k);schedule(clock()+1000);}
  }else if(!m.finished){state.put('ml-active',k);schedule(clock()+1000);}
  return {job:m,key:k};
 }
 function view(k,m){return summarize(m,state.list('ml-item:').map(([,v])=>v.item),orders());}
 async function saveItems(ids,changed=[]){
  const need=ids.filter(id=>{const c=state.get('ml-item:'+id);return !c||clock()-c.updated>=(changed.includes(id)?TTL:7*86400000);});if(!need.length)return;
  const response=await read('items/bulk?'+new URLSearchParams({ids:need.join(',')}));if(!Array.isArray(response))throw Error('ml_items_invalid');
  for(const entry of response){if((entry.status_code??entry.code)!==200||!entry.body?.id)continue;const item=metadata(entry.body),prior=state.get('ml-item:'+item.id)?.item,events=state.get('ml-changes:'+item.id)||[];
   if(prior)for(const [field,label] of [['title','Título'],['price','Preço'],['status','Situação'],['stock','Estoque informado'],['shipping','Logística']])if(JSON.stringify(prior[field])!==JSON.stringify(item[field]))events.unshift({at:clock(),label,before:prior[field]??null,after:item[field]??null});
   if(events.length)state.put('ml-changes:'+item.id,events.slice(0,50));state.put('ml-item:'+item.id,{item,updated:clock()});
  }
 }
 async function focusVisits(range,id){if(!/^ML[A-Z]\d+$/.test(id)||!state.get('ml-item:'+id))return;const k=key(range)+'visits:'+id,c=state.get(k);if(c&&clock()-c.updated<86400000)return c;
  try{const v=await read('items/visits?'+new URLSearchParams({ids:id,date_from:range.start,date_to:shift(range.end,1)}));const row=Array.isArray(v)?v.find(x=>x.item_id===id):v;const saved={total:Number.isFinite(row?.total_visits)?row.total_visits:null,updated:clock(),version:3};state.put(k,saved);return saved;}
  catch(error){const saved={total:null,updated:clock(),version:3,reason:error.message};state.put(k,saved);return saved;}
 }
 async function shipping(ids){for(const id of ids){const k='ml-shipment:'+id,c=state.get(k);if(c&&(c.terminal||clock()-c.updated<TTL))continue;try{const v=await read('shipments/'+id);state.put(k,{id,status:v.status,terminal:['delivered','cancelled','returned'].includes(v.status),updated:clock()});}catch(error){state.put(k,{id,status:null,reason:error.message,updated:clock()});}}}
 async function run(){const k=state.get('ml-active'),m=k&&state.get(meta(k));if(!m||m.finished)return;
  try{
   if(['orders','delta'].includes(m.stage)){
    const delta=m.stage==='delta';m.phase=delta?'Buscando somente pedidos novos ou alterados':'Importando datas ainda não salvas';
    for(let batch=0;batch<4;batch++){
     const q=new URLSearchParams({seller:m.user,sort:'date_desc',offset:String(m.offset),limit:'50'}),span=m.segments[m.segment];
     if(delta){q.set('order.date_last_updated.from',new Date(m.syncFrom-300000).toISOString());q.set('order.date_last_updated.to',new Date(m.syncTo).toISOString());}
     else {q.set('order.date_created.from',span.start+'T00:00:00.000-03:00');q.set('order.date_created.to',shift(span.end,1)+'T00:00:00.000-03:00');}
     const v=await read('orders/search?'+q);if(!Array.isArray(v.results))throw Error('ml_orders_invalid');
     for(const raw of v.results){const order=cleanOrder(raw),old=state.get('ml-order:'+order.id);if(JSON.stringify(old)!==JSON.stringify(order)){state.put('ml-order:'+order.id,order);m.changedIds.push(...order.items.map(i=>i.id));}}
     m.orderTotal=Number(v.paging?.total)||v.results.length;m.offset+=v.results.length;
     if(v.results.length<50||m.offset>=m.orderTotal){m.offset=0;if(!delta){addCoverage(state,'ml',span.start,span.end);m.segment++;if(m.segment>=m.segments.length)m.stage='delta';break;}
      state.put('ml-sync-since',m.syncTo);m.changedIds=[...new Set(m.changedIds)];
      if(clock()-(state.get('ml-catalog-at')||0)>=86400000){m.stage='catalog';m.ids=[];m.scroll=null;}else{m.ids=m.changedIds;m.stage='metadata';}m.cursor=0;break;
     }
     if(m.offset>=10000){m.complete=false;m.finished=true;m.phase='Limite de pedidos da API atingido; consulta parcial';break;}
    }
   }else if(m.stage==='catalog'){
    m.phase='Conferência diária dos anúncios ativos';
    for(let n=0;n<4;n++){const q=new URLSearchParams({search_type:'scan',limit:'100',status:'active'});if(m.scroll)q.set('scroll_id',m.scroll);const v=await read('users/'+m.user+'/items/search?'+q);const ids=v.results||[];m.ids=[...new Set([...m.ids,...ids])];m.scroll=v.scroll_id;
     if(ids.length<100||m.ids.length>=Number(v.paging?.total)||!m.scroll){state.put('ml-catalog-at',clock());m.ids=[...new Set([...m.ids,...m.changedIds])].filter(id=>/^ML[A-Z]\d+$/.test(id));m.stage='metadata';m.cursor=0;break;}
    }
   }else if(m.stage==='metadata'){
    m.phase='Salvando somente cadastros novos ou vencidos';const ids=m.ids.slice(m.cursor,m.cursor+20);await saveItems(ids,m.changedIds);m.cursor+=ids.length;if(m.cursor>=m.ids.length){m.stage='quality';m.cursor=0;}
   }else if(['quality','details'].includes(m.stage)){
    m.stage='quality';m.phase='Qualidade: no máximo uma consulta por anúncio por dia';
    const ids=m.ids.slice(m.cursor,m.cursor+20);for(const id of ids){const item=state.get('ml-item:'+id)?.item;if(item?.status!=='active')continue;let p=state.get('ml-performance:'+id);if(!p||clock()-p.updated>=86400000){try{const v=await read('item/'+id+'/performance');p={available:true,score:Number.isFinite(v.score)?v.score:null,level:v.level_wording||v.level||null,actions:pendingActions(v),calculated:v.calculated_at,updated:clock()};}catch(e){if(/_(429|5\d\d)$|_(timeout|network|io_context)$/.test(e.message))throw e;p={available:false,reason:e.message,updated:clock()};}state.put('ml-performance:'+id,p);}captureQuality(state,id,p,item);}
    m.cursor+=ids.length;if(m.cursor>=m.ids.length){m.stage='shipping';m.cursor=0;m.shipments=[...new Set(orders().filter(o=>o.date===todayBR(clock())&&o.status==='paid'&&o.shipment&&!o.delivered&&!o.shipped).map(o=>o.shipment))];}
   }else if(m.stage==='shipping'){
    m.phase='Atualizando os envios de hoje';const ids=m.shipments.slice(m.cursor,m.cursor+10);await shipping(ids);m.cursor+=ids.length;if(m.cursor>=m.shipments.length){m.finished=true;m.phase='Dados salvos · atualização incremental concluída';m.completedAt=clock();state.put('ml-last-completed',clock());}
   }else {m.finished=true;m.phase='Carga antiga preservada; próxima consulta usará sincronização incremental';}
  }catch(error){m.error=/^ml_[a-z_]+(?:_\d{3})?$/.test(error.message)?error.message:'ml_consulta_indisponivel';m.finished=true;m.phase='Atualização pausada; dados salvos preservados';}
  m.updated=clock();state.put(meta(k),m);if(m.finished)state.delete('ml-active');else schedule(clock()+5000);
 }
 return {get,force(range,user){const active=state.get('ml-active');if(active){const m=state.get(meta(active));if(m&&!m.finished)return false;state.delete('ml-active');}const k=key(range),m=state.get(meta(k));if(m)state.put(meta(k),{...m,updated:0,error:null});get(range,user);return true;},view,orders,focusVisits,shippingInfo:id=>state.get('ml-shipment:'+id),quality:range=>qualityDeclines(state,range,view(key(range),{range}).products),extra(k,id){return {performance:state.get('ml-performance:'+id),visits:state.get(k+'visits:'+id),changes:state.get('ml-changes:'+id)||[]};},async tick(){if(running){schedule(clock()+5000);return;}running=true;try{await run();}finally{running=false;}}};
}
