/* Site interactions and listing engagement. Semantic parts, never field values,
   contact addresses, link URLs or viewer identity, are sent to GA4.
   Legacy view/link events remain compatible with private profile reports. */
(function () {
  'use strict';
  if (!/^(www\.)?operationsacademia\.org$/.test(location.hostname) ||
      navigator.globalPrivacyControl || navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
  var active = {}, last = Date.now(), interaction = last;
  var pageSeconds = 0;
  var pageRunning = false;
  var away = false;
  var controls = 'a, button, input, select, textarea, summary, [role="button"], [role="tab"], [onclick]';
  // Only known, renderer-owned row labels become dimensions. Profile content
  // and arbitrary DOM text never become an event label.
  var parts = {
    'Research area(s)': 'research_areas', 'Presenting at INFORMS': 'informs_days',
    'INFORMS talk': 'informs_talk', 'CV': 'cv', 'Research summary': 'research_summary',
    'Web page': 'website', 'Contact': 'contact', 'Position type': 'position_type',
    'Suggested apply by': 'suggested_deadline', 'Final apply by': 'final_deadline',
    'File link': 'job_file', 'Posted online at': 'posting_source', 'Further info': 'further_info',
    'Comments on Job Posting': 'job_description', 'Campus countries': 'campus_countries',
    'OA posting ID': 'posting_id'
  };
  function details(target) {
    var control = target.closest(controls), row = target.closest('.oa-kv tr');
    var heading = row && row.querySelector('th');
    var part = heading ? parts[heading.textContent.trim()] || 'detail' :
      target.closest('.oa-card-title') ? 'title' : target.closest('.oa-card-sub') ? 'subtitle' :
      target.closest('.oa-card-head') ? 'header' : target.closest('.oa-card-body') ? 'body' :
      target.closest('li.oa-card') ? 'card' : 'page';
    var head = target.closest('.oa-card-head');
    var card = target.closest('li.oa-card');
    var action = head ? card && card.classList.contains('oa-card-gated') ? 'locked' :
      head.getAttribute('aria-expanded') === 'true' ? 'close' : 'open' :
      control && control.tagName === 'A' ? 'link' : control ? 'control' : 'content';
    var region = target.closest('nav, header, footer, main, form, aside');
    // DOM position identifies generic controls without exporting labels or ids
    // that may contain account identifiers or message subjects.
    var el = control || target, path = [], cursor = el;
    while (cursor && cursor !== document.body && path.length < 6) {
      var index = 1, previous = cursor.previousElementSibling;
      while (previous) { if (previous.tagName === cursor.tagName) index++; previous = previous.previousElementSibling; }
      path.unshift(cursor.tagName.toLowerCase() + ':' + index); cursor = cursor.parentElement;
    }
    return { part: part, action: action, element: el.tagName.toLowerCase(),
      region: region ? region.tagName.toLowerCase() : 'page', target: path.join('/') };
  }
  window.OAInteractionDetails = details;
  function entity(card) {
    var mount = card.closest('#oa-candidates, #oa-jobs, #oa-jobs-recent, #oa-past');
    if (!mount || !card.id || card.classList.contains('oa-card-gated')) return null;
    return { c: card.id, m: mount.id, type: mount.id === 'oa-candidates' ? 'candidate' : 'job' };
  }
  function send(rec, type, name) {
    if (window.OAUsageRecord) window.OAUsageRecord(rec);
    if (window.gtag) window.gtag('event', name, {
      page_location: type ? location.origin + '/' + (type === 'candidate' ? 'candidates' : 'jobs') + '?oa_listing=' + encodeURIComponent(rec.c.slice(4)) : location.origin + location.pathname,
      listing_type: type || 'none', listing_id: rec.c ? rec.c.slice(4) : '',
      listing_part: rec.p || '', interaction_action: rec.a || '',
      element_type: rec.e || '', page_region: rec.r || '', target_path: rec.z || '',
      source_page: location.pathname, mouse_button: rec.b || 0,
      active_seconds: rec.d || 0,
      transport_type: 'beacon'
    });
  }
  // A detail must occupy at least half of its possible visible height/width.
  // Tall descriptions can qualify without fitting wholly on the screen.
  function visiblePart(node, top) {
    var r = node.getBoundingClientRect(), style = getComputedStyle(node);
    if (!r.width || !r.height || style.visibility === 'hidden' || style.display === 'none') return false;
    var height = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, top));
    var width = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    return height >= Math.min(r.height, innerHeight - top) / 2 &&
      width >= Math.min(r.width, innerWidth) / 2;
  }
  function flushPart(v, part) {
    var seconds = v.parts[part];
    if (seconds > 0) send({ t: Date.now(), k: 'part_engagement', c: v.c, m: v.m,
      p: part, d: seconds, x: '', h: '' }, v.type, 'oa_listing_part_engagement');
    v.parts[part] = 0;
  }
  function tickParts(v, card, delta, top) {
    var seen = {};
    card.querySelectorAll('.oa-card-title, .oa-card-sub, .oa-card-body .oa-kv tr').forEach(function (node) {
      if (visiblePart(node, top)) seen[details(node).part] = true;
    });
    Object.keys(seen).forEach(function (part) {
      if (!v.visibleParts[part]) {
        v.parts[part] = 0;
        send({ t: Date.now(), k: 'part_view', c: v.c, m: v.m, p: part, x: '', h: '' }, v.type, 'oa_listing_part_view');
      } else v.parts[part] += delta;
    });
    Object.keys(v.visibleParts).forEach(function (part) {
      if (!seen[part]) { flushPart(v, part); delete v.parts[part]; }
    });
    v.visibleParts = seen;
  }
  function finish(key) {
    var v = active[key];
    if (!v) return;
    if (v.seconds > 0) send({ t: Date.now(), k: 'engagement', c: v.c, m: v.m,
      d: v.seconds, x: '', h: '' }, v.type, 'oa_listing_engagement');
    Object.keys(v.parts).forEach(function (part) { flushPart(v, part); });
    delete active[key];
  }
  function tick() {
    var now = Date.now(), delta = Math.min(2, Math.max(0, (now - last) / 1000));
    last = now;
    var seen = {};
    var eligible = !away && document.visibilityState === 'visible' && document.hasFocus() && now - interaction < 60000;
    if (eligible) {
      if (pageRunning) pageSeconds += delta;
      var header = document.querySelector('.v3-header'), top = 0;
      if (header) { var h = header.getBoundingClientRect(); if (h.top <= 0) top = Math.max(0, Math.min(innerHeight - 1, h.bottom)); }
      document.querySelectorAll('li.oa-card').forEach(function (card) {
        var meta = entity(card), head = card.querySelector('.oa-card-head');
        if (!meta || !head || head.getAttribute('aria-expanded') !== 'true') return;
        var rect = card.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) return;
        var key = meta.type + ':' + meta.c;
        seen[key] = true;
        if (!active[key]) {
          active[key] = Object.assign({ seconds: 0, parts: {}, visibleParts: {} }, meta);
          send({ t: now, k: 'view', c: meta.c, m: meta.m, x: '', h: '' }, meta.type, 'oa_listing_view');
        } else active[key].seconds += delta;
        tickParts(active[key], card, delta, top);
      });
    }
    pageRunning = eligible;
    Object.keys(active).forEach(function (key) { if (!seen[key]) finish(key); });
  }
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function (name) {
    document.addEventListener(name, function () { interaction = Date.now(); }, { passive: true, capture: true });
  });
  function click(e) {
    if (e.type === 'auxclick' && e.button !== 1) return;
    var target = e.target && (e.target.nodeType === 1 ? e.target : e.target.parentElement);
    if (!target || !target.closest) return;
    var d = details(target), link = target.closest('a'), card = target.closest('li.oa-card');
    var meta = card && entity(card);
    var rec = { t: Date.now(), k: 'interaction', p: d.part, a: d.action,
      e: d.element, r: d.region, z: d.target, b: e.button || 0, x: '', h: '' };
    if (meta) { rec.c = meta.c; rec.m = meta.m; }
    send(rec, meta && meta.type, 'oa_site_click');
    if (meta && link) send({ t: rec.t, k: 'link', c: meta.c, m: meta.m, p: d.part, x: '', h: '' }, meta.type, 'oa_listing_link');
    // Start or close the viewing episode after the card's own handler ran.
  }
  document.addEventListener('click', click, true);
  document.addEventListener('auxclick', click, true);
  document.addEventListener('click', function () { requestAnimationFrame(tick); }, true);
  setInterval(tick, 1000);
  // Checkpoints bound lost time on crashes; each segment is recorded once.
  function checkpoint() {
    Object.keys(active).forEach(function (key) {
      var v = active[key];
      if (v.seconds > 0) {
        send({ t: Date.now(), k: 'engagement', c: v.c, m: v.m, d: v.seconds, x: '', h: '' }, v.type, 'oa_listing_engagement');
        v.seconds = 0;
      }
      Object.keys(v.parts).forEach(function (part) { flushPart(v, part); });
    });
    if (pageSeconds > 0) {
      send({ t: Date.now(), k: 'page_engagement', d: pageSeconds, x: '', h: '' }, '', 'oa_page_engagement');
      pageSeconds = 0;
    }
    if (window.OAUsageFlush) window.OAUsageFlush();
  }
  setInterval(checkpoint, 15000);
  document.addEventListener('visibilitychange', function () { tick(); checkpoint(); });
  window.addEventListener('blur', function () { tick(); checkpoint(); });
  window.addEventListener('focus', tick);
  window.addEventListener('pageshow', function () { away = false; pageRunning = false; last = Date.now(); interaction = last; tick(); });
  window.addEventListener('pagehide', function () { if (!away) tick(); away = true; pageRunning = false; Object.keys(active).forEach(finish); checkpoint(); });
  tick();
}());
