import fs from 'node:fs';
import {createRequire} from 'node:module';
const schools=createRequire(import.meta.url)('../assets/oa-schools.js');
const base=new URL('../data/',import.meta.url);
const read=name=>JSON.parse(fs.readFileSync(new URL(name,base),'utf8'));
const manifest=new Map(read('faculty-link-review/manifest.json').records.map(r=>[r.id,r]));
const links=read('map-department-links.json');
const key=r=>JSON.stringify([r.institution,r.school,r.department]);
const indexed=new Map(links.records.map(r=>[key(r),r]));
let verified=0;
const approved=[];
for(let i=0;i<4;i++){
 const file=new URL(`faculty-link-review/results-${i}.json`,base);
 if(!fs.existsSync(file))continue;
 for(const r of JSON.parse(fs.readFileSync(file,'utf8')).records){
  const original=manifest.get(r.id);
  if(!original||key(original)!==key(r))throw Error('Review identity mismatch: '+r.id);
  if(!['verified','owner-approved'].includes(r.status)){
    if(indexed.get(key(r))?.reviewId===r.id)indexed.delete(key(r));
    continue;
  }
  if(!/^https:\/\//.test(r.facultyUrl)||!r.sources?.length||!r.checked||!r.evidence)throw Error('Incomplete verification: '+r.id);
  const target={...r,...r.publishAs};
  const existing=indexed.get(key(target))||indexed.get(key(r))||{};
  if(key(target)!==key(r))indexed.delete(key(r));
  const record={...existing,institution:target.institution,school:target.school,department:target.department,facultyUrl:r.facultyUrl,sources:r.sources,checked:r.checked,notes:[r.notes,r.evidence].filter(Boolean).join(' '),reviewId:r.id};
  if(r.directoryFilter)record.directoryFilter=r.directoryFilter;else delete record.directoryFilter;
  if(r.status==='owner-approved')record.approval='Site owner selected this URL and scope on '+r.checked;
  indexed.set(key(target),record);
  if(r.status==='owner-approved')approved.push(record);
  verified++;
 }
}
// A selected current URL also replaces older links under canonical aliases.
// Otherwise merging a corrected department can create conflicting destinations.
const canonical=r=>{
 const c=schools.canonColumns({institution:r.institution,school:r.school,unit:r.department});
 return JSON.stringify([schools.institutionKey(c.institution),schools.fold(c.school),schools.fold(c.unit)]);
};
for(const chosen of approved)for(const record of indexed.values()){
 if(canonical(record)!==canonical(chosen))continue;
 record.facultyUrl=chosen.facultyUrl;
 record.approval=chosen.approval;
 if(chosen.directoryFilter)record.directoryFilter=chosen.directoryFilter;else delete record.directoryFilter;
}
links.records=[...indexed.values()];
fs.writeFileSync(new URL('map-department-links.json',base),JSON.stringify(links,null,2)+'\n');
console.log(JSON.stringify({verifiedReviews:verified,officialLinkRecords:links.records.length}));
