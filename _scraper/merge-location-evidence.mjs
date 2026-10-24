import fs from 'node:fs';
const target=new URL('../data/school-map-locations.json',import.meta.url);
const data=JSON.parse(fs.readFileSync(target,'utf8'));
for(const range of ['0-179','180-359','360-539','540-713']){
 const file=new URL(`../data/location-evidence-${range}.json`,import.meta.url);
 if(!fs.existsSync(file))continue;
 for(const record of JSON.parse(fs.readFileSync(file,'utf8')).records){
  const index=data.records.findIndex(r=>r.id===record.id);
  if(index<0)data.records.push(record);else data.records[index]=record;
 }
}
const rows=new Set();
for(const r of data.records)for(const id of r.rowIds){
 if(rows.has(id))throw new Error(`Multiple location records for ${id}`);
 rows.add(id);
}
fs.writeFileSync(target,JSON.stringify(data,null,2)+'\n');
console.log(`Merged ${data.records.length} verified records covering ${rows.size} directory rows.`);
