import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), model=require('../assets/oa-map-model.js'), S=require('../assets/oa-schools.js');
const read=name=>JSON.parse(fs.readFileSync(new URL(name,import.meta.url),'utf8'));
// The builders omit explicitly excluded locations from both the directory and
// the served map. Historical evidence may remain in this source file.
const verified=read('../data/school-map-locations.json').records.filter(r=>!S.directoryExcluded(r));
const directory=read('../data/directory.json');
const rows=Array.isArray(directory)?directory:directory.rows;
const seen=new Map(), ids=new Set();
assert.equal(model.displayName('WU Vienna'),'Vienna University of Economics and Business');
for(const v of verified){
 assert.ok(v.id&&!ids.has(v.id),'unique location identity');ids.add(v.id);
 assert.ok(model.located(v),v.id+' coordinates');
 for(const field of ['institution','address','addressSource','coordinateSource','checked'])assert.ok(v[field],v.id+' '+field);
 assert.ok(v.building||(v.locationPrecision==='campus'&&v.campusLabel),v.id+' building or labelled campus');
 assert.match(v.checked,/^\d{4}-\d{2}-\d{2}$/);
 for(const field of ['addressSource','coordinateSource'])assert.equal(new URL(v[field]).protocol,'https:');
 assert.ok(v.rowIds.length);
 if(v.locationPrecision==='campus')assert.ok(v.locationContext,v.id+' explains campus fallback');
 for(const id of v.rowIds){
  if(seen.has(id)) {
   const previous=seen.get(id);
   const sameBuilding=v.building&&v.building===previous.building&&
    S.institutionKey(v.institution)===S.institutionKey(previous.institution)&&
    Math.hypot(v.lat-previous.lat,v.lng-previous.lng)<0.0001;
   const grouped=v.locationGroup&&v.locationGroup===previous.locationGroup;
   assert.ok(sameBuilding||grouped,'ambiguous location for '+id);
   if(grouped)assert.equal(new URL(v.locationGroupSource).protocol,'https:');
  }
  seen.set(id,v);
  // Reviewed evidence retains its original row ids after a department rename.
  // The builder records the resolved location on the canonical current row.
  const row=rows.find(r=>r.id===id||(r.sourceRowIds||[]).includes(id))||
   rows.find(r=>(r.mapLocationIds||[]).includes(v.id));
  assert.ok(row,'unknown directory row or canonical location route '+id);
  // Evidence may retain a legacy school/campus label after the directory
  // adopts the university's official name. The builder's explicit location
  // association is authoritative for those reviewed relationships.
  assert.ok([v.institutionKey,v.institution].filter(Boolean).some(name=>
    S.institutionKey(row.institution)===S.institutionKey(name)) ||
    (row.mapLocationIds||[]).includes(v.id),'institution or verified canonical location route '+v.id);
  if(v.country) assert.ok((row.countries||[row.country]).includes(v.country),'verified campus country reaches directory filters: '+v.id);
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
const campusPoint=model.pointsFor(card,{...data,verified:[{...source,locationPrecision:'campus'}]}).find(p=>p.lat===40);
assert.ok(campusPoint.approximate&&campusPoint.locationVerified,'official campus evidence must not claim an exact department building');
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
const multi=model.pointsFor(card,{...data,verified:[{...source,locationGroup:'eligible-hosts'}, {...source,id:'another-host',locationGroup:'eligible-hosts',school:'Science',department:'Computer Science',lat:42}]});
assert.equal(multi.filter(p=>p.locationGroup==='eligible-hosts').length,2,'one posting can have two explicitly evidenced hosts');
assert.ok(multi.filter(p=>p.locationGroup).every(p=>model.matchesRow(p.card.schools[0].rows[0],'Engineering','Systems')),'each eligible host retains the original posting link');
assert.equal(card.schools[0].rows[0].department,'Systems','additional locations do not mutate the original row');
