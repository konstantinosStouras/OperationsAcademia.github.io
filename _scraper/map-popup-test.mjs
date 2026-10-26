import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const nav=require('../assets/oa-jobnav.js');
const model=require('../assets/oa-map-model.js');
assert.equal(model.displayName('KAIST'),'Korea Advanced Institute of Science and Technology (KAIST)');
assert.equal(model.displayName('MIT'),'Massachusetts Institute of Technology (MIT)');
assert.equal(model.departmentName('OR/OM'),'Operations Research, Operations Management');
assert.ok(model.rowMatchScore({school:'Duffield College of Engineering',department:'School of Operations Research and Information Engineering',mapAliases:[{school:'',department:'Operations Research and Information Engineering'}]},'', 'Operations Research and Information Engineering') > model.rowMatchScore({school:'Cornell Tech',department:'Operations Research and Information Engineering'},'', 'Operations Research and Information Engineering'),'legacy school-less department links prefer their exact original row over another campus');
const shared=model.pointsFor({id:'same',institution:'Test University',countries:['United States'],schools:[
  {name:'Business School',rows:[{id:'business',department:'Operations Management',lat:40,lng:-88}]},
  {name:'Engineering School',rows:[{id:'engineering',department:'Industrial Engineering',lat:40,lng:-88}]}
]},{locations:new Map(),historic:new Map(),rowInstitutions:{}});
assert.equal(shared.length,2,'schools sharing coordinates retain separate cards');
assert.notEqual(shared[0].card.id,shared[1].card.id);
const root=path.resolve(import.meta.dirname,'..');
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.geojson':'application/json','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
  let file=path.join(root,decodeURIComponent(req.url.split('?')[0]));
  if(!fs.existsSync(file)&&!path.extname(file))file+='.html';
  if(!file.startsWith(root)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
  res.setHeader('content-type',types[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.PW_CHROMIUM?{executablePath:process.env.PW_CHROMIUM}:{})});
const university='University of Illinois at Urbana-Champaign';
const job={institution:university,school:'Gies College of Business',unit:'Information Systems, Operations Management, Supply Chain Management, and Analytics',furtherInfoUrl:'https://www.operationsacademia.org/universities?filterA=old'};
assert.equal(nav.furtherInfoUrl({...job,furtherInfoUrl:'https://example.org/job'}),'https://example.org/job');
const errors=[];
async function pageAt(query='',mobile=false){
  const p=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:1000}});
  p.on('pageerror',e=>errors.push(e.message));
  await p.route('**/*',r=>{
    const url=new URL(r.request().url());if(url.origin!==base)return r.abort();
    let file=path.join(root,decodeURIComponent(url.pathname));
    if(!fs.existsSync(file)&&!path.extname(file))file+='.html';
    if(!file.startsWith(root)||!fs.existsSync(file)||!fs.statSync(file).isFile())return r.fulfill({status:404,body:''});
    return r.fulfill({contentType:types[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
  });
  await p.addInitScript(()=>{
    let api;
    Object.defineProperty(window,'OAUniMap',{configurable:true,get:()=>api,set:v=>{
      api=v;const mount=v.mount;v.mount=function(cfg){window.testMap=mount(cfg);return window.testMap;};
    }});
  });
  await p.goto(base+'/universities'+query,{waitUntil:'domcontentloaded',timeout:60000});
  await p.waitForFunction(()=>window.testMap&&window.testMap.shown().length>0);
  return p;
}
try {
  for (const mobile of [false,true]) {
    const p=await pageAt('?view=map&filterA=INSEAD',mobile);
    for (const [region,countries] of [
      ['world',['France','Singapore','United Arab Emirates','United States']],
      ['europe',['France']],['north-america',['United States']],
      ['asia',['Singapore','United Arab Emirates']],['africa',[]],
      ['south-america',[]],['oceania',[]],
      ['world',['France','Singapore','United Arab Emirates','United States']]
    ]) {
      await p.locator('[data-region="'+region+'"]').click();
      await p.waitForTimeout(100);
      assert.deepEqual(await p.evaluate(()=>testMap.shown().map(p=>p.country).sort()),countries.slice().sort(),region+' shows only its INSEAD locations');
    }
    const campuses=await p.evaluate(()=>testMap.shown().map(p=>({country:p.country,label:p.campusLabel,address:p.address,rows:p.card.schools.flatMap(s=>s.rows.map(r=>r.department))})));
    assert.equal(campuses.length,4);
    for(const campus of campuses){assert.ok(campus.label);assert.ok(campus.address);assert.equal(campus.rows.length,2);}
    await p.locator('.oa-map-logo').first().scrollIntoViewIfNeeded();
    const before=await p.evaluate(()=>({zoom:testMap.map.getZoom(),center:testMap.map.getCenter(),scroll:scrollY}));
    await p.locator('.oa-map-logo').first().click();
    await p.waitForTimeout(350);
    const state=await p.evaluate(()=>{
      const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};};
      return {zoom:testMap.map.getZoom(),center:testMap.map.getCenter(),scroll:scrollY,map:rect('.oa-uni-map'),card:rect('.oa-map-popup'),controls:rect('.leaflet-top.leaflet-right'),visible:getComputedStyle(document.querySelector('.leaflet-top.leaflet-right')).visibility,top:document.querySelector('.leaflet-popup-content').scrollTop};
    });
    assert.equal(state.zoom,before.zoom,'opening a school preserves zoom');
    assert.deepEqual(state.center,before.center,'opening a school preserves center');
    assert.equal(state.scroll,before.scroll,'opening a school preserves page scroll');
    assert.equal(state.visible,'visible');assert.equal(state.top,0);
    assert.ok(state.card.y>=state.map.y && state.card.bottom<=state.map.bottom,'card fits vertically');
    assert.ok(state.card.right<state.controls.x,'card leaves controls accessible');
    const closeLayout=await p.evaluate(()=>{
      const close=document.querySelector('.leaflet-popup-close-button').getBoundingClientRect();
      const content=document.querySelector('.leaflet-popup-content').getBoundingClientRect();
      return {width:close.width,height:close.height,bottom:close.bottom,contentTop:content.top};
    });
    assert.ok(closeLayout.width>=44 && closeLayout.height>=44,'close target is touch sized');
    assert.ok(closeLayout.bottom<closeLayout.contentTop,'close button is above the scrollbar');
    await p.locator('.leaflet-popup-close-button').click();
    await p.waitForTimeout(350);
    assert.equal(await p.locator('.oa-map-popup').count(),0);
    await p.locator('.oa-map-logo').first().click();
    await p.locator('.leaflet-control-zoom-in').click();
    await p.waitForTimeout(350);
    assert.ok(await p.evaluate(()=>testMap.map.getZoom())>before.zoom);
    await p.locator('.oa-map-reset button').click();
    await p.waitForTimeout(350);
    assert.equal(await p.locator('.oa-map-popup').count(),0);
    console.log(mobile?'Phone passed':'Desktop passed');
    await p.close();
  }
  assert.deepEqual(errors,[]);
} finally {await browser.close();server.close();}


