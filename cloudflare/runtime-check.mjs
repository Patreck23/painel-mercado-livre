import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.worker-test/worker.js',compatibilityDate:'2026-11-03',compatibilityFlags:['nodejs_compat'],durableObjects:{DASHBOARD:{className:'CasaNissiDashboard',useSQLite:true}}}));
try{
 const health=await mf.dispatchFetch('https://painel.example.workers.dev/health');assert.equal(health.status,200);assert.equal((await health.json()).version,'2.1.0-cloudflare');
 const home=await mf.dispatchFetch('https://painel.example.workers.dev/');assert.equal(home.status,200);assert.ok(home.headers.get('Content-Security-Policy').includes('img-src https:'));assert.ok((await home.text()).includes('O seu dia, em dois lugares.'));
 const setup=await mf.dispatchFetch('https://painel.example.workers.dev/mercado-livre');assert.equal(setup.status,200);const html=await setup.text();assert.ok(html.includes('Ativar a conexão'));assert.ok(html.includes('https://painel.example.workers.dev/auth/mercado-livre/callback'));assert.ok(!html.includes('● Bling conectado'));
 console.log('Worker runtime: SQLite binding, routing, setup and dynamic callback passed.');
}finally{await mf.dispose();}
