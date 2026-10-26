import fs from 'node:fs';
const base=new URL('../data/',import.meta.url);
const read=name=>JSON.parse(fs.readFileSync(new URL(name,base),'utf8'));
const manifest=new Map(read('faculty-link-review/manifest.json').records.map(r=>[r.id,r]));
const links=read('map-department-links.json');
const key=r=>JSON.stringify([r.institution,r.school,r.department]);
const indexed=new Map(links.records.map(r=>[key(r),r]));
let verified=0;
for(let i=0;i<4;i++){
 const file=new URL(`faculty-link-review/results-${i}.json`,base);
 if(!fs.existsSync(file))continue;
 for(const r of JSON.parse(fs.readFileSync(file,'utf8')).records){
  const original=manifest.get(r.id);
  if(!original||key(original)!==key(r))throw Error('Review identity mismatch: '+r.id);
  if(r.status!=='verified'){
    if(indexed.get(key(r))?.reviewId===r.id)indexed.delete(key(r));
    continue;
  }
  if(!/^https:\/\//.test(r.facultyUrl)||!r.sources?.length||!r.checked||!r.evidence)throw Error('Incomplete verification: '+r.id);
  const existing=indexed.get(key(r))||{};
  indexed.set(key(r),{...existing,institution:r.institution,school:r.school,department:r.department,facultyUrl:r.facultyUrl,sources:r.sources,checked:r.checked,notes:[r.notes,r.evidence].filter(Boolean).join(' '),...(r.directoryFilter?{directoryFilter:r.directoryFilter}:{}),reviewId:r.id});
  verified++;
 }
}
links.records=[...indexed.values()];
fs.writeFileSync(new URL('map-department-links.json',base),JSON.stringify(links,null,2)+'\n');
console.log(JSON.stringify({verifiedReviews:verified,officialLinkRecords:links.records.length}));
