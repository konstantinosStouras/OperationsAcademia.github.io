/* Listing engagement: visible, expanded cards in a focused tab only.
   Only public listing identifiers and engagement are sent to GA4, never typed values or viewer identity. */
(function () {
  'use strict';
  if (!/^(www\.)?operationsacademia\.org$/.test(location.hostname) ||
      navigator.globalPrivacyControl || navigator.doNotTrack === '1') return;
  var active = {}, last = Date.now(), interaction = last;
  function entity(card) {
    var mount = card.closest('#oa-candidates, #oa-jobs, #oa-jobs-recent');
    if (!mount || !card.id || card.classList.contains('oa-card-gated')) return null;
    return { c: card.id, m: mount.id, type: mount.id === 'oa-candidates' ? 'candidate' : 'job' };
  }
  function send(rec, type, name) {
    if (window.OAUsageRecord) window.OAUsageRecord(rec);
    if (window.gtag) window.gtag('event', name, {
      page_location: location.origin + '/' + (type === 'candidate' ? 'candidates' : 'jobs') + '?oa_listing=' + encodeURIComponent(rec.c.slice(4)),
      active_seconds: rec.d || 0,
      transport_type: 'beacon'
    });
  }
  function finish(key) {
    var v = active[key];
    if (!v) return;
    if (v.seconds > 0) send({ t: Date.now(), k: 'engagement', c: v.c, m: v.m,
      d: v.seconds, x: '', h: '' }, v.type, 'oa_listing_engagement');
    delete active[key];
  }
  function tick() {
    var now = Date.now(), delta = Math.min(2, Math.max(0, (now - last) / 1000));
    last = now;
    var seen = {};
    if (document.visibilityState === 'visible' && document.hasFocus() && now - interaction < 60000) {
      document.querySelectorAll('li.oa-card').forEach(function (card) {
        var meta = entity(card), head = card.querySelector('.oa-card-head');
        if (!meta || !head || head.getAttribute('aria-expanded') !== 'true') return;
        var rect = card.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) return;
        var key = meta.type + ':' + meta.c;
        seen[key] = true;
        if (!active[key]) {
          active[key] = Object.assign({ seconds: 0 }, meta);
          send({ t: now, k: 'view', c: meta.c, m: meta.m, x: '', h: '' }, meta.type, 'oa_listing_view');
        } else active[key].seconds += delta;
      });
    }
    Object.keys(active).forEach(function (key) { if (!seen[key]) finish(key); });
  }
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function (name) {
    document.addEventListener(name, function () { interaction = Date.now(); }, { passive: true, capture: true });
  });
  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a'), card = link && link.closest('li.oa-card');
    var meta = card && entity(card);
    if (meta) send({ t: Date.now(), k: 'link', c: meta.c, m: meta.m, x: '', h: '' }, meta.type, 'oa_listing_link');
  }, true);
  document.addEventListener('click', function () { requestAnimationFrame(tick); }, true);
  setInterval(tick, 1000);
  // Checkpoints bound lost time on crashes; each segment is recorded once.
  setInterval(function () {
    Object.keys(active).forEach(function (key) {
      var v = active[key];
      if (v.seconds > 0) {
        send({ t: Date.now(), k: 'engagement', c: v.c, m: v.m, d: v.seconds, x: '', h: '' }, v.type, 'oa_listing_engagement');
        v.seconds = 0;
      }
    });
  }, 15000);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('blur', tick);
  window.addEventListener('pagehide', function () { Object.keys(active).forEach(finish); });
}());
