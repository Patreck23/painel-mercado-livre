const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function channelGroup(type){const key=norm(type);if(key==='mercadolivre')return 'Mercado Livre';if(key==='nuvemshop')return 'Site';if(key==='shopee')return 'Shopee';if(key==='amazon')return 'Amazon';if(['magazineluiza','magalu'].includes(key))return 'Magalu';return 'Outros canais';}
export function createChannels({request,clock=()=>Date.now()}){
 let cache=null;
 async function get(){
  if(cache&&clock()<cache.until)return cache.promise;
  const promise=(async()=>{const mapping=new Map();try{for(let page=1;page<=10;page++){const result=await request('canais-venda?pagina='+page+'&limite=100');if(!Array.isArray(result.data))throw Error('bad_channels');for(const c of result.data)mapping.set(String(c.id),{id:String(c.id),name:String(c.descricao||c.tipo||'Canal '+c.id),type:String(c.tipo||''),group:channelGroup(c.tipo)});if(result.data.length<100)return {mapping,complete:true};}return {mapping,complete:false};}catch{return {mapping,complete:false};}})();
  cache={until:clock()+300000,promise};return promise;
 }
 return {get,reset(){cache=null;}};
}
export function describeChannel(directory,id){return directory?.mapping?.get(String(id))||{id:String(id),name:String(id)==='0'?'Sem canal identificado':'Canal #'+String(id),group:'Não classificado',type:''};}
