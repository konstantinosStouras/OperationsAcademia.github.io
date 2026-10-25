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
try{
  const p=await pageAt('?university='+encodeURIComponent(university));
  assert.equal(await p.locator('.oa-map-cluster').innerText(),'2');
  const scoped=await p.evaluate(()=>testMap.shown().map(x=>({school:x.school,rows:x.card.schools.flatMap(s=>s.rows.map(r=>r.department)),lat:x.lat,lng:x.lng})));
  assert.equal(scoped.length,2);
  assert.equal(scoped.find(x=>/Grainger/.test(x.school)).lat,40.110649);
  assert.deepEqual(scoped.find(x=>/Grainger/.test(x.school)).rows,['Industrial and Enterprise Systems Engineering']);
  assert.ok(scoped.find(x=>/Gies/.test(x.school)).rows.every(x=>!/Engineering|Labor|IS\/OM/.test(x)));
  assert.equal(await p.locator('.oa-map-popup').count(),0,'university search shows all schools');
  await p.locator('#oaf-dept').fill('Grainger');
  await p.waitForFunction(()=>testMap.shown().length===1);
  assert.match(await p.evaluate(()=>testMap.shown()[0].school),/Grainger/);
  await p.locator('#oaf-dept').fill('');
  await p.waitForFunction(()=>testMap.shown().length===2);
  await p.close();

  for(const mobile of [false,true]){
    const q=await pageAt(new URL(nav.furtherInfoUrl(job)).search,mobile);
    await q.waitForSelector('.oa-map-selected-department');
    const popup=await q.locator('.oa-map-popup').innerText();
    assert.match(popup,/Gies College of Business/);
    assert.doesNotMatch(popup,/Grainger|Labor|Industrial and Enterprise/);
    assert.equal(await q.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await q.waitForFunction(()=>{
      const p=document.querySelector('.oa-map-popup').getBoundingClientRect(),m=document.querySelector('.oa-uni-map').getBoundingClientRect();
      return p.left>=m.left&&p.right<=m.right&&p.top>=m.top&&p.bottom<=m.bottom;
    });
    if(process.env.MAP_SCREENSHOT_DIR)await q.locator('.oa-uni-map').screenshot({path:path.join(process.env.MAP_SCREENSHOT_DIR,mobile?'map-phone.png':'map-desktop.png')});
    await q.locator('.leaflet-popup-close-button').click();
    await q.evaluate(()=>testMap.refresh());
    await q.waitForFunction(()=>!document.querySelector('.oa-map-popup'));
    assert.equal(await q.locator('.oa-map-popup').count(),0,'refresh does not reopen a dismissed popup');
    await q.close();
  }
  const eng=await pageAt(new URL(nav.furtherInfoUrl({...job,school:'The Grainger College of Engineering',unit:'Industrial and Enterprise Systems Engineering'})).search);
  await eng.waitForSelector('.oa-map-popup');
  assert.doesNotMatch(await eng.locator('.oa-map-popup').innerText(),/Gies|Labor/);
  await eng.close();
  const unknown=await pageAt(new URL(nav.furtherInfoUrl({...job,school:'School of Labor and Employment Relations',unit:'Human Resources and Technology'})).search);
  assert.equal(await unknown.locator('.oa-map-popup').count(),0,'excluded department must never open an unrelated school');
  assert.match(await unknown.locator('.oa-map-status').innerText(),/requested department is not in the directory/);
  await unknown.close();

  const fullName=await pageAt('?university='+encodeURIComponent('Korea Advanced Institute of Science and Technology'));
  assert.ok(await fullName.evaluate(()=>testMap.shown().every(p=>p.card.institution==='KAIST')));
  await fullName.close();

  const evidence=JSON.parse(fs.readFileSync(path.join(root,'data/school-map-locations.json'),'utf8')).records;
  const directory=JSON.parse(fs.readFileSync(path.join(root,'data/directory.json'),'utf8'));
  for(const officialName of ['University College London','Universidade Católica Portuguesa']){
    const universityPage=await pageAt('?'+new URLSearchParams({university:officialName}));
    const visibleIds=await universityPage.evaluate(()=>testMap.shown().map(point=>point.card.id));
    const expected=evidence.filter(record=>record.institution===officialName);
    assert.ok(expected.length,officialName+' has verified search fixtures');
    for(const location of expected)assert.ok(visibleIds.some(id=>id.includes(':location:'+location.id+'::')),officialName+' search includes '+location.id);
    assert.ok(await universityPage.evaluate(name=>testMap.shown().every(point=>point.card.institution===name||point.card.officialInstitution===name||(point.card.aka||'').split(' · ').includes(name)),officialName),officialName+' search excludes unrelated universities');
    await universityPage.close();
  }
  const testRows=process.env.MAP_TEST_ROWS?new Set(process.env.MAP_TEST_ROWS.split(',')):null;
  const evidenceQueue=evidence.flatMap(location=>location.rowIds.map(id=>({location,id}))).filter(item=>!testRows||testRows.has(item.id));
  const dubai=evidence.find(location=>location.id==='indian-institute-management-ahmedabad-dubai');
  if(dubai){
    const campus=await pageAt('?'+new URLSearchParams({university:dubai.institutionKey,country:'United Arab Emirates'}));
    assert.ok(await campus.evaluate(()=>testMap.shown().every(point=>point.country==='United Arab Emirates')),'country filter scopes individual campuses');
    assert.ok(await campus.evaluate(expected=>testMap.shown().some(point=>point.lat===expected.lat&&point.lng===expected.lng),dubai),'Dubai campus is discoverable under its verified country');
    await campus.close();
  }
  await Promise.all(Array.from({length:4},async()=>{
    while(evidenceQueue.length){
      const {location,id}=evidenceQueue.shift();
      if(evidenceQueue.length%25===0)console.log('Department links remaining:',evidenceQueue.length);
      const row=directory.find(r=>r.id===id);
      const url=nav.furtherInfoUrl({institution:row.institution,school:row.school,unit:row.department,furtherInfoUrl:'https://www.operationsacademia.org/universities?filterA=legacy'});
      const q=await pageAt(new URL(url).search);
      try{await q.waitForSelector(row.department?'.oa-map-selected-department':'.oa-map-popup',{timeout:5000});}
      catch(error){throw new Error(id+': '+await q.locator('.oa-map-status').innerText(),{cause:error});}
      if(location.locationGroup && evidence.filter(candidate=>candidate.rowIds.includes(id)).length>1){
        const options=q.locator('.oa-map-location-options');
        assert.ok((await options.innerText()).includes(location.address),id+' offers its eligible host address');
        await options.getByRole('button',{name:location.school+' · '+location.department+' · '+location.building,exact:true}).click();
        await q.waitForFunction(()=>document.querySelectorAll('.oa-map-popup').length===1&&!document.querySelector('.oa-map-location-options'));
      }
      assert.ok((await q.locator('.oa-map-popup').innerText()).includes(location.address),id+' opens its verified address');
      assert.deepEqual(await q.evaluate(()=>{const p=testMap.map._popup.getLatLng();return [p.lat,p.lng];}),[location.lat,location.lng],id+' opens the building pin');
      await q.locator('#oaf-dept').fill(location.department||location.school||'');
      await q.waitForFunction(expected=>testMap.shown().some(p=>p.locationVerified&&p.lat===expected.lat&&p.lng===expected.lng),location);
      await q.close();
    }
  }));

  const all=await pageAt();
  if(process.env.MAP_AUDIT_PATH)fs.writeFileSync(process.env.MAP_AUDIT_PATH,JSON.stringify(await all.evaluate(()=>testMap.shown()),null,2)+'\n');
  const audit=await all.evaluate(()=>{
    const points=testMap.shown(), failures=[], groups=[];
    testMap.map.eachLayer(layer=>{if(layer instanceof L.MarkerClusterGroup)groups.push(layer);});
    let clusters=0;
    function check(c){
      if(c.getChildCount()>1){clusters++;const html=groups[0].options.iconCreateFunction(c).options.html;
        if(Number(html.replace(/<[^>]+>/g,''))!==c.getChildCount())failures.push('cluster count');}
      (c._childClusters||[]).forEach(check);
    }
    check(groups[0]._topClusterLevel);
    const ids=new Set();
    points.forEach(p=>{
      if(ids.has(p.card.id))failures.push('duplicate '+p.card.id);ids.add(p.card.id);
      if(p.card.schools.length!==1)failures.push('mixed schools '+p.card.id);
      if(p.card.schools[0].rows.some(r=>(r.school||'')!==p.school))failures.push('wrong school '+p.card.id);
      if(!Number.isFinite(p.lat)||!Number.isFinite(p.lng))failures.push('invalid location');
    });
    return {universities:new Set(points.map(p=>p.card.universityId)).size,locations:points.length,
      approximate:points.filter(p=>p.approximate).length,clusters,failures};
  });
  assert.deepEqual(audit.failures,[]);
  assert.ok(audit.clusters>100);
  console.log('Full map audit:',JSON.stringify(audit));
  // Every continent uses the same school-specific points and count rule.
  for(const region of ['north-america','south-america','europe','africa','asia','oceania']){
    await all.locator(`[data-region="${region}"]`).click();
    assert.ok(await all.evaluate(()=>testMap.shown().length)>0,region);
  }
  assert.deepEqual(errors,[]);
  await all.close();
  console.log('University map: UIUC separation, direct job links, filters, mobile, all clusters and continents passed.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
