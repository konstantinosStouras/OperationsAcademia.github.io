// Freeze the original university-fallback points as a reproducible research queue.
// Usage: node _scraper/export-location-audit.mjs <MAP_AUDIT_PATH>
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), S=require('../assets/oa-schools.js');
const input=process.argv[2];
if(!input)throw new Error('Pass the map audit exported by university-map-test.mjs');
const points=JSON.parse(fs.readFileSync(input,'utf8')).filter(p=>p.approximate);
const jobs=JSON.parse(fs.readFileSync(new URL('../data/jobs.json',import.meta.url),'utf8'));
const records=points.map(p=>{
 const rows=p.card.schools.flatMap(s=>s.rows);
 const relevant=jobs.filter(j=>S.institutionKey(j.institution)===S.institutionKey(p.card.institution)&&rows.some(r=>S.fold(r.department)===S.fold(j.unit||j.department)));
 return {id:p.card.id,institution:p.card.institution,school:p.school,departments:rows.map(r=>r.department),rowIds:rows.map(r=>r.id),status:'pending',
  departmentUrls:[...new Set(rows.flatMap(r=>[r.deptUrl,r.facultyUrl]).filter(Boolean))],
  postingUrls:[...new Set(relevant.map(j=>j.adUrl).filter(Boolean))]};
});
const output=new URL('./location-audit.json',import.meta.url);
if(fs.existsSync(output))throw new Error('The baseline already exists; preserve research progress.');
fs.writeFileSync(output,JSON.stringify({baselineDate:'2026-10-23',baselineCount:records.length,records},null,2)+'\n');
