const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const num=n=>n.toLocaleString('pt-BR',{maximumFractionDigits:2});
const pct=n=>(n*100).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%';
export function dates(days,now=Date.now()){
 const end=new Date(now).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
 const shift=n=>{const d=new Date(end+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
 return {end,start:shift(1-days),previousStart:shift(1-days*2),previousEnd:shift(-days)};
}
export function normalize(detail){
 const items=(detail.itens||[]).map(i=>({key:i.produto?.id?'id:'+i.produto.id:i.codigo?'sku:'+i.codigo:'unlinked:'+i.id,name:String(i.descricao||i.codigo||'Produto sem descrição'),sku:String(i.codigo||''),qty:Number(i.quantidade),unit:Number(i.valor)}));
 return {id:String(detail.id),date:String(detail.data||'').slice(0,10),store:String(detail.loja?.id??'Sem canal'),status:String(detail.situacao?.id??'Sem situação'),items};
}
export function aggregate(orders,range,{store='',status='',search=''}={}){
 const products=new Map();let skipped=0,currentOrders=new Set(),previousOrders=new Set();
 for(const o of orders){
  if(o.date<range.previousStart||o.date>range.end||(store&&o.store!==store)||(status&&o.status!==status))continue;
  const current=o.date>=range.start;
  for(const i of o.items){
   if(!Number.isFinite(i.qty)||!Number.isFinite(i.unit)||i.qty<=0||i.unit<0){skipped++;continue;}
   let p=products.get(i.key);if(!p){p={...i,current:0,previous:0,units:0,previousUnits:0,orders:new Set(),previousOrders:new Set(),daily:new Map(),channels:new Map()};products.set(i.key,p);}
   const value=i.qty*i.unit;
   if(current){p.current+=value;p.units+=i.qty;p.orders.add(o.id);currentOrders.add(o.id);p.daily.set(o.date,(p.daily.get(o.date)||0)+value);p.channels.set(o.store,(p.channels.get(o.store)||0)+value);}
   else{p.previous+=value;p.previousUnits+=i.qty;p.previousOrders.add(o.id);previousOrders.add(o.id);}
  }
 }
 const all=[...products.values()].sort((a,b)=>b.current-a.current||a.name.localeCompare(b.name)),total=all.reduce((a,p)=>a+p.current,0);let cumulative=0;
 for(const p of all){p.share=total?p.current/total:0;p.abc=p.current<=0?'—':cumulative<0.8?'A':cumulative<0.95?'B':'C';cumulative+=p.share;p.growth=p.previous>0?(p.current-p.previous)/p.previous:null;p.average=p.units?p.current/p.units:null;}
 const q=search.toLocaleLowerCase('pt-BR');
 return {products:all.filter(p=>(p.name+' '+p.sku).toLocaleLowerCase('pt-BR').includes(q)),total,previous:all.reduce((a,p)=>a+p.previous,0),units:all.reduce((a,p)=>a+p.units,0),orders:currentOrders.size,previousOrders:previousOrders.size,skipped,active:all.filter(p=>p.current>0).length,topShare:all.slice(0,5).reduce((a,p)=>a+p.share,0)};
}

export function createAnalytics({request,clock=()=>Date.now()}){
 const jobs=new Map(),details=new Map();let active=null;
 async function run(job){
  try{
   const summaries=[];job.phase='Buscando pedidos dos dois períodos';
   for(let p=1;p<=40;p++){
    const result=await request('pedidos/vendas?'+new URLSearchParams({pagina:String(p),limite:'100',dataInicial:job.range.previousStart,dataFinal:job.range.end}));
    if(!Array.isArray(result.data))throw Error('invalid_list');summaries.push(...result.data);
    if(result.data.length<100){job.listComplete=true;break;}
   }
   const unique=[...new Map(summaries.map(o=>[String(o.id),o])).values()].sort((a,b)=>String(b.data).localeCompare(String(a.data)));
   job.total=unique.length;job.phase='Detalhando os itens de cada pedido';
   for(const o of unique){
    const key=String(o.id);let cached=details.get(key);
    if(!cached||clock()-cached.updated>300000){
     try{const result=await request('pedidos/vendas/'+encodeURIComponent(key));if(!result.data||!Array.isArray(result.data.itens))throw Error('missing_items');cached={order:normalize(result.data),updated:clock()};details.set(key,cached);}
     catch{job.failed++;job.processed++;continue;}
    }
    job.orders.push(cached.order);job.processed++;
   }
   job.phase=job.failed?'Carga concluída com pedidos indisponíveis':'Carga concluída';job.finished=true;
  }catch{job.error=true;job.phase='O Bling não concluiu a consulta. A carga será tentada novamente.';job.finished=true;}
  finally{job.updated=clock();active=null;}
 }
 function get(days){
  const range=dates(days,clock()),key=range.start+':'+range.end;
  let job=jobs.get(key);
  if(!job||job.finished&&clock()-job.updated>60000){
   if(active)return {busy:true,active};
   job={range,orders:[],total:0,processed:0,failed:0,phase:'Iniciando consulta',finished:false,listComplete:false,error:false,updated:clock()};jobs.set(key,job);active=job;void run(job);
   if(jobs.size>4)jobs.delete(jobs.keys().next().value);
   if(details.size>8000)details.clear();
  }
  return {job};
 }
 return {get,reset(){jobs.clear();details.clear();}};
}

export const styles=`
*{box-sizing:border-box}body{margin:0;font:14px Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:#182230;background:#f3f5f8}a{color:inherit}.layout{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh}.sidebar{background:#121923;color:#aeb7c5;padding:30px 20px;position:sticky;top:0;height:100vh}.brand{font-size:21px;font-weight:850;color:white;letter-spacing:-1px}.brand b{color:#f4c925}.brand small{display:block;font-size:10px;letter-spacing:2px;color:#8b96a8;margin-top:7px}.section-label{font-size:10px;letter-spacing:1.6px;margin:36px 10px 12px;color:#738096}.nav a{display:block;padding:12px;border-radius:7px;margin:5px 0;text-decoration:none;font-size:13px}.nav a.active{background:#f4c925;color:#171d27;font-weight:750}.nav a:hover{background:#283241;color:#fff}.connection{margin-top:45px;border:1px solid #303b49;padding:14px;border-radius:9px;font-size:11px;line-height:1.7}.connection strong{color:#84dfb7}.workspace{min-width:0}.topbar{background:#fff;border-bottom:1px solid #e2e7ed;display:flex;justify-content:space-between;padding:20px 34px;color:#677385;font-size:12px}.topbar strong{color:#17212f}.content{max-width:1600px;margin:auto;padding:32px}.eyebrow{font-size:11px;font-weight:700;color:#727d8b;letter-spacing:1.5px;text-transform:uppercase}h1{font-size:30px;letter-spacing:-1px;margin:8px 0}h2{font-size:17px;letter-spacing:-.3px;margin:0 0 8px}h3{font-size:14px;margin:0 0 12px}.muted{color:#738092;font-size:12px;line-height:1.6}.heading{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:24px}.button,button{padding:10px 16px;border-radius:7px;border:1px solid #d9e0e8;background:white;cursor:pointer;text-decoration:none;font:600 12px system-ui;white-space:nowrap}.button.primary,button{background:#f4c925;border-color:#e6bc1e;color:#1a2029}.filters{display:flex;gap:14px;align-items:end;flex-wrap:wrap;background:white;border:1px solid #e2e7ed;padding:17px 20px;border-radius:10px;margin:20px 0}.filters label{display:flex;flex-direction:column;gap:7px;font-size:11px;color:#637184;font-weight:650}input,select{border:1px solid #dbe1e8;padding:9px 11px;border-radius:6px;background:#fff;font:12px system-ui;color:#243143;min-width:140px}.notice{border:1px solid #f0df9c;background:#fffae8;border-radius:9px;padding:14px 18px;color:#725d20;font-size:12px;line-height:1.7;margin:18px 0}.progress{height:5px;background:#e9e2c8;margin-top:10px;border-radius:10px;overflow:hidden}.progress i{display:block;height:100%;background:#d0a91c}.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:22px 0}.kpi{background:#fff;border:1px solid #e2e7ed;border-radius:10px;padding:20px}.kpi .label{font-size:11px;color:#738092;font-weight:650}.kpi strong{display:block;font-size:29px;letter-spacing:-1px;margin:12px 0 7px;overflow-wrap:anywhere}.kpi small{font-size:11px;color:#738092}.split{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(260px,1fr);gap:18px;margin:20px 0}.card{background:#fff;border:1px solid #e2e7ed;border-radius:10px;padding:22px;min-width:0;margin-bottom:18px}.card-head{display:flex;align-items:start;justify-content:space-between;gap:15px;margin-bottom:20px}.tag{font-size:10px;padding:5px 8px;border-radius:5px;background:#f0f3f7;color:#657184;font-weight:700}.chart svg{display:block;width:100%;height:210px}.chart-labels{display:flex;justify-content:space-between;font-size:10px;color:#8c98a7}.insight{padding:16px 0;border-bottom:1px solid #eef1f5}.insight:last-child{border-bottom:0}.insight b{font-size:13px;display:block;margin-bottom:5px}.insight p{font-size:12px;color:#738092;line-height:1.6;margin:0}.up{color:#12845c}.down{color:#ce4d4d}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px;white-space:nowrap}th{padding:13px 12px;text-align:left;color:#7a8696;font-size:10px;letter-spacing:.4px;text-transform:uppercase;background:#f8f9fb;border-top:1px solid #e7ebf0;border-bottom:1px solid #e7ebf0}td{padding:16px 12px;border-bottom:1px solid #edf0f4}td:first-child{white-space:normal;min-width:240px}td a{font-weight:650;text-decoration:none}td a:hover{text-decoration:underline}.sku{display:block;font-size:10px;color:#8b96a5;margin-top:4px}.abc{display:inline-block;border-radius:5px;padding:5px 9px;background:#f0f3f7;font-size:11px;font-weight:800}.abc.A{background:#e4f6ed;color:#19815b}.abc.B{background:#eaf0fe;color:#3f68b2}.abc.C{background:#fff2d6;color:#a3751c}.share{display:inline-block;width:55px;height:4px;background:#eef1f6;border-radius:5px;margin-left:5px;vertical-align:middle}.share i{height:4px;background:#5877c6;display:block;border-radius:5px}.footer{color:#8b96a6;font-size:10px;line-height:1.7;margin:20px 0}.empty{padding:40px;text-align:center;color:#738092}.legend{display:flex;gap:18px;font-size:11px;color:#738092}.legend i{display:inline-block;width:8px;height:8px;background:#4068ba;border-radius:50%;margin-right:5px}.legend i.previous{background:#b3bfd2}.bar-row{margin:18px 0;font-size:12px}.bar-row div:first-child{display:flex;justify-content:space-between;margin-bottom:8px}.bar-track{height:7px;background:#eef1f6;border-radius:5px}.bar-track i{height:100%;display:block;background:#557ac7;border-radius:5px}@media(min-width:1800px){.content{padding:40px}}@media(max-width:1100px){.layout{grid-template-columns:180px minmax(0,1fr)}.sidebar{padding:25px 13px}.content{padding:24px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.split{grid-template-columns:1fr}}@media(max-width:700px){.layout{display:block}.sidebar{position:static;width:100%;height:auto;padding:16px}.brand small,.section-label,.connection{display:none}.nav{display:flex;gap:5px;overflow:auto;margin-top:10px}.nav a{padding:8px;white-space:nowrap}.topbar{padding:16px}.content{padding:18px}.heading{align-items:start;flex-direction:column}h1{font-size:26px}.kpi{padding:16px}.kpi strong{font-size:23px}.filters{padding:14px}.filters label{flex:1}input,select{min-width:110px;max-width:100%}.card{padding:16px}}
`;
export function shell(body,{title='Análise de produtos',refresh=60,active='products'}={}){
 return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+(refresh?'<meta http-equiv="refresh" content="'+refresh+'">':'')+'<title>'+esc(title)+' · Casa Nissi</title><style>'+styles+'</style></head><body><div class="layout"><aside class="sidebar"><div class="brand">CASA <b>NISSI</b><small>INTELIGÊNCIA COMERCIAL</small></div><div class="section-label">ACOMPANHAMENTO</div><nav class="nav"><a class="'+(active==='overview'?'active':'')+'" href="/dashboard">Visão geral</a><a class="'+(active==='products'?'active':'')+'" href="/analises">Análise de produtos</a><a href="/pedidos">Pedidos</a><a href="/produtos">Catálogo Bling</a></nav><div class="section-label">FONTE DE DADOS</div><div class="connection"><strong>● Bling conectado</strong><br>Casa Nissi<br>Consulta de dados reais</div></aside><div class="workspace"><header class="topbar"><span>Operação / <strong>'+esc(title)+'</strong></span><span>Casa Nissi · Bling</span></header><main class="content">'+body+'<footer class="footer">Casa Nissi · Inteligência comercial · Valores em BRL · Horário de Brasília.<br>Mercado, visitas, conversão e Ads exigem fontes complementares. Custos e lucro não são inferidos.</footer></main></div></div></body></html>';
}
function growth(p){return p.previous>0?'<span class="'+(p.growth>=0?'up':'down')+'">'+(p.growth>=0?'+':'')+pct(p.growth)+'</span>':p.current>0?'<span class="tag">Sem base anterior</span>':'—';}
function dailyChart(product,range,days){
 const entries=Array.from({length:days},(_,i)=>{const d=new Date(range.start+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+i);return d.toISOString().slice(0,10);});
 const values=entries.map(d=>product.daily.get(d)||0),max=Math.max(1,...values),step=900/days;
 return '<div class="chart"><svg viewBox="0 0 900 210" role="img" aria-label="Valor diário dos itens"><line x1="0" x2="900" y1="190" y2="190" stroke="#e8ecf2"/>'+values.map((v,i)=>'<rect x="'+(i*step+2)+'" y="'+(190-v/max*170)+'" width="'+Math.max(1,step-4)+'" height="'+v/max*170+'" fill="#4973c2" rx="2"><title>'+entries[i]+': '+money(v)+'</title></rect>').join('')+'</svg><div class="chart-labels"><span>'+range.start+'</span><span>'+range.end+'</span></div></div>';
}
export function renderAnalytics(state,url,now=Date.now()){
 const days=Number(url.searchParams.get('dias')||30),job=state.job||state.active;
 if(!job)return shell('<h1>Iniciando consulta</h1>',{refresh:10});
 if(state.busy)return shell('<h1>Importação em andamento</h1><div class="notice">Outra janela está consultando os itens. Esta tela tentará carregar seu período novamente em 15 segundos.</div>',{refresh:15});
 const store=url.searchParams.get('loja')||'',status=url.searchParams.get('situacao')||'',search=url.searchParams.get('busca')||'';
 const a=aggregate(job.orders,job.range,{store,status,search}),complete=job.finished&&job.listComplete&&!job.failed&&!job.error;
 const options=(values,current,prefix)=>values.map(v=>'<option value="'+esc(v)+'" '+(String(v)===current?'selected':'')+'>'+prefix+esc(v)+'</option>').join('');
 const stores=[...new Set(job.orders.map(o=>o.store))].sort(),statuses=[...new Set(job.orders.map(o=>o.status))].sort();
 const filters='<form class="filters" method="get" action="/analises"><label>Período<select name="dias">'+[7,30,90].map(v=>'<option value="'+v+'" '+(days===v?'selected':'')+'>'+v+' dias</option>').join('')+'</select></label><label>Canal no Bling<select name="loja"><option value="">Todos os canais</option>'+options(stores,store,'Canal #')+'</select></label><label>Situação do pedido<select name="situacao"><option value="">Todas as situações</option>'+options(statuses,status,'Situação #')+'</select></label><label>Produto ou SKU<input name="busca" value="'+esc(search)+'" placeholder="Pesquisar produto"></label><button>Aplicar filtros</button></form>';
 const progress=job.total?Math.min(100,job.processed/job.total*100):0;
 const notice=complete?'':'<div class="notice"><strong>'+esc(job.phase)+'</strong> · '+job.processed+' de '+job.total+' pedidos detalhados.'+(job.failed?' '+job.failed+' pedidos indisponíveis.':'')+(!job.listComplete&&job.finished?' Limite de 4.000 pedidos atingido ou listagem incompleta.':'')+'<br>Indicadores provisórios: aguarde a carga terminar para comparar produtos e interpretar a curva ABC.<div class="progress"><i style="width:'+progress+'%"></i></div></div>';
 const kpi=(label,value,sub)=>'<article class="kpi"><span class="label">'+label+'</span><strong>'+value+'</strong><small>'+sub+'</small></article>';
 const linkParams=new URLSearchParams({dias:String(days),loja:store,situacao:status});
 const selected=a.products.find(p=>p.key===url.searchParams.get('produto'));
 const selectedParams=new URLSearchParams(linkParams);if(selected)selectedParams.set('produto',selected.key);
 const heading='<div class="heading"><div><div class="eyebrow">Inteligência de vendas</div><h1>'+(selected?esc(selected.name):'Desempenho dos produtos')+'</h1><div class="muted">'+job.range.start+' a '+job.range.end+' · Comparação: '+job.range.previousStart+' a '+job.range.previousEnd+'</div></div><a class="button primary" href="/analises?'+esc(selectedParams)+'">Atualizar análise</a></div>';
 const methodology='<p class="muted">Valor dos itens = quantidade × valor unitário retornado pelo Bling. Frete não é somado; descontos adicionais do pedido não são rateados aqui. Inclui as situações selecionadas, sem presumir pagamento. Kits contam como unidades comerciais. Comparação inclui o dia de hoje ainda em andamento.</p>';
 if(selected){
  const channels=[...selected.channels].sort((x,y)=>y[1]-x[1]);
  const content=heading+notice+'<a class="button" href="/analises?'+esc(linkParams)+'">← Todos os produtos</a><section class="kpis">'+kpi('Valor dos itens',money(selected.current),'Período selecionado')+kpi('Unidades comerciais',num(selected.units),selected.orders.size+' pedidos')+kpi('Preço médio vendido',selected.average===null?'—':money(selected.average),'Valor dos itens ÷ unidades')+kpi('Variação do valor',growth(selected),'Anterior: '+money(selected.previous))+'</section><section class="split"><article class="card"><div class="card-head"><div><h2>Curva diária do produto</h2><div class="muted">SKU '+esc(selected.sku||'não informado')+'</div></div><span class="abc '+selected.abc+'">Classe '+selected.abc+'</span></div>'+dailyChart(selected,job.range,days)+'</article><article class="card"><h2>Participação por canal</h2>'+channels.map(([k,v])=>'<div class="bar-row"><div><span>Canal '+esc(k)+'</span><strong>'+money(v)+'</strong></div><div class="bar-track"><i style="width:'+(selected.current?v/selected.current*100:0)+'%"></i></div></div>').join('')+'</article></section>'+methodology;
  return shell(content,{title:'Produto',refresh:job.finished?60:15});
 }
 const sumProduct={daily:new Map()};for(const p of a.products)for(const [d,v] of p.daily)sumProduct.daily.set(d,(sumProduct.daily.get(d)||0)+v);
 const rising=a.products.filter(p=>p.previous>0&&p.growth>0).sort((x,y)=>y.growth-x.growth)[0];
 const falling=a.products.filter(p=>p.previous>0&&p.growth<0).sort((x,y)=>x.growth-y.growth)[0];
 const insights='<div class="insight"><b>Concentração em 5 produtos</b><p>'+pct(a.topShare)+' do valor dos itens no período. Acompanhe a dependência dos produtos líderes.</p></div><div class="insight"><b>Maior crescimento na seleção</b><p>'+(rising?esc(rising.name)+' · '+pct(rising.growth):'Sem comparação positiva disponível.')+'</p></div><div class="insight"><b>Maior queda na seleção</b><p>'+(falling?esc(falling.name)+' · '+pct(falling.growth):'Sem comparação negativa disponível.')+'</p></div>';
 const rows=a.products.map(p=>{const params=new URLSearchParams(linkParams);params.set('produto',p.key);return '<tr><td><a href="/analises?'+esc(params)+'">'+esc(p.name)+'</a><span class="sku">'+esc(p.sku||'Sem SKU · '+p.key)+'</span></td><td>'+num(p.units)+'</td><td>'+p.orders.size+'</td><td>'+money(p.current)+'</td><td>'+(p.average===null?'—':money(p.average))+'</td><td>'+pct(p.share)+'<span class="share"><i style="width:'+(p.share*100)+'%"></i></span></td><td>'+growth(p)+'</td><td><span class="abc '+p.abc+'">'+p.abc+'</span></td></tr>';}).join('');
 const content=heading+filters+notice+'<section class="kpis">'+kpi('Valor dos itens',money(a.total),'Anterior: '+money(a.previous))+kpi('Unidades comerciais',num(a.units),a.orders+' pedidos com itens válidos')+kpi('Produtos com vendas',String(a.active),'Identificados por produto ou SKU')+kpi('Variação entre períodos',a.previous?'<span class="'+(a.total>=a.previous?'up':'down')+'">'+pct((a.total-a.previous)/a.previous)+'</span>':'—',complete?'Base completa consultada':'Base em carregamento')+'</section><section class="split"><article class="card"><div class="card-head"><div><h2>Evolução diária</h2><div class="muted">Valor dos itens da seleção de produtos</div></div><span class="tag">BRL</span></div>'+dailyChart(sumProduct,job.range,days)+'</article><article class="card"><h2>Pontos de atenção'+(!complete?' · provisórios':'')+'</h2>'+insights+'</article></section><article class="card"><div class="card-head"><div><h2>Ranking e curva ABC</h2><div class="muted">Clique em um produto para abrir sua curva de crescimento.</div></div><span class="tag">'+a.products.length+' produtos na busca</span></div><div class="table-wrap"><table><thead><tr><th>Produto / SKU</th><th>Unidades</th><th>Pedidos</th><th>Valor dos itens</th><th>Preço médio</th><th>Participação</th><th>Variação</th><th>ABC</th></tr></thead><tbody>'+(rows||'<tr><td colspan="8" class="empty">'+(job.finished?'Nenhum item corresponde aos filtros.':'Os produtos aparecerão conforme os pedidos forem detalhados.')+'</td></tr>')+'</tbody></table></div><p class="muted">ABC por valor dos itens: A até aproximadamente 80% do acumulado; B até 95%; C restante. O produto que cruza um limite permanece na classe anterior. A busca não recalcula as classes.</p></article>'+methodology+(a.skipped?'<div class="notice">'+a.skipped+' itens com quantidade ou preço inválidos ficaram fora dos cálculos.</div>':'')+'<article class="card"><h2>Próximas análises</h2><p class="muted">Cobertura de estoque, produtos sem giro e margem exigem conciliação com cadastro, saldos e custos. Não são calculados com dados ausentes. Visitas, conversão e Ads serão tratados na futura aba Mercado Livre.</p></article>';
 return shell(content,{refresh:job.finished?60:15});
}
