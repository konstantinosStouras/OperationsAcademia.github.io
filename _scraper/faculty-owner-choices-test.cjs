const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,'data',name),'utf8'));
const schools=require('../assets/oa-schools.js');
const model=require('../assets/oa-map-model.js');

(async()=>{
  const {buildDirectory}=await import('./directory-model.mjs');
  const {attachMapLocations,attachDepartmentLinks}=await import('./map-directory.mjs');
  const directory=read('directory.json'), map=read('university-map.json');
  const links=read('map-department-links.json').records;
  const manifest=read('faculty-link-review/manifest.json').records;
  const original=id=>manifest.find(r=>r.id==='faculty-'+String(id).padStart(4,'0'));
  const key=schools.institutionKey;
  const institutionIs=(row,name)=>key(row.institution)===key(name);
  const removed=[93,143,157,170,177,179,182,193,227,233,235,302,333,341,392,511,586,628];
  const entire=['Chatham University','Lake Erie College','Lenoir-Rhyne University','Lone Star College System'];
  // These are the owner's selected destinations, rather than URLs copied from
  // the generated approval audit. Test them on the actual consolidated cards.
  const accepted=[
    [50,'https://www.bitsom.edu.in/faculty-directory/'],
    [128,'https://dsu.edu/directory/college-of-business-and-information-systems.html'],
    [196,'https://www.isu.edu/management/our-faculty/'],
    [208,'https://www.ivybusiness.iastate.edu/directory/?LName=&Department=ISBA'],
    [209,'https://www.ivybusiness.iastate.edu/directory/?LName=&Department=SCM'],
    [220,'https://www.kimep.kz/bang-college-of-business/en/'],
    [221,'https://case.ku.edu.tr/en/about/faculty/'],
    [222,'https://eng.ku.edu.tr/en/industrial-engineering/people/faculty/'],
    [225,'https://www.klu.org/faculty-research/faculty/resident-faculty'],
    [246,'https://miamioh.edu/fsb/directory/?up=/query/all/all/Information_Systems_and_Analytics/Faculty'],
    [250,'https://www.microsoft.com/applied-sciences/people'],
    [274,'https://stern.nyuad.nyu.edu/programs-admissions/faculty/'],
    [483,'https://www.colorado.edu/business/ms-programs/masters-program-business-analytics/ms-business-analytics-faculty'],
    [615,'https://olin.washu.edu/faculty-and-research/faculty-directory/index.php?area=Supply%20Chain%20Operations%20%26%20Technology']
  ];
  function render(rows){
    const cards=new Map();
    for(const row of rows){
      const institution=map.rowInstitutions[row.id]||row.institution;
      if(!cards.has(institution))cards.set(institution,{id:institution,institution,schools:[],countries:[]});
      const card=cards.get(institution);
      card.countries=[...new Set(card.countries.concat(row.countries||[],row.country||[]).filter(Boolean))];
      let school=card.schools.find(s=>s.name===(row.school||''));
      if(!school){school={name:row.school||'',rows:[]};card.schools.push(school);}
      school.rows.push(row);
    }
    const historic=new Map();
    for(const item of map.historic){if(!historic.has(item.key))historic.set(item.key,[]);historic.get(item.key).push(item);}
    const prepared=model.prepareData({...map,directory:rows,locations:new Map(map.locations.map(v=>[v.key,v])),historic});
    return model.mergeSchoolLocations(model.consolidatePoints([...cards.values()].flatMap(card=>model.pointsFor(card,prepared)),map.verified),map.verified,{schoolAliases:map.schoolAliases});
  }
  const points=render(directory);
  const kuhne=points.find(p=>/hne Logistics/.test(p.card.institution));
  assert.ok(model.pointMatchScore(kuhne,'Kühne Logistics University','','Operations and Technology — Operations Management and Business Analytics')>0,'canonical full department title opens Kühne card');
  assert.equal(model.pointMatchScore(kuhne,'Kühne Logistics University','','Unrelated Department'),0,'canonical title matching does not broaden to unrelated units');
  const displayed=points.flatMap(p=>p.card.schools.flatMap(s=>s.rows.map(row=>({point:p,school:s.name,row}))));
  const displayFor=id=>displayed.filter(v=>institutionIs(v.point.card,original(id).institution)||
    (v.row.mapSources||[]).some(s=>original(id).sourceRows.some(old=>institutionIs(s,old.institution))));
  for(const name of entire){
    assert.ok(!directory.some(r=>institutionIs(r,name)),name+' excluded from directory');
    assert.ok(!points.some(p=>institutionIs(p.card,name)),name+' excluded from cards');
    // Entire-school exclusions must survive a new posting for an unseen unit,
    // not just filter the exact historical row that prompted the decision.
    assert.equal(buildDirectory({jobs:[{institution:name,school:'New school',unit:'New department'}],members:[name]}).rows.length,0,name+' cannot be recreated');
  }
  const legacy={
    143:[['HEC Paris','','AI']],157:[['FLAME University','','BA'],['FLAME University','','OM']],
    170:[['Georgia Military College','','Supply Chain and Logistics Systems']],177:[['Goldey-Beacom College','','BA']],
    182:[['Harris-Stowe State University','Anheuser-Busch School of Business','Management Information Systems']],
    233:[['Lenoir-Rhyne University','','OM']],
    302:[['Park University','','SCM, Analytics'],['Park University','','Stat, Analytics and SCM'],['Park University','Robert W. Plaster School of Business','Information Systems and Business Analytics']],
    341:[['Rutgers University','','AI/ML/DS/Stats']],
    392:[['Taejae University','School of Arts, Sciences and Technology','Business Innovation']],
    586:[['University of Waikato','Business School','Supply Chain Management']],628:[['Wingate University','','DA/BA./Business Stat']]
  };
  for(const id of removed){
    const record=original(id),oldIds=new Set(record.rowIds),evidenceIds=new Set(record.evidenceIds);
    assert.ok(!directory.some(r=>oldIds.has(r.id)),record.institution+' obsolete row removed');
    assert.ok(!map.verified.some(r=>evidenceIds.has(r.id)),record.institution+' obsolete location removed');
    assert.ok(!displayed.some(v=>(v.row.mapSources||[]).some(s=>oldIds.has(s.rowId))),record.institution+' obsolete row cannot survive map consolidation');
    const variants=[[record.institution,record.school,record.department],...record.sourceRows.map(r=>[r.institution,r.school,r.department]),...(legacy[id]||[])];
    for(const [institution,school,unit] of variants){
      const fresh=buildDirectory({jobs:[{institution,school,unit,posted:'2030-01-01'}],past:[{institution,school,unit}],archive:[{institution,school,department:unit}]}).rows;
      assert.equal(fresh.length,0,'rejected future/source alias cannot recreate '+JSON.stringify([institution,school,unit]));
    }
  }
  assert.ok(directory.some(r=>/HEC Paris/.test(r.institution)),'HEC Paris itself remains');
  assert.ok(directory.some(r=>institutionIs(r,'Howard University')&&/BA|Business Analytics/.test(r.department||'')&&r.facultyUrl),'verified Howard business row remains');
  assert.ok(directory.some(r=>/Rutgers/.test(r.institution)&&/Supply Chain Management/.test(r.department||'')&&r.facultyUrl),'Rutgers business departments remain');
  assert.ok(directory.some(r=>institutionIs(r,'University of Macau')&&/Accounting/.test(r.department||'')&&r.facultyUrl),'Macau accounting remains');
  for(const [id,url] of accepted){
    assert.ok(displayFor(id).some(v=>v.row.facultyUrl===url&&!v.row.suppressFacultyLink),'owner-approved faculty link reaches rendered card: '+id);
  }
  const departments=id=>displayFor(id).map(v=>v.row.department||'');
  assert.ok(departments(196).includes('Management'),'Idaho displays Management');
  assert.ok(!departments(196).some(d=>/Marketing and Management/i.test(d)),'Idaho combined Marketing label removed');
  assert.ok(departments(246).includes('Department of Information Systems and Analytics'),'Miami displays corrected department');
  assert.ok(!departments(246).some(d=>/Information Systems and Technology/i.test(d)),'Miami obsolete label removed');
  assert.ok(departments(615).includes('Supply Chain, Operations and Technology'),'Olin displays academic area');
  assert.ok(!departments(615).some(d=>/Boeing Center/i.test(d)),'Olin centre is not a department');
  const abdullah=displayed.filter(v=>/Abdullah Al Salem/.test(v.point.card.institution));
  assert.ok(abdullah.length,'Abdullah Al Salem remains listed');
  assert.ok(abdullah.every(v=>!v.row.facultyUrl),'no unverified Abdullah faculty URL invented');
  // Fresh postings use both old and corrected labels. They must coalesce into
  // the same department and reuse its selected faculty URL and physical card.
  const aliasCases=[
    ['Miami University','','Information Systems and Technology','Farmer School of Business','Department of Information Systems and Analytics',246],
    ['Idaho State University','College of Business','Marketing and Management','College of Business','Management',196],
    ['Washington University in St. Louis','Olin Business School','Boeing Center for Supply Chain Innovation','Olin Business School','Supply Chain, Operations and Technology',615]
  ];
  for(const [institution,oldSchool,oldUnit,school,unit,id] of aliasCases){
    const jobs=[{institution,school:oldSchool,unit:oldUnit},{institution,school,unit}];
    const rows=buildDirectory({jobs}).rows;
    assert.equal(rows.length,1,institution+' old and new posting aliases create one department');
    attachMapLocations(rows,map.verified,map.schoolAliases);
    attachDepartmentLinks(rows,map.verified,map.schoolAliases,links);
    const future=render(rows),url=accepted.find(v=>v[0]===id)[1];
    assert.equal(future.length,1,institution+' aliases share one map location');
    assert.ok(future[0].card.schools.flatMap(s=>s.rows).some(r=>r.facultyUrl===url),institution+' future posting inherits the selected roster');
  }
  console.log('All 33 owner decisions: 14 approved faculty URLs, 18 removals, retained unlinked school, scoped preservation, and future posting aliases passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
