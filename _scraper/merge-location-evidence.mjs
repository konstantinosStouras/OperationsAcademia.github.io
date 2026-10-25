import fs from 'node:fs';
const target=new URL('../data/school-map-locations.json',import.meta.url);
const data=JSON.parse(fs.readFileSync(target,'utf8'));
const researchIds=new Map();
for(const range of ['0-179','180-359','360-539','540-713']){
 const file=new URL(`../data/location-evidence-${range}.json`,import.meta.url);
 if(!fs.existsSync(file))continue;
 for(const record of JSON.parse(fs.readFileSync(file,'utf8')).records){
  if(researchIds.has(record.id))throw new Error(`Duplicate research record ${record.id} in ${researchIds.get(record.id)} and ${range}; distinct directory aliases must retain their own records.`);
  researchIds.set(record.id,range);
  const index=data.records.findIndex(r=>r.id===record.id);
  if(index<0)data.records.push(record);else data.records[index]=record;
 }
}
const rows=new Map();
for(const r of data.records)for(const id of r.rowIds){
 if(rows.has(id)&&(!r.locationGroup||r.locationGroup!==rows.get(id).locationGroup||!r.locationGroupSource))throw new Error(`Unexplained multiple location records for ${id}`);
 rows.set(id,r);
}
fs.writeFileSync(target,JSON.stringify(data,null,2)+'\n');
console.log(`Merged ${data.records.length} verified records covering ${rows.size} directory rows.`);
