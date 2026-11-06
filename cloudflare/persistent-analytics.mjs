import {dates,normalize} from '../backend/analytics.mjs';
import {addCoverage,missingRanges,migrateBling,todayBR} from './sales-cache.mjs';
export function createPersistentAnalytics({state,schedule,request,classifyOrders,channels,clock=()=>Date.now()}){
 let running=false;const refreshMs=1800000,prefix=key=>'analytics:'+key+':',metaKey=key=>prefix(key)+'meta';
 const allOrders=()=>{const statuses=new Map(state.get('bling-statuses')||[]);return state.list('detail:').map(([,v])=>v.order).filter(Boolean).map(o=>({...o,cancelled:statuses.get(String(o.status))?.cancelled??o.cancelled??false}));};
 const localDate=t=>new Date(t).toLocaleString('sv-SE',{timeZone:'America/Sao_Paulo',hour12:false});
 function hydrate(key,m){const status=new Map(state.get('bling-statuses')||m.statusEntries||[]),legacy=state.list(prefix(key)+'order:').map(([,o])=>o),map=new Map(legacy.map(o=>[o.id,o]));for(const o of allOrders())map.set(o.id,o);
  return {...m,cancelledCount:[...map.values()].filter(o=>o.date>=m.range.start&&o.date<=m.range.end&&(status.get(String(o.status))?.cancelled??o.cancelled)).length,orders:[...map.values()].filter(o=>o.date>=m.range.previousStart&&o.date<=m.range.end).map(o=>({...o,cancelled:status.get(String(o.status))?.cancelled??o.cancelled??false})),statuses:status,channels:{mapping:new Map(state.get('bling-channels')?.entries||m.channelEntries||[]),complete:state.get('bling-channels')?.complete??m.channelsComplete??false}};
 }
 function get(days){migrateBling(state,clock());const range=typeof days==='object'?days:dates(days,clock()),key=range.start+':'+range.end;let m=state.get(metaKey(key));const active=state.get('analytics-active');
  if(active&&active!==key){const other=state.get(metaKey(active));if(other&&!other.finished&&other.economyVersion)return m?{job:hydrate(key,m)}:{busy:true,active:hydrate(active,other)};}
  if(m&&!m.economyVersion){m={...m,finished:true,updated:0};}
  const gaps=missingRanges(state.get('bling-coverage')||[],range.previousStart,range.end),historical=range.end<todayBR(clock());
  if(!m||m.finished&&(!m.error||clock()-m.updated>=3600000)&&(gaps.length||!historical&&clock()-m.updated>=refreshMs)){
   m={...m,economyVersion:1,generation:crypto.randomUUID(),range,total:0,processed:0,failed:0,phase:gaps.length?'Importando somente datas ainda não salvas':'Buscando somente pedidos novos ou alterados',finished:historical&&!gaps.length,listComplete:!gaps.length,error:false,errorCode:null,updated:clock(),page:1,segments:gaps,segment:0,mode:gaps.length?'backfill':'delta',stage:'list',cursor:0,pending:[],syncFrom:state.get('bling-sync-since')||clock()-300000,syncTo:clock()};
   state.put(metaKey(key),m);if(!m.finished){state.put('analytics-active',key);schedule(clock()+1000);}
  }else if(!m.finished){state.put('analytics-active',key);schedule(clock()+1000);}
  return {job:hydrate(key,m)};
 }
 async function run(){const key=state.get('analytics-active'),m=key&&state.get(metaKey(key));if(!m||m.finished)return;
  try{
   if(m.stage==='list'){
    for(let batch=0;batch<3;batch++){
     const q=new URLSearchParams({pagina:String(m.page),limite:'100'}),span=m.segments[m.segment];
     if(m.mode==='delta'){q.set('dataAlteracaoInicial',localDate(m.syncFrom-300000));q.set('dataAlteracaoFinal',localDate(m.syncTo));}
     else{q.set('dataInicial',span.start);q.set('dataFinal',span.end);}
     const v=await request('pedidos/vendas?'+q);if(!Array.isArray(v.data))throw Error('invalid_list');
     for(const o of v.data){state.put('bling-summary:'+o.id,o);if(!m.pending.includes(String(o.id)))m.pending.push(String(o.id));}
     m.page++;if(v.data.length<100){m.page=1;if(m.mode==='backfill'){m.segment++;if(m.segment>=m.segments.length){m.mode='delta';m.listComplete=true;}break;}m.listComplete=true;m.stage='classify';break;}
     if(m.page>100){m.listComplete=false;m.stage='classify';break;}
    }
   }else if(m.stage==='classify'){
    m.phase='Conferindo situações dos pedidos alterados';const summaries=m.pending.map(id=>state.get('bling-summary:'+id)).filter(Boolean),classification=await classifyOrders(summaries),mapping=new Map(state.get('bling-statuses')||m.statusEntries||[]);for(const [id,v] of classification.mapping)mapping.set(id,v);state.put('bling-statuses',[...mapping]);m.statusEntries=[...mapping];m.unknownStatuses=classification.unknown.length;m.total=summaries.length;
    let directory=state.get('bling-channels');if(!directory||clock()-directory.updated>=86400000){try{const c=await channels();directory={entries:[...c.mapping],complete:c.complete,updated:clock()};state.put('bling-channels',directory);}catch{directory=directory||{entries:[],complete:false,updated:clock()};}}
    m.channelEntries=directory.entries;m.channelsComplete=directory.complete;
    if(m.unknownStatuses){m.error=true;m.finished=true;m.phase='Não foi possível confirmar as situações dos pedidos alterados';}else m.stage='details';
   }else if(m.stage==='details'){
    m.phase='Salvando somente pedidos novos ou modificados';const status=new Map(m.statusEntries);
    for(let n=0;n<20&&m.cursor<m.pending.length;n++){
     const id=m.pending[m.cursor],summary=state.get('bling-summary:'+id),cacheKey='detail:'+id;let cached=state.get(cacheKey);const fingerprint=JSON.stringify(summary);
     // The explicit modification feed can contain item changes with unchanged summary totals.
     if(!cached||cached.fingerprint!==fingerprint||m.mode==='delta'&&cached.updated<m.syncFrom){const v=await request('pedidos/vendas/'+encodeURIComponent(id));if(!v.data||!Array.isArray(v.data.itens))throw Error('missing_items');const order=normalize(v.data);order.cancelled=status.get(String(order.status))?.cancelled===true;cached={order,updated:clock(),fingerprint};state.put(cacheKey,cached);}
     m.cursor++;m.processed=m.cursor;
    }
    if(m.cursor>=m.pending.length){for(const span of m.segments)if(m.listComplete)addCoverage(state,'bling',span.start,span.end);state.put('bling-sync-since',m.syncTo);m.finished=true;m.phase='Dados salvos · atualização incremental concluída';m.completedAt=clock();state.put('bling-last-completed',clock());}
   }else {m.finished=true;m.phase='Dados anteriores preservados';}
  }catch(error){m.error=true;m.finished=true;const code=String(error?.message||'');m.errorCode=/^(token_exchange_failed|bling_read_failed)_\d{3}$/.test(code)||/^bling_(token|read)_(io_context|timeout|network|invalid_json|invalid_payload)$/.test(code)||['invalid_list','missing_items','not_connected'].includes(code)?code:'consulta_indisponivel';m.phase='Atualização pausada. Os dados já salvos continuam disponíveis.';}
  m.updated=clock();state.put(metaKey(key),m);if(!m.finished)schedule(clock()+5000);else state.delete('analytics-active');
 }
 return {get,force(range){const active=state.get('analytics-active');if(active){const m=state.get(metaKey(active));if(m&&!m.finished)return false;state.delete('analytics-active');}const k=range.start+':'+range.end,m=state.get(metaKey(k));if(m)state.put(metaKey(k),{...m,updated:0,error:false});get(range);return true;},orders:allOrders,async tick(){if(running){schedule(clock()+5000);return;}running=true;try{await run();}finally{running=false;}},reset(){state.delete('analytics-active');}};
}
