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
try{
 const page=await browser.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 await page.addInitScript(()=>{let api;Object.defineProperty(window,'OAUniMap',{configurable:true,get:()=>api,set:v=>{api=v;const mount=v.mount;v.mount=cfg=>(window.testMap=mount(cfg));}});});
 await page.goto(base+'/universities?view=map',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.testMap&&testMap.shown().length>700);
 const result=await page.evaluate(()=>{
  let cluster;testMap.map.eachLayer(l=>{if(l instanceof L.MarkerClusterGroup)cluster=l;});
  const markers=cluster.getLayers(),differentAddresses=[],sharedExtras=[],insead=[],failures=[];
  const fold=s=>(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
  for(const m of markers){
   m.fire('click');
   const pop=testMap.map._popup.getContent(),shared=m.oaPoint.address||'';
   if(!pop)throw Error('Card did not open: '+m.oaCard.institution);
   const rows=[...pop.querySelectorAll('.oa-map-department')];
   const extraLinks=[...pop.querySelectorAll('.oa-map-extra-locations a')].map(a=>fold(a.textContent));
   if(new Set(extraLinks).size!==extraLinks.length)failures.push('Extra address repeated across departments: '+m.oaCard.institution);
   for(const details of pop.querySelectorAll('.oa-map-extra-locations')){
    if(!details.closest('.oa-map-department'))sharedExtras.push({university:m.oaCard.institution,addresses:[...details.querySelectorAll('a')].map(a=>a.textContent)});
   }
   for(const row of rows){
    const details=row.querySelector('details');if(!details)continue;
    const links=[...details.querySelectorAll('a')],labels=links.map(a=>fold(a.textContent));
    if(!links.length)failures.push('Empty department location: '+m.oaCard.institution);
    if(new Set(labels).size!==labels.length)failures.push('Repeated department address: '+m.oaCard.institution);
    for(const a of links){
     if(shared&&fold(a.textContent).endsWith(fold(shared)))failures.push('Repeats shared address: '+m.oaCard.institution);
     if(a.textContent.trim()){
      const v=m.oaPoint.locationSources.find(v=>a.textContent.includes((v.sourceLocation||v).address));
      const loc=v&&(v.sourceLocation||v);
      differentAddresses.push({university:m.oaCard.institution,department:row.querySelector('.oa-map-department-name').textContent,shared,address:a.textContent,building:m.oaPoint.building,sourceBuilding:loc?.building,distance:loc&&Number.isFinite(loc.lat)&&Number.isFinite(loc.lng)?Math.round(L.latLng(loc.lat,loc.lng).distanceTo(m.getLatLng())):null});
     }
    }
   }
   if(/One school across four locations|School location; department office not separately verified/.test(pop.textContent))failures.push('Redundant context: '+m.oaCard.institution);
   if(/INSEAD/.test(m.oaCard.institution)){
    if(rows.length!==2||rows.some(r=>r.children.length!==1||!r.querySelector('.oa-map-department-name a[href]')))failures.push('INSEAD should show only two linked department names: '+rows.map(r=>r.outerHTML).join(''));
    if(pop.querySelectorAll('.oa-map-address a').length!==1)failures.push('INSEAD should have one shared address');
    insead.push(m.oaPoint.campusLabel||m.oaPoint.label);
   }
  }
  testMap.map.closePopup();
  return {cards:markers.length,insead,differentAddresses,sharedExtras,failures};
 });
 console.log(JSON.stringify(result,null,2));
 assert.deepEqual(result.failures,[]);assert.equal(result.insead.length,4);
 assert.ok(result.differentAddresses.some(r=>/Dublin/.test(r.university)&&/Belfield/.test(r.address)),'retain the separate verified Dublin faculty office');
 assert.ok(!result.differentAddresses.some(r=>/Rutgers/.test(r.university)),'country suffix alone must not create a second address');
 assert.ok(result.sharedExtras.some(r=>/Purdue/.test(r.university)&&r.addresses.length===2),'show shared additional school buildings once');
 assert.deepEqual(errors,[]);
}finally{await browser.close();await new Promise(r=>server.close(r));}
