import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const root=path.resolve(import.meta.dirname,'..');
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.geojson':'application/json','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
 let file=path.join(root,decodeURIComponent(req.url.split('?')[0]));
 if(!fs.existsSync(file)&&!path.extname(file))file+='.html';
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
 res.setHeader('content-type',types[path.extname(file)]||'application/octet-stream');
 fs.createReadStream(file).pipe(res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,...(process.env.PW_CHROMIUM?{executablePath:process.env.PW_CHROMIUM}:{})});


const assert=require('node:assert/strict');
try{
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900},isMobile:width===390,hasTouch:width===390});const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  await page.addInitScript(()=>{let api;Object.defineProperty(window,'OAUniMap',{configurable:true,get:()=>api,set:v=>{api=v;const mount=v.mount;v.mount=cfg=>(window.testMap=mount(cfg));}});});
  await page.goto(base+'/universities?view=map&filterA=Northw',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.testMap&&testMap.shown().length===4);
  const originals=await page.evaluate(()=>testMap.shown().map(p=>({id:p.card.id,lat:p.lat,lng:p.lng})));
  assert.equal(await page.locator('.oa-map-cluster').innerText(),'4');
  for(const keyboard of [false,true]){
   const group=page.locator('.oa-map-cluster');await group.scrollIntoViewIfNeeded();
   if(keyboard){await group.focus();await page.keyboard.press('Enter');}else await group.click();
   await page.waitForFunction(()=>document.querySelectorAll('.oa-map-logo').length===4&&document.querySelectorAll('.oa-map-cluster').length===0);
   await page.waitForTimeout(350);
   const state=await page.evaluate(()=>{
    const map=document.querySelector('.oa-uni-map').getBoundingClientRect();
    return {zoom:testMap.map.getZoom(),logos:[...document.querySelectorAll('.oa-map-logo')].map(e=>{const r=e.getBoundingClientRect();return {label:e.getAttribute('aria-label'),left:r.left-map.left,right:r.right-map.left,top:r.top-map.top,bottom:r.bottom-map.top};}),width:map.width,height:map.height};
   });
   assert.ok(state.logos.every(r=>r.label),'all four logos have accessible labels');
   const cardIds=await page.evaluate(()=>{const ids=[];testMap.map.eachLayer(m=>{if(m.oaCard&&m.getElement()?.isConnected)ids.push(m.oaCard.id);});return ids;});
   assert.equal(new Set(cardIds).size,4,'four distinct school-location cards are visible');
   for(const a of state.logos){assert.ok(a.left>=0&&a.right<=state.width&&a.top>=0&&a.bottom<=state.height,'logo stays in map');for(const b of state.logos)if(a!==b)assert.ok(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top,'logos do not overlap');}
   assert.deepEqual(await page.evaluate(()=>testMap.shown().map(p=>({id:p.card.id,lat:p.lat,lng:p.lng}))),originals,'expansion preserves real coordinates');
   for(let i=0;i<4;i++){await page.locator('.oa-map-logo').nth(i).click();await page.waitForSelector('.oa-map-popup');await page.locator('.leaflet-popup-close-button').click();await page.waitForSelector('.oa-map-popup',{state:'detached'});}
   await page.getByRole('button',{name:'Reset map to selected continent'}).click();
   await page.waitForFunction(()=>document.querySelectorAll('.oa-map-cluster').length===1&&document.querySelector('.oa-map-cluster').textContent==='4');
  }
  // A filter change must discard expanded markers from the prior result set.
  await page.locator('.oa-map-cluster').click();await page.waitForFunction(()=>document.querySelectorAll('.oa-map-logo').length===4);
  await page.locator('#oaf-dept').fill('McCormick');
  await page.waitForFunction(()=>testMap.shown().length===1&&document.querySelectorAll('.oa-map-logo').length===1);
  assert.deepEqual(errors,[]);console.log('One-click group expansion, keyboard, four cards, reset and filtering passed at '+width+'px');await page.close();
 }
}finally{await browser.close();await new Promise(r=>server.close(r));}
