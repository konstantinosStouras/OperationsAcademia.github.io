/* Deterministic reuse of reviewed map locations. A school match is a reference,
   never evidence that a newly advertised department occupies that building. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./oa-schools.js'));
  else root.OAMapRouting=factory(root.OASchools);
}(typeof window!=='undefined'?window:this,function(S){
  'use strict';
  function evidenceCountries(verified,directory){
    var byId=new Map(),byInstitution=new Map(),result=new Map();
    function countries(row){return Array.from(new Set([row.country].concat(row.countries||[]).filter(Boolean)));}
    (directory||[]).forEach(function(row){
      [row.id].concat(row.sourceRowIds||[]).filter(Boolean).forEach(function(id){byId.set(id,row);});
      var key=S.institutionKey(row.institution),values=byInstitution.get(key)||new Set();
      countries(row).forEach(function(country){values.add(country);});byInstitution.set(key,values);
    });
    (verified||[]).forEach(function(v){
      var values=v.country?[v.country]:Array.from(new Set((v.rowIds||[]).flatMap(function(id){var row=byId.get(id);return row?countries(row):[];})));
      if(!values.length){
        var names=Array.from(new Set([v.institution,v.institutionKey].filter(Boolean).map(S.institutionKey)));
        var inherited=new Set();names.forEach(function(name){(byInstitution.get(name)||[]).forEach(function(country){inherited.add(country);});});
        if(inherited.size===1)values=Array.from(inherited);
      }
      result.set(v.id,values.slice().sort());
    });
    return result;
  }
  function createResolver(options){
    options=options||{};
    var verified=(options.verified||[]).slice().sort(function(a,b){return a.id.localeCompare(b.id);});
    var directory=options.directory||[],aliases=options.schoolAliases||[];
    var folds=new Map(),institutions=new Map(),columns=new Map(),schoolNames=new Map();
    function fold(s){s=String(s||'');if(!folds.has(s))folds.set(s,S.fold(s));return folds.get(s);}
    function institution(s){s=String(s||'');if(!institutions.has(s))institutions.set(s,S.institutionKey(s));return institutions.get(s);}
    function canon(i,s,d){var k=JSON.stringify([i||'',s||'',d||'']);if(!columns.has(k))columns.set(k,S.canonColumns({institution:i||'',school:s||'',unit:d||''}));return columns.get(k);}
    aliases.forEach(function(a){var i=institution(a.institution);(a.aliases||[]).concat(a.school).forEach(function(s){schoolNames.set(i+'|'+fold(s),fold(a.school));});});
    function school(i,s){return schoolNames.get(i+'|'+fold(s))||fold(s);}
    function add(map,key,value){if(!map.has(key))map.set(key,new Set());map.get(key).add(value);}
    function entries(map,key){return Array.from(map.get(key)||[]);}
    function distinct(xs){return Array.from(new Set(xs));}
    function valid(v){return Number.isFinite(v.lat)&&Math.abs(v.lat)<=90&&Number.isFinite(v.lng)&&Math.abs(v.lng)<=180;}
    function distance(a,b){var rad=Math.PI/180;return 12742000*Math.asin(Math.min(1,Math.sqrt(Math.sin((a.lat-b.lat)*rad/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin((a.lng-b.lng)*rad/2)**2)));}
    var byDirectoryId=new Map(),byExact=new Map(),byDepartment=new Map(),bySchool=new Map(),recordSchool=new Map();
    directory.forEach(function(r){[r.id].concat(r.sourceRowIds||[]).filter(Boolean).forEach(function(id){byDirectoryId.set(id,r);});});
    verified.filter(valid).forEach(function(v){
      var originals=(v.rowIds||[]).map(function(id){return byDirectoryId.get(id);}).filter(Boolean);
      var names=distinct([v.institution,v.institutionKey].concat(originals.map(function(r){return r.institution;})).filter(Boolean));
      var official=institution(v.institution),home=school(official,v.mapCardSchool||v.school||'');
      recordSchool.set(v.id,home);
      names.forEach(function(name){
        var i=institution(name),c=canon(name,v.mapCardSchool||v.school,v.department);
        var currentSchool=school(official,v.mapCardSchool||v.school||c.school||'');
        // The school index uses the current reviewed identity, never a former
        // school attached to a legacy departmental row.
        if(currentSchool)add(bySchool,i+'|'+currentSchool,v);
        (v.rowIds||[]).forEach(function(id){add(byExact,i+'|'+id,v);});
        var pairs=[{school:v.school,department:v.department},{school:v.mapCardSchool,department:v.department}].concat(originals.flatMap(function(r){return [{school:r.school,department:r.department||r.unit}].concat(r.sourceRowAliases||[]);}));
        pairs.forEach(function(p){
          if(!p.department)return;
          var cc=canon(name,p.school,p.department),ds=distinct([fold(p.department),fold(cc.unit)]).filter(Boolean);
          var ss=distinct([school(official,p.school),school(official,cc.school),currentSchool]);
          ds.forEach(function(d){
            add(byDepartment,i+'||'+d,v);
            ss.filter(Boolean).forEach(function(s){add(byDepartment,i+'|'+s+'|'+d,v);});
          });
        });
      });
    });
    // Use the same complete-link radius as visible school cards; do not join
    // a chain of nearby buildings into a much larger, invented campus.
    function sites(records){
      var groups=[];
      records.slice().sort(function(a,b){return a.id.localeCompare(b.id);}).forEach(function(v){
        var g=groups.find(function(g){return g.every(function(q){
          if(institution(v.institution)!==institution(q.institution)||recordSchool.get(v.id)!==recordSchool.get(q.id))return false;
          if(v.country&&q.country&&fold(v.country)!==fold(q.country))return false;
          if(v.mapCardIdentity||q.mapCardIdentity)return !!v.mapCardIdentity&&v.mapCardIdentity===q.mapCardIdentity;
          return distance(v,q)<=150;
        });});
        if(g)g.push(v);else groups.push([v]);
      });
      return groups.map(function(g){return g.slice().sort(function(a,b){return Number(!!a.department)-Number(!!b.department)||a.id.localeCompare(b.id);})[0];}).sort(function(a,b){return a.id.localeCompare(b.id);});
    }
    var schoolSites=new Map();
    bySchool.forEach(function(values,key){schoolSites.set(key,sites(Array.from(values)));});
    function unresolved(reason){return {ids:[],kind:'unresolved',reason:reason};}
    function resolve(row){
      row=row||{};
      var edited=row._edit&&row._edit.fields||[];
      if(row.locationEdited||edited.indexOf('school')!==-1||edited.indexOf('department')!==-1||edited.indexOf('unit')!==-1)return unresolved('edited-location');
      var c=canon(row.institution,row.school,row.department||row.unit),i=institution(c.institution||row.institution);
      var rowIds=distinct([row.id].concat(row.sourceRowIds||[]).filter(Boolean));
      var exact=distinct(rowIds.flatMap(function(id){return entries(byExact,i+'|'+id);}));
      if(exact.length)return {ids:exact.map(function(v){return v.id;}).sort(),kind:'exact'};
      var rawSchool=row.school||c.school||'',s=school(i,rawSchool),ds=distinct([fold(row.department||row.unit),fold(c.unit)]).filter(Boolean);
      var matches=distinct(ds.flatMap(function(d){return entries(byDepartment,i+'|'+s+'|'+d);}));
      if(matches.length){
        var homes=distinct(matches.map(function(v){return recordSchool.get(v.id);}));
        if(homes.length>1)return unresolved('ambiguous-department-school');
        return {ids:sites(matches).map(function(v){return v.id;}),kind:'department'};
      }
      if(!s)return unresolved('school-not-established');
      var refs=schoolSites.get(i+'|'+s)||[];
      if(refs.length)return {ids:refs.map(function(v){return v.id;}),kind:'school'};
      return unresolved('school-not-established');
    }
    return {resolve:resolve};
  }
  return {createResolver:createResolver,evidenceCountries:evidenceCountries};
}));
