// Synchronous document store interface, backed by a SQLite Durable Object.
export function persistentMap(state,prefix){
 const map=new Map(state.list(prefix).map(([key,value])=>[key.slice(prefix.length),value]));
 const set=map.set.bind(map),remove=map.delete.bind(map);
 map.set=(key,value)=>{state.put(prefix+key,value);return set(key,value);};
 map.delete=key=>{state.delete(prefix+key);return remove(key);};
 return map;
}
export function sealStore(state,vault,key){
 let last=null,serialized=null;
 return {get(){try{const v=state.get(key);if(!v)return null;if(v===last&&serialized)return JSON.parse(serialized);const value=vault.decrypt(v);last=v;serialized=JSON.stringify(value);return value;}catch{return null;}},set(value){if(!value){if(state.get(key))state.delete(key);last=null;serialized=null;return;}const next=JSON.stringify(value);if(next===serialized)return;const encrypted=vault.encrypt(value);state.put(key,encrypted);last=encrypted;serialized=next;}};
}
