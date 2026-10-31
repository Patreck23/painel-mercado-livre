const label=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
export function createCancellation({request,clock=()=>Date.now(),overrideIds=[]}){
 const cache=new Map(),explicit=new Set(overrideIds.map(String));
 async function resolve(id,seen=new Set()){
  id=String(id??'');if(!/^\d+$/.test(id))return {known:false,id};
  if(explicit.has(id))return {known:true,cancelled:true,id,name:'Cancelado (configurado)'};
  if(seen.has(id)||seen.size>8)return {known:false,id};
  const cached=cache.get(id);if(cached&&cached.until>clock())return cached.promise;
  const next=new Set(seen);next.add(id);
  const promise=(async()=>{
   try{
    const response=await request('situacoes/'+encodeURIComponent(id)),data=response.data;
    if(!data||Array.isArray(data)||typeof data.nome!=='string')return {known:false,id};
    const direct=/^cancelad[oa]s?(?:\s|$)/.test(label(data.nome));
    if(direct)return {known:true,cancelled:true,id,name:data.nome};
    if(Number(data.idHerdado)>0&&String(data.idHerdado)!==id){const parent=await resolve(String(data.idHerdado),next);if(!parent.known)return {known:false,id,name:data.nome};return {known:true,cancelled:parent.cancelled,id,name:data.nome};}
    return {known:true,cancelled:false,id,name:data.nome};
   }catch{return {known:false,id};}
  })();cache.set(id,{until:clock()+60000,promise});return promise;
 }
 async function classify(orders){
  const ids=[...new Set(orders.map(o=>String(o.situacao?.id??'')))],mapping=new Map();
  for(const id of ids)mapping.set(id,await resolve(id));
  const accepted=[],cancelled=[],unknown=[];
  for(const o of orders){const result=mapping.get(String(o.situacao?.id??''));if(!result?.known)unknown.push(o);else if(result.cancelled)cancelled.push(o);else accepted.push(o);}
  return {accepted,cancelled,unknown,mapping,complete:unknown.length===0};
 }
 return {classify,resolve,reset(){cache.clear();}};
}
