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
    var resolveReady,rejectReady;
    var whenReady=new Promise(function(resolve,reject){resolveReady=resolve;rejectReady=reject;});
    var locations = new Map(), historic = new Map(), rowInstitutions = {}, ready = false, lastSignature = '';
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
    var legend = el('p',{class:'oa-map-legend',text:'Logo: university location · Number: grouped universities · Initials: logo unavailable. Locations are approximate.'});
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
        var count=new Set(c.getAllChildMarkers().map(function(m){return m.oaCard.id;})).size;
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
      pop.appendChild(el('h3',{text:card.institution}));
      pop.appendChild(el('p',{text:(card.countries||[]).join(' · ')}));
      pop.appendChild(el('p',{text:(card.schools||[]).length+((card.schools||[]).length===1?' school · ':' schools · ')+(card.schools||[]).reduce(function(n,s){return n+(s.rows||[]).length;},0)+' department listings · '+(card.n||0)+' past postings'}));
      (card.schools||[]).forEach(function(s) {
        if(s.name)pop.appendChild(el('h4',{text:s.name}));
        (s.rows||[]).forEach(function(r) {
          var p=el('p',{}); p.appendChild(makeLink(r.department||'School listing',r.deptUrl));
          if(r.facultyUrl) {p.appendChild(document.createTextNode(' · '));p.appendChild(makeLink('Faculty',r.facultyUrl));}
          pop.appendChild(p);
        });
      });
      var q=encodeURIComponent(card.institution),nav=el('p',{class:'oa-map-popup-links'});
      [['Open university profile','universities?university='+q],['Current jobs','jobs?institution='+q],['Candidates','candidates?c_affiliation='+q],['Recent hires','recent-faculty?placement='+q],['PhD alumni','recent-faculty?alma='+q],['Past jobs','previous-markets?university='+q]].forEach(function(item){nav.appendChild(makeLink(item[0],item[1]));});
      pop.appendChild(nav);
      if(card.edited && card.edited.t)pop.appendChild(el('p',{text:'Last updated '+new Date(card.edited.t).toLocaleDateString()+(card.edited.name?' by '+card.edited.name:'')}));
      if(point && point.mapUrl)pop.appendChild(makeLink('Campus location',point.mapUrl));
      return pop;
    }
    function openPopup(content,latlng,source) {
      map.closePopup();
      opener=source||document.activeElement;
      L.popup({maxWidth:360,minWidth:Math.min(260,window.innerWidth-80),autoPanPadding:[20,20],className:'oa-map-popup'})
        .setLatLng(latlng).setContent(content).openOn(map);
      setTimeout(function(){var link=content.querySelector('a,button'); (link||content).focus();},0);
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
      mapEl.querySelectorAll('.oa-map-cluster').forEach(function(n){n.setAttribute('role','button');n.setAttribute('aria-label',n.textContent+' grouped universities. Zoom in or expand markers');n.setAttribute('tabindex','0');});
    }
    cluster.on('animationend',labelClusters);map.on('moveend',labelClusters);
    function pointsFor(card) {
      var names=[card.institution].concat((card.aka||'').split(' · '));
      (card.schools||[]).forEach(function(s){(s.rows||[]).forEach(function(r){if(rowInstitutions[r.id])names.push(rowInstitutions[r.id]);});});
      names=Array.from(new Set(names));
      var pts=[],seen=new Set(),fallback=null;
      names.forEach(function(name) {
        var k=key(name),r=locations.get(k);if(r&&!fallback)fallback=r;
        (historic.get(k)||[]).forEach(function(p){
          var coord=p.lat.toFixed(4)+','+p.lng.toFixed(4);if(seen.has(coord))return;seen.add(coord);
          var schoolLogo=locations.get(key(p.school));
          pts.push(Object.assign({},p,{logo:schoolLogo&&schoolLogo.logo||logoFor(card)||r&&r.logo,country:r&&r.country||(card.countries||[])[0]||''}));
        });
      });
      if(!pts.length&&fallback)pts.push(Object.assign({},fallback,{logo:logoFor(card)||fallback.logo}));
      return pts;
    }
    var pendingResults=[];
    function renderResults() {
      if(!details.open || resultList.childElementCount)return;
      var fragment=document.createDocumentFragment();
      pendingResults.forEach(function(c){
        var item=el('li',{}),m=markers.get(c.id),entry=el('details',{}),built=false;
        var heading=el('summary',{text:c.institution+(m?'':' — location unavailable')});
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
      cards.forEach(function(c){
        var ps=pointsFor(c);
        if(!ps.length){if(region==='world'||(c.countries||[]).some(function(country){return regionOf({country:country})===region;}))missing.push(c);return;}
        ps=ps.filter(function(p){return region==='world'||regionOf(p)===region;});
        if(ps.length)inRegion.push(c);
        ps.forEach(function(p){points.push(Object.assign({},p,{card:c}));});
      });
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
        var m=L.marker([p.lat,p.lng],{icon:icon,title:card.institution,alt:card.institution,keyboard:true});
        m.oaCard=card;m.oaPoint=p;
        m.on('add',function(){var n=m.getElement();if(n){n.setAttribute('aria-label','Open '+card.institution);n.setAttribute('role','button');var im=n.querySelector('img');if(im){im.addEventListener('load',function(){if(im.naturalWidth/im.naturalHeight>1.6)im.classList.add('oa-map-logo-wide');});im.addEventListener('error',function(){im.remove();});if(im.complete&&im.naturalWidth&&im.naturalWidth/im.naturalHeight>1.6)im.classList.add('oa-map-logo-wide');if(!im.getAttribute('src'))im.src=im.getAttribute('data-src');}}});
        m.on('click',function(){openPopup(cardContent(card,p),m.getLatLng(),m.getElement());});
        layers.push(m);if(!markers.has(card.id))markers.set(card.id,m);
      });
      cluster.addLayers(layers);
      var sorted=inRegion.concat(missing).sort(function(a,b){return a.institution.localeCompare(b.institution);});
      pendingResults=sorted;resultList.replaceChildren();renderResults();
      summary.textContent='Matching universities ('+sorted.length+')';
      status.textContent=inRegion.length+(inRegion.length===1?' university · ':' universities · ')+points.length+(points.length===1?' mapped location':' mapped locations')+(missing.length?' · '+missing.length+' without coordinates (available in the list)':'')+'.'+(!sorted.length?' No matches. Try another continent or clear the search filters.':'');
      labelClusters();
    }
    function update(next) {
      snapshot=next;
      var signature=JSON.stringify((next.filters||[]));
      var keep=signature===lastSignature;lastSignature=signature;draw(keep);
    }
    Promise.all([
      fetch('/data/university-map.json?v=20261022-mobile').then(function(r){if(!r.ok)throw Error('map data');return r.json();}),
      fetch('/assets/world/countries.geojson?v=20261022-mobile').then(function(r){if(!r.ok)throw Error('geography');return r.json();})
    ]).then(function(data) {
      data[0].locations.forEach(function(r){nameKeys.set(r.name,r.key);locations.set(r.key,r);});
      data[0].logos.forEach(function(r){nameKeys.set(r.name,r.key);universityLogos.set(r.key,r);});
      rowInstitutions=data[0].rowInstitutions||{};
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
