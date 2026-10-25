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
  var verifiedIndexes=new WeakMap(),uiucKey=S.institutionKey('University of Illinois at Urbana-Champaign');
  function verifiedIndex(records){
    // Detect changed membership/keys while keeping live record objects as values.
    // This avoids repeating expensive institution alias normalization for every row.
    var signature=records.map(function(v){return JSON.stringify([v.institutionKey||v.institution,v.rowIds]);}).join('|');
    var cached=verifiedIndexes.get(records);if(cached&&cached.signature===signature&&records.every(function(v,i){return v===cached.records[i];}))return cached.index;
    var index=new Map();records.forEach(function(v){
      var key=S.institutionKey(v.institutionKey||v.institution);
      if(!index.has(key))index.set(key,new Map());var rows=index.get(key);
      v.rowIds.forEach(function(id){if(!rows.has(id))rows.set(id,[]);rows.get(id).push(v);});
    });
    verifiedIndexes.set(records,{signature:signature,index:index,records:records.slice()});return index;
  }
  function pointsFor(card,data){
    var groups=new Map(), names=[card.institution].concat((card.aka||'').split(' · '));
    var cardKey=S.institutionKey(card.institution),byRow=verifiedIndex(data.verified||[]).get(cardKey),uiuc=cardKey===uiucKey;
    (card.schools||[]).forEach(function(s){(s.rows||[]).forEach(function(r){
      if(S.directoryExcluded({institution:card.institution,school:s.name}))return;
        var locations=byRow&&byRow.get(r.id)||[];
        (locations.length?locations:[null]).forEach(function(verified){
        var originalRow=r;
      var c=S.canonColumns({institution:card.institution,school:s.name||'',unit:r.department||''});
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
          sourceEvidenceIds:unique(rows.flatMap(function(r){return (r.mapSources||[]).map(function(a){return a.evidenceId;});})),sourceCardIds:[scoped.id],sourceUniversityIds:[card.id],
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
        sourceCardIds:unique(ps.flatMap(function(p){return p.sourceCardIds||[p.card.id];})),sourceUniversityIds:unique(ps.flatMap(function(p){return p.sourceUniversityIds||[p.card.universityId];})),canonicalEvidenceId:canonical.id,
        mapUrl:'https://www.google.com/maps/search/?api=1&query='+canonical.lat+','+canonical.lng});
      out.push(merged);
    });
    return out;
  }
  function distanceMeters(a,b){
    var rad=Math.PI/180,dlat=(b.lat-a.lat)*rad,dlng=(b.lng-a.lng)*rad;
    var h=Math.sin(dlat/2)*Math.sin(dlat/2)+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlng/2)*Math.sin(dlng/2);
    return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
  }
  function pointEvidence(point,verified){
    var ids=point.sourceEvidenceIds||[];
    return (verified||[]).filter(function(v){return ids.indexOf(v.id)!==-1;});
  }
  function physicalPointKey(point){return (point.canonicalEvidenceId||(point.sourceEvidenceIds||[]).slice().sort()[0]||point.card.id)+'::'+point.card.id;}
  // Prefer the verified school office, otherwise a stable existing point. Never invent a midpoint.
  function representativeSchoolLocation(points,verified){
    return points.slice().sort(function(a,b){
      var as=pointEvidence(a,verified).some(function(v){return !v.department;}),bs=pointEvidence(b,verified).some(function(v){return !v.department;});
      return Number(bs)-Number(as)||Number(!!b.locationVerified)-Number(!!a.locationVerified)||physicalPointKey(a).localeCompare(physicalPointKey(b));
    })[0];
  }
  // Physical school cards are separate from evidence identities: departments keep their
  // own offices and provenance even when their nearby markers share one visible card.
  function mergeSchoolLocations(points,verified,options){
    var buckets=new Map(),out=[];
    function retainEvidence(p){
      var evidence=pointEvidence(p,verified);
      return Object.assign({},p,{locationSources:evidence,card:Object.assign({},p.card,{schools:p.card.schools.map(function(s){return Object.assign({},s,{rows:s.rows.map(function(r){
        var ids=(r.mapSources||[]).map(function(source){return source.evidenceId;});
        return Object.assign({},r,{locationSources:evidence.filter(function(v){return ids.indexOf(v.id)!==-1;})});
      })});})})});
    }
    function schoolFor(p){
      var institution=S.institutionKey(p.card.officialInstitution||p.card.institution);
      var alias=((options||{}).schoolAliases||[]).find(function(a){return S.institutionKey(a.institution)===institution&&(a.aliases||[]).concat(a.school).some(function(s){return fold(s)===fold(p.school);});});
      return alias?alias.school:p.school;
    }
    points.forEach(function(p){
      var edited=p.card.schools.some(function(s){return s.rows.some(function(r){return r.locationEdited;});});
      if(!located(p)||edited){out.push(retainEvidence(p));return;}
      var evidence=pointEvidence(p,verified),explicit=unique(evidence.map(function(v){return v.mapCardIdentity;}).concat(p.mapCardIdentity||[]));
      // Conflicting reviewed overrides must not silently absorb one another.
      if(explicit.length>1){out.push(retainEvidence(p));return;}
      var school=fold(schoolFor(p)),institution=S.institutionKey(p.card.officialInstitution||p.card.institution);
      if(!explicit.length&&!school){out.push(retainEvidence(p));return;}
      var k=JSON.stringify([institution,explicit.length?'explicit':'nearby',explicit[0]||school,fold(p.country)]);
      if(!buckets.has(k))buckets.set(k,{explicit:!!explicit.length,points:[]});
      buckets.get(k).points.push(p);
    });
    buckets.forEach(function(bucket,k){
      var groups=[];
      bucket.points.slice().sort(function(a,b){return physicalPointKey(a).localeCompare(physicalPointKey(b));}).forEach(function(p){
        var group=groups.find(function(g){return bucket.explicit||g.every(function(q){return distanceMeters(p,q)<=150;});});
        if(group)group.push(p);else groups.push([p]);
      });
      groups.forEach(function(ps){
        var anchor=representativeSchoolLocation(ps,verified),sources=unique(ps.flatMap(function(p){return p.sourceEvidenceIds||[];}));
        var evidence=(verified||[]).filter(function(v){return sources.indexOf(v.id)!==-1;}).slice().sort(function(a,b){return a.id.localeCompare(b.id);});
        ps.forEach(function(p){
          if((p.sourceEvidenceIds||[]).length)return;
          evidence.push({id:'legacy:'+p.card.id,rowIds:unique(p.card.schools.flatMap(function(s){return s.rows.flatMap(function(r){return (r.mapSources||[]).map(function(a){return a.rowId;});});})),
            institution:p.card.officialInstitution||p.card.institution,school:p.school,department:p.department||'',
            lat:p.lat,lng:p.lng,address:p.address||'',building:p.building||'',addressSource:p.addressSource||'',coordinateSource:p.coordinateSource||'',
            locationPrecision:p.locationPrecision|| (p.approximate?'campus':'legacy'),approximate:!!p.approximate,locationVerified:false});
        });
        var metadata=evidence.find(function(v){return v.mapCardIdentity;})||anchor;
        var schoolNames=unique(ps.map(schoolFor)),namedSchools=schoolNames.filter(function(s){return !!fold(s);});
        var school=metadata.mapCardSchool||(namedSchools.length===1?namedSchools[0]:schoolFor(anchor)),rows=new Map();
        var preserveSections=!metadata.mapCardSchool&&namedSchools.length>1;
        ps.forEach(function(p){p.card.schools.forEach(function(s){s.rows.forEach(function(r){
          var section=preserveSections?schoolFor(p):school;
          var rk=fold(section)+'::'+fold(r.department),held=rows.get(rk);
          if(!held){held=Object.assign({},r,{mapAliases:[],mapSources:[],locationSources:[],mapCardSchool:section});rows.set(rk,held);}
          held.mapAliases.push.apply(held.mapAliases,r.mapAliases||[]);
          held.mapAliases.push({school:section,department:r.department});
          held.mapSources.push.apply(held.mapSources,(r.mapSources||[]).map(function(source){
            return Object.assign({},source,{mapAliases:(source.mapAliases||[]).concat([{school:section,department:source.department}])});
          }));
          var ids=(r.mapSources||[]).map(function(v){return v.evidenceId;});
          var rowIds=(r.mapSources||[]).map(function(v){return v.rowId;});
          held.locationSources.push.apply(held.locationSources,evidence.filter(function(v){return ids.indexOf(v.id)!==-1||v.locationVerified===false&&(v.rowIds||[]).some(function(id){return rowIds.indexOf(id)!==-1;});}));
          if(!held.deptUrl&&r.deptUrl)held.deptUrl=r.deptUrl;
          if(!held.facultyUrl&&r.facultyUrl)held.facultyUrl=r.facultyUrl;
        });});});
        var mergedRows=Array.from(rows.values()).sort(function(a,b){return fold(a.department).localeCompare(fold(b.department));});
        mergedRows.forEach(function(r){
          r.mapAliases=Array.from(new Map(r.mapAliases.map(function(a){return [JSON.stringify(a),a];})).values());
          r.mapSources=Array.from(new Map(r.mapSources.map(function(a){return [a.rowId+'::'+a.evidenceId,a];})).values());
          r.locationSources=Array.from(new Map(r.locationSources.map(function(a){return [a.id,a];})).values());
          r.n=sourceCount(r.mapSources);
        });
        var identity='school-location:'+k+'::'+physicalPointKey(anchor);
        var sections=new Map();mergedRows.forEach(function(r){var k=fold(r.mapCardSchool);if(!sections.has(k))sections.set(k,{name:r.mapCardSchool,rows:[]});sections.get(k).rows.push(r);});
        var card=Object.assign({},anchor.card,{id:identity,schools:Array.from(sections.values()),n:sourceCount(mergedRows.flatMap(function(r){return r.mapSources;}))});
        out.push(Object.assign({},anchor,{card:card,school:school,physicalCardId:identity,
          label:metadata.mapCardLabel||school||anchor.label,mapCardLabel:metadata.mapCardLabel||'',
          sourceEvidenceIds:sources,sourceCardIds:unique(ps.flatMap(function(p){return p.sourceCardIds||[p.card.id];})),
          sourceUniversityIds:unique(ps.flatMap(function(p){return p.sourceUniversityIds||[p.card.universityId];})),
          locationSources:evidence,representativeEvidenceId:anchor.canonicalEvidenceId||(anchor.sourceEvidenceIds||[])[0],
          sharedSchoolLocation:ps.length>1,containsApproximateLocations:ps.some(function(p){return p.approximate;})
        }));
      });
    });
    return out;
  }
  function locationGroupsForTarget(point,university,school,department,verified){
    var target=S.institutionKey(university),ids=[];
    point.card.schools.forEach(function(s){s.rows.forEach(function(r){(r.mapSources||[]).forEach(function(source){
      var related=S.institutionKey(source.institution)===target||S.institutionKey(point.card.officialInstitution||'')===target||(source.institutionAliases||[]).some(function(a){return S.institutionKey(a)===target;});
      if(related&&rowMatchScore(source,school,department)>0)ids.push(source.evidenceId);
    });});});
    return unique((verified||point.locationSources||[]).filter(function(v){return ids.indexOf(v.id)!==-1;}).map(function(v){return v.locationGroup;}));
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
  return {pointsFor:pointsFor,consolidatePoints:consolidatePoints,mergeSchoolLocations:mergeSchoolLocations,representativeSchoolLocation:representativeSchoolLocation,locationGroupsForTarget:locationGroupsForTarget,canonicalLocation:canonicalLocation,pointMatchScore:pointMatchScore,located:located,displayName:displayName,departmentName:departmentName,matchesRow:matchesRow,rowMatchScore:rowMatchScore};
}));
