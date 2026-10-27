import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require('playwright'),assert=require('node:assert/strict');
const root=path.resolve(import.meta.dirname,'..');
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.geojson':'application/json','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
 let file=path.join(root,decodeURIComponent(req.url.split('?')[0]));
 if(!fs.existsSync(file)&&!path.extname(file))file+='.html';
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
 res.setHeader('content-type',types[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=process.env.MAP_TEST_BASE||'http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,...(process.env.PW_CHROMIUM?{executablePath:process.env.PW_CHROMIUM}:{})});

async function checkLogos(page,count){
 await page.waitForFunction(count=>window.testMap&&testMap.shown().length===count&&document.querySelectorAll('.oa-map-logo').length===count,count);
 await page.waitForTimeout(350);
 assert.equal(await page.locator('.oa-map-cluster').count(),0,'search reveals logos without a click');
 const layout=await page.evaluate(()=>{
  const map=document.querySelector('.oa-uni-map').getBoundingClientRect();
  return {map:{left:map.left,right:map.right,top:map.top,bottom:map.bottom},boxes:[...document.querySelectorAll('.oa-map-logo')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})};
 });
 for(const a of layout.boxes){assert.ok(a.left>=layout.map.left&&a.right<=layout.map.right&&a.top>=layout.map.top&&a.bottom<=layout.map.bottom,'logo fits map');for(const b of layout.boxes)if(a!==b)assert.ok(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top,'logos stay separate');}
}
try{
 for(const width of [1280,390,320]){
  const page=await browser.newPage({viewport:{width,height:780},isMobile:width<600,hasTouch:width<600}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  await page.addInitScript(()=>{let api;Object.defineProperty(window,'OAUniMap',{configurable:true,get:()=>api,set:v=>{api=v;const mount=v.mount;v.mount=cfg=>(window.testMap=mount(cfg));}});});
  await page.goto(base+'/universities?view=map',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.testMap&&testMap.shown().length>700);
  const search=page.locator('#oaf-university');
  await search.fill('Northw');await checkLogos(page,4);
  assert.ok(await search.evaluate(e=>document.activeElement===e),'typing keeps focus in search');
  const before=await page.evaluate(()=>testMap.shown().map(p=>[p.card.id,p.lat,p.lng]));
  // Resize should recalculate logo spacing, including phone rotation.
  await page.setViewportSize({width:width<600?568:1100,height:width<600?390:700});await checkLogos(page,4);
  assert.deepEqual(await page.evaluate(()=>testMap.shown().map(p=>[p.card.id,p.lat,p.lng])),before);
  await page.setViewportSize({width,height:780});await checkLogos(page,4);
  const logo=page.locator('.oa-map-logo').first();if(width<600)await logo.tap();else await logo.click();
  await page.waitForSelector('.oa-map-popup');
  await page.setViewportSize({width,height:700});await page.waitForTimeout(350);
  assert.equal(await page.locator('.oa-map-popup').count(),1,'resize preserves open school card');
  await page.locator('.leaflet-popup-close-button').click();await page.waitForSelector('.oa-map-popup',{state:'detached'});
  await checkLogos(page,4);
  // User navigation must remain in place on an unchanged-data refresh.
  await page.evaluate(()=>testMap.map.setZoom(4,{animate:false}));
  await page.evaluate(()=>testMap.refresh());assert.equal(await page.evaluate(()=>testMap.map.getZoom()),4);
  await search.fill('University of Chicago');await checkLogos(page,1);
  await search.fill('zzzz-no-university-matches');await page.waitForFunction(()=>testMap.shown().length===0);
  assert.equal(await page.locator('.oa-map-logo').count(),0,'no stale search markers');
  await search.fill('');await page.waitForFunction(()=>testMap.shown().length>700);
  assert.ok(await page.locator('.oa-map-cluster').count()>0,'clearing search returns world overview');
  for(const query of ['Northw','University of Illinois at Urbana-Champaign','INSEAD']){
   await page.goto(base+'/universities?view=map&filterA='+encodeURIComponent(query),{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.testMap&&testMap.shown().length>0);
   await checkLogos(page,await page.evaluate(()=>testMap.shown().length));
  }
  // A job's department deep link still opens its specific card immediately.
  const jobLink='/universities?view=map&filterA='+encodeURIComponent('University of Illinois at Urbana-Champaign')+'&focus=department&school='+encodeURIComponent('Gies College of Business')+'&department='+encodeURIComponent('Information Systems, Operations Management, Supply Chain Management, and Analytics');
  await page.goto(base+jobLink,{waitUntil:'domcontentloaded'});await page.waitForSelector('.oa-map-popup');
  assert.match(await page.locator('.oa-map-popup').innerText(),/Gies College of Business/);
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();
  await search.fill('Northw');await checkLogos(page,4);
  assert.equal(await page.locator('.oa-map-popup').count(),0,'a new search supersedes the job card');
  assert.deepEqual(errors,[]);console.log('Automatic typed and linked searches, resize, manual navigation, empty results, and department links passed at '+width+'px');await page.close();
 }
}finally{await browser.close();await new Promise(r=>server.close(r));}
