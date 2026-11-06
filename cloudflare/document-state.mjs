// Cache SQLite reads in the object and avoid UPDATEs for identical data.
// SQLite remains authoritative across restarts; no token/secret is logged.
export function createDocumentState(sql,{maxEntries=30000}={}){
 const values=new Map(),lists=new Map();let revision=0;
 const remember=(k,v)=>{if(values.size>=maxEntries&&!values.has(k)){values.delete(values.keys().next().value);lists.clear();}values.set(k,v);};
 const raw=k=>{if(values.has(k))return values.get(k);const rows=sql.exec('SELECT value FROM documents WHERE key = ?',k).toArray();const value=rows.length?rows[0].value:null;remember(k,value);return value;};
 const invalidate=k=>{revision++;for(const p of lists.keys())if(k.startsWith(p))lists.delete(p);};
 return {
  get:key=>{const value=raw(key);return value===null?undefined:JSON.parse(value);},
  put(key,value){const serialized=JSON.stringify(value);if(raw(key)===serialized)return false;sql.exec('INSERT INTO documents(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE documents.value <> excluded.value',key,serialized);remember(key,serialized);invalidate(key);return true;},
  delete(key){if(raw(key)===null)return false;sql.exec('DELETE FROM documents WHERE key = ?',key);remember(key,null);invalidate(key);return true;},
  list(prefix){let keys=lists.get(prefix);if(!keys){const rows=sql.exec('SELECT key,value FROM documents WHERE key >= ? AND key < ? ORDER BY key',prefix,prefix+'\uffff').toArray();keys=rows.map(row=>{remember(row.key,row.value);return row.key;});lists.set(prefix,keys);}
   return keys.map(k=>[k,JSON.parse(raw(k))]);},
  get revision(){return revision;}
 };
}
