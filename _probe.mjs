import http from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.woff':'font/woff', '.woff2':'font/woff2' };
const server = http.createServer((req,res)=>{
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/,'');
  let file = path.join(ROOT, rel);
  if(!file.startsWith(ROOT)){res.writeHead(403).end();return;}
  if(existsSync(file)&&statSync(file).isDirectory()) file=path.join(file,'index.html');
  if(!existsSync(file)){res.writeHead(404).end('nf');return;}
  res.writeHead(200,{'content-type':TYPES[path.extname(file)]||'application/octet-stream'});
  createReadStream(file).pipe(res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}/`;
const SHIM = readFileSync(path.join(ROOT,'_scraper','_fake-firebase.js'),'utf8');
const { chromium } = await import('playwright');
const browser = await chromium.launch({ args:['--no-sandbox'],
  executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium',
  proxy:{ server:'http://127.0.0.1:1', bypass:'<-loopback>,127.0.0.1,localhost' } });

export async function open(url, { seed, dialogs, blockFb } = {}) {
  const q = await browser.newPage({ viewport:{width:1280,height:1000} });
  const errs = [], logs = [];
  q.on('pageerror', e=>errs.push('PAGEERROR: '+e.message));
  q.on('console', m=>{ if(m.type()==='error'||m.type()==='warning') logs.push(m.type()+': '+m.text()); });
  if (dialogs) q.on('dialog', dialogs);
  if (seed) await q.addInitScript(`window.__FAKE_FB = ${JSON.stringify(seed)};`);
  await q.route('**/firebasejs/**', r => blockFb ? r.abort()
    : r.fulfill({status:200,contentType:'application/javascript',body:SHIM}));
  await q.route('**tile.openstreetmap.org**', r=>r.abort());
  await q.goto(BASE+url, { waitUntil:'domcontentloaded' });
  return { q, errs, logs };
}
export const close = async () => { await browser.close(); server.close(); };
export { BASE };
