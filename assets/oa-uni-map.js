/* Operations Academia map. Directory snapshots own every search/filter/edit;
   this component only applies a geographic region and renders that same view.
   Land, locations and logos are local snapshots, independent of other sites. */
(function () {
  'use strict';
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function(c) { n.appendChild(c); });
    return n;
  }
  var nameKeys=new Map();
  function key(s) {
    s=String(s||'');
    if(!nameKeys.has(s))nameKeys.set(s,window.OASchools?OASchools.institutionKey(s):s.toLowerCase());
    return nameKeys.get(s);
  }
  function fold(s) {
    if (window.OAList) return OAList.fold(s);
    s=String(s || '').toLowerCase();
    if(s.normalize)s=s.normalize('NFD').replace(/[̀-ͯ]/g,'');
    return s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/^ | $/g, '');
  }
  var REGIONS = [
    ['world','World'],['north-america','North America'],['south-america','South America'],
    ['europe','Europe'],['africa','Africa'],['asia','Asia'],['oceania','Oceania']
  ];
  var COUNTRIES = {
    'north-america': 'Canada|United States|United States of America|Mexico|Guatemala|Belize|Honduras|El Salvador|Nicaragua|Costa Rica|Panama|Cuba|Jamaica|Haiti|Dominican Republic|Puerto Rico|Trinidad and Tobago|Barbados|Bahamas|Greenland',
    'south-america': 'Brazil|Argentina|Chile|Peru|Colombia|Venezuela|Ecuador|Bolivia|Paraguay|Uruguay|Guyana|Suriname|French Guiana',
    europe: 'United Kingdom|Ireland|France|Germany|Italy|Spain|Portugal|Netherlands|Belgium|Luxembourg|Switzerland|Austria|Denmark|Norway|Sweden|Finland|Iceland|Poland|Czech Republic|Czechia|Slovakia|Hungary|Romania|Bulgaria|Greece|Cyprus|Malta|Slovenia|Croatia|Serbia|Bosnia and Herzegovina|Albania|Montenegro|North Macedonia|Kosovo|Estonia|Latvia|Lithuania|Ukraine|Belarus|Moldova|Russia|Russian Federation',
    africa: 'South Africa|Egypt|Morocco|Algeria|Tunisia|Libya|Sudan|South Sudan|Ethiopia|Eritrea|Djibouti|Somalia|Kenya|Uganda|Tanzania|Rwanda|Burundi|Ghana|Nigeria|Senegal|Cameroon|Ivory Coast|Côte d’Ivoire|Zambia|Zimbabwe|Botswana|Namibia|Mozambique|Angola|Mauritius|Madagascar|Malawi|Lesotho|Eswatini|Democratic Republic of the Congo|Republic of the Congo|Gabon|Benin|Togo|Mali|Niger|Chad|Burkina Faso|Liberia|Sierra Leone|Guinea|Cape Verde|Seychelles',
    asia: 'China|Hong Kong|Taiwan|Macau|Macao|Japan|South Korea|Republic of Korea|North Korea|Mongolia|India|Pakistan|Bangladesh|Sri Lanka|Nepal|Bhutan|Maldives|Singapore|Malaysia|Indonesia|Thailand|Vietnam|Philippines|Cambodia|Laos|Myanmar|Brunei|Timor-Leste|Saudi Arabia|United Arab Emirates|Qatar|Bahrain|Kuwait|Oman|Yemen|Israel|Palestine|Jordan|Lebanon|Syria|Iraq|Iran|Turkey|Türkiye|Georgia|Armenia|Azerbaijan|Kazakhstan|Uzbekistan|Turkmenistan|Kyrgyzstan|Tajikistan|Afghanistan',
    oceania: 'Australia|New Zealand|Fiji|Papua New Guinea|Samoa|Tonga|Vanuatu|Solomon Islands|New Caledonia|Guam|French Polynesia'
  };
  function regionOf(r) {
    var country = fold(r.country);
    var found = Object.keys(COUNTRIES).find(function(k) {
      return COUNTRIES[k].split('|').some(function(c) { return fold(c) === country; });
    });
    if (found) return found;
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) return null;
    // Coordinates fill gaps in historic records; country metadata wins above.
    if (r.lng < -30) return r.lat >= 8 ? 'north-america' : 'south-america';
    if (r.lat < -10 && r.lng > 110) return 'oceania';
    if (r.lng >= -20 && r.lng <= 55 && r.lat < 37) return 'africa';
    if (r.lat >= 35 && r.lng < 45) return 'europe';
    return 'asia';
  }
  function mount(cfg) {
    var host = document.querySelector(cfg.mount);
    if (!host) return;
    host.className = 'oa-uni'; host.replaceChildren();
    var saved = new URLSearchParams(location.search).get('region');
    var region = REGIONS.some(function(r) { return r[0] === saved; }) ? saved : 'world';
    var snapshot = cfg.snapshot || {view:[],rows:[]};
    var targetParams = new URLSearchParams(location.search);
    var targetUniversity = targetParams.get('university') || targetParams.get('filterA') || '';
    var targetSchool = targetParams.get('school') || '';
    var targetDepartment = targetParams.get('department') || '';
    var focusApplied = false;
    var resolveReady,rejectReady;
    var whenReady=new Promise(function(resolve,reject){resolveReady=resolve;rejectReady=reject;});
    var locations = new Map(), historic = new Map(), rowInstitutions = {}, verified = [], ready = false, lastSignature = '';
    var tabs = el('div', {class:'oa-map-regions', role:'group', 'aria-label':'Continent'});
    REGIONS.forEach(function(r) {
      var b = el('button',{type:'button','data-region':r[0],text:r[1]});
      b.addEventListener('click',function() {
        region=r[0]; syncRegion(); draw(false); updateButtons();
      }); tabs.appendChild(b);
    });
    var status = el('p',{class:'oa-map-status',role:'status','aria-live':'polite'});
    var mapEl = el('div',{class:'oa-uni-map',id:'oa-uni-map',role:'region','aria-label':'University locations map','aria-describedby':'oa-map-help'});
    var help = el('p',{id:'oa-map-help',class:'oa-map-help',text:'Select a logo for school details, or a numbered group to zoom in automatically. The list below provides the same details without using the map.'});
    var legend = el('p',{class:'oa-map-legend',text:'Logo: school or campus location · Number: grouped locations · Initials: logo unavailable. Locations are approximate.'});
    var details = el('details',{class:'oa-map-results'});
    var summary = el('summary',{text:'Matching universities'}), resultList=el('ul',{});
    details.append(summary,resultList);
    host.append(tabs,status,help,mapEl,legend,details);
    function updateButtons() {
      tabs.querySelectorAll('button').forEach(function(b) { b.setAttribute('aria-pressed',String(b.getAttribute('data-region')===region)); });
    }
    updateButtons();
    function syncRegion() {
      var p=new URLSearchParams(location.search); p.set('view','map');
      if(region==='world') p.delete('region'); else p.set('region',region);
      history.replaceState(null,'',location.pathname+'?'+p+location.hash);
    }
    if(!window.L) { status.textContent='The map could not load. Switch to Cards to explore the directory.'; return; }
    var map=L.map(mapEl,{scrollWheelZoom:false,worldCopyJump:false,minZoom:0,maxZoom:17,zoomSnap:.25,zoomControl:false,attributionControl:true});
    L.control.zoom({position:'topright'}).addTo(map);
    map.setView([22,10],2);
    map.attributionControl.addAttribution('Land: Natural Earth / world-atlas');
    var reset=L.control({position:'topright'});
    reset.onAdd=function() {
      var box=el('div',{class:'leaflet-bar oa-map-reset'}), b=el('button',{type:'button','aria-label':'Reset map to selected continent',text:'↺'});
      box.appendChild(b); L.DomEvent.disableClickPropagation(box);
      b.addEventListener('click',function(){frame(currentPoints);}); return box;
    }; reset.addTo(map);
    var land=null;
    function palette() {
      var css=getComputedStyle(host);
      return {color:css.getPropertyValue('--map-border').trim(),fillColor:css.getPropertyValue('--map-land').trim(),weight:0.6,fillOpacity:1};
    }
    var observer=new MutationObserver(function(){if(land)land.setStyle(palette());});
    observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    var cluster=L.markerClusterGroup({showCoverageOnHover:false,zoomToBoundsOnClick:false,spiderfyOnMaxZoom:false,
      maxClusterRadius:42,animate:!matchMedia('(prefers-reduced-motion: reduce)').matches,
      iconCreateFunction:function(c) {
        var count=c.getChildCount();
        var size=Math.min(68,40+Math.sqrt(count)*3);
        return L.divIcon({className:'oa-map-cluster',html:'<span>'+count+'</span>',iconSize:[size,size]});
      }}).addTo(map);
    var currentPoints=[],markers=new Map(),opener=null,autoFrame=true,framing=false;
    function frame(points) {
      framing=true;autoFrame=true;
      if(region==='world') map.fitBounds([[-56,-172],[76,180]],{padding:[8,8],animate:false});
      else if(points.length) map.fitBounds(L.latLngBounds(points.map(function(p){return [p.lat,p.lng];})).pad(.1),{maxZoom:points.length===1?8:5,animate:false});
      else map.setView([22,10],2,{animate:false});
      framing=false;
    }
    map.on('dragstart zoomstart',function(){if(!framing)autoFrame=false;});
    function makeLink(text,href) {
      if(!href || !/^(https?:\/\/|(?:universities|jobs|candidates|recent-faculty|previous-markets)\?)/i.test(href)) return el('span',{text:text});
      var a=el('a',{text:text,href:href});
      if(/^https?:/i.test(href)){a.target='_blank';a.rel='noopener';} return a;
    }
    var universityLogos = new Map(), logoCache = new WeakMap();
    function logoFor(card) {
      if(logoCache.has(card))return logoCache.get(card);
      var names=[card.institution].concat((card.aka||'').split(' · '));
      (card.schools||[]).forEach(function(s){(s.rows||[]).forEach(function(r){if(rowInstitutions[r.id])names.push(rowInstitutions[r.id]);});});
      for(var i=0;i<names.length;i++){var record=universityLogos.get(key(names[i]))||locations.get(key(names[i]));if(record&&record.logo){logoCache.set(card,record.logo);return record.logo;}}
      return null;
    }
    function logoImage(card) {
      var url=logoFor(card);
      if(!url||!/^\/assets\/university-logos\/[^/]+$/.test(url))return null;
      var img=el('img',{class:'oa-map-result-logo',src:url,alt:'',width:'40',height:'40',loading:'lazy'});
      img.addEventListener('error',function(){img.remove();});return img;
    }
    function cardContent(card,point) {
      var pop=el('div',{class:'oa-uni-pop',tabindex:'-1'});
      var brand=logoImage(card);if(brand)pop.appendChild(brand);
      pop.appendChild(el('h3',{text:card.officialInstitution||OAMapModel.displayName(card.institution)}));
      pop.appendChild(el('p',{text:(card.countries||[]).join(' · ')}));
      if(point&&point.approximate)pop.appendChild(el('p',{text:'Approximate university location — school building not yet verified.'}));
      if(point&&point.locationVerified){
        pop.appendChild(el('p',{text:point.address}));
        var evidence=el('p',{text:'Location checked '+point.checked+' · '});
        evidence.appendChild(makeLink('Official address',point.addressSource));
        evidence.appendChild(document.createTextNode(' · '));
        evidence.appendChild(makeLink('Official building map',point.coordinateSource));
        pop.appendChild(evidence);
      }
      pop.appendChild(el('p',{text:(card.schools||[]).length+((card.schools||[]).length===1?' school · ':' schools · ')+(card.schools||[]).reduce(function(n,s){return n+(s.rows||[]).length;},0)+' department listings · '+(card.n||0)+' past postings'}));
      var schools=(card.schools||[]).slice().sort(function(a,b){return Number(fold(b.name)===fold(targetSchool))-Number(fold(a.name)===fold(targetSchool));});
      schools.forEach(function(s) {
        if(s.name)pop.appendChild(el('h4',{text:s.name}));
        (s.rows||[]).forEach(function(r) {
          var selected=targetDepartment && OAMapModel.matchesRow(r,targetSchool,targetDepartment);
          var p=el('p',selected?{class:'oa-map-selected-department'}:{}); p.appendChild(makeLink(OAMapModel.departmentName(r.department)||'School listing',r.deptUrl));
          if(r.facultyUrl) {p.appendChild(document.createTextNode(' · '));p.appendChild(makeLink('Faculty',r.facultyUrl));}
          pop.appendChild(p);
        });
      });
      var q=encodeURIComponent(card.institution),nav=el('p',{class:'oa-map-popup-links'});
      [['Open university profile','universities?university='+q],['Current jobs','jobs?institution='+q],['Candidates','candidates?c_affiliation='+q],['Recent hires','recent-faculty?placement='+q],['PhD alumni','recent-faculty?alma='+q],['Past jobs','previous-markets?university='+q]].forEach(function(item){nav.appendChild(makeLink(item[0],item[1]));});
      pop.appendChild(nav);
      if(card.edited && card.edited.t)pop.appendChild(el('p',{text:'Last updated '+new Date(card.edited.t).toLocaleDateString()+(card.edited.name?' by '+card.edited.name:'')}));
      if(point && point.mapUrl)pop.appendChild(makeLink(point.approximate?'University location':'School location',point.mapUrl));
      return pop;
    }
    function openPopup(content,latlng,source) {
      map.closePopup();
      opener=source||document.activeElement;
      L.popup({maxWidth:Math.min(360,mapEl.clientWidth-120),minWidth:Math.min(260,mapEl.clientWidth-120),maxHeight:Math.max(160,mapEl.clientHeight-90),autoPanPaddingTopLeft:[20,20],autoPanPaddingBottomRight:[70,20],className:'oa-map-popup'})
        .setLatLng(latlng).setContent(content).openOn(map);
      setTimeout(function(){var selected=content.querySelector('.oa-map-selected-department');var link=(selected||content).querySelector('a,button'); (link||content).focus({preventScroll:true});if(selected)selected.scrollIntoView({block:'nearest'});},0);
    }
    map.on('popupclose',function(e){if(opener && document.contains(opener) && e.popup.getElement().contains(document.activeElement))opener.focus({preventScroll:true});opener=null;});
    mapEl.addEventListener('keydown',function(e){if(e.key==='Escape'){map.closePopup();} if((e.key===' '||e.key==='Enter')&&e.target.classList.contains('leaflet-marker-icon')){e.preventDefault();e.stopImmediatePropagation();e.target.click();}},true);
    cluster.on('clusterclick',function(e) {
      var all=e.layer.getAllChildMarkers();
      map.closePopup();
      if(map.getZoom()>=map.getMaxZoom() || all.every(function(m){return m.getLatLng().equals(all[0].getLatLng());})) {
        e.layer.spiderfy();
      } else {
        e.layer.zoomToBounds({padding:[35,35],maxZoom:Math.min(map.getMaxZoom(),map.getZoom()+3)});
      }
    });
    function labelClusters() {
      mapEl.querySelectorAll('.oa-map-cluster').forEach(function(n){n.setAttribute('role','button');n.setAttribute('aria-label',n.textContent+' grouped locations. Zoom in or expand markers');n.setAttribute('tabindex','0');});
    }
    cluster.on('animationend',labelClusters);map.on('moveend',labelClusters);
    function pointsFor(card) {
      return OAMapModel.pointsFor(card,{locations:locations,historic:historic,rowInstitutions:rowInstitutions,verified:verified}).map(function(p){
        var schoolLogo=locations.get(key(p.school));
        p.logo=schoolLogo&&schoolLogo.logo||logoFor(card);return p;
      });
    }
    var pendingResults=[];
    function renderResults() {
      if(!details.open || resultList.childElementCount)return;
      var fragment=document.createDocumentFragment();
      pendingResults.forEach(function(c){
        var item=el('li',{}),m=markers.get(c.id),entry=el('details',{}),built=false;
        var heading=el('summary',{text:(c.officialInstitution||OAMapModel.displayName(c.institution))+' — '+((c.schools[0]||{}).name||OAMapModel.departmentName((c.schools[0].rows[0]||{}).department)||'University')+(m?'':' — location unavailable')});
        entry.appendChild(heading);
        entry.addEventListener('toggle',function(){
          if(!entry.open||built)return;built=true;
          entry.appendChild(cardContent(c,m&&m.oaPoint));
          if(m){var b=el('button',{type:'button',text:'Show on map'});b.addEventListener('click',function(){cluster.zoomToShowLayer(m,function(){openPopup(cardContent(c,m.oaPoint),m.getLatLng(),b);});});entry.appendChild(b);}
        });
        item.appendChild(entry);fragment.appendChild(item);
      });
      resultList.appendChild(fragment);
    }
    details.addEventListener('toggle',renderResults);
    function draw(keepView) {
      if(!ready)return;
      var cards=snapshot.view||[],points=[],missing=[],inRegion=[];
      var deptFilter=(snapshot.filters||[]).find(function(f){return f.key==='dept';});
      var queries=deptFilter?deptFilter.values.map(fold).filter(Boolean):[];
      cards.forEach(function(c){
        var ps=pointsFor(c);
        ps=ps.filter(function(p){return region==='world'||regionOf(p)===region;});
        // A university-only search keeps all its schools. Department search
        // narrows the actual map cards as well as the directory's university.
        if(queries.length)ps=ps.filter(function(p){var text=fold(p.school+' '+p.card.schools[0].rows.map(function(r){return r.department+' '+(r.mapAliases||[]).map(function(a){return a.school+' '+a.department;}).join(' ');}).join(' '));return queries.some(function(q){return q.split(' ').every(function(w){return text.indexOf(w)!==-1;});});});
        ps=ps.filter(function(p){if(OAMapModel.located(p))return true;missing.push(p.card);return false;});
        if(ps.length)inRegion.push(c);
        ps.forEach(function(p){points.push(p);});
      });
      var restoreFocus=!!(map._popup&&map.hasLayer(map._popup));
      map.closePopup();cluster.clearLayers();markers.clear();currentPoints=points;
      if(!keepView)frame(points);
      var layers=[];
      points.forEach(function(p) {
        var card=p.card;
        var initials=card.institution.split(/\s+/).slice(0,2).map(function(s){return s[0];}).join('');
        var escape=function(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
        var html='<span class="oa-map-logo-face">'+escape(initials);
        if(p.logo && /^\/assets\/university-logos\/[^/]+$/.test(p.logo))html+='<img data-src="'+escape(p.logo)+'" alt="" width="40" height="40">';
        html+='</span>';
        var icon=L.divIcon({className:'oa-map-logo',html:html,iconSize:[44,44],iconAnchor:[22,22]});
        // Escape every dynamic value before passing the marker markup to Leaflet.
        var markerName=(card.officialInstitution||OAMapModel.displayName(card.institution))+' — '+OAMapModel.departmentName(p.label);
        var m=L.marker([p.lat,p.lng],{icon:icon,title:markerName,alt:markerName,keyboard:true});
        m.oaCard=card;m.oaPoint=p;
        m.on('add',function(){var n=m.getElement();if(n){n.setAttribute('aria-label','Open '+markerName);n.setAttribute('role','button');var im=n.querySelector('img');if(im){im.addEventListener('load',function(){if(im.naturalWidth/im.naturalHeight>1.6)im.classList.add('oa-map-logo-wide');});im.addEventListener('error',function(){im.remove();});if(im.complete&&im.naturalWidth&&im.naturalWidth/im.naturalHeight>1.6)im.classList.add('oa-map-logo-wide');if(!im.getAttribute('src'))im.src=im.getAttribute('data-src');}}});
        m.on('click',function(){openPopup(cardContent(card,p),m.getLatLng(),m.getElement());});
        layers.push(m);if(!markers.has(card.id))markers.set(card.id,m);
      });
      cluster.addLayers(layers);
      var sorted=points.map(function(p){return p.card;}).concat(missing).sort(function(a,b){return a.institution.localeCompare(b.institution);});
      pendingResults=sorted;resultList.replaceChildren();renderResults();
      summary.textContent='Matching school and department locations ('+sorted.length+')';
      status.textContent=inRegion.length+(inRegion.length===1?' university · ':' universities · ')+points.length+(points.length===1?' mapped location':' mapped locations')+(missing.length?' · '+missing.length+' without coordinates (available in the list)':'')+'.'+(!sorted.length?' No matches. Try another continent or clear the search filters.':'');
      labelClusters();
      // Deep links wait for BOTH asynchronous data sources, then open the
      // matching school location without requiring a cluster/marker click.
      if(targetUniversity && targetParams.get('focus')==='department' && (!focusApplied || restoreFocus)) {
        var matches=layers.filter(function(m){return key(m.oaCard.institution)===key(targetUniversity) || (m.oaCard.aka||'').split(' · ').some(function(a){return key(a)===key(targetUniversity);});});
        if(matches.length) {
          var target=OASchools.canonColumns({institution:targetUniversity,school:targetSchool,unit:targetDepartment});
          targetSchool=target.school;targetDepartment=target.unit;
          var chosen=matches.find(function(m){return m.oaCard.schools.some(function(s){return s.rows.some(function(r){return targetDepartment&&OAMapModel.matchesRow(r,targetSchool,targetDepartment);});});}) || matches.find(function(m){return targetSchool && m.oaCard.schools.some(function(s){return s.rows.some(function(r){return OAMapModel.matchesRow(r,targetSchool,'');});});});
          if(!chosen && !targetSchool && !targetDepartment && matches.length===1)chosen=matches[0];
          if(!chosen){status.textContent+=' The requested department is not in the directory; showing the available schools.';return;}
          focusApplied=true;autoFrame=false;
          map.setView(chosen.getLatLng(),14,{animate:false});
          openPopup(cardContent(chosen.oaCard,chosen.oaPoint),chosen.getLatLng());
        }
      }
    }
    function update(next) {
      snapshot=next;
      var signature=JSON.stringify((next.filters||[]));
      var keep=signature===lastSignature;lastSignature=signature;draw(keep);
    }
    Promise.all([
      fetch('/data/university-map.json?v=20261023-location-evidence').then(function(r){if(!r.ok)throw Error('map data');return r.json();}),
      fetch('/assets/world/countries.geojson?v=20261022-mobile').then(function(r){if(!r.ok)throw Error('geography');return r.json();})
    ]).then(function(data) {
      data[0].locations.forEach(function(r){nameKeys.set(r.name,r.key);locations.set(r.key,r);});
      data[0].logos.forEach(function(r){nameKeys.set(r.name,r.key);universityLogos.set(r.key,r);});
      rowInstitutions=data[0].rowInstitutions||{};
      verified=data[0].verified||[];
      data[0].historic.forEach(function(r){var k=r.key;nameKeys.set(r.institution||r.name,k);if(!historic.has(k))historic.set(k,[]);historic.get(k).push(r);});
      land=L.geoJSON(data[1],{style:palette,interactive:false}).addTo(map);land.bringToBack();
      ready=true;draw(false);resolveReady();
    }).catch(function(err){status.textContent='Map assets could not load. Please reload the page to try again.';console.error('OAUniMap',err);rejectReady(err);});
    var resize=new ResizeObserver(function(){map.invalidateSize({pan:false});if(ready&&autoFrame&&mapEl.clientWidth)frame(currentPoints);});resize.observe(mapEl);
    window.addEventListener('popstate',function(){var p=new URLSearchParams(location.search).get('region');region=REGIONS.some(function(r){return r[0]===p;})?p:'world';updateButtons();draw(false);});
    return {map:map,whenReady:whenReady,update:update,refresh:function(){draw(true);},shown:function(){return currentPoints.slice();},rows:function(){return snapshot.rows.slice();}};
  }
  window.OAUniMap={mount:mount,fold:fold,regionOf:regionOf};
})();
