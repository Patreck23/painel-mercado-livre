import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCancellation} from './cancellation.mjs';
test('discovers account-specific canceled IDs and inherited states',async()=>{
 const records={200:{nome:'Cancelado',idHerdado:0},600:{nome:'Atendido',idHerdado:0},901:{nome:'Reembolsado no marketplace',idHerdado:200}};
 const service=createCancellation({request:async path=>({data:records[path.split('/')[1]]})});
 const result=await service.classify([{id:1,situacao:{id:200}},{id:2,situacao:{id:600}},{id:3,situacao:{id:901}}]);
 assert.equal(result.complete,true);assert.deepEqual(result.cancelled.map(o=>o.id),[1,3]);assert.deepEqual(result.accepted.map(o=>o.id),[2]);
});
test('unknown permissions never classify an ID by guess',async()=>{
 const service=createCancellation({request:async()=>{throw Error('403');}});
 const result=await service.classify([{id:1,situacao:{id:9}}]);assert.equal(result.complete,false);assert.equal(result.unknown.length,1);assert.equal(result.accepted.length,0);
});
test('detects cyclic inheritance without recursion loop',async()=>{
 const service=createCancellation({request:async path=>({data:{nome:'Custom',idHerdado:path.endsWith('/1')?2:1}})});
 assert.equal((await service.resolve('1')).known,false);
});
