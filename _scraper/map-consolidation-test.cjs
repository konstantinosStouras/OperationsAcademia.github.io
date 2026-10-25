const assert=require('node:assert/strict');
const model=require('../assets/oa-map-model.js');
const records=[
{id:'primary',locationIdentity:'primary',institution:'Official University',institutionKey:'Alias One',school:'Business',department:'Operations',lat:40,lng:-80,address:'Canonical building'},
{id:'secondary',locationIdentity:'primary',institution:'Official University',institutionKey:'Alias Two',school:'Business',department:'Operations',lat:40.00001,lng:-80,address:'Legacy address'}
].map((v,i)=>({...v,rowIds:['row'+i]}));
function point(i,edited){return model.pointsFor({id:'card'+i,institution:'Alias '+(i?'Two':'One'),schools:[{name:i?'Legacy School':'',rows:[{id:'row'+i,department:i?'Legacy Operations':'Operations',n:3,...(edited?{_edit:{fields:['department']}}:{})}]}]}, {verified:records,locations:new Map(),historic:new Map(),rowInstitutions:{}})[0];}
const a=point(0),b=point(1),merged=model.consolidatePoints([a,b],records);
assert.equal(merged.length,1);
assert.deepEqual(merged[0].sourceEvidenceIds.sort(),['primary','secondary']);
assert.equal(merged[0].card.n,6);
assert.equal(merged[0].lat,40);
assert.equal(merged[0].address,'Canonical building');
assert.equal(model.consolidatePoints([b],records)[0].lat,40,'alias-only search uses canonical evidence not present among points');
assert.equal(model.consolidatePoints([b,a],records)[0].card.id,merged[0].card.id,'identity does not depend on input order');
assert.equal(model.consolidatePoints([a,a,b],records)[0].card.n,6,'duplicate original rows are not counted twice');
assert.ok(model.pointMatchScore(merged[0],'Alias Two','Legacy School','Legacy Operations')>0);
assert.equal(model.pointMatchScore(merged[0],'Alias One','Legacy School','Legacy Operations'),0,'one university alias cannot borrow another original row match');
assert.ok(model.pointMatchScore(merged[0],'Official University','','')>0);
assert.equal(model.pointMatchScore(merged[0],'Other University','',''),0);
assert.equal(model.pointMatchScore(merged[0],'Alias One','','Wrong Department'),0);
assert.equal(model.consolidatePoints([a,point(1,true)],records).length,2,'user-edited departments remain separate');
const unreviewed={...b,locationIdentity:undefined};
assert.equal(model.consolidatePoints([a,unreviewed],records).length,2,'no implicit geographic deduplication');
const secondDepartment={...records[1],id:'finance',department:'Finance',locationIdentity:'finance',rowIds:['finance']};
const finance=model.pointsFor({id:'finance',institution:'Alias Two',schools:[{name:'Business',rows:[{id:'finance',department:'Finance'}]}]}, {verified:[secondDepartment],locations:new Map(),historic:new Map(),rowInstitutions:{}})[0];
assert.equal(model.consolidatePoints([a,finance],records.concat(secondDepartment)).length,2,'different departments in the same building remain separate');
const schoolRecords=records.map(r=>({...r,department:''}));
const schoolPoints=[0,1].map(i=>model.pointsFor({id:'school'+i,institution:'Alias '+(i?'Two':'One'),schools:[{name:'Business',rows:[{id:'row'+i,department:i?'Supply Chain':'Operations'}]}]}, {verified:schoolRecords,locations:new Map(),historic:new Map(),rowInstitutions:{}})[0]);
const schoolMerged=model.consolidatePoints(schoolPoints,schoolRecords);
assert.equal(schoolMerged.length,1,'reviewed school-level identity merges original university aliases');
assert.equal(schoolMerged[0].card.schools[0].rows.length,2,'school-level consolidation preserves distinct original departments');
console.log('Map consolidation identity, canonical coordinates, provenance, counts, edits and deep-link tests passed.');
