export const shiftDay=(day,delta)=>new Date(Date.parse(day+'T12:00:00Z')+delta*86400000).toISOString().slice(0,10);
export const todayBR=(now=Date.now())=>new Date(now).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
export function missingRanges(coverage,start,end){let cursor=start;const gaps=[];
 for(const span of [...coverage].sort((a,b)=>a.start.localeCompare(b.start))){if(span.end<cursor||span.start>end)continue;if(span.start>cursor)gaps.push({start:cursor,end:shiftDay(span.start,-1)});if(span.end>=cursor)cursor=shiftDay(span.end,1);if(cursor>end)break;}
 if(cursor<=end)gaps.push({start:cursor,end});return gaps;
}
export function addCoverage(state,source,start,end){const spans=[...(state.get(source+'-coverage')||[]),{start,end}].sort((a,b)=>a.start.localeCompare(b.start)),merged=[];for(const span of spans){const last=merged.at(-1);if(last&&span.start<=shiftDay(last.end,1))last.end=last.end>span.end?last.end:span.end;else merged.push({...span});}state.put(source+'-coverage',merged);}
export function migrateML(state,now){if(state.get('ml-canonical-v1'))return;
 const records=state.list('ml-analytics:'),orders=new Map();let newest=0;
 for(const [key,value] of records){if(key.endsWith(':meta')&&(value.finished||['catalog','metadata','details','quality','shipping'].includes(value.stage))&&!value.error&&value.complete&&value.range){addCoverage(state,'ml',value.range.previousStart,value.range.end);newest=Math.max(newest,value.updated||0);}if(key.includes(':order:')&&value.id){const {generation,...order}=value;orders.set(order.id,order);}}
 for(const [id,o] of orders)if(!state.get('ml-order:'+id))state.put('ml-order:'+id,o);
 if(!state.get('ml-sync-since'))state.put('ml-sync-since',newest?newest-86400000:now-300000);
 state.put('ml-canonical-v1',true);
}
export function migrateBling(state,now){if(state.get('bling-canonical-v1'))return;let newest=0;const statuses=new Map();
 for(const [key,value] of state.list('analytics:'))if(key.endsWith(':meta')&&value.finished&&value.listComplete&&!value.error&&value.range){addCoverage(state,'bling',value.range.previousStart,value.range.end);newest=Math.max(newest,value.updated||0);for(const [id,v] of value.statusEntries||[])statuses.set(id,v);if(value.channelEntries)state.put('bling-channels',{entries:value.channelEntries,complete:value.channelsComplete,updated:value.updated||now});}
 if(statuses.size)state.put('bling-statuses',[...statuses]);state.put('bling-sync-since',newest?newest-86400000:now-300000);state.put('bling-canonical-v1',true);
}
