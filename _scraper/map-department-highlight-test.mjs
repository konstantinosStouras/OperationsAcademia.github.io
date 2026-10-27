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


async function openFirst(page){
 await page.waitForFunction(()=>window.testMap&&testMap.shown().length===4&&document.querySelectorAll('.oa-map-logo').length===4);
 await page.waitForTimeout(350);
 const logo=page.locator('.oa-map-logo').first();if(page.viewportSize().width<600)await logo.tap();else await logo.click();
 await page.waitForSelector('.oa-map-popup');
}
async function matches(page,names){
 const pop=page.locator('.oa-map-popup'),selected=pop.locator('.oa-map-department.oa-map-selected-department');
 assert.equal(await selected.count(),names.length);
 const actual=await selected.locator('.oa-map-department-name').allTextContents();
 assert.deepEqual(actual.slice().sort(),names.slice().sort());
 for(const name of names){
  const row=selected.filter({has:page.locator('.oa-map-department-name',{hasText:name})});
  assert.equal(await row.locator('.oa-map-match-label').innerText(),'Matches your search');
  assert.match(await row.locator('a').first().getAttribute('href'),/^https?:\/\//,'faculty link remains usable');
 }
 if(names.length)assert.equal(await pop.locator('.oa-map-department').first().evaluate(e=>e.classList.contains('oa-map-selected-department')),true,'matching departments appear first');
 if(names.length)await visibleMatch(page);
}
async function visibleMatch(page){
 await page.waitForFunction(()=>{
  const row=document.querySelector('.oa-map-popup .oa-map-department.oa-map-selected-department');
  if(!row)return false;
  const box=row.closest('.leaflet-popup-content').getBoundingClientRect(),label=row.querySelector('.oa-map-match-label').getBoundingClientRect(),name=row.querySelector('.oa-map-department-name').getBoundingClientRect();
  return label.top>=box.top-1&&name.bottom<=box.bottom+1;
 },null,{timeout:5000});
}
try{
 for(const width of (process.env.MAP_TEST_WIDTHS||'1280,390,320').split(',').map(Number)){
  const height=Number(process.env.MAP_TEST_HEIGHT||780);
  const page=await browser.newPage({viewport:{width,height},isMobile:width<600,hasTouch:width<600}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  await page.addInitScript(()=>{let api;Object.defineProperty(window,'OAUniMap',{configurable:true,get:()=>api,set:v=>{api=v;const mount=v.mount;v.mount=cfg=>(window.testMap=mount(cfg));}});});
  const insead=base+'/universities?view=map&filterA=INSEAD';
  await page.goto(insead,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.testMap&&testMap.shown().length===4);
  const input=page.locator('#oaf-dept');
  await input.fill('Decision');await openFirst(page);await matches(page,['Decision Sciences']);
  assert.equal(await page.locator('.oa-map-popup .oa-map-department').count(),2,'other departments remain on the card');
  await input.fill('Technology and Operations');await page.waitForSelector('.oa-map-popup',{state:'detached'});await openFirst(page);
  await matches(page,['Technology and Operations Management']);
  // Readability in both themes and a touch-sized faculty link.
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
   const style=await page.locator('.oa-map-popup .oa-map-selected-department').evaluate(e=>{
    const c=getComputedStyle(e),label=e.querySelector('.oa-map-match-label'),a=e.querySelector('a');
    const rgb=s=>s.match(/[\d.]+/g).slice(0,3).map(Number);
    const luminance=s=>rgb(s).map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4);}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const bg=luminance(c.backgroundColor),contrast=node=>{const fg=luminance(getComputedStyle(node).color);return (Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05);};
    return {labelContrast:contrast(label),linkContrast:contrast(a),border:parseFloat(c.borderLeftWidth),touchHeight:a.getBoundingClientRect().height};
   });
   assert.ok(style.labelContrast>=4.5&&style.linkContrast>=4.5,theme+' highlight text remains readable');assert.ok(style.border>=3);
   if(width<600)assert.ok(style.touchHeight>=44,'highlight preserves faculty touch target');
  }
  await visibleMatch(page);
  await page.waitForTimeout(350);
  if(process.env.MAP_SCREENSHOTS)await page.locator('.oa-map-popup').screenshot({path:path.join(process.env.MAP_SCREENSHOTS,'department-highlight-'+width+'.png')});
  await page.setViewportSize({width:width<600?568:1100,height:width<600?390:700});await matches(page,['Technology and Operations Management']);
  await page.setViewportSize({width,height});
  await input.fill('');await page.waitForSelector('.oa-map-popup',{state:'detached'});await openFirst(page);await matches(page,[]);
  // Repeated URL parameters select multiple departments using the same filter semantics.
  await page.goto(insead+'&dept=Decision%20Sciences&dept=Technology%20and%20Operations%20Management',{waitUntil:'domcontentloaded'});
  await openFirst(page);await matches(page,['Decision Sciences','Technology and Operations Management']);
  await page.goto(base+'/universities?view=map&filterA=Northw&dept=Kellogg',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.testMap&&testMap.shown().length===2&&document.querySelectorAll('.oa-map-logo').length===2);
  await page.locator('.oa-map-logo').first().click();await page.waitForSelector('.oa-map-popup');await matches(page,[]);
  // Automatically opened single-location cards use exactly the same highlights.
  await page.goto(base+'/universities?view=map&dept='+encodeURIComponent('Industrial and Enterprise Systems Engineering'),{waitUntil:'domcontentloaded'});
  await page.waitForSelector('.oa-map-popup');
  assert.match(await page.locator('.oa-map-popup .oa-map-selected-department .oa-map-department-name').innerText(),/Industrial and Enterprise Systems Engineering/);
  assert.equal(await page.locator('.oa-map-popup .oa-map-match-label').innerText(),'Matches your search');
  await visibleMatch(page);
  // Job-specific highlighting is retained, but cannot leak after clearing filters.
  await page.goto(base+'/universities?view=map&filterA='+encodeURIComponent('University of Illinois at Urbana-Champaign')+'&focus=department&school='+encodeURIComponent('Gies College of Business')+'&department='+encodeURIComponent('Information Systems, Operations Management, Supply Chain Management, and Analytics'),{waitUntil:'domcontentloaded'});
  await page.waitForSelector('.oa-map-popup');assert.ok(await page.locator('.oa-map-popup .oa-map-selected-department').count()>0);
  assert.equal(await page.locator('.oa-map-popup .oa-map-match-label').first().innerText(),'Requested department');
  await visibleMatch(page);
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();
  await page.locator('#oaf-university').fill('University of Illinois at Urbana-Champaign');
  await page.waitForFunction(()=>testMap.shown().length===2&&document.querySelectorAll('.oa-map-logo').length===2);
  await page.locator('.oa-map-logo').first().click();await page.waitForSelector('.oa-map-popup');await matches(page,[]);
  assert.deepEqual(errors,[]);console.log('Department highlights, ordering, themes, faculty links, filter changes, shared links, and job targets passed at '+width+'px');await page.close();
 }
}finally{await browser.close();await new Promise(r=>server.close(r));}
