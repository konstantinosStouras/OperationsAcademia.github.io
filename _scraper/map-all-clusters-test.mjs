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
 for(const width of (process.env.MAP_TEST_WIDTHS||'1280,390,320').split(',').map(Number)){
  const page=await browser.newPage({viewport:{width,height:Number(process.env.MAP_TEST_HEIGHT||900)},isMobile:width<600,hasTouch:width<600,reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  await page.addInitScript(()=>{let api;Object.defineProperty(window,'OAUniMap',{configurable:true,get:()=>api,set:v=>{api=v;const mount=v.mount;v.mount=cfg=>(window.testMap=mount(cfg));}});});
  await page.goto(base+'/universities?view=map',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.testMap&&testMap.shown().length>700);
  const inventory=await page.evaluate(()=>{
   const map=testMap.map;let cluster;map.eachLayer(l=>{if(l instanceof L.MarkerClusterGroup)cluster=l;});
   const unique=new Map();
   function walk(c){if(c.getChildCount()>1){const all=c.getAllChildMarkers();const key=all.map(m=>L.stamp(m)).sort((a,b)=>a-b).join(',');unique.set(key,all);}c._childClusters.forEach(walk);}
   cluster._topClusterLevel._childClusters.forEach(walk);
   window.audit={cluster,groups:[...unique.values()],coordinates:cluster.getLayers().map(m=>[m,m.getLatLng().lat,m.getLatLng().lng])};
   return {groups:audit.groups.length,largest:Math.max(...audit.groups.map(g=>g.length)),locations:audit.coordinates.length};
  });
  let focusedGroups=0;
  for(let start=0;start<(process.env.MAP_SKIP_AUDIT?0:inventory.groups);start+=25){
   const result=await page.evaluate(({start,end})=>{
    const {cluster,groups,coordinates}=audit,map=testMap.map;let focused=0;
    const fail=message=>{throw Error(message);};
    for(let index=start;index<Math.min(end,groups.length);index++){
     map.fire('click');const all=groups[index];
     cluster.fire('clusterclick',{layer:{getAllChildMarkers:()=>all}});
     if(document.querySelector('.oa-map-expanded-panel'))fail('scrollable list returned');
     const expanded=coordinates.map(([m])=>m).filter(m=>!cluster.hasLayer(m)),remaining=all.filter(m=>cluster.hasLayer(m));
     if(!expanded.length)fail('no logos revealed '+index);
     if(remaining.length)focused++;
     const rect=map.getContainer().getBoundingClientRect();
     const boxes=expanded.map(m=>{
      const e=m.getElement();if(!e?.isConnected)fail('missing logo group '+index);
      if(!e.getAttribute('aria-label'))fail('missing accessible label');
      const b=e.getBoundingClientRect();if(b.left<rect.left||b.right>rect.right||b.top<rect.top||b.bottom>rect.bottom)fail('offscreen logo '+index);
      if(b.width<44||b.height<44)fail('touch target shrunk');
      return b;
     });
     for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)fail('overlapping logos '+index+' count '+expanded.length);}
     // Every location in the focused central viewport is a logo; only those
     // outside that geographic area may remain in the normal cluster layer.
     for(const [m] of coordinates){if(!cluster.hasLayer(m))continue;const p=map.latLngToContainerPoint(m.getLatLng());if(p.x>0&&p.x<map.getSize().x&&p.y>0&&p.y<map.getSize().y)fail('nearby location left grouped '+index);}
     if(all.some(m=>!cluster.hasLayer(m)&&!expanded.includes(m)))fail('location lost');
     map.fire('click');
     if(coordinates.some(([m,lat,lng])=>m.getLatLng().lat!==lat||m.getLatLng().lng!==lng||!cluster.hasLayer(m)))fail('restoration failed');
     if(!map.doubleClickZoom.enabled())fail('map gesture not restored');
    }
    return focused;
   },{start,end:start+25});focusedGroups+=result;
  }
  console.log(JSON.stringify({width,...inventory,focusedGroups,status:process.env.MAP_SKIP_AUDIT?'Interaction smoke checks; full audit skipped':'Every unique cluster membership across all zoom levels passed'}));
  // Large groups must stay on the map and reveal usable logos on one tap.
  await page.evaluate(()=>testMap.map.setView([20,0],0,{animate:false}));
  const largest=await page.locator('.oa-map-cluster').evaluateAll(nodes=>Math.max(...nodes.map(n=>Number(n.textContent))));
  const dense=page.locator('.oa-map-cluster').filter({hasText:new RegExp('^'+largest+'$')}).first();
  if(width<600)await dense.tap();else await dense.click();
  await page.waitForFunction(()=>audit.coordinates.some(([m])=>!audit.cluster.hasLayer(m)&&m.getElement()?.isConnected));
  assert.equal(await page.locator('.oa-map-expanded-panel').count(),0);
  const denseState=await page.evaluate(()=>{
   const selected=audit.coordinates.filter(([m])=>!audit.cluster.hasLayer(m));
   const member=selected[Math.floor(selected.length/2)][0];member.getElement().dataset.testCard=member.oaCard.id;
   return {count:selected.length,id:member.oaCard.id,zoom:testMap.map.getZoom()};
  });
  assert.ok(denseState.count>1&&denseState.zoom>0,'large group zooms and reveals multiple logos');
  if(process.env.MAP_SCREENSHOTS)await page.locator('.oa-uni-map').screenshot({path:path.join(process.env.MAP_SCREENSHOTS,'map-only-group-'+width+'.png')});
  const logo=page.locator('[data-test-card]');
  if(width<600)await logo.tap();else await logo.click();
  assert.equal(await page.locator('.oa-uni-pop').getAttribute('data-map-card-id'),denseState.id);
  await page.locator('.leaflet-popup-close-button').click();await page.waitForSelector('.oa-map-popup',{state:'detached'});
  await page.getByRole('button',{name:'Reset map to selected continent'}).click();
  assert.equal(await page.evaluate(()=>audit.coordinates.filter(([m])=>!audit.cluster.hasLayer(m)).length),0);
  await page.emulateMedia({reducedMotion:'no-preference'});
  // Real pointer/touch events exercise search, bubbling, animation and all cards.
  for(const query of ['Northw','University of Chicago','Chicago']){
   await page.goto(base+'/universities?view=map&filterA='+encodeURIComponent(query),{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.testMap&&testMap.shown().length>0);
   if(await page.evaluate(()=>testMap.shown().length===1)){
    await page.waitForSelector('.oa-map-popup');
    console.log(query+': single location opens directly at '+width+'px');continue;
   }
   const count=await page.evaluate(()=>testMap.shown().length);
   await page.waitForFunction(count=>document.querySelectorAll('.oa-map-logo').length>=count,count);
   assert.equal(await page.locator('.oa-map-cluster').count(),0,query+' expands automatically without a bubble click');
   for(let i=0;i<count;i++){
    const logo=page.locator('.oa-map-logo').nth(i);
    if(width<600)await logo.tap();else await logo.click();
    await page.waitForSelector('.oa-map-popup');
    if(width<600)await page.locator('.leaflet-popup-close-button').tap();else await page.locator('.leaflet-popup-close-button').click();
    await page.waitForSelector('.oa-map-popup',{state:'detached'});
   }
   console.log(query+': '+count+' logos revealed automatically and cards accessible at '+width+'px');
  }
  assert.deepEqual(errors,[]);await page.close();
 }
}finally{await browser.close();await new Promise(r=>server.close(r));}

