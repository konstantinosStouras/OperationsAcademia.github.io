import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const root=path.resolve(import.meta.dirname,'..');
const output=path.join(root,'data/faculty-link-review');
// A concurrent location-editing task may be preparing new map geometry.
// Audit faculty changes against the published geometry without changing it.
const publishedMap=process.argv.includes('--committed-map')?execFileSync('git',['show','HEAD:data/university-map.json'],{cwd:root,maxBuffer:20*1024*1024}):null;
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.geojson':'application/json','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
 let file=path.join(root,decodeURIComponent(req.url.split('?')[0]));
 if(!fs.existsSync(file)&&!path.extname(file))file+='.html';
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
 res.setHeader('content-type',types[path.extname(file)]||'application/octet-stream');
 if(publishedMap&&file===path.join(root,'data','university-map.json'))res.end(publishedMap);else fs.createReadStream(file).pipe(res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,...(process.env.PW_CHROMIUM?{executablePath:process.env.PW_CHROMIUM}:{})});
try{
 const page=await browser.newPage();
 await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 await page.addInitScript(()=>{let api;Object.defineProperty(window,'OAUniMap',{configurable:true,get:()=>api,set:v=>{api=v;const mount=v.mount;v.mount=cfg=>(window.auditMap=mount(cfg));}});});
 await page.goto(base+'/universities?view=map',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.auditMap&&auditMap.shown().length>700,{timeout:90000});
 const points=await page.evaluate(()=>auditMap.shown());
 const missing=points.flatMap(point=>point.card.schools.flatMap(s=>s.rows.filter(r=>r.department&&(r.suppressFacultyLink||!/^https?:\/\//i.test(r.facultyUrl||''))).map(row=>({pointId:point.card.id,institution:point.card.officialInstitution||point.card.institution,school:s.name,department:row.department,country:point.country,row}))));
 const grouped=new Map();
 for(const item of missing){
  const key=JSON.stringify([item.institution,item.school,item.department]);
  if(!grouped.has(key))grouped.set(key,{key,institution:item.institution,school:item.school,department:item.department,countries:[],pointIds:[],rowIds:[],evidenceIds:[],deptUrls:[],sourceRows:[]});
  const record=grouped.get(key);record.countries.push(item.country);record.pointIds.push(item.pointId);
  record.rowIds.push(item.row.id,...(item.row.rowIds||[]),...(item.row.mapSources||[]).map(s=>s.rowId));
  record.evidenceIds.push(...(item.row.locationSources||[]).map(s=>s.id));
  record.deptUrls.push(item.row.deptUrl,...(item.row.mapSources||[]).map(s=>s.deptUrl));
  record.sourceRows.push(...(item.row.mapSources||[]).map(s=>({rowId:s.rowId,institution:s.institution,school:s.school,department:s.department,evidenceId:s.evidenceId})));
 }
 const records=Array.from(grouped.values()).sort((a,b)=>a.institution.localeCompare(b.institution)||a.school.localeCompare(b.school)||a.department.localeCompare(b.department));
 records.forEach((r,i)=>{r.id='faculty-'+String(i+1).padStart(4,'0');for(const field of ['countries','pointIds','rowIds','evidenceIds','deptUrls'])r[field]=Array.from(new Set(r[field].filter(Boolean)));r.sourceRows=Array.from(new Map(r.sourceRows.map(s=>[JSON.stringify(s),s])).values());});
 const universities=new Map();for(const r of records){if(!universities.has(r.institution))universities.set(r.institution,[]);universities.get(r.institution).push(r);}
 const shards=[[],[],[],[]];for(const list of Array.from(universities.values()).sort((a,b)=>b.length-a.length)){shards.sort((a,b)=>a.length-b.length);shards[0].push(...list);}
 fs.mkdirSync(output,{recursive:true});
 const manifest={version:1,created:new Date().toISOString(),initialMissingRows:missing.length,uniqueDepartments:records.length,physicalCards:points.length,records};
 const manifestPath=path.join(output,'manifest.json');
 if(process.argv.includes('--initialize')){
  if(fs.existsSync(manifestPath))throw Error('Refusing to replace the original audit manifest');
  fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  shards.forEach((records,i)=>fs.writeFileSync(path.join(output,'queue-'+i+'.json'),JSON.stringify({records:records.sort((a,b)=>a.id.localeCompare(b.id))},null,2)+'\n'));
 }
 fs.writeFileSync(path.join(output,'current-missing.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({missingRows:missing.length,uniqueDepartments:records.length,cards:points.length,shardSizes:shards.map(s=>s.length)}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
