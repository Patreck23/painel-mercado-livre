import { createServer } from 'node:http';

// Bootstrap only. OAuth and persistent token storage must be configured before
// enabling authorization. Never log request URLs, authorization codes or secrets.
export function handler(req, res) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  };
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {...headers, Allow: 'GET, HEAD'}); res.end(); return;
  }
  if (path === '/health') {
    res.writeHead(200, {...headers, 'Content-Type': 'application/json'});
    res.end(req.method === 'HEAD' ? '' : JSON.stringify({service:'casa-nissi-bling',status:'ok',blingConnected:false}));
    return;
  }
  const callback = path === '/auth/bling/callback';
  if (path !== '/' && !callback) { res.writeHead(404, headers); res.end('Não encontrado'); return; }
  res.writeHead(callback ? 503 : 200, headers);
  res.end(req.method === 'HEAD' ? '' : '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Casa Nissi · Integração Bling</title><body style="font:18px system-ui;max-width:650px;margin:60px auto;padding:24px"><h1>Casa Nissi · Integração Bling</h1><p>Servidor inicial disponível.</p><p>A conexão com o Bling ainda não foi configurada. Nenhum código de autorização foi processado e nenhum dado da empresa está disponível neste endereço.</p></body></html>');
}
if (process.env.NODE_ENV !== 'test') {
  createServer(handler).listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Servidor disponível'));
}
