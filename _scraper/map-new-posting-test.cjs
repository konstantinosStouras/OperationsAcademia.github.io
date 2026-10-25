const assert=require('node:assert/strict');
const model=require('../assets/oa-map-model.js');
const schools=require('../assets/oa-schools.js');

(async()=>{
  const college='College of Science, Engineering and Technology';
  assert.deepEqual(schools.canonColumns({institution:'Minnesota State University, Mankato',school:college,unit:'Computer Information Science'}),
    {institution:'Minnesota State University, Mankato',school:college,unit:'Computer Information Science'});
  assert.equal(schools.splitFused(college).school,college,'commas within an official college name do not invent another school');
  assert.deepEqual(schools.splitFused(college+', Computer Information Science'),{school:college,unit:'Computer Information Science'});
  const {attachMapLocations}=await import('./map-directory.mjs');
  const university='Routing Integration University';
  const evidence=(id,department,extra={})=>({id,institution:university,school:'Business School',department,lat:40,lng:-80,address:id+' address',rowIds:[id+'-row'],country:'United States',...extra});
  const row=(id,department,extra={})=>({id,institution:university,school:'Business School',department,country:'United States',type:'Business School',n:1,...extra});
  function render(rows,verified,aliases=[]){
    const cards=new Map();
    for(const r of rows){
      if(!cards.has(r.institution))cards.set(r.institution,{id:'university:'+r.institution,institution:r.institution,schools:[],countries:[]});
      const card=cards.get(r.institution);
      card.countries=[...new Set(card.countries.concat(r.countries||[],r.country||[]).filter(Boolean))];
      let school=card.schools.find(s=>s.name===r.school);
      if(!school){school={name:r.school,rows:[]};card.schools.push(school);}
      school.rows.push(r);
    }
    const locations=new Map(Array.from(cards.values(),card=>[schools.institutionKey(card.institution),{lat:50,lng:-80}]));
    const data=model.prepareData({verified,directory:rows,schoolAliases:aliases,locations,historic:new Map(),rowInstitutions:{}});
    return model.mergeSchoolLocations(model.consolidatePoints(Array.from(cards.values()).flatMap(card=>model.pointsFor(card,data)),verified),verified,{schoolAliases:aliases});
  }
  const sourceRows=point=>point.card.schools.flatMap(s=>s.rows.flatMap(r=>r.mapSources||[]));
  const pointFor=(points,id)=>points.find(point=>sourceRows(point).some(source=>source.rowId===id));
  const displayRow=(point,id)=>point.card.schools.flatMap(s=>s.rows).find(r=>(r.mapSources||[]).some(source=>source.rowId===id));

  // A newly exported department reuses its known school without changing the
  // evidence or presenting that school's address as a verified departmental office.
  const base=[evidence('business-office','')];
  const fresh=[row('business-office-row',''),row('incoming-analytics','New Analytics')];
  const before=JSON.stringify(base);
  attachMapLocations(fresh,base);
  assert.equal(fresh[1].mapLocationKind,'school');
  assert.deepEqual(fresh[1].mapLocationIds,['business-office']);
  const freshPoints=render(fresh,base);
  assert.equal(freshPoints.length,1,'new department adds no duplicate school marker');
  assert.equal(displayRow(freshPoints[0],'incoming-analytics').department,'New Analytics');
  assert.equal(displayRow(freshPoints[0],'incoming-analytics').locationReference,'school');
  assert.equal(sourceRows(freshPoints[0]).find(s=>s.rowId==='incoming-analytics').locationReference,'school');
  assert.ok(model.pointMatchScore(freshPoints[0],university,'Business School','New Analytics')>0);
  assert.equal(JSON.stringify(base),before,'new postings never rewrite reviewed evidence');
  assert.ok(!base[0].rowIds.includes('incoming-analytics'),'inferred routing stays separate from verified row membership');

  // A new row using an established department alias receives the exact office.
  const operations=[evidence('operations','Operations Management')];
  const aliasRows=[row('operations-row','OM',{school:'Legacy Business'}),row('new-operations','OM',{school:'School of Business'})];
  const aliases=[{institution:university,school:'Business School',aliases:['Business School','School of Business']}];
  attachMapLocations(aliasRows,operations,aliases);
  assert.equal(aliasRows[1].mapLocationKind,'department');
  assert.deepEqual(aliasRows[1].mapLocationIds,['operations']);
  const aliasPoints=render(aliasRows,operations,aliases);
  assert.equal(aliasPoints.length,1);
  assert.equal(aliasPoints[0].card.schools[0].rows.length,1,'department aliases share one row');
  assert.equal(displayRow(aliasPoints[0],'new-operations').department,'Operations Management');
  assert.equal(sourceRows(aliasPoints[0]).find(s=>s.rowId==='new-operations').locationReference,undefined);
  assert.ok(model.pointMatchScore(aliasPoints[0],university,'School of Business','OM')>0,'original posting alias still targets the shared card');

  // Several established school campuses stay separate and offer a common route
  // group, rather than arbitrarily assigning a future department to one campus.
  const campuses=[evidence('campus-main',''),evidence('campus-remote','',{lat:45,lng:-75,country:'Canada'})];
  const multiRows=[row('campus-main-row',''),row('campus-remote-row','',{country:'Canada'}),row('multi-new','Emerging Analytics')];
  attachMapLocations(multiRows,campuses);
  assert.equal(multiRows[2].mapLocationKind,'school');
  assert.deepEqual(multiRows[2].mapLocationIds,['campus-main','campus-remote']);
  assert.deepEqual(multiRows[2].countries.slice().sort(),['Canada','United States']);
  const multiPoints=render(multiRows,campuses);
  assert.equal(multiPoints.length,2,'both campus cards are retained without extra inferred pins');
  const groups=multiPoints.map(point=>model.locationGroupsForTarget(point,university,'Business School','Emerging Analytics',campuses));
  assert.ok(groups[0].length&&groups[0].some(group=>groups[1].includes(group)),'new multi-campus posting has a common chooser group');
  multiPoints.forEach(point=>assert.equal(displayRow(point,'multi-new').department,'Emerging Analytics'));

  // A reviewed location with no country on its original row may inherit the
  // unique institutional country; aliases must not split the same physical card.
  const countryEvidence=[evidence('michigan-office','',{institution:'University of Michigan',institutionKey:'University of Michigan at Ann Arbor',rowIds:['old-campus'],country:undefined,lat:42,lng:-83})];
  delete countryEvidence[0].country;
  const countryRows=[
    row('old-campus','',{institution:'University of Michigan at Ann Arbor',country:''}),
    row('country-source','Other unit',{institution:'University of Michigan',school:'Engineering School'}),
    row('country-new','New Analytics',{institution:'University of Michigan',country:''})
  ];
  attachMapLocations(countryRows,countryEvidence);
  assert.equal(countryRows[0].country,'United States','reviewed original row inherits unique institution country');
  assert.equal(countryRows[2].country,'United States','new route receives the same inferred country');
  const countryPoints=render(countryRows,countryEvidence);
  assert.equal(pointFor(countryPoints,'old-campus').card.id,pointFor(countryPoints,'country-new').card.id,'country inference does not create a duplicate school card');
  const runtimeRows=[
    row('old-campus','',{institution:'University of Michigan at Ann Arbor'}),
    row('runtime-new','New Analytics',{institution:'University of Michigan',country:'Canada'})
  ];
  const runtimePoints=render(runtimeRows,countryEvidence);
  assert.equal(pointFor(runtimePoints,'old-campus').card.id,pointFor(runtimePoints,'runtime-new').card.id,'runtime routing does not split a known school by an unrelated posting country');
  assert.equal(pointFor(runtimePoints,'runtime-new').country,'United States','the reused location keeps its evidenced country');

  const unknown=[row('business-office-row',''),row('unknown-school','New Analytics',{school:'Medical School'})];
  attachMapLocations(unknown,base);
  assert.equal(unknown[1].mapLocationKind,'unresolved');
  assert.deepEqual(unknown[1].mapLocationIds,[]);
  const unknownPoint=pointFor(render(unknown,base),'unknown-school');
  assert.equal(unknownPoint.locationVerified,undefined,'unknown schools do not borrow a business office');
  assert.equal(unknownPoint.school,'Medical School');
  assert.deepEqual(unknownPoint.sourceEvidenceIds,[]);
  const wrongSchool=[row('operations-row','Operations Management'),row('wrong-school-same-dept','Operations Management',{school:'Medical School'})];
  attachMapLocations(wrongSchool,operations);
  assert.equal(wrongSchool[1].mapLocationKind,'unresolved','matching department words do not override a different school');
  assert.deepEqual(pointFor(render(wrongSchool,operations),'wrong-school-same-dept').sourceEvidenceIds,[]);

  const edited=[row('business-office-row',''),row('edited-new','Human correction',{_edit:{fields:['department']},mapLocationIds:['business-office'],mapLocationKind:'school'})];
  attachMapLocations(edited,base);
  assert.equal(edited[1].mapLocationKind,'unresolved');
  assert.deepEqual(edited[1].mapLocationIds,[],'manual correction invalidates stored inferred routing');
  const editedPoint=pointFor(render(edited,base),'edited-new');
  assert.equal(editedPoint.locationVerified,undefined);
  assert.equal(displayRow(editedPoint,'edited-new').department,'Human correction');
  assert.equal(displayRow(editedPoint,'edited-new').locationEdited,true);
  const editedExact=[row('operations-row','Operations Management',{school:'Medical School',_edit:{fields:['school']}})];
  attachMapLocations(editedExact,operations);
  assert.equal(editedExact[0].mapLocationKind,'unresolved','an edited school does not inherit even an exact historical row route');
  assert.deepEqual(pointFor(render(editedExact,operations),'operations-row').sourceEvidenceIds,[]);
  const renamedExact=[row('operations-row','Human department name correction',{_edit:{fields:['department']}})];
  attachMapLocations(renamedExact,operations);
  const renamedPoint=pointFor(render(renamedExact,operations),'operations-row');
  assert.deepEqual(renamedPoint.sourceEvidenceIds,['operations'],'renaming an established department preserves its exact reviewed office');
  assert.equal(displayRow(renamedPoint,'operations-row').department,'Human department name correction');
  console.log('New postings: existing school reuse, department aliases, multi-campus choices, country consistency, unknown schools and manual corrections passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
