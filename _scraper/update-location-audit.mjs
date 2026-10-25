// Source discovery is deliberately separate from location verification.
// Optional argument: directory containing saved location-research-*.json searches.
import fs from 'node:fs';
import path from 'node:path';
const auditFile=new URL('./location-audit.json',import.meta.url);
const audit=JSON.parse(fs.readFileSync(auditFile,'utf8'));
const evidence=JSON.parse(fs.readFileSync(new URL('../data/school-map-locations.json',import.meta.url),'utf8')).records;
const researchDirectory=process.argv[2];
const searches=new Map();
if(researchDirectory){
 for(const name of fs.readdirSync(researchDirectory).filter(n=>/^location-research-\d+\.json$/.test(n))){
  for(const entry of JSON.parse(fs.readFileSync(path.join(researchDirectory,name),'utf8')))searches.set(entry.id,entry);
 }
}
for(const record of audit.records){
 const matched=evidence.filter(v=>v.rowIds.some(id=>record.rowIds.includes(id)));
 // A confirmed office at one campus does not complete a known multi-campus group.
 const covered=new Set(matched.filter(v=>v.verificationScope!=='partial-group-location').flatMap(v=>v.rowIds));
 record.status=record.verificationExcluded?'excluded-by-user':record.rowIds.every(id=>covered.has(id))?(matched.some(v=>v.locationPrecision==='campus')?'resolved-at-campus':'verified'):matched.length?'partially-verified':'pending';
 if(matched.length)record.verificationIds=matched.map(v=>v.id);
 const search=searches.get(record.id);
 if(search){
  const candidates=[...String(search.result).matchAll(/^.*?\((https?:\/\/[^\s]+)\)\s*$/gm)].map(m=>m[1]);
  record.sourceSearch={date:'2026-10-23',status:candidates.length?'candidates-found':'no-candidate-captured',candidates:[...new Set(candidates)].slice(0,3)};
 }
}
audit.summary={baseline:audit.baselineCount,excludedByUser:audit.records.filter(r=>r.status==='excluded-by-user').length,verified:audit.records.filter(r=>r.status==='verified').length,campusFallback:audit.records.filter(r=>r.status==='resolved-at-campus').length,partiallyVerified:audit.records.filter(r=>r.status==='partially-verified').length,pending:audit.records.filter(r=>r.status==='pending').length,sourceSearches:audit.records.filter(r=>r.sourceSearch).length};
fs.writeFileSync(auditFile,JSON.stringify(audit,null,2)+'\n');
console.log(audit.summary);
