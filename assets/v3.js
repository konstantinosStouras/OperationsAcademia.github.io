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
      /* …and move FOCUS there, which the native jump did and this did not:
         the skip link and every nav link scrolled the page while the
         keyboard stayed on the link, so the next Tab went back to the header. */
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
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

    /* "More" shows the state of whatever is current UNDER it — five of the
       home page's eight sections are in the panel, and without this the nav
       says nothing while the reader is in any of them. A CLASS only: the
       trigger is not a link and takes no aria-current, and the link inside
       the panel already carries it. */
    var moreBtn = $('.v3-more-btn');
    var morePanel = $('.v3-more-panel');

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
      links.forEach(function (a) { a.classList.remove('is-active'); a.removeAttribute('aria-current'); });
      if (active && byId[active]) {
        byId[active].forEach(function (a) { a.classList.add('is-active'); a.setAttribute('aria-current', 'true'); });
      }
      if (moreBtn) {
        moreBtn.classList.toggle('is-active',
          !!(morePanel && morePanel.querySelector('a.is-active')));
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
    var sheet = $('.v3-sheet');
    if (!burger) return;
    if (sheet) { sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); }
    burger.addEventListener('click', function () {
      var open = document.body.classList.toggle('v3-sheet-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      /* A dialog takes focus when it opens and gives it back when it closes;
         without this Tab walked the page BEHIND the sheet. */
      if (open && close) setTimeout(function () { close.focus(); }, 0);
    });
    function closeAndReturn() {
      var was = document.body.classList.contains('v3-sheet-open');
      closeSheet();
      if (was) burger.focus();
    }
    if (backdrop) backdrop.addEventListener('click', closeAndReturn);
    if (close) close.addEventListener('click', closeAndReturn);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeAndReturn(); return; }
      /* keep Tab inside the open sheet */
      if (e.key !== 'Tab' || !sheet || !document.body.classList.contains('v3-sheet-open')) return;
      var stops = sheet.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!stops.length) return;
      var first = stops[0], last = stops[stops.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!sheet.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    });
  }

  /* ---------------------------------------------------------- more dropdown */
  /** The header's "More" panel (owner, 2026-09-09: the eight flat nav items
      become five — Jobs · Candidates · Forum · Survey · More — with the rest
      under More in two labelled blocks).

      IT IS A DISCLOSURE, NOT A MENU, and that is a decision rather than a
      shortcut. role="menu"/role="menuitem" is the contract for a list of
      COMMANDS: it stops the children being announced as LINKS, it takes away
      the cue that middle-click and "copy link address" work — on a site whose
      permalinks are load-bearing — it makes Tab leave the whole widget instead
      of walking it, and it forbids the plain text between the groups, which is
      the reason the panel has two blocks rather than being one flat list. What
      is in here is nine ordinary navigation links, so it is a button with
      aria-expanded over a hidden div of <a>s, every one an ordinary tab stop,
      and the arrow keys are a convenience laid on top of Tab rather than the
      only way through.

      The account menu next door DOES say role="menu" — it is mostly commands —
      and what this copies from it is the OPEN/CLOSE mechanics: the `hidden`
      attribute, aria-expanded on the trigger, a CAPTURE-phase mousedown on
      document, and Escape. What it deliberately does not copy is the ROLE:
      that menu implements no arrow-key roving either, and a contract kept by
      half is worse than one never made.

      THE MARKUP SHIPS THE TRIGGER, ITS aria-expanded AND THE PANEL'S `hidden`;
      this file only ever toggles them. That is the header's own rule — the
      header must paint its final form on the first frame, and page-test
      samples `.v3-nav a`'s left edge every frame through a load and allows
      exactly ONE value, while `.v3-nav` is `margin: 0 auto`: a button injected
      here would widen the nav and move the first link. The panel is absolutely
      positioned for the same reason, so opening it moves nothing. */
  function wireMore() {
    var wrap = $('.v3-nav-more');
    if (!wrap) return;                        /* a header without the dropdown */
    var trigger = $('.v3-more-btn', wrap);
    var panel = $('.v3-more-panel', wrap);
    if (!trigger || !panel) return;

    function items() { return $$('a[href]', panel); }

    function open(where) {
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      var it = items();
      if (where && it.length) it[where === 'last' ? it.length - 1 : 0].focus();
    }

    /* Shut already? Do nothing — which is what keeps the Escape handler below
       from fighting the sheet's, and makes every close path idempotent. */
    function close(returnFocus) {
      if (panel.hidden) return;
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      /* Only Escape and a breakpoint change come back to the trigger. A press
         on a LINK must not: wireSmoothScroll moves the keyboard to the section
         it has just travelled to, and taking it back to the header would undo
         the one thing that fix was for. */
      if (returnFocus) trigger.focus();
    }

    trigger.addEventListener('click', function (e) {
      /* Enter and Space on a <button> fire a click whose detail is 0; a
         pointer press fires one whose detail is at least 1. Opened from the
         keyboard the panel takes the keyboard; opened with the pointer it
         leaves it where it is, which is what a reader reaching for a link with
         the mouse expects. ArrowDown below is the deterministic path, so
         nothing rests on `detail` alone. */
      if (panel.hidden) open(e.detail === 0 ? 'first' : null);
      else close(false);
    });

    trigger.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); open('first'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); open('last'); }
    });

    panel.addEventListener('keydown', function (e) {
      var it = items();
      var i = it.indexOf(document.activeElement);
      if (i === -1) return;
      /* preventDefault only where the keyboard is already inside the panel, or
         ArrowDown and Home would scroll the page under it. TAB IS UNTOUCHED —
         this is a disclosure, so the keyboard walks the links and then leaves,
         and the focusout below shuts the panel behind it. */
      if (e.key === 'ArrowDown') { e.preventDefault(); it[(i + 1) % it.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); it[(i - 1 + it.length) % it.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); it[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); it[it.length - 1].focus(); }
    });

    panel.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || !panel.contains(a)) return;
      /* …but not on a modified press: the reader is opening it in a new tab,
         and the panel they are reading from should still be there. */
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      /* NOT OPTIONAL. wireSmoothScroll closes the mobile SHEET on a same-page
         anchor and knows nothing about this panel, so without it pressing
         "Placements" on the home page scrolls the page and leaves the panel
         hanging open over the content. */
      close(false);
    });

    /* CAPTURE, like the account menu's, and for that one's reason: a
       bubble-phase listener on document can be silenced by any handler between
       the target and here that stops propagation, and this site has several
       mousedown handlers that swallow the event to keep the keyboard in a box
       (the forum's tag picker among them). */
    document.addEventListener('mousedown', function (e) {
      if (!panel.hidden && !wrap.contains(e.target)) close(false);
    }, true);

    /* A no-op while shut, which is the whole of why the two document-level
       Escape handlers on this page do not fight: the sheet's moves no focus
       while the sheet is shut. They can never both be open anyway — below
       921px `.v3-nav` is display:none so this trigger cannot be pressed, and
       above 920px the sheet is. Escape is deliberately not stopped from
       propagating: swallowing it would take it from whatever else listens. */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close(true);
    });

    wrap.addEventListener('focusout', function () {
      /* focusout fires BEFORE the new element takes focus, so activeElement is
         <body> at this instant, and relatedTarget is null for several of the
         ways focus can leave — the deferred read is the one that covers both.
         This is what shuts the panel when Tab walks out of its last link. No
         focus is moved: the reader has just moved it themselves. */
      setTimeout(function () {
        if (!panel.hidden && !wrap.contains(document.activeElement)) close(false);
      }, 0);
    });

    var pending = false;
    window.addEventListener('resize', function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        /* Below the burger's breakpoint the nav is display:none and the
           trigger goes with it: an open panel would be invisible and
           unclosable, and would come back OPEN on the way up. ASK THE LAYOUT
           rather than copying 920 out of the stylesheet (the measureChip
           lesson: a computed answer cannot drift from the stylesheet the way a
           number can), and getClientRects() rather than offsetParent, which
           answers a different question and is null for a fixed header. */
        if (!panel.hidden && !trigger.getClientRects().length) close(false);
      });
    }, { passive: true });
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

  /* Three things are done at PARSE time — this file sits at the end of the
     body, after all the content — and all for the same reason: what the reader
     sees first must not depend on the seven scripts that follow this one.

     The reveal-on-scroll blocks are hidden by the stylesheet until this file
     claims them, and it used to claim them in boot(), on DOMContentLoaded —
     which is AFTER every other script on the page has parsed and run. So the
     whole of the home page below the hero sat blank through that window, and
     a throw anywhere in boot()'s earlier calls left it blank for good. Doing
     it here, first, means the content is revealed as soon as the markup it
     acts on exists, and nothing that happens later can prevent it.

     The counters are taken over here for the same kind of reason: so they
     never paint their final value and then rewind.

     The "More" dropdown is here because it is a HEADER control, and the header
     is the first thing a reader reaches for: a nav button painted on the first
     frame that does nothing until the whole deferred chain has run is the same
     shape as the reveals that used to sit blank. It draws nothing and moves
     nothing — the trigger and the hidden panel are in the markup — so wiring
     it early costs no paint; what it buys is that it works when pressed, and
     that a throw in one of boot()'s other wirings cannot take it down.

     Everything else waits for the document. */
  wireReveals();
  wireCounts();
  wireMore();

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
