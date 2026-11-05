import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureQuality,qualityDeclines,createQualityResearch,renderQualityDeclines} from './ml-quality.mjs';
const memory=()=>{const docs=new Map();return {get:k=>structuredClone(docs.get(k)),put:(k,v)=>docs.set(k,structuredClone(v)),delete:k=>docs.delete(k),list:p=>[...docs].filter(([k])=>k.startsWith(p)).map(([k,v])=>[k,structuredClone(v)])};};
const range={start:'2026-11-01',end:'2026-11-05',previousStart:'2026-10-27',previousEnd:'2026-10-31'};
const at=d=>Date.parse(d+'T15:00:00Z');
const put=(s,id,day,score,actions=[])=>captureQuality(s,id,{available:true,score,updated:at(day),actions},{status:'active',title:'Produto'});
test('quality comparison requires observations in both periods and never backdates a calculated score',()=>{
 const s=memory();captureQuality(s,'MLB1',{available:true,score:50,updated:at('2026-11-05'),calculated:'2026-10-30T12:00:00Z',actions:[]},{});
 assert.equal(s.list('ml-quality-history:')[0][1].day,'2026-11-05');const p=[{id:'MLB1',status:'active'}];assert.equal(qualityDeclines(s,range,p).rows.length,0);assert.equal(qualityDeclines(s,range,p).missing,1);
 put(s,'MLB1','2026-10-31',80);const c=qualityDeclines(s,range,p);assert.equal(c.rows[0].drop,30);assert.equal(c.compared,1);
});
test('ranking is limited to ten true active declines and detects new official actions',()=>{
 const s=memory(),products=[];for(let i=1;i<=15;i++){const id='MLB'+i;products.push({id,status:i===15?'paused':'active',revenue:i});put(s,id,'2026-10-31',100);put(s,id,'2026-11-05',100-i,[{key:'new',title:'Melhorar fotos'}]);}
 put(s,'MLB16','2026-10-31',50);put(s,'MLB16','2026-11-05',80);products.push({id:'MLB16',status:'active'});
 const c=qualityDeclines(s,range,products);assert.equal(c.total,14);assert.equal(c.rows.length,10);assert.equal(c.rows[0].id,'MLB14');assert.equal(c.rows[0].newActions[0].key,'new');assert.ok(c.rows.every(r=>r.drop>0));
});
test('missing or unavailable quality does not become zero; only latest daily observation is used',()=>{
 const s=memory();put(s,'MLB1','2026-10-31',80);put(s,'MLB1','2026-11-05',0);captureQuality(s,'MLB1',{available:false,score:0,updated:at('2026-11-05')+5000},{});
 captureQuality(s,'MLB1',{available:true,score:90,updated:at('2026-11-05')-1000},{});assert.equal(s.get('ml-quality-history:MLB1:2026-11-05').score,0);
 assert.equal(qualityDeclines(s,range,[{id:'MLB1',status:'active'}]).rows[0].drop,80);
});
function decline(s,id='MLB1'){put(s,id,'2026-10-31',90);put(s,id,'2026-11-05',70,[{key:'photos',title:'Melhore fotos'}]);return qualityDeclines(s,range,[{id,status:'active',title:'Produto',catalog:true,price:99}]).rows[0];}
test('online research queries actual catalog competition and caches a grounded AI report',async()=>{
 const s=memory(),row=decline(s),scheduled=[];let calls=0;
 const research=createQualityResearch({state:s,clock:()=>at('2026-11-05'),schedule:t=>scheduled.push(t),read:async path=>{assert.equal(path,'items/MLB1/price_to_win?version=v2');return {status:'competing',currency_id:'BRL',current_price:99,winner:{item_id:'MLB2',price:90,currency_id:'BRL'}};},ai:{run:async(model,input)=>{calls++;assert.ok(input.messages[0].content.includes('causa não é'));assert.ok(input.messages[1].content.includes('competing'));assert.equal(input.response_format.type,'json_object');return {response:JSON.stringify({hypotheses:['Verificar se há pendências novas nas fotos.'],next_steps:['Conferir a recomendação oficial.'],limitations:'A causa não está confirmada.'})};}}});
 research.queue([row]);research.queue([row]);assert.equal(s.get('ml-quality-queue').length,1);await research.tick();assert.equal(research.report(row).status,'ready');assert.equal(research.report(row).competition.winner.price,90);assert.equal(research.report(row).sources.length,2);research.queue([row]);await research.tick();assert.equal(calls,1);
});
test('AI failure and quota never masquerade as a completed generated explanation',async()=>{
 const s=memory(),row=decline(s),now=at('2026-11-05');const research=createQualityResearch({state:s,clock:()=>now,schedule:()=>{},read:async()=>{throw Error('ml_read_403');},ai:{run:async()=>({response:'not JSON'})}});
 research.queue([row]);await research.tick();assert.equal(research.report(row).status,'ai_unavailable');assert.equal(research.report(row).competition.available,false);
 s.delete('ml-quality-report:'+row.signature);s.put('ml-quality-ai-budget:2026-11-05',10);research.queue([row]);await research.tick();assert.equal(research.report(row).status,'daily_limit');
});
test('empty-history UI and generated text escape untrusted content',()=>{
 const s=memory(),row=decline(s);row.product.title='<script>bad</script>';const comparison={rows:[row],total:1,compared:1,eligible:1,missing:0};
 const html=renderQualityDeclines({comparison,range,link:()=>'/mercado-livre',photo:()=>'',research:{report:()=>({status:'ready',updated:at('2026-11-05'),hypotheses:['<img onerror=bad>'],nextSteps:[],limitations:'Não confirmada',sources:[]})}});assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('não são causas confirmadas'));
 const empty=renderQualityDeclines({comparison:{rows:[],total:0,compared:0,eligible:10,missing:10},range,link:()=>'',photo:()=>''});assert.ok(empty.includes('Estamos formando o histórico'));assert.ok(!empty.includes('Nenhuma queda confirmada entre'));
});
