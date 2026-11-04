// Synchronous document store interface, backed by a SQLite Durable Object.
export function persistentMap(state,prefix){
 const map=new Map(state.list(prefix).map(([key,value])=>[key.slice(prefix.length),value]));
 const set=map.set.bind(map),remove=map.delete.bind(map);
 map.set=(key,value)=>{state.put(prefix+key,value);return set(key,value);};
 map.delete=key=>{state.delete(prefix+key);return remove(key);};
 return map;
}
export function sealStore(state,vault,key){
 return {get(){try{const v=state.get(key);return v?vault.decrypt(v):null;}catch{return null;}},set(value){if(value)state.put(key,vault.encrypt(value));else state.delete(key);}};
}
