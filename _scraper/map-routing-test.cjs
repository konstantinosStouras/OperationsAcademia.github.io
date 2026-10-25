const assert=require('node:assert/strict');
const {createResolver,evidenceCountries}=require('../assets/oa-map-routing.js');
const location=(id,school,department,lat=40,lng=-80,extra={})=>({id,institution:'Routing University',school,department,lat,lng,rowIds:[id+'-row'],...extra});
const verified=[
  location('business-office','Business School',''),
  location('operations','Business School','Department of Operations',40.0001,-80),
  location('engineering','Engineering School','Operations',40,-80),
  location('business-remote','Business School','Department of Operations',41,-80,{country:'Canada',locationGroup:'operations-campuses'}),
  location('other','Business School','Operations',40,-80,{institution:'Other University'}),
];
const directory=[{id:'operations-row',institution:'Routing University',school:'Legacy Business',department:'Operations Management'}];
const schoolAliases=[{institution:'Routing University',school:'Business School',aliases:['Business School','School of Business']}];
const router=createResolver({verified,directory,schoolAliases});
assert.deepEqual(router.resolve({id:'operations-row',institution:'Routing University'}),{ids:['operations'],kind:'exact'});
assert.deepEqual(router.resolve({institution:'Routing University',school:'Business School',department:'Operations Management'}),{ids:['operations'],kind:'department'});
assert.deepEqual(router.resolve({institution:'Routing University',school:'Legacy Business',department:'Operations Management'}),{ids:['operations'],kind:'department'});
assert.deepEqual(router.resolve({institution:'Routing University',school:'School of Business',department:'New Analytics'}),{ids:['business-office','business-remote'],kind:'school'});
assert.equal(router.resolve({institution:'Routing University',school:'New Medical School',department:'Analytics'}).kind,'unresolved');
assert.equal(router.resolve({institution:'Routing University',department:'Operations'}).kind,'unresolved','a shared department name does not choose between business and engineering');
assert.equal(router.resolve({institution:'Routing University',department:'New Analytics'}).kind,'unresolved');
assert.equal(router.resolve({institution:'Routing University',school:'Legacy Business',department:'New Analytics'}).kind,'unresolved','legacy department school is not authority for new departments');
assert.equal(router.resolve({id:'operations-row',institution:'Routing University',school:'Medical School',_edit:{fields:['school']}}).kind,'unresolved');
assert.equal(router.resolve({id:'operations-row',institution:'Other University'}).kind,'unresolved','row IDs cannot cross institutions');
assert.deepEqual(router.resolve({institution:'Routing University',school:'Business School',department:'Department of Operations'}),{ids:['business-remote','operations'],kind:'department'});
assert.deepEqual(router.resolve({institution:'Routing University',department:'Operations Management'}),{ids:['operations'],kind:'department'});
const ambiguous=createResolver({verified:[location('a','Business','Analytics'),location('b','Engineering','Analytics')]});
assert.equal(ambiguous.resolve({institution:'Routing University',department:'Analytics'}).reason,'ambiguous-department-school');
const chain=createResolver({verified:[location('a','Business','A',40,-80),location('b','Business','B',40.001,-80),location('c','Business','C',40.002,-80)]});
assert.equal(chain.resolve({institution:'Routing University',school:'Business',department:'New'}).ids.length,2,'complete-link avoids proximity chaining');
const explicit=createResolver({verified:[location('a','Business','A',40,-80,{mapCardIdentity:'one'}),location('b','Business','B',40.1,-80,{mapCardIdentity:'one'})]});
assert.deepEqual(explicit.resolve({institution:'Routing University',school:'Business',department:'New'}).ids,['a']);
const reversed=createResolver({verified:verified.slice().reverse(),directory,schoolAliases});
assert.deepEqual(router.resolve({institution:'Routing University',school:'Business School',department:'New'}),reversed.resolve({institution:'Routing University',school:'Business School',department:'New'}));
assert.equal(verified[0].department,'','resolver never changes the reviewed records or assigns a new department');
console.log('Map routing exact identities, aliases, school references, campuses, ambiguity and determinism passed.');
const countryEvidence=[
  {id:'michigan',institution:'University of Michigan',institutionKey:'University of Michigan at Ann Arbor',rowIds:['ann-arbor']},
  {id:'international',institution:'International School',rowIds:['unknown']},
  {id:'explicit',institution:'International School',rowIds:['france'],country:'Singapore'},
  {id:'linked',institution:'International School',rowIds:['france']},
];
const countryRows=[
  {id:'ann-arbor',institution:'University of Michigan at Ann Arbor',country:''},
  {id:'michigan-row',institution:'University of Michigan',country:'United States'},
  {id:'unknown',institution:'International School'},
  {id:'france',institution:'International School',country:'France'},
  {id:'singapore',institution:'International School',country:'Singapore'},
];
const countryMap=evidenceCountries(countryEvidence,countryRows);
assert.deepEqual(countryMap.get('michigan'),['United States']);
assert.deepEqual(countryMap.get('international'),[],'a multi-country institution has no inferred default');
assert.deepEqual(countryMap.get('explicit'),['Singapore'],'explicit evidence wins over linked directory country');
assert.deepEqual(countryMap.get('linked'),['France'],'the linked row wins over the university-wide set');
console.log('Evidence countries preserve exact locations and infer only unique institution countries.');
