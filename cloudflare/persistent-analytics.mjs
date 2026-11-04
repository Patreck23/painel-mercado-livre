import {dates,normalize} from '../backend/analytics.mjs';
// Each alarm processes a bounded batch; order records and progress survive eviction.
export function createPersistentAnalytics({state,schedule,request,classifyOrders,channels,clock=()=>Date.now()}){
 let running=null;
 const prefix=key=>'analytics:'+key+':';
 const metaKey=key=>prefix(key)+'meta';
 function hydrate(key,meta){return {...meta,orders:state.list(prefix(key)+'order:').map(([,v])=>v),statuses:new Map(meta.statusEntries||[]),channels:{mapping:new Map(meta.channelEntries||[]),complete:!!meta.channelsComplete}};}
 function get(days){
  const range=dates(days,clock()),key=range.start+':'+range.end;let meta=state.get(metaKey(key));
  const active=state.get('analytics-active');
  if(!meta||meta.finished&&clock()-meta.updated>60000){
   if(active&&active!==key){const other=state.get(metaKey(active));if(other&&!other.finished)return {busy:true,active:hydrate(active,other)};}
   for(const [k] of state.list(prefix(key)))state.delete(k);
   meta={generation:crypto.randomUUID(),range,total:0,processed:0,failed:0,phase:'Iniciando consulta',finished:false,listComplete:false,error:false,updated:clock(),page:1,stage:'list',cursor:0};
   state.put(metaKey(key),meta);state.put('analytics-active',key);schedule(clock()+100);
  }else if(!meta.finished)schedule(clock()+100);
  return {job:hydrate(key,meta)};
 }
 async function run(){
  const key=state.get('analytics-active');if(!key)return;
  const meta=state.get(metaKey(key));if(!meta||meta.finished)return;
  const current=()=>state.get(metaKey(key))?.generation===meta.generation;
  try{
   if(meta.stage==='list'){
    meta.phase='Buscando pedidos dos dois períodos';
    for(let batch=0;batch<10&&meta.page<=40;batch++){
     const result=await request('pedidos/vendas?'+new URLSearchParams({pagina:String(meta.page),limite:'100',dataInicial:meta.range.previousStart,dataFinal:meta.range.end}));
     if(!current())return;
     if(!Array.isArray(result.data))throw Error('invalid_list');
     for(const o of result.data)state.put(prefix(key)+'summary:'+o.id,o);
     meta.page++;
     if(result.data.length<100){meta.listComplete=true;meta.stage='classify';break;}
    }
    if(meta.page>40)meta.stage='classify';
   }else if(meta.stage==='classify'){
    meta.phase='Identificando canais e cancelamentos';
    const summaries=state.list(prefix(key)+'summary:').map(([,v])=>v),directory=await channels(),classification=await classifyOrders(summaries);
    if(!current())return;
    meta.channelEntries=[...directory.mapping];meta.channelsComplete=directory.complete;
    meta.statusEntries=[...classification.mapping];meta.unknownStatuses=classification.unknown.length;meta.cancelledCount=classification.cancelled.length;meta.total=summaries.length;
    if(meta.unknownStatuses){meta.error=true;meta.finished=true;meta.phase='O Bling não permitiu confirmar as situações dos pedidos.';}else{meta.stage='details';meta.phase='Detalhando os itens de cada pedido';}
   }else if(meta.stage==='details'){
    const summaries=state.list(prefix(key)+'summary:').map(([,v])=>v).sort((a,b)=>String(b.data).localeCompare(String(a.data))||String(a.id).localeCompare(String(b.id)));
    const status=new Map(meta.statusEntries);
    for(let batch=0;batch<25&&meta.cursor<summaries.length;batch++){
     const o=summaries[meta.cursor],cacheKey='detail:'+o.id;let cached=state.get(cacheKey);
     try{
      if(!cached||clock()-cached.updated>300000){const result=await request('pedidos/vendas/'+encodeURIComponent(o.id));if(!current())return;if(!result.data||!Array.isArray(result.data.itens))throw Error('missing_items');cached={order:normalize(result.data),updated:clock()};state.put(cacheKey,cached);}
      state.put(prefix(key)+'order:'+o.id,{...cached.order,cancelled:status.get(String(o.situacao?.id))?.cancelled===true});
     }catch(error){meta.failed++;if(meta.failed>=5)throw error;}
     meta.cursor++;meta.processed=meta.cursor;
    }
    if(meta.cursor>=summaries.length){meta.finished=true;meta.phase=meta.failed?'Carga concluída com pedidos indisponíveis':'Carga concluída';}
   }
  }catch(error){meta.error=true;meta.finished=true;const code=String(error?.message||'');meta.errorCode=/^(token_exchange_failed|bling_read_failed)_\d{3}$/.test(code)||/^bling_(token|read)_(io_context|timeout|network|invalid_json|invalid_payload)$/.test(code)||['invalid_list','missing_items','not_connected'].includes(code)?code:'consulta_indisponivel';meta.phase='Consulta interrompida. Os registros carregados são parciais.';}
  if(!current())return;
  meta.updated=clock();state.put(metaKey(key),meta);
  if(!meta.finished)schedule(clock()+1000);
  else state.delete('analytics-active');
 }
 return {get,tick(){if(!running)running=run().finally(()=>running=null);return running;},reset(){for(const [key] of state.list('analytics:'))state.delete(key);state.delete('analytics-active');for(const [key] of state.list('detail:'))state.delete(key);}};
}
