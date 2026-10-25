/* School-specific map cards. Shared by the browser and the full-directory audit. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./oa-schools.js'));
  else root.OAMapModel=factory(root.OASchools);
}(typeof window!=='undefined'?window:this,function(S){
  'use strict';
  function fold(s){return S.fold(String(s||''));}
  // Display-only expansions keep existing identities and bookmarked aliases.
  function displayName(name){
    var names={
      'MIT':'Massachusetts Institute of Technology (MIT)',
      'KAIST':'Korea Advanced Institute of Science and Technology (KAIST)',
      'LBS':'London Business School (LBS)',
      'NTU':'Nanyang Technological University (NTU)',
      'CEIBS':'China Europe International Business School (CEIBS)',
      'HKUST(GZ)':'Hong Kong University of Science and Technology (Guangzhou)',
      'UCL GBSH':'University College London — Global Business School for Health',
      'ESSEC':'ESSEC Business School',
      'IESE':'IESE Business School',
      'IESEG':'IÉSEG School of Management',
      'HEC Montréal':'École des hautes études commerciales de Montréal (HEC Montréal)',
      'UT San Antonio':'The University of Texas at San Antonio',
      'WU Vienna':'Vienna University of Economics and Business'
    };
    return names[name]||name;
  }
  function departmentName(name){
    var terms={OM:'Operations Management',OR:'Operations Research',SCM:'Supply Chain Management',IS:'Information Systems',MIS:'Management Information Systems',IE:'Industrial Engineering',BA:'Business Analytics',DA:'Data Analytics',DS:'Data Science',AI:'Artificial Intelligence',ML:'Machine Learning',Stats:'Statistics'};
    return String(name||'').replace(/\b(OM|OR|SCM|IS|MIS|IE|BA|DA|DS|AI|ML|Stats)\b/g,function(t){return terms[t];}).replace(/\s*\/\s*/g,', ');
  }
  function located(p){return p&&Number.isFinite(p.lat)&&Math.abs(p.lat)<=90&&Number.isFinite(p.lng)&&Math.abs(p.lng)<=180;}
  function coord(p){return p.lat.toFixed(5)+','+p.lng.toFixed(5);}
  function pointsFor(card,data){
    var groups=new Map(), names=[card.institution].concat((card.aka||'').split(' · '));
    (card.schools||[]).forEach(function(s){(s.rows||[]).forEach(function(r){
      if(S.directoryExcluded({institution:card.institution,school:s.name}))return;
        var locations=(data.verified||[]).filter(function(v){return S.institutionKey(v.institutionKey||v.institution)===S.institutionKey(card.institution)&&v.rowIds.indexOf(r.id)!==-1;});
        (locations.length?locations:[null]).forEach(function(verified){
        var originalRow=r;
      var c=S.canonColumns({institution:card.institution,school:s.name||'',unit:r.department||''});
      var uiuc=S.institutionKey(card.institution)===S.institutionKey('University of Illinois at Urbana-Champaign');
      var school=uiuc?c.school:(s.name||c.school), department=uiuc?c.unit:r.department;
      var aliases=[{school:school,department:department}];
      var edited=r._edit&&r._edit.fields||[];
      if(verified){
        if(edited.indexOf('school')===-1)school=typeof verified.school==='string'?verified.school:school;
        if(edited.indexOf('department')===-1)department=verified.department||department;
        r=Object.assign({},r,verified,{id:r.id,locationVerified:true,mapUrl:'https://www.google.com/maps/search/?api=1&query='+verified.lat+','+verified.lng});
      }
      var source={rowId:originalRow.id,institution:card.institution,institutionAliases:(card.aka||'').split(' · ').filter(Boolean),school:school,department:department,mapAliases:aliases.slice(),n:originalRow.n||0,evidenceId:verified&&verified.id};
      var id=school?'school:'+fold(school):'department:'+fold(department);
      // Verified departments in different buildings must not inherit one another's pins.
      if(verified)id+=':location:'+verified.id;
      var locationEdited=edited.indexOf('school')!==-1||edited.indexOf('department')!==-1;
      if(locationEdited)id+=':edited:'+originalRow.id;
      if(!groups.has(id))groups.set(id,{name:school,rows:[],seen:new Set()});
      var g=groups.get(id),rk=fold(department);
      if(!g.seen.has(rk)){g.rows.push(Object.assign({},r,{school:school,department:department,mapAliases:aliases,mapSources:[source],locationEdited:locationEdited}));g.seen.add(rk);}
      else {
        var existing=g.rows.find(function(row){return fold(row.department)===rk;});
        existing.mapAliases.push.apply(existing.mapAliases,aliases);
        existing.mapSources.push(source);
        existing.n=sourceCount(existing.mapSources);
      }
      if(data.rowInstitutions[r.id])names.push(data.rowInstitutions[r.id]);
        r=originalRow;
        });
    });});
    // An unspecified university row adds no separate department beside named ones.
    if(groups.size>1)groups.delete('department:');
    var keys=new Set(names.filter(Boolean).map(S.institutionKey)), history=[], fallback=null;
    keys.forEach(function(k){
      if(!fallback&&located(data.locations.get(k)))fallback=data.locations.get(k);
      (data.historic.get(k)||[]).forEach(function(p){if(located(p))history.push(p);});
    });
    var out=[];
    groups.forEach(function(g,id){
      var candidates=g.rows.filter(located).map(function(r){return Object.assign({},r);});
      if(!g.rows.some(function(r){return r.locationVerified;}))history.forEach(function(p){
        var c=S.canonColumns({institution:card.institution,school:p.school||'',unit:p.department||''});
        if((g.name&&fold(c.school)===fold(g.name)) || (!g.name&&!c.school&&g.rows.some(function(r){return fold(r.department)===fold(c.unit);})))candidates.push(p);
      });
      var approximate=false;
      if(!candidates.length){
        approximate=true;
        var campus=history.filter(function(p){return !p.school&&!p.department;});
        candidates=campus.length?campus:(fallback?[fallback]:[]);
      }
      var seen=new Set();
      // Keep a school card in the accessible list even if no location exists.
      if(!candidates.length)candidates=[{}];
      candidates.forEach(function(p){
        var xy=located(p)?coord(p):'unmapped';if(seen.has(xy))return;seen.add(xy);
        var rows=g.rows.filter(function(r){return !located(r)||coord(r)===xy;});
        if(!rows.length)return;
        var scoped=Object.assign({},card,{id:card.id+'::'+id+'::'+xy,universityId:card.id,officialInstitution:p.locationVerified?p.institution:null,
          schools:[{name:g.name,rows:rows}],countries:p.locationVerified&&p.country?[p.country]:card.countries,n:rows.reduce(function(n,r){return n+(r.n||0);},0)});
        out.push(Object.assign({},p,{school:g.name,card:scoped,approximate:approximate||p.locationPrecision==='campus',
          sourceEvidenceIds:unique(rows.flatMap(function(r){return (r.mapSources||[]).map(function(a){return a.evidenceId;});})),sourceCardIds:[scoped.id],
          country:p.country||(card.countries||[])[0]||'',label:g.name||rows.map(function(r){return r.department;}).filter(Boolean).join(' · ')||card.institution}));
      });
    });
    return out;
  }
  function unique(values){return Array.from(new Set(values.filter(Boolean)));}
  function sourceCount(sources){
    var counts=new Map();sources.forEach(function(s){counts.set(s.rowId,Math.max(counts.get(s.rowId)||0,s.n||0));});
    return Array.from(counts.values()).reduce(function(a,b){return a+b;},0);
  }
  function identityKey(record){return JSON.stringify([record.locationIdentity,fold(record.institution),fold(record.school),fold(record.department)]);}
  // Canonical display coordinates remain stable when a filter exposes only a legacy alias.
  function canonicalLocation(record,verified){
    if(!record.locationIdentity)return record;
    var candidates=(verified||[]).filter(function(v){return identityKey(v)===identityKey(record);});
    candidates.sort(function(a,b){return Number(b.id===record.locationIdentity)-Number(a.id===record.locationIdentity)||a.id.localeCompare(b.id);});
    return candidates[0]||record;
  }
  // Only reviewed identities merge; nearby buildings and edited rows remain independent.
  function consolidatePoints(points,verified){
    var groups=new Map(),out=[];
    points.forEach(function(p){
      if(!p.locationVerified||!p.locationIdentity||p.card.schools.some(function(s){return s.rows.some(function(r){return r.locationEdited;});})){out.push(p);return;}
      var record=(verified||[]).find(function(v){return (p.sourceEvidenceIds||[]).indexOf(v.id)!==-1;});
      if(!record){out.push(p);return;}
      var k=identityKey(record);if(!groups.has(k))groups.set(k,{record:record,points:[]});groups.get(k).points.push(p);
    });
    groups.forEach(function(group,k){
      var canonical=canonicalLocation(group.record,verified);
      var ps=group.points.slice().sort(function(a,b){return a.card.id.localeCompare(b.card.id);}),base=ps[0],rows=new Map();
      ps.forEach(function(p){p.card.schools.forEach(function(s){s.rows.forEach(function(r){
        var rk=fold(r.department),held=rows.get(rk);
        if(!held){held=Object.assign({},r,{mapAliases:[],mapSources:[]});rows.set(rk,held);}
        held.mapAliases.push.apply(held.mapAliases,r.mapAliases||[]);
        held.mapSources.push.apply(held.mapSources,r.mapSources||[]);
        if(!held.deptUrl&&r.deptUrl)held.deptUrl=r.deptUrl;
        if(!held.facultyUrl&&r.facultyUrl)held.facultyUrl=r.facultyUrl;
      });});});
      var mergedRows=Array.from(rows.values());
      mergedRows.forEach(function(r){r.mapAliases=Array.from(new Map(r.mapAliases.map(function(a){return [JSON.stringify(a),a];})).values());r.mapSources=Array.from(new Map(r.mapSources.map(function(a){return [a.rowId+'::'+a.evidenceId,a];})).values());r.n=sourceCount(r.mapSources);});
      var sources=mergedRows.flatMap(function(r){return r.mapSources;});
      var card=Object.assign({},base.card,{id:'location-identity:'+k,officialInstitution:canonical.institution,
        schools:[{name:canonical.school,rows:mergedRows}],n:sourceCount(sources)});
      var merged=Object.assign({},base,canonical,{card:card,school:canonical.school,sourceEvidenceIds:unique(ps.flatMap(function(p){return p.sourceEvidenceIds||[];})),
        sourceCardIds:unique(ps.flatMap(function(p){return p.sourceCardIds||[p.card.id];})),canonicalEvidenceId:canonical.id,
        mapUrl:'https://www.google.com/maps/search/?api=1&query='+canonical.lat+','+canonical.lng});
      out.push(merged);
    });
    return out;
  }
  // Score each original university identity with its own row aliases, never another row's.
  function pointMatchScore(point,university,school,department){
    var target=S.institutionKey(university),best=0;
    point.card.schools.forEach(function(s){s.rows.forEach(function(r){
      var sources=r.mapSources||[{institution:point.card.institution,institutionAliases:(point.card.aka||'').split(' · '),school:r.school,department:r.department,mapAliases:r.mapAliases}];
      sources.forEach(function(source){
        var exact=S.institutionKey(source.institution)===target;
        var related=exact||S.institutionKey(point.card.officialInstitution||'')===target||(source.institutionAliases||[]).some(function(a){return S.institutionKey(a)===target;});
        if(!related)return;
        var score=rowMatchScore(source,school,department);
        if(score)best=Math.max(best,score*10+(exact?1:0));
      });
    });});
    return best;
  }
  function matchesRow(r,school,department){
    return [{school:r.school,department:r.department}].concat(r.mapAliases||[]).some(function(a){return (!school||fold(a.school)===fold(school))&&(!department||fold(a.department)===fold(department));});
  }
  function rowMatchScore(r,school,department){
    return [{school:r.school,department:r.department}].concat(r.mapAliases||[]).reduce(function(best,a){
      if((school&&fold(a.school)!==fold(school))||(department&&fold(a.department)!==fold(department)))return best;
      // A legacy link with no school belongs to its original school-less row
      // before another campus that happens to use the same department name.
      return Math.max(best,1+(fold(a.school)===fold(school)?2:0));
    },0);
  }
  return {pointsFor:pointsFor,consolidatePoints:consolidatePoints,canonicalLocation:canonicalLocation,pointMatchScore:pointMatchScore,located:located,displayName:displayName,departmentName:departmentName,matchesRow:matchesRow,rowMatchScore:rowMatchScore};
}));
