/* ---------------------------------------------------------------------------
   Operations Academia — the Universities map.

   Replaces the Awesome Table map view. Vanilla ES5-compatible JS; the map
   itself is Leaflet + OpenStreetMap tiles, vendored under assets/leaflet/ so
   the only third party in the reading path is the tile server. One global:
   window.OAUniMap.

       OAUniMap.mount({ mount: '#oa-uni', data: 'data/universities.json' });

   What it reproduces from the vendor view, deliberately one-for-one:
     - a search field above the map, filtering the pins as you type;
     - clustered pins (the vendor used Google's marker clusterer);
     - a popup per school with the same rows the vendor's tooltip had —
       School/Department, then links to Faculty, Recent hires, PhD Alumni,
       Candidates on the market, Current job openings, Past job postings —
       each pointing at the corresponding page of THIS site, pre-filtered to
       that school (the same ?filter deep links the site has always used).
   The legacy ?filterA=/?filterB= deep links (jobs.json's "Further info"
   column links every posting here as ?filterA=<school>) land in the search
   field, exactly as they landed in the vendor's search filter.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* Diacritic- AND punctuation-insensitive — the same rule as oa-list.js, so
     searching "munster" finds Münster on every page alike, and a posting's
     "Further info" link still lands on its university after the site tidied
     the spelling ("University of California Berkeley" finding "University of
     California, Berkeley"). Both sides are folded the same way, so it only
     ever finds MORE. Keep it in step with oa-list.js and oa-alert-match.js. */
  function fold(s) {
    s = String(s === null || s === undefined ? '' : s).toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/^ | $/g, '');
  }

  function safeUrl(u) {
    u = String(u || '').trim();
    return /^https?:\/\//i.test(u) ? u : '';
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === false || v === undefined) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    (kids || []).forEach(function (c) {
      if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  /* The rows of a school's popup: the vendor tooltip's own list, each link
     pre-filtering the matching page by the school's institution name. Built
     as DOM, never as an HTML string — the dataset is operator-supplied, but
     this page is public and nothing here should ever be interpretable. */
  function popupContent(r, cfg) {
    var inst = r.institution || r.name;
    var q = encodeURIComponent(inst);

    function row(label, node) {
      if (!node) return null;
      return el('tr', null, [
        el('td', { class: 'oa-uni-poplabel', text: label }),
        el('td', null, [node]),
      ]);
    }
    function extLink(url, label) {
      var u = safeUrl(url);
      if (!u) return null;
      return el('a', { href: u, target: '_blank', rel: 'noopener', text: label || 'link' });
    }
    function siteLink(href) {
      return el('a', { href: href, text: 'link' });
    }

    var rows = [
      row('School, Department', r.schoolDept ? el('span', { text: r.schoolDept }) : null),
      row('Faculty', extLink(r.facultyUrl, 'link')),
      row('Recent hires', siteLink('recent-faculty.html?placement=' + q)),
      row('PhD Alumni', siteLink('recent-faculty.html?alma=' + q)),
      /* Where the candidates list LIVES differs between the designs that
         serve this map: a page of its own in the /v2/ archive, a section of
         the one-page site on the live one — where three list engines share
         the query string, so its filter keys are namespaced (urlPrefix 'c_').
         The page says which; the default is the page-of-its-own form, so the
         archive's copy of this engine behaves exactly as it always did. */
      row('Candidates on the market', siteLink(
        (cfg && cfg.candidatesHref) ? cfg.candidatesHref(q) : 'candidates.html?affiliation=' + q)),
      row('Current job openings', siteLink('jobs.html?institution=' + q)),
      row('Past job postings', siteLink('previous-markets.html?university=' + q)),
      row('Campus location', extLink(r.mapUrl, 'map')),
    ].filter(Boolean);

    return el('div', { class: 'oa-uni-pop' }, [
      el('h3', { text: inst }),
      el('table', null, [el('tbody', null, rows)]),
    ]);
  }

  function matchesQuery(r, needle) {
    if (!needle) return true;
    var hay = [r.name, r.institution, r.school, r.department, r.schoolDept, r.address];
    for (var i = 0; i < hay.length; i++) {
      if (fold(hay[i]).indexOf(needle) !== -1) return true;
    }
    return false;
  }

  function mount(cfg) {
    var host = document.querySelector(cfg.mount);
    if (!host) return;

    host.className = 'oa-uni';
    host.innerHTML = '';

    var input = el('input', {
      id: 'oa-uni-search',
      type: 'search',
      placeholder: 'University',
      autocomplete: 'off',
      'aria-label': 'Search universities on the map',
    });
    var count = el('span', {
      class: 'oa-uni-count',
      role: 'status',
      'aria-live': 'polite',
    });
    var bar = el('div', { class: 'oa-uni-bar' }, [
      el('label', { for: 'oa-uni-search', text: 'University' }),
      input,
      count,
    ]);
    var mapEl = el('div', { class: 'oa-uni-map', id: 'oa-uni-map' });
    host.appendChild(bar);
    host.appendChild(mapEl);

    function fail(msg) {
      mapEl.className = 'oa-uni-map is-empty';
      mapEl.textContent = msg;
    }

    if (!window.L || !window.L.map) {
      fail('The map could not be loaded. Please reload the page, or let us know if it keeps happening.');
      return;
    }

    var map = L.map(mapEl, {
      // wheel zoom off: the map sits mid-page, and a wheel that zooms the map
      // traps the scroll that was meant to pass it (the vendor's embed had the
      // same behaviour); the +/- controls and pinch still zoom.
      scrollWheelZoom: false,
      worldCopyJump: true,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    var cluster = (L.markerClusterGroup ? L.markerClusterGroup({ showCoverageOnHover: false })
      : L.layerGroup());
    cluster.addTo(map);

    var base = [];      // the file, exactly as it was served
    var rows = [];      // what is drawn — `base` after cfg.prepare, if any
    var shown = [];
    var timer = null;

    /* A page may correct the dataset before it is drawn (universities.html
       overlays the maintainer's `rowOverrides` — see assets/oa-rowedit.js).
       The engine keeps the file it fetched, so the overlay can arrive LATE —
       Firestore resolves after this fetch as often as not — and be applied
       without going back to the network. */
    function prepared(list) {
      if (typeof cfg.prepare !== 'function') return list.slice();
      var out = cfg.prepare(list.slice());
      return (out || []).filter(function (r) { return r && numeric(r.lat) && numeric(r.lng); });
    }

    function bounds(list) {
      var b = L.latLngBounds([]);
      list.forEach(function (r) { b.extend([r.lat, r.lng]); });
      return b;
    }

    function draw(q, opts) {
      var keepView = !!(opts && opts.keepView);
      var needle = fold(q);
      shown = rows.filter(function (r) { return matchesQuery(r, needle); });
      /* Close before clearing. A popup whose marker is about to leave the
         cluster is no longer Leaflet's to auto-close, so it lingers in the DOM
         and the next pin opens a SECOND one beside it. */
      map.closePopup();
      cluster.clearLayers();
      shown.forEach(function (r) {
        var m = L.marker([r.lat, r.lng], { title: r.name });
        var pop = popupContent(r, cfg);
        // A page may add its own controls to a popup — the maintainer's Edit
        // and Take down on universities.html. The hook is the map's twin of
        // OAList's `onCard`, and like it, drawing a button is never authority.
        if (typeof cfg.onPopup === 'function') {
          try { cfg.onPopup(pop, r); } catch (e) { if (window.console) console.error(e); }
        }
        m.bindPopup(pop, { maxWidth: 320 });
        cluster.addLayer(m);
      });
      count.textContent = !rows.length ? ''
        : needle
          ? shown.length + ' of ' + rows.length + ' universities'
          : rows.length + ' universities';
      /* A SEARCH frames what it found; a REDRAW must not. Re-fitting on a
         redraw undoes a viewport the reader chose deliberately — and every
         correction made from a pin causes one. */
      if (shown.length && !keepView) {
        map.fitBounds(bounds(shown).pad(0.1), { maxZoom: needle ? 8 : 17 });
      }
    }

    /* Filter state lives in the query string, like every list page — and the
       vendor's own ?filterA=/?filterB= deep links (every posting's "Further
       info" link names this page that way) are honoured as the search. */
    /* `isFinite(null)` is true, and a null coordinate would pin 0°,0° */
    function numeric(v) { return typeof v === 'number' && isFinite(v); }
    function readUrl() {
      var p = new URLSearchParams(location.search);
      return p.get('q') || p.get('filterA') || p.get('filterB') || '';
    }
    function syncUrl() {
      var p = new URLSearchParams(location.search);
      p['delete']('q'); p['delete']('filterA'); p['delete']('filterB');
      if (input.value) { p.set('q', input.value); p.set('view', 'map'); }   // a search is a map search
      var qs = p.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    }

    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { draw(input.value); syncUrl(); }, 140);
    });

    fetch(cfg.data, { credentials: 'same-origin', cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
        return res.json();
      })
      .then(function (data) {
        base = (Array.isArray(data) ? data : []).filter(function (r) {
          return r && numeric(r.lat) && numeric(r.lng);
        });
        rows = prepared(base);
        input.value = readUrl();
        draw(input.value);
        if (!rows.length) fail('No universities could be loaded. Please reload the page, or let us know if it keeps happening.');
      })
      ['catch'](function (err) {
        fail('The universities could not be loaded. Please reload the page, or let us know if it keeps happening.');
        if (window.console) console.error('OAUniMap: failed to load ' + cfg.data, err);
      });

    return {
      rows: function () { return rows.slice(); },
      shown: function () { return shown.slice(); },
      /** Re-run cfg.prepare over the file as served, and redraw IN PLACE —
          the reader's viewport is kept. (The popup closes: its marker is
          destroyed by the redraw, and reopening one on a marker the cluster
          has not finished placing leaves two popups on screen. Keeping the
          VIEW is what makes correcting a run of schools workable; the reader
          is still looking at the same place.) */
      refresh: function () {
        if (!base.length) return;
        rows = prepared(base);
        draw(input.value, { keepView: true });
      },
      map: map,
    };
  }

  window.OAUniMap = { mount: mount, fold: fold };
})();
