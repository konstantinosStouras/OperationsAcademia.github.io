import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {compactLocationRecords} from './build-map-data.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const nav=require('../assets/oa-jobnav.js');
const model=require('../assets/oa-map-model.js');
const schools=require('../assets/oa-schools.js');
const routing=require('../assets/oa-map-routing.js');
require('./map-consolidation-test.cjs');
require('./map-physical-card-test.cjs');
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
const frozenFiles=new Map(['data/school-map-locations.json','data/directory.json','data/university-map.json'].map(name=>{const file=path.join(root,name);return [file,fs.readFileSync(file)];}));
const evidence=JSON.parse(frozenFiles.get(path.join(root,'data/school-map-locations.json'))).records.filter(r=>!schools.directoryExcluded(r));
const directory=JSON.parse(frozenFiles.get(path.join(root,'data/directory.json')));
const generated=JSON.parse(frozenFiles.get(path.join(root,'data/university-map.json')));
assert.equal(createHash('sha256').update(JSON.stringify(generated.verified)).digest('hex'),createHash('sha256').update(JSON.stringify(compactLocationRecords(evidence))).digest('hex'),'map payload must be rebuilt from current location evidence before browser testing');
const directoryIds=new Set(directory.flatMap(row=>[row.id,...(row.sourceRowIds||[])]));
for(const location of evidence)for(const id of location.rowIds)assert.ok(directoryIds.has(id)||directory.some(row=>(row.mapLocationIds||[]).includes(location.id)),id+' must resolve to the generated directory before browser testing');
const snapshotHashes=Object.fromEntries(Array.from(frozenFiles,([file,bytes])=>[path.relative(root,file).replaceAll('\\','/'),createHash('sha256').update(bytes).digest('hex')]));
console.log('Frozen map data snapshot:',JSON.stringify(snapshotHashes));
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.geojson':'application/json','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
  let file=path.join(root,decodeURIComponent(req.url.split('?')[0]));
  if(!fs.existsSync(file)&&!path.extname(file))file+='.html';
  if(!file.startsWith(root)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
  res.setHeader('content-type',types[path.extname(file)]||'application/octet-stream');
  if(frozenFiles.has(file))res.end(frozenFiles.get(file));else fs.createReadStream(file).pipe(res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.PW_CHROMIUM?{executablePath:process.env.PW_CHROMIUM}:{})});
console.log('Map browser launched; checking school cards and filters.');
const university='University of Illinois at Urbana-Champaign';
const job={institution:university,school:'Gies College of Business',unit:'Information Systems, Operations Management, Supply Chain Management, and Analytics',furtherInfoUrl:'https://www.operationsacademia.org/universities?filterA=old'};
assert.equal(nav.furtherInfoUrl({...job,furtherInfoUrl:'https://example.org/job'}),'https://example.org/job');
const errors=[];
async function pageAt(query='',mobile=false){
  if(process.env.MAP_DEBUG_LOG)console.log('Opening map:',query||'(all)',mobile?'mobile':'desktop');
  const p=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:1000},isMobile:mobile,hasTouch:mobile});
  p.on('pageerror',e=>errors.push(e.message));
  await p.route('**/*',r=>{
    const url=new URL(r.request().url());if(url.origin!==base)return r.abort();
    let file=path.join(root,decodeURIComponent(url.pathname));
    if(!fs.existsSync(file)&&!path.extname(file))file+='.html';
    if(!file.startsWith(root)||!fs.existsSync(file)||!fs.statSync(file).isFile())return r.fulfill({status:404,body:''});
    return r.fulfill({contentType:types[path.extname(file)]||'application/octet-stream',body:frozenFiles.get(file)||fs.readFileSync(file)});
  });
  await p.addInitScript(()=>{
    let api;
    Object.defineProperty(window,'OAUniMap',{configurable:true,get:()=>api,set:v=>{
      api=v;const mount=v.mount;v.mount=function(cfg){window.testMap=mount(cfg);return window.testMap;};
    }});
  });
  await p.goto(base+'/universities'+query,{waitUntil:'domcontentloaded',timeout:60000});
  await p.waitForFunction(()=>window.testMap&&window.testMap.shown().length>0);
  if(process.env.MAP_DEBUG_LOG)console.log('Map ready:',query||'(all)');
  return p;
}
try{
  const p=await pageAt('?university='+encodeURIComponent(university));
  await p.waitForFunction(()=>document.querySelectorAll('.oa-map-logo').length===2);
  assert.equal(await p.locator('.oa-map-cluster').count(),0,'a university search reveals its school logos');
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
  for(const [types,expected] of [[['Business school'],['Gies']],[['Non-business school'],['Grainger']],[['Business school','Non-business school'],['Gies','Grainger']]]){
    const query=new URLSearchParams({university});types.forEach(type=>query.append('type',type));
    const filtered=await pageAt('?'+query);
    const names=await filtered.evaluate(()=>testMap.shown().map(point=>point.school));
    assert.equal(names.length,expected.length,'school type scopes the physical school cards');
    expected.forEach(name=>assert.ok(names.some(school=>school.includes(name)),name+' is shown for its selected school type'));
    await filtered.close();
  }

  for(const mobile of [false,true]){
    const q=await pageAt(new URL(nav.furtherInfoUrl(job)).search,mobile);
    await q.waitForSelector('.oa-map-selected-department');
    const popup=await q.locator('.oa-map-popup').innerText();
    assert.match(popup,/Gies College of Business/);
    assert.equal(await q.locator('.oa-map-card-identity h3').innerText(),'Gies College of Business','school identity leads the card');
    assert.equal(await q.locator('.oa-map-card-identity .oa-map-university-name').innerText(),university);
    assert.equal(await q.locator('.oa-map-community').getAttribute('open'),null,'secondary links start collapsed');
    assert.equal(await q.locator('.oa-map-primary-action').innerText(),'Current jobs');
    const addressLink=q.locator('.oa-map-popup .oa-map-address a');
    assert.equal(await addressLink.count(),1,'the address is the map link');
    const addressUrl=new URL(await addressLink.getAttribute('href'));
    assert.equal(addressUrl.origin,'https://www.google.com');
    assert.equal(addressUrl.pathname,'/maps/search/');
    assert.equal(addressUrl.searchParams.get('query'),await q.evaluate(()=>{const at=testMap.map._popup.getLatLng();return at.lat+','+at.lng;}),'address opens the displayed school coordinates');
    assert.equal(await q.locator('.oa-map-popup a').filter({hasText:/^(Official address|Building map|Campus or headquarters map|School location|University location)$/}).count(),0,'redundant location links are removed');
    assert.doesNotMatch(popup,/Grainger|Labor|Industrial and Enterprise/);
    assert.equal(await q.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await q.waitForFunction(()=>{
      const p=document.querySelector('.oa-map-popup').getBoundingClientRect(),m=document.querySelector('.oa-uni-map').getBoundingClientRect();
      return p.left>=m.left&&p.right<=m.right&&p.top>=m.top&&p.bottom<=m.bottom;
    });
    await q.locator('.oa-map-community > summary').click();
    assert.equal(await q.locator('.oa-map-community a').count(),4,'community navigation remains available');
    await q.locator('.oa-map-community > summary').click();
    if(mobile){
      await q.setViewportSize({width:320,height:740});
      await q.waitForFunction(()=>{const popup=document.querySelector('.oa-map-popup').getBoundingClientRect(),map=document.querySelector('.oa-uni-map').getBoundingClientRect();return popup.left>=map.left&&popup.right<=map.right;});
      assert.equal(await q.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'narrow phone has no horizontal overflow');
      assert.ok(await q.locator('.leaflet-popup-close-button').evaluate(n=>n.getBoundingClientRect().width>=44),'close target is touch sized');
      assert.ok(await q.locator('.oa-map-department-name a').first().evaluate(n=>n.getBoundingClientRect().height>=44),'department faculty link is touch sized');
      await q.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
    }
    if(process.env.MAP_SCREENSHOT_DIR)await q.locator('.oa-uni-map').screenshot({path:path.join(process.env.MAP_SCREENSHOT_DIR,mobile?'map-phone.png':'map-desktop.png')});
    await q.locator('.leaflet-popup-close-button').click();
    await q.evaluate(()=>testMap.refresh());
    await q.waitForFunction(()=>!document.querySelector('.oa-map-popup'));
    assert.equal(await q.locator('.oa-map-popup').count(),0,'refresh does not reopen a dismissed popup');
    assert.equal(await q.locator('.leaflet-control-zoom-in').isVisible(),true,'map controls return after closing the card');
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

  console.log('School filters and mobile links passed; checking full-map provenance and Dublin.');
  // Use the complete, rendered physical cards as the stable display baseline.
  // Filtering must not change their representative or strip sibling departments.
  const baselinePage=await pageAt();
  const physicalBaseline=await baselinePage.evaluate(()=>testMap.shown());
  const cardAudit=await baselinePage.evaluate(()=>{
    const list=document.querySelector('.oa-map-results');list.open=true;list.dispatchEvent(new Event('toggle'));
    list.querySelectorAll('li > details').forEach(entry=>{entry.open=true;entry.dispatchEvent(new Event('toggle'));});
    const points=new Map(testMap.shown().map(point=>[point.card.id,point]));
    const failures=[];let cards=0,facultyLinks=0,missing=0;
    list.querySelectorAll('.oa-uni-pop').forEach(pop=>{
      const point=points.get(pop.dataset.mapCardId);if(!point)return;cards++;
      const expected=point.card.schools.flatMap(s=>s.rows).filter(r=>OAMapModel.departmentName(r.department));
      const actual=Array.from(pop.querySelectorAll('.oa-map-department'));
      if(expected.length!==actual.length)failures.push(point.card.id+' department coverage');
      expected.forEach(row=>{
        const name=OAMapModel.departmentName(row.department);
        const match=actual.find(node=>node.querySelector('.oa-map-department-name').textContent===name);
        if(!match){failures.push(point.card.id+' missing '+name);return;}
        const links=match.querySelectorAll('.oa-map-department-name a');
        const faculty=!row.suppressFacultyLink&&/^https?:\/\//i.test(row.facultyUrl||'')?row.facultyUrl:'';
        if(faculty){facultyLinks++;if(links.length!==1||links[0].getAttribute('href')!==faculty)failures.push(point.card.id+' faculty destination');}
        else{missing++;if(links.length||!match.textContent.includes('Faculty page not listed'))failures.push(point.card.id+' invented faculty destination');}
      });
      if(!pop.querySelector('.oa-map-card-identity h3')||!pop.querySelector('.oa-map-primary-action')||pop.querySelector('.oa-map-community').open)failures.push(point.card.id+' card structure');
      if(Array.from(pop.querySelectorAll('a')).some(a=>a.textContent==='Faculty'||a.textContent==='Department'))failures.push(point.card.id+' duplicate link labels');
    });
    return {cards,facultyLinks,missing,failures};
  });
  assert.equal(cardAudit.cards,physicalBaseline.length,'every physical map card follows the shared renderer');
  assert.deepEqual(cardAudit.failures,[]);
  console.log('Uniform card and faculty-link audit:',JSON.stringify(cardAudit));
  await baselinePage.close();
  const byEvidence=new Map();
  for(const point of physicalBaseline)for(const id of point.sourceEvidenceIds||[]){
    assert.ok(!byEvidence.has(id),id+' belongs to one physical school card');
    byEvidence.set(id,point);
  }
  for(const record of evidence){
    const point=byEvidence.get(record.id);
    assert.ok(point,record.id+' retains a visible physical card');
    const source=(point.locationSources||[]).find(source=>source.id===record.id);
    assert.ok(source,record.id+' retains its original evidence');
    assert.deepEqual([source.lat,source.lng,source.address],[record.lat,record.lng,record.address],record.id+' preserves original office evidence independently of shared marker');
    assert.deepEqual(source.sourceLocation,record.sourceLocation,record.id+' preserves original-location correction provenance');
  }
  const rowCards=new Map();
  for(const point of physicalBaseline){
    const ids=new Set(point.card.schools.flatMap(s=>s.rows.flatMap(r=>(r.mapSources||[]).map(source=>source.rowId))));
    for(const id of ids){if(!rowCards.has(id))rowCards.set(id,[]);rowCards.get(id).push(point);}
  }
  const repeatResolver=routing.createResolver({verified:evidence,directory,schoolAliases:generated.schoolAliases});
  const directoryById=new Map(directory.map(row=>[row.id,row]));
  for(const [id,points] of rowCards){
    if(points.length<2)continue;
    const groups=points.map(point=>(point.locationSources||[]).filter(source=>(source.rowIds||[]).includes(id)&&source.locationGroup).map(source=>source.locationGroup));
    if(groups[0].some(group=>groups.every(set=>set.includes(group))))continue;
    const sources=points.map(point=>point.card.schools.flatMap(s=>s.rows.flatMap(r=>(r.mapSources||[]).filter(source=>source.rowId===id))));
    const routeGroups=sources.map(list=>list.map(source=>source.mapRouteGroup).filter(Boolean));
    assert.ok(routeGroups[0].some(group=>routeGroups.every(set=>set.includes(group))),id+' repeated cards require evidenced or explicitly routed multiple locations, not stale legacy coordinates');
    const route=repeatResolver.resolve(directoryById.get(id));
    assert.ok((route.kind==='department'||route.kind==='school')&&route.ids.length>1,id+' synthetic group must be reproducible by the location resolver');
    const actualIds=[...new Set(sources.flatMap(list=>list.map(source=>source.evidenceId)))].sort();
    assert.deepEqual(actualIds,route.ids.slice().sort(),id+' synthetic group contains exactly the eligible reviewed sites');
  }
  const dublin=await pageAt('?university='+encodeURIComponent('University College Dublin'));
  const dublinPoints=await dublin.evaluate(()=>testMap.shown());
  assert.equal(dublinPoints.length,3,'Dublin exposes Smurfit, Quinn and Belfield engineering cards');
  const smurfit=dublinPoints.find(point=>(point.sourceEvidenceIds||[]).includes('dublin-supply-chain-smurfit-verified'));
  assert.ok(smurfit);
  assert.deepEqual(smurfit.card.schools.flatMap(s=>s.rows.map(r=>r.department)).sort(),['Management Information Systems','Management Subject Area']);
  for(const query of ['Information Systems','Management Area','Supply Chain']){
    await dublin.locator('#oaf-dept').fill(query);
    await dublin.waitForFunction(id=>testMap.shown().length===1&&testMap.shown()[0].card.id===id,smurfit.card.id);
    const filtered=await dublin.evaluate(()=>testMap.shown()[0]);
    assert.deepEqual(filtered.card.schools,smurfit.card.schools,query+' retains every Smurfit department and its evidence');
    assert.deepEqual([filtered.lat,filtered.lng],[smurfit.lat,smurfit.lng],query+' retains the shared school pin');
  }
  await dublin.close();
  for(const id of ['university-college-dublin','university-college-dublin____mis']){
    const row=directory.find(r=>r.id===id),expected=byEvidence.get(evidence.find(r=>r.rowIds.includes(id)).id);
    const link=nav.furtherInfoUrl({institution:row.institution,school:row.school,unit:row.department,furtherInfoUrl:'https://www.operationsacademia.org/universities?filterA=legacy'});
    const linked=await pageAt(new URL(link).search);
    await linked.waitForSelector('.oa-map-popup');
    assert.deepEqual(await linked.evaluate(()=>{const at=testMap.map._popup.getLatLng();return [at.lat,at.lng];}),[expected.lat,expected.lng],id+' opens its shared card directly');
    if(row.department){
      assert.match(await linked.locator('.oa-map-selected-department').innerText(),/Management Information Systems/);
      assert.match(await linked.locator('.oa-map-popup').innerText(),/Management Subject Area/,'department deep link retains sibling department');
    }
    await linked.close();
  }
  for(const officialName of ['University College London','Universidade Católica Portuguesa']){
    const universityPage=await pageAt('?'+new URLSearchParams({university:officialName}));
    assert.match(await universityPage.locator('.oa-map-status').innerText(),/^1 university · /,officialName+' aliases count as one university');
    const visibleIds=await universityPage.evaluate(()=>testMap.shown().flatMap(point=>point.sourceEvidenceIds||[]));
    const expected=evidence.filter(record=>record.institution===officialName);
    assert.ok(expected.length,officialName+' has verified search fixtures');
    for(const location of expected)assert.ok(visibleIds.includes(location.id),officialName+' search includes '+location.id);
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
      const displayLocation=byEvidence.get(location.id);
      if(evidenceQueue.length%25===0)console.log('Department links remaining:',evidenceQueue.length);
      const row=directory.find(r=>r.id===id||(r.sourceRowIds||[]).includes(id))||
        directory.find(r=>(r.mapLocationIds||[]).includes(location.id));
      assert.ok(row,id+' resolves to a current directory row');
      const url=nav.furtherInfoUrl({institution:row.institution,school:row.school,unit:row.department,furtherInfoUrl:'https://www.operationsacademia.org/universities?filterA=legacy'});
      const q=await pageAt(new URL(url).search);
      try{await q.waitForSelector(row.department?'.oa-map-selected-department':'.oa-map-popup',{timeout:5000});}
      catch(error){throw new Error(id+': '+await q.locator('.oa-map-status').innerText(),{cause:error});}
      const target=schools.canonColumns({institution:row.institution,school:row.school,unit:row.department});
      // University filters can change the representative of a consolidated
      // school card. Score the frozen-data points in this filtered view,
      // rather than assuming the all-universities representative is unchanged.
      const routePoints=await q.evaluate(()=>testMap.shown());
      const sourceLocation=routePoints.find(point=>(point.sourceEvidenceIds||[]).includes(location.id))||displayLocation;
      const scored=routePoints.map(point=>({point,score:model.pointMatchScore(point,row.institution,target.school,target.unit)}));
      const best=Math.max(...scored.map(x=>x.score));
      let eligible=scored.filter(x=>x.score&&x.score===best).map(x=>x.point);
      if(!target.school&&!target.unit){
        const generic=scored.filter(x=>x.score).map(x=>x.point).filter(point=>point.card.schools.some(s=>s.rows.some(r=>(r.mapSources||[]).some(source=>{
          const related=schools.institutionKey(source.institution)===schools.institutionKey(row.institution)||schools.institutionKey(point.card.officialInstitution||'')===schools.institutionKey(row.institution)||(source.institutionAliases||[]).some(a=>schools.institutionKey(a)===schools.institutionKey(row.institution));
          return related&&[{school:source.school,department:source.department}].concat(source.mapAliases||[]).some(a=>!schools.fold(a.school||'')&&!schools.fold(a.department||''));
        }))));
        if(generic.length===1)eligible=generic;
      }
      const groupSets=eligible.map(point=>model.locationGroupsForTarget(point,row.institution,target.school,target.unit,evidence));
      const commonGroups=groupSets.length?groupSets[0].filter(group=>groupSets.every(set=>set.includes(group))):[];
      // A canonical directory row can have evidence from several older school
      // labels. Its link follows the best canonical route; it cannot select
      // each historical source independently without a location chooser.
      assert.ok(eligible.length,id+' has a canonical physical-card route');
      const routedLocation=eligible.length>1&&commonGroups.length?sourceLocation:eligible[0];
      if(eligible.length>1&&commonGroups.length){
        const options=q.locator('.oa-map-location-options');
        const choices=await options.locator('button[data-map-card-id]').evaluateAll(buttons=>buttons.map(b=>b.getAttribute('data-map-card-id')));
        assert.deepEqual(choices.slice().sort(),eligible.map(point=>point.card.id).sort(),id+' chooser lists each eligible physical card once');
        const index=choices.indexOf(sourceLocation.card.id);
        assert.ok(index>=0,id+' offers its source school card');
        await options.locator('button[data-map-card-id]').nth(index).click();
        await q.waitForFunction(()=>document.querySelectorAll('.oa-map-popup').length===1&&!document.querySelector('.oa-map-location-options'));
      }
      const popupText=await q.locator('.oa-map-popup').innerText();
      assert.ok(popupText.includes(routedLocation.address),id+' opens its verified canonical address: expected '+routedLocation.address+'; rendered '+popupText.slice(0,1200));
      if((id.startsWith('insead__')||id.startsWith('university-of-alaska-'))&&row.department&&row.facultyUrl){
        const selected=q.locator('.oa-map-selected-department');
        assert.equal(await selected.locator('.oa-map-department-name a').getAttribute('href'),row.facultyUrl,id+' department name links directly to faculty');
        assert.equal(await selected.getByRole('link',{name:'Faculty',exact:true}).count(),0,'no separate faculty label');
      }
      if(routedLocation.locationPrecision==='campus')assert.ok((await q.locator('.oa-map-popup').innerText()).includes(routedLocation.locationContext),id+' explains campus fallback');
      assert.deepEqual(await q.evaluate(()=>{const p=testMap.map._popup.getLatLng();return [p.lat,p.lng];}),[routedLocation.lat,routedLocation.lng],id+' opens the representative school pin');
      assert.ok(await q.evaluate(evidenceIds=>{const at=testMap.map._popup.getLatLng();return testMap.shown().some(p=>p.lat===at.lat&&p.lng===at.lng&&evidenceIds.every(id=>(p.sourceEvidenceIds||[]).includes(id)));},routedLocation.sourceEvidenceIds||[]),id+' opened point retains canonical location evidence');
      await q.locator('#oaf-dept').fill(location.department||location.school||'');
      await q.waitForFunction(expected=>testMap.shown().some(p=>p.card.id===expected.card.id&&p.lat===expected.lat&&p.lng===expected.lng),displayLocation);
      const filtered=await q.evaluate(cardId=>testMap.shown().find(p=>p.card.id===cardId),displayLocation.card.id);
      assert.deepEqual(filtered.card.schools,displayLocation.card.schools,id+' department filter preserves sibling departments and provenance');
      await q.close();
    }
  }));

  // Shared cards also contain older directory rows without location-evidence IDs.
  // Exercise their original links without claiming a newly verified office for them.
  if(!testRows||process.env.MAP_TEST_LEGACY_SHARED){
    const legacyIds=new Set(physicalBaseline.filter(point=>point.sharedSchoolLocation).flatMap(point=>point.card.schools.flatMap(s=>s.rows.flatMap(r=>(r.mapSources||[]).filter(source=>!source.evidenceId).map(source=>source.rowId)))));
    const legacyQueue=Array.from(legacyIds),legacyTotal=legacyQueue.length;
    console.log('Shared legacy department links:',legacyTotal);
    await Promise.all(Array.from({length:4},async()=>{
      while(legacyQueue.length){
        const id=legacyQueue.shift(),row=directory.find(r=>r.id===id);
        assert.ok(row,id+' original directory row exists');
        const url=nav.furtherInfoUrl({institution:row.institution,school:row.school,unit:row.department,furtherInfoUrl:'https://www.operationsacademia.org/universities?filterA=legacy'});
        const q=await pageAt(new URL(url).search);
        await q.waitForSelector(row.department?'.oa-map-selected-department':'.oa-map-popup');
        const opened=await q.evaluate(rowId=>{
          const at=testMap.map._popup.getLatLng();
          return testMap.shown().find(point=>point.lat===at.lat&&point.lng===at.lng&&point.card.schools.some(s=>s.rows.some(r=>(r.mapSources||[]).some(source=>source.rowId===rowId))));
        },id);
        assert.ok(opened,id+' opens a card retaining its original legacy row');
        const expected=physicalBaseline.find(point=>point.card.id===opened.card.id);
        assert.ok(expected,id+' uses a stable full-directory physical card');
        assert.deepEqual(opened.card.schools,expected.card.schools,id+' legacy link retains all sibling departments');
        await q.locator('#oaf-dept').fill(row.department||row.school||'');
        await q.waitForFunction(cardId=>testMap.shown().some(point=>point.card.id===cardId),opened.card.id);
        const filtered=await q.evaluate(cardId=>testMap.shown().find(point=>point.card.id===cardId),opened.card.id);
        assert.deepEqual(filtered.card.schools,expected.card.schools,id+' legacy department search retains all sibling rows');
        await q.close();
      }
    }));
    console.log('Shared legacy department links passed:',legacyTotal);
  }

  const all=await pageAt();
  if(process.env.MAP_AUDIT_PATH)fs.writeFileSync(process.env.MAP_AUDIT_PATH,JSON.stringify(await all.evaluate(()=>testMap.shown()),null,2)+'\n');
  const reviewedGroups=new Map();
  for(const location of evidence.filter(r=>r.locationIdentity)){
    const canonical=model.canonicalLocation(location,evidence);
    if(!reviewedGroups.has(canonical.id))reviewedGroups.set(canonical.id,[]);
    reviewedGroups.get(canonical.id).push(location.id);
  }
  const visibleEvidence=await all.evaluate(()=>testMap.shown().map(p=>({ids:p.sourceEvidenceIds||[],identity:p.locationIdentity})));
  for(const [canonicalId,ids] of reviewedGroups){
    const matching=visibleEvidence.filter(p=>p.ids.some(id=>ids.includes(id)));
    assert.equal(matching.length,1,canonicalId+' has one reviewed department/location card');
    for(const id of ids)assert.ok(matching[0].ids.includes(id),canonicalId+' retains evidence '+id);
  }
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
      if(p.card.schools.length!==1&&!(p.locationSources||[]).some(s=>s.mapCardIdentity))failures.push('unreviewed mixed schools '+p.card.id);
      p.card.schools.forEach(s=>{if(s.rows.some(r=>r.mapCardSchool!==undefined&&r.mapCardSchool!==s.name))failures.push('wrong school section '+p.card.id);});
      if(!Number.isFinite(p.lat)||!Number.isFinite(p.lng))failures.push('invalid location');
    });
    return {universities:new Set(points.map(p=>p.card.officialInstitution||p.card.institution)).size,locations:points.length,
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
