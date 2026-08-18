/* ===========================================================================
   Operations Academia — v3 behaviours.

   Everything the one-page preview needs beyond the vendored engines:

     THEME      light/dark, chosen by the visitor, remembered in localStorage
                ('oaV3Theme'), defaulting to the system preference. The
                pre-paint snippet in each page's <head> sets data-theme before
                first paint so there is no flash; this file only wires the
                toggle buttons.

     SCROLL     eased in-page travel (owner: "initially accelerate, then slow
                down as the screen gets closer, and finally slowly stop", as
                on stouras.com). Implemented with rAF and an ease-in-out
                curve whose deceleration tail is longer than its
                acceleration — and the TARGET POSITION IS RE-READ EVERY
                FRAME, because the lists above the target lazy-load and grow
                the page mid-flight; a fixed pixel destination would land in
                the wrong section.

     NAV        scrollspy over the section anchors, and the phone/tablet
                slide-over sheet.

     FAQ        the accordion (one open at a time).

     LAZY       V3.lazy(el, fn) — run fn when el approaches the viewport,
                once. Used to mount the jobs/candidates/placements engines
                only as the reader nears them, so first paint stays light.

     Plus: reveal-on-scroll, back-to-top, stat count-up, footer year.
   =========================================================================== */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* ------------------------------------------------------------------ theme */

  var THEME_KEY = 'oaV3Theme';

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme, remember) {
    document.documentElement.setAttribute('data-theme', theme);
    if (remember) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode */ }
    }
    $$('.v3-theme').forEach(function (b) {
      b.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      b.setAttribute('title', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    });
  }

  function wireTheme() {
    applyTheme(currentTheme(), false);
    $$('.v3-theme').forEach(function (b) {
      b.addEventListener('click', function () {
        applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
      });
    });
    // follow the SYSTEM only while the visitor has never chosen for themselves
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onSys = function (e) {
        var stored = null;
        try { stored = localStorage.getItem(THEME_KEY); } catch (err) {}
        if (!stored) applyTheme(e.matches ? 'dark' : 'light', false);
      };
      if (mq.addEventListener) mq.addEventListener('change', onSys);
      else if (mq.addListener) mq.addListener(onSys);
    }
  }

  /* ----------------------------------------------------------- eased scroll */

  var headerOffset = function () {
    var h = $('.v3-header');
    return (h ? h.offsetHeight : 64) + 10;
  };

  var scrolling = null; // the one active animation; a new request cancels it

  /* Ease-in-out with a LONG settle: quadratic acceleration for the first
     third, then a quartic deceleration for the remaining two thirds — the
     screen picks up speed, slows as the target nears, and drifts to a stop. */
  function ease(t) {
    var SPLIT = 0.34;
    if (t < SPLIT) {
      var a = t / SPLIT;                      // 0..1 across the acceleration
      return SPLIT * a * a;                   // v(0)=0, accelerating
    }
    var d = (t - SPLIT) / (1 - SPLIT);        // 0..1 across the deceleration
    return SPLIT + (1 - SPLIT) * (1 - Math.pow(1 - d, 4));
  }

  function targetYOf(el) {
    if (!el) return 0;
    var r = el.getBoundingClientRect();
    var y = r.top + window.pageYOffset - headerOffset();
    var max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return Math.min(Math.max(0, y), max);
  }

  function scrollToEl(el, done) {
    if (reduceMotion) {
      window.scrollTo(0, targetYOf(el));
      if (done) done();
      return;
    }
    if (scrolling) { cancelAnimationFrame(scrolling.raf); scrolling = null; }

    var startY = window.pageYOffset;
    var dist = Math.abs(targetYOf(el) - startY);
    if (dist < 2) { if (done) done(); return; }

    // duration grows with distance but is capped — a trip to the foot of the
    // page takes ~1.5s, a hop to the next section ~0.7s
    var duration = Math.min(1500, Math.max(550, 420 + dist * 0.22));
    var t0 = null;
    var state = { raf: 0 };
    scrolling = state;

    // a wheel/touch from the reader takes the wheel back immediately
    var interrupted = false;
    function interrupt() { interrupted = true; }
    window.addEventListener('wheel', interrupt, { passive: true });
    window.addEventListener('touchstart', interrupt, { passive: true });

    function cleanup() {
      window.removeEventListener('wheel', interrupt);
      window.removeEventListener('touchstart', interrupt);
      if (scrolling === state) scrolling = null;
    }

    function step(ts) {
      if (interrupted) { cleanup(); return; }
      if (t0 === null) t0 = ts;
      var t = Math.min(1, (ts - t0) / duration);
      // the destination is re-read every frame: content above it may have
      // lazy-loaded and moved it since the click
      var target = targetYOf(el);
      var y = startY + (target - startY) * ease(t);
      window.scrollTo(0, y);
      if (t < 1) {
        state.raf = requestAnimationFrame(step);
      } else {
        cleanup();
        if (done) done();
      }
    }
    state.raf = requestAnimationFrame(step);
  }

  function wireSmoothScroll() {
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target.closest ? e.target.closest('a[href*="#"]') : null;
      if (!a) return;
      // only same-page anchors
      var url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname !== location.pathname) return;
      var id = decodeURIComponent(url.hash.slice(1));
      if (!id) return;
      var el = document.getElementById(id);
      if (!el) return;
      e.preventDefault();
      closeSheet();
      // record the section in the address bar without the native jump
      try { history.pushState(null, '', '#' + id); } catch (err) {}
      scrollToEl(el);
    });

    // arriving with a #hash: let the page paint, then travel to it
    if (location.hash.length > 1) {
      var el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (el) {
        // two frames so fonts/first layout settle; the per-frame re-read in
        // scrollToEl handles anything that loads after that
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { scrollToEl(el); });
        });
      }
    }
  }

  /* -------------------------------------------------------------- scrollspy */

  function wireSpy() {
    var links = $$('.v3-nav a[href*="#"], .v3-sheet nav a[href*="#"]').filter(function (a) {
      var url = new URL(a.href, location.href);
      return url.pathname === location.pathname && url.hash.length > 1;
    });
    if (!links.length) return;
    var byId = {};
    var sections = [];
    links.forEach(function (a) {
      var id = decodeURIComponent(new URL(a.href, location.href).hash.slice(1));
      var el = document.getElementById(id);
      if (!el) return;
      (byId[id] = byId[id] || []).push(a);
      if (sections.indexOf(el) === -1) sections.push(el);
    });

    var ticking = false;
    function update() {
      ticking = false;
      var probe = window.pageYOffset + headerOffset() + window.innerHeight * 0.25;
      var active = null;
      for (var i = 0; i < sections.length; i++) {
        var top = sections[i].getBoundingClientRect().top + window.pageYOffset;
        if (top <= probe) active = sections[i].id;
      }
      // at the very bottom, the last section wins even if its top is far up
      if (window.innerHeight + window.pageYOffset >= document.documentElement.scrollHeight - 4) {
        active = sections[sections.length - 1].id;
      }
      links.forEach(function (a) { a.classList.remove('is-active'); });
      if (active && byId[active]) {
        byId[active].forEach(function (a) { a.classList.add('is-active'); });
      }
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  }

  /* ------------------------------------------------------------ mobile sheet */

  function closeSheet() {
    document.body.classList.remove('v3-sheet-open');
    var b = $('.v3-burger');
    if (b) b.setAttribute('aria-expanded', 'false');
  }

  function wireSheet() {
    var burger = $('.v3-burger');
    var backdrop = $('.v3-sheet-backdrop');
    var close = $('.v3-sheet-close');
    if (!burger) return;
    burger.addEventListener('click', function () {
      var open = document.body.classList.toggle('v3-sheet-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    if (backdrop) backdrop.addEventListener('click', closeSheet);
    if (close) close.addEventListener('click', closeSheet);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSheet();
    });
  }

  /* -------------------------------------------------------------------- FAQ */

  function wireFaq() {
    var items = $$('.v3-faq-item');
    if (!items.length) return;
    items.forEach(function (item) {
      var q = $('.v3-faq-q', item);
      if (!q) return;
      q.setAttribute('aria-expanded', item.classList.contains('is-open') ? 'true' : 'false');
      q.addEventListener('click', function () {
        var opening = !item.classList.contains('is-open');
        items.forEach(function (o) {
          o.classList.remove('is-open');
          var oq = $('.v3-faq-q', o);
          if (oq) oq.setAttribute('aria-expanded', 'false');
        });
        if (opening) {
          item.classList.add('is-open');
          q.setAttribute('aria-expanded', 'true');
        }
      });
    });
  }

  /* ---------------------------------------------------------- lazy sections */

  function lazy(el, fn) {
    if (typeof el === 'string') el = $(el);
    if (!el) return;
    if (!('IntersectionObserver' in window)) { fn(); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        io.disconnect();
        fn();
      });
    }, { rootMargin: '900px 0px' });
    io.observe(el);
  }

  /* --------------------------------------------------------------- reveals */

  function wireReveals() {
    var els = $$('.v3-reveal');
    if (!els.length) return;
    if (reduceMotion || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('is-in');
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ------------------------------------------------------------ back to top */

  function wireTop() {
    var btn = $('.v3-top');
    if (!btn) return;
    var shown = false;
    window.addEventListener('scroll', function () {
      var want = window.pageYOffset > window.innerHeight * 1.2;
      if (want !== shown) {
        shown = want;
        btn.classList.toggle('is-shown', want);
      }
    }, { passive: true });
    btn.addEventListener('click', function () {
      scrollToEl(document.body, function () {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      });
    });
  }

  /* --------------------------------------------------------------- numbers */

  /** Count a stat up when it first scrolls into view (owner, 2026-08-17: the
      hero's numbers should run up fast as the page is scrolled top to bottom).

      `text` may carry a suffix ("200+", "12 yrs") — only the LEADING integer
      runs, and it keeps the source's own thousands formatting, so a year
      ("2014") spins as 2014 rather than "2,014".

      Called twice on the same element it CONTINUES from what is on screen
      instead of dropping back to zero: the hero's figures are authored in the
      HTML so they animate on the very first paint, and the live files
      (/data/*.json) land a second later and may raise one of them.

      Opt a number out with data-count="off". */

  var COUNT_MS = 800;                 // fast — over before the eye settles

  function countUp(el, text) {
    if (!el) return;
    var str = String(text == null ? el.textContent : text).trim();
    var m = /^(\d[\d,]*)([\s\S]*)$/.exec(str);
    var prev = el._v3count;
    if (prev) {                       // never two runs on one number
      if (prev.io) prev.io.disconnect();
      prev.dead = true;
      el._v3count = null;
    }
    if (!m || reduceMotion || el.getAttribute('data-count') === 'off' ||
        !('IntersectionObserver' in window) || !('requestAnimationFrame' in window)) {
      el.textContent = str;           // no motion wanted, or none possible
      return;
    }
    var target = parseInt(m[1].replace(/,/g, ''), 10);
    var suffix = m[2] || '';
    var group = m[1].indexOf(',') !== -1;
    // start from whatever number is on screen (a run in flight, or a figure
    // the HTML seeded and a live file has just raised) — never rewind one
    var seen = /^(\d[\d,]*)/.exec((el.textContent || '').trim());
    var now = prev ? prev.value
      : seen ? parseInt(seen[1].replace(/,/g, ''), 10) : 0;
    /* Deliberately `<`, not `<=`: a figure the HTML seeded AT its target is
       the ordinary case here (index.html writes "200+", "700+", "2014"), and
       it is the one the count-up animation exists FOR — starting it at the
       target would paint the final number and animate nothing. The reported
       symptom, a hero holding "0+ universities", was never this line: it was
       the observer firing behind seven synchronous scripts, which deferring
       them and taking the counters over at parse time is what fixes. */
    var from = now > 0 && now < target ? now : 0;
    var state = { value: from, dead: false, io: null };

    function show(v) {
      state.value = v;
      el.textContent = (group ? v.toLocaleString('en-US') : String(v)) + suffix;
    }

    el._v3count = state;
    show(from);
    state.io = new IntersectionObserver(function (entries) {
      if (!entries.some(function (en) { return en.isIntersecting; })) return;
      state.io.disconnect();
      var t0 = null;
      function tick(ts) {
        if (state.dead) return;       // a newer value took this number over
        if (t0 === null) t0 = ts;
        var t = Math.min(1, (ts - t0) / COUNT_MS);
        show(Math.round(from + (target - from) * (1 - Math.pow(1 - t, 3))));
        if (t < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }, { threshold: 0.35 });
    state.io.observe(el);
  }

  /* Every hero stat runs, not only the two the live files fill in — the
     figures written straight into the HTML are wired from their own markup.
     Called at PARSE time and again from boot(); a number already wired by the
     first call is left to finish its run rather than started over. */
  function wireCounts() {
    $$('.v3-stat b, [data-count]').forEach(function (el) {
      if (el._v3count || el.getAttribute('data-count') === 'off') return;
      countUp(el, el.textContent);
    });
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    // content blocks ported from the old site may carry inline ga() handlers;
    // the analytics property is long dead, but the global must exist
    window.ga = window.ga || function () {};
    wireTheme();
    wireSheet();
    wireSmoothScroll();
    wireSpy();
    wireFaq();
    wireTop();
    wireCounts();
    $$('.js-current-year').forEach(function (el) {
      el.textContent = String(new Date().getFullYear());
    });
  }

  /* Two things are done at PARSE time — this file sits at the end of the body,
     after all the content — and both for the same reason: what the reader sees
     first must not depend on the seven scripts that follow this one.

     The reveal-on-scroll blocks are hidden by the stylesheet until this file
     claims them, and it used to claim them in boot(), on DOMContentLoaded —
     which is AFTER every other script on the page has parsed and run. So the
     whole of the home page below the hero sat blank through that window, and
     a throw anywhere in boot()'s earlier calls left it blank for good. Doing
     it here, first, means the content is revealed as soon as the markup it
     acts on exists, and nothing that happens later can prevent it.

     The counters are taken over here for the same kind of reason: so they
     never paint their final value and then rewind. Everything else waits for
     the document. */
  wireReveals();
  wireCounts();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.V3 = {
    lazy: lazy,
    scrollToEl: scrollToEl,
    statTo: countUp,          // the live files raise a figure the HTML seeded
    countUp: countUp,
    theme: { apply: applyTheme, current: currentTheme }
  };
})();
