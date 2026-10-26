import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const routing=require('../assets/oa-map-routing.js');
const schools=require('../assets/oa-schools.js');

// Derived routing is rebuilt with every posting export; the evidence stays immutable.
export function attachMapLocations(rows,verified,schoolAliases=[]){
  const resolver=routing.createResolver({verified,directory:rows,schoolAliases});
  const byId=new Map(verified.map(v=>[v.id,v]));
  const evidenceCountries=routing.evidenceCountries(verified,rows);
  for(const row of rows){
    let route=resolver.resolve(row);
    if(route.kind==='school'&&Number.isFinite(row.lat)&&Number.isFinite(row.lng))route={ids:[],kind:'unresolved'};
    row.mapLocationIds=route.ids;
    row.mapLocationKind=route.kind;
    const aliasTerms=(row.sourceRowAliases||[]).flatMap(alias=>[alias.school,alias.department]).filter(Boolean);
    if(aliasTerms.length)row.mapSearchTerms=[...new Set(aliasTerms)];
    const locations=route.ids.map(id=>byId.get(id));
    if(!locations.length)continue;
    row.mapInstitutionNames=[...new Set(locations.map(v=>v.institution).filter(Boolean))];
    row.mapSearchTerms=[...new Set(locations.flatMap(v=>route.kind==='school'?[v.school]:[v.school,v.department]).concat(aliasTerms).filter(Boolean))];
    const countries=[...new Set(locations.flatMap(v=>evidenceCountries.get(v.id)).filter(Boolean))];
    if(countries.length){
      row.country=countries.length===1?countries[0]:'';
      if(countries.length>1)row.countries=countries;else delete row.countries;
    }
  }
  return rows;
}

// Links belong to academic units, not to their nearby physical school card.
// A school-reference route never authorizes another department's faculty link.
export function attachDepartmentLinks(rows,verified,schoolAliases=[],officialLinks=[]){
  const resolver=routing.createResolver({verified,directory:rows,schoolAliases});
  const byId=new Map(verified.map(v=>[v.id,v]));
  const schoolNames=new Map();
  for(const alias of schoolAliases)for(const name of [...alias.aliases,alias.school]){
    schoolNames.set(schools.institutionKey(alias.institution)+'|'+schools.fold(name),alias.school);
  }
  function identity(institution,school,department){
    const c=schools.canonColumns({institution,school:school||'',unit:department||''});
    if(!c.unit)return null;
    const key=schools.institutionKey(c.institution);
    const schoolName=schoolNames.get(key+'|'+schools.fold(c.school))||c.school;
    return JSON.stringify([key,schools.fold(schoolName),schools.fold(c.unit)]);
  }
  const keys=new Map();
  for(const row of rows){
    const route=resolver.resolve(row);
    let identities=[];
    if(route.kind==='exact'||route.kind==='department'){
      identities=route.ids.map(id=>byId.get(id)).filter(v=>v&&v.department)
        .map(v=>identity(v.institution,v.school,v.department));
    }else if(route.kind!=='school'){
      identities=[identity(row.institution,row.school,row.department||row.unit)];
    }
    identities=[...new Set(identities.filter(Boolean))];
    // Multiple eligible departments are not interchangeable link targets.
    keys.set(row,identities.length===1?identities[0]:null);
  }
  const overrides=new Map();
  for(const record of officialLinks){
    const key=identity(record.institution,record.school,record.department);
    if(!key)continue;
    const held=overrides.get(key)||{};
    for(const field of ['deptUrl','facultyUrl'])if(record[field]){
      if(held[field]&&held[field]!==record[field])throw new Error('Conflicting official department links: '+key+' '+field);
      held[field]=record[field];
    }
    if(record.facultyUrl){
      const filter=record.directoryFilter;
      const hint=typeof filter==='string'?filter:filter&&filter.instructions
        ?(Array.isArray(filter.labels)?filter.labels.join('; ')+'. ':'')+filter.instructions
        :filter&&filter.label?'Select '+filter.label+' in the directory.':'';
      if(hint)held.facultyDirectoryHint=hint;
      else delete held.facultyDirectoryHint;
    }
    overrides.set(key,held);
  }
  // Apply reviewed overrides before collecting consensus, so a known obsolete
  // URL cannot defeat a reviewed replacement or spread to another alias.
  for(const row of rows){
    // One broad advert may represent several independently verified units.
    // Keep each roster attached to its location identity, not to the whole advert.
    const route=resolver.resolve(row), scoped={};
    for(const id of route.ids){
      const v=byId.get(id);if(!v)continue;
      const department=route.kind==='school'?(row.department||row.unit):(v.department||row.department||row.unit);
      const link=overrides.get(identity(v.institution,v.school,department));
      if(link)scoped[id]={...link};
    }
    if(Object.keys(scoped).length)row.mapDepartmentLinks=scoped;else delete row.mapDepartmentLinks;
      // A school-level location route can still have a separately reviewed
      // department roster. Use its own exact identity, never a nearby unit.
      const official=overrides.get(keys.get(row))||overrides.get(identity(row.institution,row.school,row.department||row.unit));
    if(!official)continue;
    for(const field of ['deptUrl','facultyUrl'])if(official[field])row[field]=official[field];
    if(official.facultyUrl){
      if(official.facultyDirectoryHint)row.facultyDirectoryHint=official.facultyDirectoryHint;
      else delete row.facultyDirectoryHint;
    }
    if(official.deptUrl)delete row.deptUrlInherited;
    if(official.facultyUrl)delete row.suppressFacultyLink;
  }
  const known=new Map();
  for(const row of rows){
    const key=keys.get(row);if(!key)continue;
    if(!known.has(key))known.set(key,{deptUrl:new Set(),facultyUrl:new Set()});
    const group=known.get(key);
    for(const field of ['deptUrl','facultyUrl'])if(row[field]&&!(field==='facultyUrl'&&row.suppressFacultyLink))group[field].add(row[field]);
  }
  for(const row of rows){
    const group=known.get(keys.get(row));if(!group)continue;
    for(const field of ['deptUrl','facultyUrl']){
      if(row[field]||(field==='facultyUrl'&&row.suppressFacultyLink))continue;
      if(group[field].size===1){
        row[field]=Array.from(group[field])[0];
        if(field==='deptUrl')row.deptUrlInherited=true;
      }
    }
  }
  return rows;
}
