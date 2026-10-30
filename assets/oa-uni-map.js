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
  var countryRegions=new Map();
  Object.keys(COUNTRIES).forEach(function(region){COUNTRIES[region].split('|').forEach(function(country){countryRegions.set(fold(country),region);});});
  function regionOf(r) {
    var country = fold(r.country);
    var found = countryRegions.get(country);
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
    var focusApplied = false,highlightTarget = false;
    var resolveReady,rejectReady;
    var whenReady=new Promise(function(resolve,reject){resolveReady=resolve;rejectReady=reject;});
    var locations = new Map(), historic = new Map(), rowInstitutions = {}, verified = [], schoolAliases = [], ready = false, lastSignature = '';
    var cachedCards=[],cachedPoints=[],preparedData=null;
    var tabs = el('div', {class:'oa-map-regions', role:'group', 'aria-label':'Continent'});
    REGIONS.forEach(function(r) {
      var b = el('button',{type:'button','data-region':r[0],text:r[1]});
      b.addEventListener('click',function() {
        region=r[0]; syncRegion(); draw(false); updateButtons();
      }); tabs.appendChild(b);
    });
    var status = el('p',{class:'oa-map-status',role:'status','aria-live':'polite'});
    var mapEl = el('div',{class:'oa-uni-map',id:'oa-uni-map',role:'region','aria-label':'University locations map','aria-describedby':'oa-map-help'});
    var help = el('p',{id:'oa-map-help',class:'oa-map-help',text:'Select a logo for school details, or a numbered group to zoom in and reveal nearby logos. Distant locations stay grouped on the map. The list below provides the same details without using the map.'});
    var legend = el('p',{class:'oa-map-legend',text:'Logo: school or campus location · Number: grouped locations · Initials: logo unavailable. Lines connect separated logos to their locations. Locations are approximate.'});
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
      b.addEventListener('click',function(){map.closePopup();frame(currentPoints);}); return box;
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
    var currentPoints=[],currentMissing=[],currentLayers=new Set(),markerCache=new WeakMap(),pointSearchCache=new WeakMap(),drawn=false,markers=new Map(),opener=null,autoFrame=true,autoSearch=false,framing=false;
    var expandedMarkers=[],expandedLayer=L.layerGroup().addTo(map),expandedDoubleClickZoom=false;
    function clearExpanded() {
      if(!expandedMarkers.length)return;
      if(expandedDoubleClickZoom){map.doubleClickZoom.enable();expandedDoubleClickZoom=false;}
      expandedLayer.clearLayers();
      var restore=expandedMarkers;expandedMarkers=[];
      restore.forEach(function(item){item.marker.setLatLng(item.location);item.marker.setZIndexOffset(0);});
      cluster.addLayers(restore.map(function(item){return item.marker;}));
    }
    map.on('zoomstart dragstart click resize',clearExpanded);
    function frame(points) {
      autoSearch=false;clearExpanded();
      framing=true;autoFrame=true;
      if(region==='world') map.fitBounds([[-56,-172],[76,180]],{padding:[8,8],animate:false});
      else if(points.length) map.fitBounds(L.latLngBounds(points.map(function(p){return [p.lat,p.lng];})).pad(.1),{maxZoom:points.length===1?8:5,animate:false});
      else map.setView([22,10],2,{animate:false});
      framing=false;
    }
    map.on('dragstart zoomstart',function(){if(!framing){autoFrame=false;autoSearch=false;}});
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
    function logoImage(card,point) {
      var url=point&&point.logo||logoFor(card);
      if(!url||!/^\/assets\/university-logos\/[^/]+$/.test(url))return null;
      var img=el('img',{class:'oa-map-result-logo',src:url,alt:'',width:'40',height:'40',loading:'lazy'});
      img.addEventListener('error',function(){img.remove();});return img;
    }
    function cardContent(card,point) {
      var pop=el('div',{class:'oa-uni-pop','data-map-card-id':card.id,tabindex:'-1'});
      var departmentFilter=(snapshot.filters||[]).find(function(f){return f.key==='dept';});
      var departmentQueries=departmentFilter?departmentFilter.values.map(fold).filter(Boolean):[];
      function locationKey(loc){
        var address=fold(loc.address||'');
        (card.countries||[]).concat(point&&point.country||'',loc.country||'').forEach(function(country){
          var suffix=' '+fold(country);if(suffix.length>1&&address.endsWith(suffix))address=address.slice(0,-suffix.length);
        });
        return address;
      }
      function buildingKey(value){return fold(String(value||'').split(/[,;—]/)[0]).replace(/\s+building$/,'');}
      function departmentLocations(row){
        var found=new Map();
        (row.locationSources||[]).forEach(function(v){
          var loc=v.sourceLocation||v,address=locationKey(loc),shared=locationKey(point||{});
          if(v.locationVerified===false||!address||/^https?:\/\//i.test(loc.address)||address===shared)return;
          var building=buildingKey(loc.building),mainBuilding=buildingKey(point&&point.building);
          var nearby=OAMapModel.located(loc)&&OAMapModel.located(point)&&L.latLng(loc.lat,loc.lng).distanceTo(L.latLng(point.lat,point.lng))<=150;
          // Offices, floors, mailing formats and coordinate refinements within
          // the same building do not need a second map address.
          if(nearby&&building&&mainBuilding&&building===mainBuilding)return;
          if(nearby&&mainBuilding&&!building&&fold(loc.address).indexOf(mainBuilding)!==-1)return;
          found.set(address,loc);
        });
        return found;
      }
      function appendLocations(parent,locations,label){
        if(!locations.size)return;
        var details=el('details',{class:'oa-map-extra-locations'});details.appendChild(el('summary',{text:label}));
        locations.forEach(function(loc){
          var address=el('p',{}),text=loc.building&&fold(loc.address).indexOf(fold(loc.building))===-1?loc.building+' · '+loc.address:loc.address;
          address.appendChild(makeLink(text,OAMapModel.located(loc)?'https://www.google.com/maps/search/?api=1&query='+loc.lat+','+loc.lng:''));details.appendChild(address);
        });
        parent.appendChild(details);
      }
      function selectedDepartment(row,school) {
        if(!row.department)return false;
        var aliases=row.mapAliases||[];
        var departmentText=fold(row.department+' '+OAMapModel.departmentName(row.department)+' '+aliases.map(function(a){return a.department||'';}).join(' '));
        var schoolText=fold(school+' '+aliases.map(function(a){return a.school||'';}).join(' '));
        if(departmentQueries.length)return departmentQueries.some(function(query){
          var words=query.split(' ');
          if(words.every(function(w){return departmentText.indexOf(w)!==-1;}))return true;
          // Combined school/department searches may use both names, but a
          // school-only search must not highlight every department it houses.
          return words.every(function(w){return (schoolText+' '+departmentText).indexOf(w)!==-1;})&&words.some(function(w){return departmentText.indexOf(w)!==-1&&schoolText.indexOf(w)===-1;});
        });
        return highlightTarget&&targetDepartment&&OAMapModel.matchesRow(row,targetSchool,targetDepartment);
      }

      var university=card.officialInstitution||OAMapModel.displayName(card.institution);
      var schools=(card.schools||[]).slice().sort(function(a,b){
        var aMatch=(a.rows||[]).some(function(r){return selectedDepartment(r,a.name);});
        var bMatch=(b.rows||[]).some(function(r){return selectedDepartment(r,b.name);});
        return Number(bMatch)-Number(aMatch)||Number(fold(b.name)===fold(targetSchool))-Number(fold(a.name)===fold(targetSchool));
      });
      var schoolNames=Array.from(new Set(schools.map(function(s){return OAMapModel.displayName(s.name||'');}).filter(Boolean)));
      var matchingSchool=schools.find(function(s){return (s.rows||[]).some(function(r){return selectedDepartment(r,s.name);});});
      if(matchingSchool)pop.classList.add('oa-map-has-match');
      var title=matchingSchool&&matchingSchool.name?OAMapModel.displayName(matchingSchool.name):schoolNames.length===1?schoolNames[0]:university;
      var header=el('header',{class:'oa-map-card-identity'}),identity=el('div',{class:'oa-map-card-name'});
      var brand=logoImage(card,point);if(brand)header.appendChild(brand);
      identity.appendChild(el('h3',{text:title}));
      if(fold(title)!==fold(university))identity.appendChild(el('p',{class:'oa-map-university-name',text:university}));
      header.appendChild(identity);pop.appendChild(header);
      var location=el('div',{class:'oa-map-card-location'});
      if(point&&point.campusLabel)location.appendChild(el('p',{class:'oa-map-campus',text:point.campusLabel}));
      location.appendChild(el('p',{class:'oa-map-country',text:[point&&point.city,(card.countries||[]).join(' · ')].filter(Boolean).join(', ')}));
      if(point&&point.approximate&&point.locationPrecision!=='campus')location.appendChild(el('p',{class:'oa-map-location-context',text:'Approximate university location — school building not yet verified.'}));
      if(point&&OAMapModel.located(point)){
        var address=el('p',{class:'oa-map-address'});
        address.appendChild(makeLink(point.address||point.building||point.label||university,'https://www.google.com/maps/search/?api=1&query='+point.lat+','+point.lng));
        location.appendChild(address);
      }
      var locationContext=point&&point.locationContext||'';
      // These describe the data model rather than helping a visitor find a place.
      if(point&&point.locationPrecision!=='campus'&&(locationContext==='Current academic department'||/^One school across four locations\.|^Grouped under the graduate business school\./.test(locationContext)))locationContext='';
      if(point&&point.locationVerified&&locationContext)location.appendChild(el('p',{class:'oa-map-location-context',text:locationContext}));
      pop.appendChild(location);
      var departments=el('div',{class:'oa-map-card-departments'});
      schools.forEach(function(s) {
        var section=el('section',{class:'oa-map-card-school'});
        var rowsWithDepartments=(s.rows||[]).filter(function(r){return !!r.department;});
        var locationsByRow=new Map(rowsWithDepartments.map(function(r){return [r,departmentLocations(r)];}));
        var commonLocations=new Map();
        if(rowsWithDepartments.length>1)locationsByRow.get(rowsWithDepartments[0]).forEach(function(loc,k){
          if(rowsWithDepartments.every(function(r){return locationsByRow.get(r).has(k);}))commonLocations.set(k,loc);
        });
        var schoolFaculty=Array.from(new Set((s.rows||[]).filter(function(r){return !r.department&&!r.suppressFacultyLink&&/^https?:\/\//i.test(r.facultyUrl||'');}).map(function(r){return r.facultyUrl;})));
        if(s.name&&schoolNames.length>1&&fold(OAMapModel.displayName(s.name))!==fold(title))section.appendChild(el('h4',{text:OAMapModel.displayName(s.name)}));
        appendLocations(schoolNames.length===1?location:section,commonLocations,'Additional school locations');
        (s.rows||[]).slice().sort(function(a,b){return Number(!!selectedDepartment(b,s.name))-Number(!!selectedDepartment(a,s.name));}).forEach(function(r) {
          var department=OAMapModel.departmentName(r.department);
          var faculty=!r.suppressFacultyLink&&/^https?:\/\//i.test(r.facultyUrl||'')?r.facultyUrl:'';
          // A school-only listing has no department name to invent. Its school
          // name can still lead to a reviewed school faculty directory.
          if(!department){
            var heading=fold(OAMapModel.displayName(s.name))===fold(title)?identity.querySelector('h3'):section.querySelector('h4');
            if(schoolFaculty.length===1&&heading&&!heading.querySelector('a'))heading.replaceChildren(makeLink(heading.textContent,schoolFaculty[0]));
            return;
          }
          var selected=selectedDepartment(r,s.name);
          var row=el('div',{class:'oa-map-department'+(selected?' oa-map-selected-department':'')});
          if(selected)row.appendChild(el('span',{class:'oa-map-match-label',text:departmentQueries.length?'Matches your search':'Requested department'}));
          var p=el('p',{class:'oa-map-department-name'});
          p.appendChild(makeLink(department||OAMapModel.displayName(s.name)||title,faculty));
          row.appendChild(p);
          if(!faculty)row.appendChild(el('p',{class:'oa-map-card-muted',text:'Faculty page not listed'}));
          else if(r.facultyDirectoryHint&&(!r._edit||!(r._edit.fields||[]).includes('facultyUrl')))row.appendChild(el('p',{class:'oa-map-card-muted',text:r.facultyDirectoryHint}));
          var departmentAddresses=new Map(locationsByRow.get(r)||[]);
          commonLocations.forEach(function(_,k){departmentAddresses.delete(k);});
          appendLocations(row,departmentAddresses,'Department location details');
          section.appendChild(row);
        });
        if(section.childElementCount)departments.appendChild(section);
      });
      if(departments.childElementCount)pop.appendChild(departments);
      var q=encodeURIComponent(card.institution),nav=el('nav',{class:'oa-map-primary-actions','aria-label':'Explore this university'});
      var jobs=makeLink('Current jobs','jobs?institution='+q);jobs.className='oa-map-primary-action';
      nav.append(jobs,makeLink('University profile','universities?university='+q));pop.appendChild(nav);
      var community=el('details',{class:'oa-map-community'}),links=el('nav',{class:'oa-map-popup-links','aria-label':'Community and history'});
      community.appendChild(el('summary',{text:'Community and history'}));
      [['Candidates','candidates?c_affiliation='+q],['Recent hires','recent-faculty?placement='+q],['Doctoral alumni','recent-faculty?alma='+q],['Past jobs','previous-markets?university='+q]].forEach(function(item){links.appendChild(makeLink(item[0],item[1]));});
      community.appendChild(links);
      if(card.n)community.appendChild(el('p',{class:'oa-map-card-muted',text:card.n+(card.n===1?' past posting':' past postings')}));
      pop.appendChild(community);
      var footer=el('footer',{class:'oa-map-card-footer'});
      if(point&&point.locationVerified&&point.checked){
        var date=new Date(point.checked+'T00:00:00Z');
        footer.appendChild(el('p',{text:'Location checked '+(Number.isNaN(date.getTime())?point.checked:date.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}))}));
      }
      if(card.edited && card.edited.t)footer.appendChild(el('p',{text:'Last updated '+new Date(card.edited.t).toLocaleDateString()+(card.edited.name?' by '+card.edited.name:'')}));
      if(footer.childElementCount)pop.appendChild(footer);
      community.addEventListener('toggle',function(){if(map._popup&&map._popup.getContent()===pop)map._popup.update();});
      return pop;
    }
    // Keep details in a stationary pane: opening a school must not move the map.
    map.createPane('schoolDetails',mapEl).classList.add('oa-map-details-pane');
    function popupSize() {
      var width=Math.max(120,Math.min(360,mapEl.clientWidth-108));
      return {maxWidth:width,minWidth:width,maxHeight:Math.max(100,mapEl.clientHeight-152)};
    }
    function revealPopupMatch(content) {
      var match=content.querySelector('.oa-map-department.oa-map-selected-department');
      if(!match||!content.isConnected)return;
      var scroller=content.parentElement,box=scroller.getBoundingClientRect(),row=match.getBoundingClientRect();
      var header=content.querySelector('.oa-map-card-identity'),top=box.top+header.getBoundingClientRect().height+8;
      // Keep the identity pinned above the match. Scroll only the card, never
      // the page or map; long rows start at their label and faculty link.
      if(row.top<top||row.bottom>box.bottom)scroller.scrollTop+=row.top-top;
    }
    var identityObserver;
    function openPopup(content,latlng,source,keepFocus) {
      map.closePopup();
      opener=source||document.activeElement;
      L.popup(Object.assign(popupSize(),{pane:'schoolDetails',autoPan:false,className:'oa-map-popup'}))
        .setLatLng(latlng).setContent(content).openOn(map);
      var header=content.querySelector('.oa-map-card-identity');
      if(header){identityObserver=new ResizeObserver(function(){revealPopupMatch(content);});identityObserver.observe(header);}
      setTimeout(function(){if(!content.isConnected)return;content.parentElement.scrollTop=0;revealPopupMatch(content);if(!keepFocus)content.focus({preventScroll:true});},0);
    }
    map.on('popupopen',function(e){host.classList.add('oa-map-popup-open');host.classList.toggle('oa-map-match-open',e.popup.getContent().classList.contains('oa-map-has-match'));});
    map.on('popupclose',function(e){if(identityObserver){identityObserver.disconnect();identityObserver=null;}host.classList.remove('oa-map-popup-open','oa-map-match-open');if(opener && document.contains(opener) && e.popup.getElement().contains(document.activeElement))opener.focus({preventScroll:true});opener=null;});
    mapEl.addEventListener('keydown',function(e){if(e.key==='Escape'){if(map._popup&&map.hasLayer(map._popup))map.closePopup();else clearExpanded();} if((e.key===' '||e.key==='Enter')&&e.target.classList.contains('leaflet-marker-icon')){e.preventDefault();e.stopImmediatePropagation();e.target.click();}},true);
    function nearbyMarkers(all,capacity) {
      // Include the whole viewport plus a logo-sized margin, so nearby points
      // cannot remain as bubbles underneath the expanded logos.
      var size=map.getSize(),halfWidth=size.x/2+54,halfHeight=size.y/2+54;
      var projected=Array.from(currentLayers).map(function(m){return {marker:m,point:map.project(m.getLatLng(),0)};});
      var origin=map.project(map.getCenter(),0),best=null;
      var centers=[origin].concat(all.map(function(m){return map.project(m.getLatLng(),0);}));
      function inside(center,zoom) {
        var scale=Math.pow(2,zoom),dx=halfWidth/scale,dy=halfHeight/scale,nearby=[];
        for(var i=0;i<projected.length;i++){
          var p=projected[i];
          if(Math.abs(p.point.x-center.x)<=dx&&Math.abs(p.point.y-center.y)<=dy)nearby.push(p.marker);
          if(nearby.length>capacity)return null;
        }
        return nearby;
      }
      var fitted=inside(origin,map.getZoom());
      if(fitted&&fitted.length)return fitted;
      // Find the fullest geographic viewport whose logos can all be tapped.
      // Distant locations stay in the ordinary map layer at their true positions.
      for(var zoom=Math.ceil(map.getZoom());zoom<=17;zoom++){
        centers.forEach(function(center){
          var nearby=inside(center,zoom);if(!nearby||!nearby.length)return;
          var distance=center.distanceTo(origin);
          if(!best||nearby.length>best.markers.length||nearby.length===best.markers.length&&(zoom<best.zoom||zoom===best.zoom&&distance<best.distance)){
            best={markers:nearby,center:center,zoom:zoom,distance:distance};
          }
        });
        if(best&&best.markers.length===capacity)break;
      }
      // Even pathological imports with hundreds of identical coordinates must
      // remain on the map without crashing; normal zoom cannot split those.
      if(!best)best={markers:all.slice(0,capacity),center:centers[1],zoom:17};
      map.setView(map.unproject(best.center,0),best.zoom,{animate:false});
      return best.markers;
    }
    function expandLocations(all,keepPopup) {
      if(!all.length)return;
      if(!keepPopup)map.closePopup();clearExpanded();
      // Fit the entire selected group in one step. A fixed zoom increment
      // leaves nested clusters, while zooming to the closest pair hides distant members.
      map.fitBounds(L.latLngBounds(all.map(function(m){return m.getLatLng();})),{paddingTopLeft:[40,40],paddingBottomRight:[80,40],maxZoom:all.length===1?14:17,animate:false});
      var size=map.getSize(),placed=[],slots=[],gap=54;
      for(var y=32;y<=size.y-32;y+=gap)for(var x=32;x<=size.x-76;x+=gap)slots.push(L.point(x,y));
      all=nearbyMarkers(all,slots.length);
      // Fast successive taps on a logo and its card must not collapse the group.
      expandedDoubleClickZoom=map.doubleClickZoom.enabled();map.doubleClickZoom.disable();
      // Individual removal detaches the plugin's move listener. Bulk removal
      // leaves it attached and silently re-clusters repositioned logos.
      all.forEach(function(m){cluster.removeLayer(m);});
      function free(p){return placed.every(function(q){return Math.max(Math.abs(p.x-q.x),Math.abs(p.y-q.y))>=gap;});}
      all.sort(function(a,b){return a.oaCard.id.localeCompare(b.oaCard.id);});
      var positions=all.map(function(m){
        var anchor=map.latLngToContainerPoint(m.getLatLng());
        var position=L.point(Math.max(32,Math.min(size.x-76,anchor.x)),Math.max(32,Math.min(size.y-32,anchor.y)));
        if(!free(position))position=slots.filter(free).sort(function(a,b){return a.distanceTo(anchor)-b.distanceTo(anchor);})[0];
        if(position)placed.push(position);
        return position;
      });
      // Greedy placement near the real coordinates can fragment free space.
      // Repack the whole group onto distinct slots if that happens.
      if(positions.some(function(p){return !p;})){
        var available=slots.slice();
        positions=all.map(function(m){var anchor=map.latLngToContainerPoint(m.getLatLng());available.sort(function(a,b){return a.distanceTo(anchor)-b.distanceTo(anchor);});return available.shift();});
      }
      all.forEach(function(m,index){
        var location=m.getLatLng(),anchor=map.latLngToContainerPoint(location);
        var position=positions[index];expandedMarkers.push({marker:m,location:location});
        var display=map.containerPointToLatLng(position);
        if(position.distanceTo(anchor)>1)L.polyline([location,display],{color:palette().color,weight:1.5,opacity:.8,interactive:false}).addTo(expandedLayer);
        m.setLatLng(display).setZIndexOffset(1000).addTo(expandedLayer);
      });
    }
    cluster.on('clusterclick',function(e){expandLocations(e.layer.getAllChildMarkers());});
    function revealSearch(keepPopup) {
      if(!currentLayers.size)return;
      framing=true;
      try{expandLocations(Array.from(currentLayers),keepPopup);}finally{framing=false;}
      autoFrame=false;autoSearch=true;
    }
    function labelClusters() {
      mapEl.querySelectorAll('.oa-map-cluster').forEach(function(n){n.setAttribute('role','button');n.setAttribute('aria-label',n.textContent+' grouped locations. Zoom in and reveal nearby logos');n.setAttribute('tabindex','0');});
    }
    cluster.on('animationend',labelClusters);map.on('moveend',labelClusters);
    function pointsFor(card) {
      return OAMapModel.pointsFor(card,preparedData).map(function(p){
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
          if(m){var b=el('button',{type:'button',text:'Show on map'});b.addEventListener('click',function(){clearExpanded();cluster.zoomToShowLayer(m,function(){openPopup(cardContent(c,m.oaPoint),m.getLatLng(),b);});});entry.appendChild(b);}
        });
        item.appendChild(entry);fragment.appendChild(item);
      });
      resultList.appendChild(fragment);
    }
    details.addEventListener('toggle',renderResults);
    function draw(keepView) {
      if(!ready)return;
      var cards=snapshot.rows||snapshot.view||[],visible=new Set((snapshot.view||[]).map(function(c){return c.id;})),points=[],missing=[];
      var deptFilter=(snapshot.filters||[]).find(function(f){return f.key==='dept';});
      var queries=deptFilter?deptFilter.values.map(fold).filter(Boolean):[];
      var countryFilter=(snapshot.filters||[]).find(function(f){return f.key==='country';});
      var countryQueries=countryFilter?countryFilter.values.map(fold).filter(Boolean):[];
      var typeFilter=(snapshot.filters||[]).find(function(f){return f.key==='type';});
      var typeQueries=typeFilter?typeFilter.values.map(fold).filter(Boolean):[];
      if(cards.length!==cachedCards.length||cards.some(function(c,i){return c!==cachedCards[i];})){
        var directory=[];
        cards.forEach(function(c){c.schools.forEach(function(s){s.rows.forEach(function(r){directory.push(Object.assign({},r,{institution:c.institution,school:s.name||r.school||''}));});});});
        preparedData=OAMapModel.prepareData({locations:locations,historic:historic,rowInstitutions:rowInstitutions,verified:verified,schoolAliases:schoolAliases,directory:directory});
        var allPoints=[];cards.forEach(function(c){allPoints.push.apply(allPoints,pointsFor(c));});
        cachedPoints=OAMapModel.mergeSchoolLocations(OAMapModel.consolidatePoints(allPoints,verified),verified,{schoolAliases:schoolAliases});
        cachedCards=cards.slice();
      }
      // Select complete school cards only after grouping, so searching one
      // department keeps the other departments at that location on its card.
      cachedPoints.forEach(function(p){
        if(!(p.sourceUniversityIds||[p.card.universityId]).some(function(id){return visible.has(id);}))return;
        if(region!=='world'&&regionOf(p)!==region)return;
        if(countryQueries.length&&countryQueries.indexOf(fold(p.country))===-1)return;
        if(typeQueries.length&&!p.card.schools.some(function(s){return s.rows.some(function(r){
          var label=r.type==='Business School'?'Business school':r.type==='University'?'Non-business school':'';
          return label&&typeQueries.indexOf(fold(label))!==-1;
        });}))return;
        if(queries.length){
          var text=pointSearchCache.get(p);
          if(text===undefined){text=fold(p.school+' '+p.card.schools.map(function(s){return s.name+' '+s.rows.map(function(r){return r.department+' '+(r.mapAliases||[]).map(function(a){return a.school+' '+a.department;}).join(' ');}).join(' ');}).join(' '));pointSearchCache.set(p,text);}
          if(!queries.some(function(q){return q.split(' ').every(function(w){return text.indexOf(w)!==-1;});}))return;
        }
        if(OAMapModel.located(p))points.push(p);else missing.push(p.card);
      });
      // Resize/auth refreshes often deliver the same cards. Keep existing
      // markers, popups and expanded accessible results in that case.
      if(drawn&&keepView&&points.length===currentPoints.length&&points.every(function(p,i){return p===currentPoints[i];})&&missing.length===currentMissing.length&&missing.every(function(c,i){return c===currentMissing[i];}))return;
      var restoreFocus=!!(map._popup&&map.hasLayer(map._popup));
      if(!keepView)highlightTarget=false;
      clearExpanded();
      map.closePopup();markers.clear();currentPoints=points;currentMissing=missing;drawn=true;
      if(!keepView)frame(points);
      var layers=[];
      points.forEach(function(p) {
        var card=p.card;
        var cached=markerCache.get(p);
        if(cached){layers.push(cached);if(!markers.has(card.id))markers.set(card.id,cached);return;}
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
        markerCache.set(p,m);
        layers.push(m);if(!markers.has(card.id))markers.set(card.id,m);
      });
      var nextLayers=new Set(layers),removed=[],added=[];
      currentLayers.forEach(function(m){if(!nextLayers.has(m))removed.push(m);});
      nextLayers.forEach(function(m){if(!currentLayers.has(m))added.push(m);});
      // Rebuilding the cluster tree is cheaper than hundreds of individual
      // removals when switching from the world to a small continent/filter.
      if(removed.length>currentLayers.size/2){cluster.clearLayers();cluster.addLayers(layers);}
      else {if(removed.length)cluster.removeLayers(removed);if(added.length)cluster.addLayers(added);}
      currentLayers=nextLayers;
      var sorted=points.map(function(p){return p.card;}).concat(missing).sort(function(a,b){return a.institution.localeCompare(b.institution);});
      pendingResults=sorted;resultList.replaceChildren();renderResults();
      summary.textContent='Matching school and department locations ('+sorted.length+')';
      var universityCount=new Set(points.map(function(p){return key(p.card.officialInstitution||p.card.institution);})).size;
      status.textContent=universityCount+(universityCount===1?' university · ':' universities · ')+points.length+(points.length===1?' mapped location':' mapped locations')+(missing.length?' · '+missing.length+' without coordinates (available in the list)':'')+'.'+(!sorted.length?' No matches. Try another continent or clear the search filters.':'');
      labelClusters();
      // Deep links wait for BOTH asynchronous data sources, then open the
      // matching school location without requiring a cluster/marker click.
      if(targetUniversity && targetParams.get('focus')==='department' && (!focusApplied || keepView&&restoreFocus)) {
        var matches=layers.filter(function(m){return OAMapModel.pointMatchScore(m.oaPoint,targetUniversity,'','')>0;});
        if(matches.length) {
          var target=OASchools.canonColumns({institution:targetUniversity,school:targetSchool,unit:targetDepartment});
          targetSchool=target.school;targetDepartment=target.unit;
          var chosen=null,bestScore=0,eligible=[];
          if(targetSchool||targetDepartment)matches.forEach(function(m){
            var score=OAMapModel.pointMatchScore(m.oaPoint,targetUniversity,targetSchool,targetDepartment);
            if(score>bestScore){chosen=m;bestScore=score;eligible=[m];}
            else if(score&&score===bestScore&&eligible.indexOf(m)===-1)eligible.push(m);
          });
          if(!targetSchool&&!targetDepartment){
            var generic=matches.filter(function(m){return m.oaCard.schools.some(function(s){return s.rows.some(function(r){return (r.mapSources||[]).some(function(source){
              var related=key(source.institution)===key(targetUniversity)||key(m.oaCard.officialInstitution||'')===key(targetUniversity)||(source.institutionAliases||[]).some(function(a){return key(a)===key(targetUniversity);});
              return related&&[{school:source.school,department:source.department}].concat(source.mapAliases||[]).some(function(a){return !fold(a.school)&&!fold(a.department);});
            });});});});
            if(generic.length===1){chosen=generic[0];eligible=generic;}
            else if(matches.length===1){chosen=matches[0];eligible=matches;}
          }
          if(!chosen){status.textContent+=' The requested department is not in the directory; showing the available schools.';return;}
          focusApplied=true;highlightTarget=true;autoFrame=false;
          var commonGroups=eligible.length?OAMapModel.locationGroupsForTarget(eligible[0].oaPoint,targetUniversity,targetSchool,targetDepartment,verified):[];
          eligible.slice(1).forEach(function(m){var groups=OAMapModel.locationGroupsForTarget(m.oaPoint,targetUniversity,targetSchool,targetDepartment,verified);commonGroups=commonGroups.filter(function(g){return groups.indexOf(g)!==-1;});});
          if(eligible.length>1&&commonGroups.length) {
            var options=el('div',{class:'oa-uni-pop oa-map-location-options',tabindex:'-1'});
            options.appendChild(el('h3',{text:chosen.oaCard.officialInstitution||OAMapModel.displayName(chosen.oaCard.institution)}));
            options.appendChild(el('p',{class:'oa-map-selected-department',text:'This department or posting has several academic locations. Select a location to see its card.'}));
            eligible.forEach(function(m){
              var p=el('p'),button=el('button',{type:'button','data-map-card-id':m.oaCard.id,text:[m.oaPoint.mapCardLabel||m.oaPoint.school,m.oaPoint.building].filter(Boolean).join(' · ')});
              button.addEventListener('click',function(){map.setView(m.getLatLng(),14,{animate:false});openPopup(cardContent(m.oaCard,m.oaPoint),m.getLatLng());});
              p.appendChild(button);options.appendChild(p);
              options.appendChild(el('p',{text:m.oaPoint.address}));
              if(m.oaPoint.locationContext)options.appendChild(el('p',{text:m.oaPoint.locationContext}));
            });
            var groupEvidence=verified.find(function(v){return v.locationGroup===commonGroups[0]&&v.locationGroupSource;});
            options.appendChild(makeLink('Official location information',groupEvidence&&groupEvidence.locationGroupSource));
            map.fitBounds(L.latLngBounds(eligible.map(function(m){return m.getLatLng();})),{padding:[40,40],maxZoom:14,animate:false});
            openPopup(options,map.getCenter());
            return;
          }
          map.setView(chosen.getLatLng(),14,{animate:false});
          openPopup(cardContent(chosen.oaCard,chosen.oaPoint),chosen.getLatLng());
          return;
        }
      }
      var hasLocationSearch=(snapshot.filters||[]).some(function(f){
        return (f.key==='university'||f.key==='dept')&&f.values.some(function(value){return !!fold(value);});
      });
      if(hasLocationSearch){
        revealSearch(false);
        if(currentLayers.size===1&&!currentMissing.length){
          var only=currentLayers.values().next().value;
          // Show the sole result without interrupting typing or dismissing a
          // phone's keyboard. Resize/unchanged-data refreshes do not reopen it.
          openPopup(cardContent(only.oaCard,only.oaPoint),only.getLatLng(),document.activeElement,true);
        }
      }
    }
    function update(next) {
      snapshot=next;
      var signature=JSON.stringify((next.filters||[]));
      var keep=signature===lastSignature;lastSignature=signature;draw(keep);
    }
    Promise.all([
      fetch('/data/university-map.json?v=20261030-directory-updates-10').then(function(r){if(!r.ok)throw Error('map data');return r.json();}),
      fetch('/assets/world/countries.geojson?v=20261022-mobile').then(function(r){if(!r.ok)throw Error('geography');return r.json();})
    ]).then(function(data) {
      data[0].locations.forEach(function(r){nameKeys.set(r.name,r.key);locations.set(r.key,r);});
      data[0].logos.forEach(function(r){nameKeys.set(r.name,r.key);universityLogos.set(r.key,r);});
      rowInstitutions=data[0].rowInstitutions||{};
      verified=data[0].verified||[];
      schoolAliases=data[0].schoolAliases||[];
      data[0].historic.forEach(function(r){var k=r.key;nameKeys.set(r.institution||r.name,k);if(!historic.has(k))historic.set(k,[]);historic.get(k).push(r);});
      land=L.geoJSON(data[1],{style:palette(),interactive:false}).addTo(map);land.bringToBack();
      ready=true;draw(false);resolveReady();
    }).catch(function(err){status.textContent='Map assets could not load. Please reload the page to try again.';console.error('OAUniMap',err);rejectReady(err);});
    var resize=new ResizeObserver(function(){map.invalidateSize({pan:false});if(map._popup){Object.assign(map._popup.options,popupSize());map._popup.update();revealPopupMatch(map._popup.getContent());}if(ready&&mapEl.clientWidth){if(autoSearch)revealSearch(true);else if(autoFrame)frame(currentPoints);}});resize.observe(mapEl);
    window.addEventListener('popstate',function(){var p=new URLSearchParams(location.search).get('region');region=REGIONS.some(function(r){return r[0]===p;})?p:'world';updateButtons();draw(false);});
    return {map:map,whenReady:whenReady,update:update,refresh:function(){draw(true);},shown:function(){return currentPoints.slice();},rows:function(){return snapshot.rows.slice();}};
  }
  window.OAUniMap={mount:mount,fold:fold,regionOf:regionOf};
})();
