import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), model=require('../assets/oa-map-model.js'), S=require('../assets/oa-schools.js');
const read=name=>JSON.parse(fs.readFileSync(new URL(name,import.meta.url),'utf8'));
const verified=read('../data/school-map-locations.json').records;
const directory=read('../data/directory.json');
const rows=Array.isArray(directory)?directory:directory.rows;
const seen=new Set(), ids=new Set();
assert.equal(model.displayName('WU Vienna'),'Vienna University of Economics and Business');
for(const v of verified){
 assert.ok(v.id&&!ids.has(v.id),'unique location identity');ids.add(v.id);
 assert.ok(model.located(v),v.id+' coordinates');
 for(const field of ['institution','building','address','addressSource','coordinateSource','checked'])assert.ok(v[field],v.id+' '+field);
 assert.match(v.checked,/^\d{4}-\d{2}-\d{2}$/);
 for(const field of ['addressSource','coordinateSource'])assert.equal(new URL(v[field]).protocol,'https:');
 assert.ok(v.rowIds.length);
 for(const id of v.rowIds){
  assert.ok(!seen.has(id),'ambiguous location for '+id);seen.add(id);
  const row=rows.find(r=>r.id===id);assert.ok(row,'unknown directory row '+id);
  assert.equal(S.institutionKey(row.institution),S.institutionKey(v.institutionKey||v.institution));
  if(v.country) assert.equal(row.country,v.country,'verified campus country reaches directory filters: '+v.id);
 }
}
const card={id:'test',institution:'Test University',schools:[{name:'Engineering',rows:[
 {id:'a',department:'Systems',n:1},{id:'b',department:'Industrial',n:2},{id:'c',department:'Mechanical',n:3}
]}]};
const source={id:'first',institution:'Test University',rowIds:['a'],school:'Engineering',department:'Department of Systems',lat:40,lng:-70,address:'First building'};
const data={verified:[source,{...source,id:'second',rowIds:['b'],department:'Department of Industrial Engineering',lat:41}],rowInstitutions:{},historic:new Map(),locations:new Map([['test university',{lat:39,lng:-71}]])};
const points=model.pointsFor(card,data);
assert.equal(points.length,3);
assert.deepEqual(points.map(p=>p.card.schools[0].rows.length),[1,1,1]);
assert.ok(points.find(p=>p.lat===39).approximate,'an unverified department must retain its status');
assert.ok(model.matchesRow(points[0].card.schools[0].rows[0],'Engineering','Systems'),'old department links survive official name corrections');
assert.ok(!model.matchesRow(points[1].card.schools[0].rows[0],'Engineering','Systems'),'no cross-department match');
console.log(`${verified.length} evidence-backed locations checked; separate buildings and legacy links passed.`);

const editedCard=JSON.parse(JSON.stringify(card));
editedCard.schools[0].rows[0].department='Community corrected department';
editedCard.schools[0].rows[0]._edit={fields:['department']};
const editedPoint=model.pointsFor(editedCard,data).find(p=>p.lat===40);
assert.equal(editedPoint.card.schools[0].rows[0].department,'Community corrected department','explicit community edits take precedence over verified names');
assert.equal(editedPoint.card.schools[0].name,'Engineering','unedited verified school remains intact');
assert.equal(editedPoint.lng,-70,'name corrections preserve verified coordinates');
