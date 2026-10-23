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
      'IESEG':'IÉSEG School of Management'
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
      var c=S.canonColumns({institution:card.institution,school:s.name||'',unit:r.department||''});
      var uiuc=S.institutionKey(card.institution)===S.institutionKey('University of Illinois at Urbana-Champaign');
      var school=uiuc?c.school:(s.name||c.school), department=uiuc?c.unit:r.department;
      var id=school?'school:'+fold(school):'department:'+fold(department);
      if(!groups.has(id))groups.set(id,{name:school,rows:[],seen:new Set()});
      var g=groups.get(id),rk=fold(department);
      if(!g.seen.has(rk)){g.rows.push(Object.assign({},r,{school:school,department:department}));g.seen.add(rk);}
      if(data.rowInstitutions[r.id])names.push(data.rowInstitutions[r.id]);
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
      history.forEach(function(p){
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
        var scoped=Object.assign({},card,{id:card.id+'::'+id+'::'+xy,universityId:card.id,
          schools:[{name:g.name,rows:rows}],n:rows.reduce(function(n,r){return n+(r.n||0);},0)});
        out.push(Object.assign({},p,{school:g.name,card:scoped,approximate:approximate,
          country:p.country||(card.countries||[])[0]||'',label:g.name||rows.map(function(r){return r.department;}).filter(Boolean).join(' · ')||card.institution}));
      });
    });
    return out;
  }
  return {pointsFor:pointsFor,located:located,displayName:displayName,departmentName:departmentName};
}));
