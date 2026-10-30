import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { uniqueIds, publicRow, suppressedBySource } from './jobs-model.mjs';
const require = createRequire(import.meta.url);
const U = require('../assets/oa-users.js');
const NAV = require('../assets/oa-jobnav.js');
const year = NAV.marketYear(new Date());
assert.deepEqual({...U.jobYearsOf([
  {uid:'one',year,status:'published'}, {uid:'one',year,status:'queued'},
  {uid:'two',year:year-1,status:'withdrawn'}, {year,status:'sheet'},
  {uid:'draft',year,status:'draft'}, {uid:'constructor',year,status:'published'}
],NAV)}, {one:[year],two:[year-1],constructor:[year]});
const renamed = uniqueIds([{id:'same',ref:'member'},{id:'same',source:'jobmarket-sheet'}]);
assert.equal(renamed[1].id,'same-2');
assert.equal(publicRow(renamed[1]).sourceId,'same');
assert.equal(suppressedBySource(renamed[1],{'jobmarket-sheet':['same']}),true);
assert.equal(suppressedBySource({...renamed[0],source:'oa-form'},{'jobmarket-sheet':['same']}),false);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const server = http.createServer(async (req,res) => {
  try {
    let p = new URL(req.url,'http://local').pathname;
    if (!path.extname(p)) p += '.html';
    const file = path.join(root,p);
    const mime = {'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css'};
    res.setHeader('Content-Type',mime[path.extname(file)] || 'application/octet-stream');
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const {chromium} = require('playwright');
const browser = await chromium.launch({headless:true,executablePath:process.env.PW_CHROMIUM || undefined});
try {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  const docs = ['one','two','three'].map((uid,i)=>({path:'userDirectory/'+uid,data:{name:uid,email:uid+'@example.edu',affiliation:'Test University',first:1000,seen:2000}}));
  docs.push({path:'jobSubmissions/a',data:{uid:'one',year,status:'published'}},
    {path:'jobSubmissions/b',data:{uid:'two',year:year-1,status:'withdrawn'}},
    {path:'candidateSubmissions/c',data:{uid:'one',year,status:'published'}});
  await page.addInitScript({content:'window.__FAKE_FB='+JSON.stringify({user:{uid:'admin-uid-0000000000',email:'kstouras@gmail.com',emailVerified:true,displayName:'Kostas Stouras',providerData:[]},docs})});
  const shim=await fs.readFile(path.join(root,'_scraper/_fake-firebase.js'),'utf8');
  await page.route('**/firebasejs/**',r=>r.fulfill({status:200,contentType:'text/javascript',body:shim}));
  await page.goto('http://127.0.0.1:'+server.address().port+'/admin-area.html');
  await page.waitForSelector('#oa-u-jobyear');
  assert.equal(await page.locator('.oa-u-table tbody tr').count(),3);
  await page.selectOption('#oa-u-jobyear',String(year-1));
  assert.equal(await page.locator('.oa-u-table tbody tr').count(),1);
  assert.match(await page.locator('.oa-u-table tbody').innerText(),/two@example.edu/);
  await page.selectOption('#oa-u-jobyear',String(year));
  await page.selectOption('#oa-u-candyear',String(year));
  assert.equal(await page.locator('.oa-u-table tbody tr').count(),1);
  assert.match(await page.locator('.oa-u-table tbody').innerText(),/one@example.edu/);
  await page.selectOption('#oa-u-jobyear',String(year-1));
  assert.equal(await page.locator('.oa-u-table tbody tr').count(),0);
  await page.selectOption('#oa-u-candyear','');
  await page.selectOption('#oa-u-jobyear',String(year));
  await fs.mkdir(path.join(root,'../outputs'),{recursive:true});
  await page.locator('#oa-aa-users').screenshot({path:path.join(root,'../outputs/job-posters-filter.png')});
  await page.addScriptTag({path:path.join(root,'assets/oa-takedown.js')});
  await page.addScriptTag({path:path.join(root,'assets/oa-jobedit.js')});
  const labels=await page.evaluate(()=>{
    window.OAJobEdit.__setPermissionsForTest({ready:true,admin:true,byId:{same:'same'},bySheetId:{same:'same'}});
    const card=document.createElement('li');
    window.OAJobEdit.onCard(card,{id:'same-2',sourceId:'same'});
    return card.textContent;
  });
  assert.match(labels,/Edit/); assert.match(labels,/Take down/);
  const own = await browser.newPage();
  await own.addInitScript({content:'window.__FAKE_FB='+JSON.stringify({user:{uid:'one',email:'one@example.edu',emailVerified:true,displayName:'One',providerData:[]},docs:[{path:'jobSubmissions/job',data:{uid:'one',ref:'test-ref',institution:'Test University',year,status:'published'}}]})});
  await own.route('**/firebasejs/**',r=>r.fulfill({status:200,contentType:'text/javascript',body:shim}));
  let published=[];
  await own.route('**/data/jobs.json',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(published)}));
  await own.goto('http://127.0.0.1:'+server.address().port+'/my-postings.html');
  await own.waitForSelector('.oa-my-status');
  assert.equal(await own.locator('.oa-my-status').textContent(),'Pending publication');
  assert.equal(await own.getByRole('button',{name:'Edit',exact:true}).count(),1);
  assert.equal(await own.getByRole('button',{name:'Take down',exact:true}).count(),1);
  published=[{id:'public-job',ref:'test-ref'}];
  await own.reload(); await own.waitForSelector('.oa-my-status');
  assert.equal(await own.locator('.oa-my-status').textContent(),'Live');
  for (const [jobs,cands] of [[0,0],[1,0],[0,1],[1,1]]) {
    const rolePage = await browser.newPage();
    const roleDocs = [];
    if (jobs) roleDocs.push({path:'jobSubmissions/owned',data:{uid:'role-owner',institution:'Example University',status:'published',year}});
    if (cands) roleDocs.push({path:'candidateSubmissions/owned',data:{uid:'role-owner',first:'Test',last:'Candidate',status:'published',year}});
    await rolePage.addInitScript({content:'window.__FAKE_FB='+JSON.stringify({user:{uid:'role-owner',email:'role@example.edu',emailVerified:true,displayName:'Role Owner',providerData:[],metadata:{creationTime:'2026-10-30T00:00:00Z'}},docs:roleDocs})});
    await rolePage.route('**/firebasejs/**',r=>r.fulfill({status:200,contentType:'text/javascript',body:shim}));
    await rolePage.route('**/*',route => {
      const u = new URL(route.request().url());
      if (u.pathname.includes('/firebasejs/')) return route.fulfill({status:200,contentType:'text/javascript',body:shim});
      return u.hostname === '127.0.0.1' ? route.continue() : route.abort();
    });
    await rolePage.goto('http://127.0.0.1:'+server.address().port+'/account.html',{waitUntil:'domcontentloaded'});
    await rolePage.waitForFunction(()=>document.querySelector('#pa-n-jobs')?.textContent.match(/^\d+$/));
    await rolePage.waitForFunction(()=>document.querySelector('#oa-menu'));
    for (const [type,expected] of [['job',jobs],['candidate',cands]]) {
      const links=rolePage.locator('a[href="profile-analytics?type='+type+'"]');
      assert.equal(await links.count(),3,'desktop menu, mobile menu and personal-area card');
      assert.deepEqual(await links.evaluateAll(xs=>xs.map(x=>!x.hidden)),[!!expected,!!expected,!!expected]);
      if (expected) assert.deepEqual(await links.locator('[data-profile-analytics-new]').evaluateAll(xs=>xs.map(x=>!x.hidden)),[true,true,true]);
    }
    await rolePage.close();
  }
  assert.deepEqual(errors,[]);
  console.log('Job poster seasons, combined filters, historical posters, and renamed job controls passed.');
} finally { await browser.close(); server.close(); }
