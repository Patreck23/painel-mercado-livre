import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dailySummary} from './daily-summary.mjs';
test('daily summary isolates today, separates canceled sales and escapes status',()=>{
 const statuses=new Map([['1',{known:true,name:'Novo <teste>',cancelled:false}],['2',{known:true,name:'Cancelado',cancelled:true}]]);
 const html=dailySummary({today:'2026-10-30',complete:true,statuses,orders:[{data:'2026-10-30',total:100,situacao:{id:1}},{data:'2026-10-30',total:900,situacao:{id:2}},{data:'2026-10-29',total:500,situacao:{id:1}}]});
 assert.ok(html.includes('100,00'));assert.ok(!html.includes('900,00'));assert.ok(!html.includes('500,00'));assert.ok(html.includes('Novo &lt;teste&gt;'));assert.ok(html.includes('Cancelado'));
});
test('normalized items use unit value, and unknown status never displays misleading zero totals',()=>{
 const args={today:'2026-10-30',complete:true,normalized:true,orders:[{date:'2026-10-30',status:'1',items:[{qty:2,unit:15}]}]};
 assert.ok(dailySummary({...args,statuses:new Map([['1',{known:true,name:'Novo'}]])}).includes('30,00'));
 assert.ok(dailySummary(args).includes('A conferir'));
});
