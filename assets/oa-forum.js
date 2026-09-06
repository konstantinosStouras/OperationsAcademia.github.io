/* ---------------------------------------------------------------------------
   Operations Academia: the forum page (forum.html).

   Two rooms under one handle scheme (see "The forum" in CLAUDE.md and the
   model's own header in assets/oa-forum-model.js). This file is the browser
   half: the gate, the room tabs, the list of questions, one thread with its
   votes and quotes, and the two compose boxes. Every WRITE goes through a
   Cloud Function (forumJoin, forumPost, forumEdit, forumVote,
   forumThreadVotes, forumModerate); every READ is a plain Firestore read the
   rules gate by the room on the path. Nothing here writes a forum document.

   THE GATE IS PAINTED FROM THE ACCOUNT HINT FIRST, like every other page: a
   remembered signed-out reader gets the sign-in card, a remembered signed-in
   one gets "Joining the forum" and never a flash of the card. When the
   session resolves, an unconfirmed password account gets the verify prompt
   (OAAccounts.pendingUser()), and a usable one calls forumJoin, which answers
   the handle for the season and WHICH ROOMS this account may enter. The tabs
   are drawn from that answer rather than from anything the page decides: a
   non-candidate sees the Open forum alone and one line saying what opens the
   other room; a current candidate, and the maintainer, see both.

   THE HANDLE IS THE ONLY IDENTITY ON THE PAGE. The uid, the e-mail and the
   profile id never reach the markup: the banner prints the handle, a post
   prints its author's handle, a quote prints the quoted author's handle. The
   join's answer is kept in sessionStorage ('oa-forum-me', keyed by uid and
   season) so a second page in the session costs no call, and sign-out clears
   it (oa-accounts.js). The seen-marks that decide the New badge live in
   localStorage ('oa-forum-seen', keyed by uid) and are cleared the same way.

   THE LIST IS AN OALIST MOUNT FED BY cfg.source, the one generic addition the
   engine gained for this page: the threads come from a Firestore read rather
   than a served file, and everything else (the tag filter with its counts,
   the text search, the chips, the URL, the pager, the phone rules) is the
   engine's, so the forum inherits _MOBILE-STANDARDS.md rather than
   re-implementing it. A card opens the THREAD (cardOpen), which is the same
   "this card is a way in" shape the one-pager's teaser uses.

   A QUESTION AND ITS ANSWERS, AND NOTHING BETWEEN THEM. There are no
   comments here and there is no plan for any (owner, 2026-09-05, of the
   comment threads under a Stack Exchange answer: "comments as shown in red
   should not be posted"). A thread is one question and the answers to it;
   post 1 is the question, every other post is an answer, and the one who
   ASKED may tick the answer that worked (forumAccept). The tick lives on the
   thread, so the card in the list can say a question is answered and the
   answers band can put that answer first.

   SAVED QUESTIONS AND WATCHED TAGS ARE THIS BROWSER'S, and deliberately.
   They are kept in localStorage beside the seen-marks, keyed to the account,
   never in Firestore: a uid-keyed document listing which threads a member
   reads or which tags they follow is exactly the record this page refuses to
   let the site keep (it loads no analytics and no usage tracker for the same
   reason). The cost is stated where it is offered: they follow the reader on
   this device and no other, and the forum learns nothing.

   ERRORS ARE WORDED, NEVER RAW. A callable refuses with a code and
   details.reason; REASONS below carries a sentence for every reason
   member.js can answer with, so a refusal reads as a sentence and never as
   "functions/permission-denied". The guard runs on every keystroke so the
   refusal the function WOULD give is shown before anything is sent.

   No em dash anywhere in this file, in the copy or the comments.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var M = window.OAForumModel;
  var G = window.OAForumGuard;
  var GUIDE = window.OAForumGuide;
  var NAV = window.OAJobNav;
  if (!M || !G || !GUIDE || !NAV || !window.OAList) {
    if (window.console) console.error('oa-forum: a module this page depends on did not load');
    return;
  }

  var REGION = 'us-central1';
  var ME_KEY = 'oa-forum-me';
  var SEEN_KEY = 'oa-forum-seen';
  var SAVED_KEY = 'oa-forum-saved';

  /* Two glyphs the page draws as controls. Inline so they take the reader's
     own ink through currentColor and cost no request; aria-hidden, because
     the button beside them carries the label. */
  var ICON_SAVE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>';
  var ICON_WATCH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      });
    }
    (kids || []).forEach(function (c) {
      if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  /* ------------------------------------------------------------- the copy */

  var TAG_HINT = 'Up to five. Pick existing tags where you can; a new tag is fine if none fits. Tags are set when the question is asked.';

  var REASONS = {
    auth: 'Sign in first.',
    room: 'That room does not exist.',
    verified: 'Confirm your e-mail address first; the Open forum opens to confirmed accounts.',
    candidate: 'The Candidates’ room is for accounts holding a candidate profile for this season.',
    banned: 'This handle is banned for the season.',
    join: 'Open the forum page first, so your handle for the season is drawn.',
    admin: 'Only the maintainer can do that.',
    guide: 'Tick the box to say you have read the guide before your first post.',
    locked: 'This thread is locked, so nothing can be added to it.',
    archive: 'This season is archived and read-only.',
    author: 'Only the author can change their own post.',
    asker: 'Only the member who asked the question can tick the answer.',
    answer: 'Only an answer can be ticked, and only while its words are still there.',
    answered: 'This question has answers, so it cannot be deleted. It can go once every answer has been deleted.',
    window: 'The fifteen-minute edit window has closed, so the post stays as written.',
    own: 'You cannot vote on your own post.',
    busy: 'The forum is busy right now. Please try again in a moment.',
    season: 'The forum is not open for the new season yet. Only the maintainer can open it.',
    bounds: 'Too long, or empty. A title is at most ' + M.BOUNDS.title + ' characters and a post at most ' + M.BOUNDS.body + '.',
    tags: 'One to five tags, each 2 to 24 characters of letters, digits and hyphens.',
    quote: 'A quote must be a passage of the post as it stands now, at most ' + M.BOUNDS.quote + ' characters.',
    thread: 'That thread could not be found.',
    threads: 'You have opened as many questions today as the forum allows. Tomorrow is fine.',
    posts: 'You have posted as often today as the forum allows. Tomorrow is fine.',
    votes: 'You have voted as often today as the forum allows.',
    gap: 'Give it a moment between two posts.',
    email: G.WHY.email,
    phone: G.WHY.phone,
    orcid: G.WHY.orcid
  };

  /** A callable's refusal in the reader's own words: the reason first, the
      function's own sentence second, a generic line last. Never a raw code. */
  function friendly(err) {
    var reason = err && err.details && err.details.reason;
    if (reason && REASONS[reason]) return REASONS[reason];
    var code = String((err && err.code) || '');
    if (/unauthenticated/.test(code)) return REASONS.auth;
    if (/not-found/.test(code)) return 'The forum is not reachable at the moment. Please try again later.';
    if (err && err.message && !/^functions\//.test(err.message) && !/^[A-Z_]+$/.test(err.message)) return String(err.message);
    return 'Something went wrong. Please try again.';
  }

  function ago(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
    var d = Date.now() - ms;
    var m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var days = Math.floor(h / 24);
    if (days < 14) return days + (days === 1 ? ' day ago' : ' days ago');
    return NAV.formatDay ? NAV.formatDay(new Date(ms).toISOString().slice(0, 10)) : new Date(ms).toISOString().slice(0, 10);
  }
  function stamp(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /* --------------------------------------------------------- the state */

  var Y = NAV.marketYear();
  var params = new URLSearchParams(location.search);
  var S = {
    me: null,                       // forumJoin's answer for this account
    room: '',                       // the room on screen
    season: Y,
    archive: false,
    tid: '',
    ask: false,
    seasons: [],                    // the forumSeasons documents that exist
    guides: {},                     // room -> guide thread id, this season
    tally: {},                      // slug -> count, this room and season
    votes: {},                      // pid -> the caller's own vote, this thread
    quote: null,                    // { n, by, text } waiting above the answer box
    saved: { uid: '', items: {}, tags: [] },   // this browser's own marks
    rows: [],                       // the threads the list last read
    sort: 'score',                  // how the answers band is ordered
    thread: null,                   // the thread on screen, and its posts
    posts: [],
    painted: false,                 // a view has been drawn at least once
    readOnly: false,                // nothing new may be POSTED to it
    frozen: false,                  // nothing at all may be written to it
    live: 0,                        // answers still standing in it
    list: null
  };

  /** What the address says: the season, the thread, the ask form. Read on
      load and again on every navigation, since the page moves between its
      views with pushState rather than a reload (a reload would throw away
      the join and re-read every side card for nothing). */
  function readState() {
    params = new URLSearchParams(location.search);
    var seasonParam = parseInt(params.get('season') || '', 10);
    S.season = isFinite(seasonParam) && seasonParam > 2000 ? seasonParam : Y;
    S.archive = S.season !== Y;
    S.tid = String(params.get('t') || '').trim();
    S.ask = params.get('ask') === '1';
  }
  readState();

  function label(season) { return NAV.marketLabel(season); }

  /** The page's own address for a state: room and season always, then one of
      a thread, the ask form, or nothing. Filters the engine owns are its own
      URL keys and travel separately. */
  function href(o) {
    var p = new URLSearchParams();
    p.set('room', (o && o.room) || S.room);
    var season = (o && o.season) || S.season;
    if (season !== Y) p.set('season', String(season));
    if (o && o.t) p.set('t', o.t);
    if (o && o.ask) p.set('ask', '1');
    /* the engine's own URL key, one parameter per value, so a link that
       carries every tag a reader watches selects them all */
    if (o && o.tags) [].concat(o.tags).forEach(function (t) { if (t) p.append('tags', t); });
    return 'forum.html?' + p.toString() + ((o && o.hash) ? '#' + o.hash : '');
  }
  /** Move between the page's views IN PLACE: push the new address, re-read
      the state from it and draw again. The list, the thread and the ask form
      are one page under three addresses, so a reader's Back button works and
      a post lands on its thread without a round trip. */
  function go(o) {
    var to = href(o);
    try { history.pushState(null, '', to); } catch (e) { location.href = to; return; }
    readState();
    if (S.me) draw();
  }
  window.addEventListener('popstate', function () {
    readState();
    if (S.me) draw();
  });
  /* Every link the page draws to one of its own addresses (a crumb, a tag,
     the Ask button, a post's #n) is followed in place the same way. A
     modified click (a new tab) is left to the browser. */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    /* "Read the forum guide" points at a <details>, and a fragment link
       scrolls to one without opening it: for every member who has already
       accepted the guide the panel is collapsed, so the link jumped to a
       shut box and read as a control that does nothing. */
    var g = e.target && e.target.closest ? e.target.closest('a[href="#oa-forum-guide"]') : null;
    if (g) {
      var panel = $('oa-forum-guide');
      if (panel) {
        e.preventDefault();
        panel.open = true;
        panel.scrollIntoView({ block: 'center' });
        var sum = panel.querySelector('summary');
        if (sum) { sum.setAttribute('tabindex', '-1'); sum.focus({ preventScroll: true }); }
        return;
      }
    }
    var a = e.target && e.target.closest ? e.target.closest('a[href^="forum.html?"]') : null;
    if (!a || !S.me) return;
    var app = $('oa-forum');
    if (!app || !app.contains(a)) return;
    e.preventDefault();
    var to = a.getAttribute('href');
    /* A POST'S OWN #n IS A PLACE ON THIS PAGE, not another view of it.
       Following it through draw() rebuilt the thread and threw away whatever
       was half written in the answer box below, which is the very thing
       paintAnswers is careful not to do. Same room, same season, same
       thread: move the address, scroll, and leave the page as it is. */
    var here = href({ room: S.room, season: S.season, t: S.tid });
    if (S.tid && to.split('#')[0] === here.split('#')[0]) {
      try { history.pushState(null, '', to); } catch (err) { location.href = to; return; }
      var frag = to.indexOf('#') === -1 ? '' : to.slice(to.indexOf('#') + 1);
      var at = frag ? document.getElementById(frag) : null;
      if (at) at.scrollIntoView();
      return;
    }
    try { history.pushState(null, '', to); } catch (err) { location.href = to; return; }
    readState();
    draw();
  });

  /* ---------------------------------------------------- the memory */

  function readMe(uid) {
    try {
      var v = JSON.parse(sessionStorage.getItem(ME_KEY) || 'null');
      if (v && v.uid === uid && Number(v.season) === Y && v.handle) return v;
    } catch (e) { /* private mode */ }
    return null;
  }
  function writeMe(me) {
    try { sessionStorage.setItem(ME_KEY, JSON.stringify(me)); } catch (e) { /* ignore */ }
  }
  /** THE FRESH MARK IS PERSISTED WHERE IT IS MINTED, or `since` is "now" on
      every read and nothing is ever newer than it. Only opening a thread
      wrote this store, so until a reader had done that, unreadOf compared
      each thread's lastAt against the current instant: no New badge, and no
      "questions carrying a tag you watch have arrived" line, for the whole
      of a reader's first visit. */
  function readSeen(uid) {
    try {
      var v = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null');
      if (v && v.uid === uid && v.seen) return v;
    } catch (e) { /* private mode */ }
    var fresh = { uid: uid, since: Date.now(), seen: {} };
    writeSeen(fresh);
    return fresh;
  }
  function writeSeen(v) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }

  /* WHAT THIS READER HAS SAVED AND WHICH TAGS THEY WATCH, in this browser and
     nowhere else. The shape is the seen-marks': one document keyed to the
     account, so a shared machine cannot show the next person the last one's
     list, and sign-out clears it (oa-accounts.js). It is not in Firestore on
     purpose: a uid beside a thread id is a record of what a member reads in a
     room built so that nothing records that. */
  function readSaved(uid) {
    try {
      var v = JSON.parse(localStorage.getItem(SAVED_KEY) || 'null');
      if (v && v.uid === uid) {
        return {
          uid: uid,
          items: (v.items && typeof v.items === 'object') ? v.items : {},
          tags: Array.isArray(v.tags) ? v.tags.filter(M.tagOk) : []
        };
      }
    } catch (e) { /* private mode */ }
    return { uid: uid, items: {}, tags: [] };
  }
  function writeSaved() {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(S.saved)); } catch (e) { /* ignore */ }
  }
  /** A saved mark names the room, the season, the thread and, for an answer,
      the post: saving an answer and saving its question are two marks. */
  function savedKey(tid, pid) {
    return S.room + ':' + S.season + ':' + tid + (pid ? ':' + pid : '');
  }
  function isSaved(tid, pid) { return !!S.saved.items[savedKey(tid, pid)]; }
  function toggleSaved(tid, pid, title, n) {
    var k = savedKey(tid, pid);
    if (S.saved.items[k]) delete S.saved.items[k];
    else {
      S.saved.items[k] = { room: S.room, season: S.season, tid: tid, pid: pid || '',
        n: Number(n) || 0, title: String(title || ''), at: Date.now() };
    }
    writeSaved();
    drawSaved();
    return !!S.saved.items[k];
  }
  function watching(tag) { return S.saved.tags.indexOf(tag) !== -1; }
  function toggleWatch(tag) {
    if (!M.tagOk(tag)) return false;
    var at = S.saved.tags.indexOf(tag);
    if (at === -1) S.saved.tags.push(tag);
    else S.saved.tags.splice(at, 1);
    writeSaved();
    drawWatch();
    drawTags();
    if (!S.tid && !S.ask) paintWatchNew(S.rows, readSeen(S.me.uid));
    return watching(tag);
  }

  /** New TO THIS READER: a thread they have not read to the end of, by the
      same rule the New badge is drawn from. One definition, two consumers. */
  function unreadOf(r, seen) {
    var was = seen.seen[r.id];
    return typeof was === 'number' ? r.n > was : (r.lastAt > (seen.since || 0));
  }

  /* ------------------------------------------------------- the callables */

  function call(name, data) {
    return OAFB.readyFunctions().then(function (fb) {
      return fb.app().functions(REGION).httpsCallable(name)(data || {});
    }).then(function (r) { return (r && r.data) || {}; });
  }

  function db() {
    return OAFB.ready().then(function (fb) { return fb.firestore(); });
  }
  var COL = (window.OAFB && OAFB.col) || {};
  var C = {
    seasons: COL.forumSeasons || 'forumSeasons',
    rooms: COL.forumRooms || 'rooms',
    threads: COL.forumThreads || 'threads',
    posts: COL.forumPosts || 'posts',
    tags: COL.forumTags || 'forumTags'
  };
  function threadsCol(d, season, room) {
    return d.collection(C.seasons).doc(String(season)).collection(C.rooms).doc(room).collection(C.threads);
  }

  /* ------------------------------------------------------------- the gate */

  /** SIGNING OUT FORGETS WHOEVER WAS READING, and hiding the sections is not
      that. `popstate` and the page's own link handler both repaint whenever
      `S.me` is set, and S.me survived a sign-out along with the handle, the
      marks, the thread on screen and the room: press Back after signing out
      and the forum came back, under the previous reader's handle, for
      whoever is now sitting there. The two browser stores are cleared by
      OAAccounts.signOut(); this is the same clearing for what the page is
      holding in memory and in the markup it has already drawn. */
  function forgetReader() {
    S.me = null;
    S.saved = { uid: '', items: {}, tags: [] };
    S.votes = {};
    S.tally = {};
    S.rows = [];
    S.thread = null;
    S.posts = [];
    S.tid = '';
    S.list = null;
    ['oa-forum-thread', 'oa-forum-compose', 'oa-forum-list', 'oa-forum-tags',
     'oa-forum-watch', 'oa-forum-saved', 'oa-forum-admin', 'oa-forum-me',
     'oa-forum-rooms', 'oa-forum-roomcard'].forEach(function (id) {
      var n = $(id);
      if (n) n.innerHTML = '';
    });
    var c = $('oa-forum-listcount');
    if (c) c.textContent = '';
  }

  /** set while a room change came from the keyboard, so the redrawn tab row
      can put focus back where the reader left it */
  var keyboardTab = false;

  function hideAll() {
    ['oa-offline', 'oa-needauth', 'oa-forum-verify', 'oa-forum-loading', 'oa-forum-error', 'oa-forum']
      .forEach(function (id) { show($(id), false); });
  }
  function fail(msg) {
    hideAll();
    var box = $('oa-forum-error');
    if (!box) return;
    box.innerHTML = '<p><strong>The forum could not be opened.</strong> ' + esc(msg) + '</p>';
    show(box, true);
  }

  function paintGate(hint) {
    hideAll();
    if (!window.OAFB || !OAFB.enabled) { show($('oa-offline'), true); return; }
    if (hint === 'in') show($('oa-forum-loading'), true);
    else show($('oa-needauth'), true);
  }

  function boot() {
    var A = window.OAAccounts;
    if (!A) { paintGate('out'); return; }
    paintGate(A.hint());
    var btn = $('oa-needauth-btn');
    if (btn) btn.addEventListener('click', function () { A.openAuth(); });
    var vbtn = $('oa-forum-verify-btn');
    if (vbtn) vbtn.addEventListener('click', function () { A.openVerifyPanel(); });
    if (!window.OAFB || !OAFB.enabled) return;

    var started = null;
    A.onChange(function (u) {
      if (A.pendingUser()) { hideAll(); show($('oa-forum-verify'), true); started = null; return; }
      if (!u) { forgetReader(); hideAll(); show($('oa-needauth'), true); started = null; return; }
      if (started === u.uid) return;
      started = u.uid;
      S.saved = readSaved(u.uid);
      hideAll();
      show($('oa-forum-loading'), true);
      join(u).then(function (me) {
        if (!A.user() || A.user().uid !== u.uid) return;   // signed out mid-flight
        S.me = me;
        draw();
      }).catch(function (err) {
        started = null;
        fail(friendly(err));
      });
    });
  }

  /** forumJoin, once per session per account: the handle and the rooms.

      THE CACHE IS TRUSTED ONLY WHILE IT SAYS YES. `rooms.candidates` is
      re-decided by the function on every call, from the profile the account
      holds RIGHT NOW, which is exactly the answer that changes under a
      reader: file a candidate profile and come back, and a cached "no"
      would keep the Candidates' room shut for the rest of the browsing
      session, with the page's own note still pointing at the form they have
      just filled in. So a cached answer that already grants the room is
      kept, and a cached "no" is asked again. The call is idempotent and the
      population it costs one call per page load is precisely the population
      whose answer can change. A cached "yes" that has since lapsed (the
      profile was withdrawn) costs nothing either: every write refuses on
      its own, and the next session asks again. */
  function join(u) {
    var cached = readMe(u.uid);
    if (cached && cached.rooms && cached.rooms.candidates) return Promise.resolve(cached);
    return call('forumJoin', {}).then(function (r) {
      var me = {
        uid: u.uid,
        season: Number(r.season) || Y,
        handle: String(r.handle || ''),
        guideAt: Number(r.guideAt) || 0,
        banned: !!r.banned,
        rooms: { candidates: !!(r.rooms && r.rooms.candidates), open: !!(r.rooms && r.rooms.open) }
      };
      writeMe(me);
      return me;
    });
  }

  /* -------------------------------------------------------------- drawing */

  function chooseRoom() {
    var want = String(params.get('room') || '');
    var rooms = S.me.rooms;
    if (M.isRoom(want) && rooms[want]) return want;
    if (rooms.candidates) return 'candidates';
    if (rooms.open) return 'open';
    return '';
  }

  function hideViews() {
    show($('oa-forum-watchnew'), false);
    ['oa-forum-listview', 'oa-forum-thread', 'oa-forum-compose'].forEach(function (id) {
      var n = $(id);
      if (!n) return;
      n.hidden = true;
      if (id !== 'oa-forum-listview') { n.innerHTML = ''; n.className = ''; }
    });
    S.quote = null;
    S.votes = {};
  }

  function draw() {
    hideAll();
    hideViews();
    S.room = chooseRoom();
    if (!S.room) { fail(REASONS.verified); return; }
    show($('oa-forum'), true);
    drawTabs();
    drawBanner();
    drawGuide();
    drawWatch();
    drawSaved();
    if (S.tid) drawThread();
    else if (S.ask && !S.archive) drawAsk();
    else drawList();
    /* THE TAB THE READER PRESSED KEEPS THE FOCUS, and it is claimed here
       rather than in drawTabs because the view drawn between the two takes
       focus of its own: whichever ran last would win, and it must be this. */
    if (keyboardTab) {
      keyboardTab = false;
      var back = document.querySelector('#oa-forum-rooms .oa-forum-tab[aria-selected="true"]');
      if (back) back.focus({ preventScroll: true });
    }
    loadSide();
    window.scrollTo(0, 0);
  }

  function drawTabs() {
    var host = $('oa-forum-rooms');
    var note = $('oa-forum-roomnote');
    if (!host) return;
    host.innerHTML = '';
    var rooms = S.me.rooms;
    [['candidates', 'Candidates’ room'], ['open', 'Open forum']].forEach(function (pair) {
      if (!rooms[pair[0]]) return;
      var on = pair[0] === S.room;
      var b = el('button', {
        type: 'button', role: 'tab', class: 'oa-forum-tab', 'data-room': pair[0],
        'aria-selected': on ? 'true' : 'false', tabindex: on ? '0' : '-1',
        onclick: function () { if (!on) go({ room: pair[0], season: S.season }); }
      }, [el('span', { class: 'oa-forum-dot', 'aria-hidden': 'true' }), pair[1]]);
      host.appendChild(b);
    });

    /* A ROVING TABINDEX NEEDS ARROW KEYS, or the tab that is not selected is
       reachable by pointer and by nothing else: tabindex="-1" takes it out of
       the tab order and there was no handler to put focus on it.

       ONCE PER HOST, not once per draw. drawTabs runs on every render and
       `innerHTML = ''` clears the buttons but not a listener on the row
       itself, so binding here without the flag stacks one handler per draw
       and a single ArrowRight then walks the selection as many times. */
    if (host.getAttribute('data-keys') !== 'on') {
      host.setAttribute('data-keys', 'on');
      host.addEventListener('keydown', function (e) {
        var keys = { ArrowLeft: -1, ArrowRight: 1, Home: 'first', End: 'last' };
        if (!(e.key in keys)) return;
        var all = [].slice.call(host.querySelectorAll('.oa-forum-tab'));
        if (all.length < 2) return;
        var at = all.indexOf(document.activeElement);
        if (at === -1) return;
        e.preventDefault();
        var to = keys[e.key] === 'first' ? 0
          : keys[e.key] === 'last' ? all.length - 1
          : (at + keys[e.key] + all.length) % all.length;
        /* the press redraws this row, so the node just focused is discarded;
           drawTabs puts focus back on whichever tab is then selected */
        keyboardTab = true;
        all[to].focus();
        all[to].click();
      });
    }
    if (note) {
      if (!rooms.candidates) {
        note.innerHTML = 'The Candidates’ room opens to accounts holding a ' +
          '<a href="post-a-candidate.html">candidate profile</a> for the ' + esc(label(Y)) + ' job market.';
        show(note, true);
      } else {
        show(note, false);
      }
    }
  }

  function drawBanner() {
    var arch = $('oa-forum-archive');
    if (arch) {
      arch.innerHTML = '<strong>' + esc(label(S.season)) + ' archive.</strong> Read-only: this season has ' +
        'closed and nothing can be added to it. <a href="' + esc(href({ room: S.room, season: Y })) + '">Back to this season</a>.';
      show(arch, S.archive);
    }
    var me = $('oa-forum-me');
    if (!me) return;
    var cand = S.room === 'candidates';
    me.className = 'oa-forum-banner' + (cand ? '' : ' is-open');
    me.innerHTML =
      '<div><span class="oa-forum-bt">' + (cand ? 'Candidates’ room' : 'Open forum') + ' &middot; ' +
        esc(label(S.season)) + ' season</span>' +
      '<span class="oa-forum-bs">' + (cand
        ? 'Only people with a candidate profile for this season can read or write here. Everything is archived, read-only, at the July roll.'
        : 'Every registered account with a confirmed e-mail address can read and write here. Everything is archived, read-only, at the July roll.') +
      '</span></div>' +
      (S.archive ? '' :
        '<div class="oa-forum-as">You are posting as<br><span class="oa-forum-handle is-me" id="oa-forum-myhandle">' +
        esc(S.me.handle) + '</span></div>');
    show(me, true);

    var card = $('oa-forum-roomcard');
    if (card) {
      card.innerHTML = '<h2>How this room works</h2><ul>' +
        (cand
          ? '<li>Only candidates with a profile for the <strong>' + esc(label(S.season)) + '</strong> season can enter.</li>'
          : '<li>Every registered account with a confirmed e-mail address can enter, faculty included.</li>') +
        '<li>You get a random handle for the season. It is the same in both rooms, it is never reused, and nobody, the maintainer included, sees who is behind it without a deliberate step.</li>' +
        '<li>At the July roll the room is archived, read-only, for next season’s candidates to read.</li>' +
        '<li>Be kind and be a good colleague. No names of people, no rumours, no naming who is interviewing where.</li>' +
        '</ul><a class="oa-forum-more" href="#oa-forum-guide">Read the forum guide</a>';
      show(card, true);
    }
    if (S.me.banned) {
      var box = $('oa-forum-error');
      if (box) {
        box.innerHTML = '<p><strong>This handle is banned for the season.</strong> You can read, but nothing you send will be accepted. To appeal, use <a href="feedback.html">Send feedback</a> and quote your handle.</p>';
        show(box, true);
      }
    }
  }

  function drawGuide() {
    var body = $('oa-forum-guidebody');
    var panel = $('oa-forum-guide');
    if (body) body.innerHTML = GUIDE.html();
    if (panel) panel.open = !S.me.guideAt;
  }

  /* --------------------------------------------------------- the side */

  function loadSide() {
    db().then(function (d) {
      return Promise.all([
        d.collection(C.seasons).get().then(function (snap) {
          var out = [];
          snap.forEach(function (doc) {
            var v = doc.data() || {};
            out.push({ season: Number(v.season) || Number(doc.id), guides: v.guides || {} });
          });
          return out;
        }).catch(function () { return []; }),
        d.collection(C.tags).doc(S.season + '_' + S.room).get().then(function (snap) {
          return snap.exists ? ((snap.data() || {}).counts || {}) : {};
        }).catch(function () { return {}; })
      ]);
    }).then(function (r) {
      S.seasons = r[0];
      S.tally = r[1] || {};
      var now = S.seasons.filter(function (s) { return s.season === Y; })[0];
      S.guides = (now && now.guides) || {};
      drawSeasons();
      drawTags();
      drawWatch();
      drawAdmin();
    }).catch(function () { /* the side cards are extras; the room still reads */ });
  }

  function drawSeasons() {
    var card = $('oa-forum-seasoncard');
    var host = $('oa-forum-seasons');
    if (!card || !host) return;
    var years = {};
    S.seasons.forEach(function (s) { if (s.season) years[s.season] = true; });
    years[Y] = true;
    var list = Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
    if (list.length < 2 && !S.archive) { show(card, false); return; }
    host.innerHTML = list.map(function (y) {
      return '<a href="' + esc(href({ room: S.room, season: y })) + '" class="' + (y === S.season ? 'is-now' : '') + '">' +
        esc(label(y)) + (y === Y ? ' (this season)' : ' archive') + '</a>';
    }).join('');
    show(card, true);
  }

  /** A tag as it is drawn in the side cards: the chip that filters the room
      by it, and the bell that says "tell me when a new question carries it".
      The chip's own title is what a reader gets for hovering it, which is
      what the tag popovers on the site the owner asked this to resemble are
      for; the count comes from the room's tally where there is one. */
  function tagChip(tag, count) {
    var title = 'Questions tagged ' + tag + (count ? ', ' + plural(count, 'question', 'questions') + ' this season' : '');
    var on = watching(tag);
    return '<span class="oa-forum-tagrow">' +
      '<a class="oa-forum-tagchip" href="' + esc(href({ room: S.room, season: S.season, tags: tag })) + '" ' +
        'data-tag="' + esc(tag) + '" title="' + esc(title) + '">' + esc(tag) +
        (count ? '<i>' + count + '</i>' : '') + '</a>' +
      '<button type="button" class="oa-forum-watch" data-watch="' + esc(tag) + '" ' +
        'aria-pressed="' + (on ? 'true' : 'false') + '" title="' + (on ? 'Stop watching ' : 'Watch ') + esc(tag) + '" ' +
        'aria-label="' + (on ? 'Stop watching the tag ' : 'Watch the tag ') + esc(tag) + '">' + ICON_WATCH + '</button>' +
      '</span>';
  }

  /** Wire every bell inside a host: pressing one is a local mark and nothing
      leaves the browser, so it repaints where it stands. */
  function wireWatch(host) {
    if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll('[data-watch]'), function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        /* the press redraws both cards, so this very button is discarded;
           without this, focus falls to <body> and the new pressed state is
           announced to nobody */
        refocus = { host: host.id, key: b.getAttribute('data-watch') };
        toggleWatch(b.getAttribute('data-watch'));
      });
    });
    keepFocus(host, '[data-watch="%"]');
  }

  /** Set while a press redrew the panel that held the button, so the panel can
      put focus back on the control the reader pressed rather than dropping it
      to <body> with the new state unannounced. */
  var refocus = null;

  /** Put focus back on the control the reader pressed, in the panel they
      pressed it in: the same tag can have a bell in both cards, and landing
      in the other one is its own small lie about where the reader is. */
  function keepFocus(host, sel) {
    if (!refocus || !host || host.id !== refocus.host) return;
    var back = host.querySelector(sel.replace('%', cssEscape(refocus.key)));
    refocus = null;
    if (back) back.focus();
  }
  function cssEscape(v) {
    return String(v).replace(/["\\]/g, '\\$&');
  }

  function drawTags() {
    var card = $('oa-forum-tagcard');
    var host = $('oa-forum-tags');
    if (!card || !host) return;
    var pairs = Object.keys(S.tally).map(function (k) { return [k, Number(S.tally[k]) || 0]; })
      .filter(function (p) { return p[1] > 0 && M.tagOk(p[0]); })
      .sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); })
      .slice(0, 12);
    if (!pairs.length) { show(card, false); return; }
    host.innerHTML = pairs.map(function (p) { return tagChip(p[0], p[1]); }).join('');
    wireWatch(host);
    show(card, true);
  }

  /** The tags this reader watches. Drawn even when the list is empty, because
      the card is where the bell is explained; the line under it says plainly
      that the list lives in this browser, so nobody takes it for a
      subscription the site is keeping for them. */
  function drawWatch() {
    var card = $('oa-forum-watchcard');
    var host = $('oa-forum-watch');
    if (!card || !host) return;
    var tags = S.saved.tags.slice().sort();
    if (!tags.length) {
      host.innerHTML = '<p class="oa-forum-cardnote">No tags yet. Press the bell beside a tag to be told ' +
        'here when a new question carries it.</p>';
    } else {
      host.innerHTML = '<div class="oa-forum-tagcloud">' + tags.map(function (t) {
        return tagChip(t, Number(S.tally[t]) || 0);
      }).join('') + '</div>' +
        '<p class="oa-forum-cardnote"><a href="' + esc(href({ room: S.room, season: S.season, tags: tags })) + '">' +
        'Show only these questions</a></p>' +
        '<p class="oa-forum-cardnote">Kept in this browser, so the forum records nothing about what you follow.</p>';
      wireWatch(host);
    }
    show(card, true);
  }

  /** The questions and answers this reader has saved. Hidden while there are
      none: the bookmark on a post is what introduces it, and an empty card
      in the sidebar of every page is clutter rather than an invitation. */
  function drawSaved() {
    var card = $('oa-forum-savedcard');
    var host = $('oa-forum-saved');
    if (!card || !host) return;
    var items = Object.keys(S.saved.items).map(function (k) {
      var v = S.saved.items[k];
      return { key: k, room: v.room, season: v.season, tid: v.tid, pid: v.pid,
        n: Number(v.n) || 0, title: String(v.title || ''), at: Number(v.at) || 0 };
    }).filter(function (v) { return v.room === S.room && Number(v.season) === Number(S.season) && v.tid; })
      .sort(function (a, b) { return b.at - a.at; })
      .slice(0, 8);
    if (!items.length) { show(card, false); return; }
    host.innerHTML = items.map(function (v) {
      var to = href({ room: v.room, season: v.season, t: v.tid, hash: v.pid ? 'p' + v.n : '' });
      return '<div class="oa-forum-savedrow">' +
        '<a href="' + esc(to) + '">' + esc(v.title || 'A question') + '</a>' +
        (v.pid ? '<span class="oa-forum-savedwhat">answer #' + v.n + '</span>' : '') +
        '<button type="button" class="oa-forum-unsave" data-unsave="' + esc(v.key) + '" ' +
          'title="Remove it from your saved list" aria-label="Remove this from your saved list">&times;</button>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('[data-unsave]'), function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        delete S.saved.items[b.getAttribute('data-unsave')];
        writeSaved();
        drawSaved();
        if (S.tid) paintSaveButtons();
      });
    });
    show(card, true);
  }

  /** After the saved list is edited from the side card, the bookmarks in the
      thread beside it have to agree: one store, two views of it. */
  function paintSaveButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('#oa-forum-thread [data-act="save"]'), function (b) {
      var li = b.closest ? b.closest('.oa-forum-post') : null;
      if (!li) return;
      var first = li.getAttribute('data-n') === '1';
      var what = first ? 'question' : 'answer';
      var on = isSaved(S.tid, first ? '' : li.getAttribute('data-pid'));
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = on ? 'Saved in this browser. Press to remove it.' : 'Save this ' + what + ' in this browser';
      /* THE ACCESSIBLE NAME MOVES WITH THE STATE, or a reader who removes a
         mark from the Saved card is still told the button removes it. It is
         the name postHTML draws, said the same way. */
      b.setAttribute('aria-label', on
        ? 'Remove this ' + what + ' from your saved list'
        : 'Save this ' + what);
    });
  }

  /** The maintainer's guide button: one per admitted room. It POSTS the guide
      thread where the room has none and REFRESHES it where it has one, which
      is the same call either way: seedGuide renders the module itself, so
      the panel and the pinned thread stay one text even after the rules are
      edited (the thread is a stored copy; the panel is not). Drawn only for
      the admin; the function refuses everyone else regardless. */
  function drawAdmin() {
    var card = $('oa-forum-admin');
    if (!card) return;
    var A = window.OAAccounts;
    if (!A || !A.isAdmin() || S.archive) { show(card, false); return; }
    var rooms = M.ROOMS.filter(function (r) { return S.me.rooms[r]; });
    if (!rooms.length) { show(card, false); return; }
    card.innerHTML = '<h2>Maintainer</h2><p>The guide thread is pinned and locked in each ' +
      'room, under the handle Moderator, and its text is the guide beside it. Post it where ' +
      'a room has none, and press it again after the rules change to bring the pinned thread ' +
      'up to date.</p>';
    rooms.forEach(function (room) {
      var here = room === 'open' ? 'Open forum' : 'Candidates’ room';
      var b = el('button', {
        type: 'button', class: 'v3-btn soft oa-forum-seedbtn', 'data-seed-room': room,
        text: (S.guides[room] ? 'Update the guide in the ' : 'Post the guide in the ') + here,
        onclick: function () {
          b.disabled = true;
          call('forumModerate', { op: 'seedGuide', room: room }).then(function (r) {
            if (r && r.updated === false) {
              b.disabled = false;
              b.textContent = 'The guide in the ' + here + ' is already up to date';
              return;
            }
            go({ room: room, season: Y });
          }).catch(function (err) {
            b.disabled = false;
            window.alert(friendly(err));
          });
        }
      });
      card.appendChild(b);
    });
    show(card, true);
  }

  /* --------------------------------------------------------- the list */

  function readThreads() {
    return db().then(function (d) {
      return threadsCol(d, S.season, S.room).orderBy('lastAt', 'desc').limit(200).get();
    }).then(function (snap) {
      var rows = [];
      snap.forEach(function (doc) {
        var v = doc.data() || {};
        if (v.hidden) return;
        rows.push({
          id: doc.id,
          title: String(v.title || ''),
          tags: Array.isArray(v.tags) ? v.tags.map(String) : [],
          by: String(v.by || ''),
          t: Number(v.t) || 0,
          lastAt: Number(v.lastAt) || 0,
          lastBy: String(v.lastBy || ''),
          n: Number(v.n) || 0,
          excerpt: String(v.excerpt || ''),
          score: Number(v.score) || 0,
          accepted: String(v.accepted || ''),
          pinned: !!v.pinned,
          locked: !!v.locked
        });
      });
      return rows;
    });
  }

  /** WHAT IS NEW IN THE TAGS THIS READER WATCHES. Computed from the rows the
      list has already read and the seen-marks it already keeps, so watching a
      tag costs no read, no document and nothing the site could later be asked
      to hand over. It is the in-app half of "tell me when a question carries
      this tag"; the e-mail half waits for the forum to be announced, since a
      digest naming a thread in the Candidates' room would announce the forum
      to whoever opens the message. */
  function paintWatchNew(rows, seen) {
    var box = $('oa-forum-watchnew');
    if (!box) return;
    var tags = S.saved.tags;
    if (!tags.length || S.archive || !Array.isArray(rows) || !rows.length) { show(box, false); return; }
    var hits = rows.filter(function (r) {
      if (!unreadOf(r, seen)) return false;
      return r.tags.some(function (t) { return tags.indexOf(t) !== -1; });
    });
    if (!hits.length) { show(box, false); return; }
    box.innerHTML = '<p><strong>' + plural(hits.length, 'new question', 'new questions') +
      '</strong> in the tags you watch.</p>' +
      '<a class="v3-btn soft" href="' + esc(href({ room: S.room, season: S.season, tags: tags })) + '">Show them</a>';
    show(box, true);
  }

  function drawList() {
    show($('oa-forum-listview'), true);
    var title = $('oa-forum-listtitle');
    if (title) title.textContent = S.room === 'candidates' ? 'Questions from candidates' : 'Questions in the Open forum';
    /* THE VIEW TAKES FOCUS, as the thread and the ask form already do. These
       are three views of one page swapped with pushState, so a reader coming
       back from a thread with the keyboard was returned to a page whose focus
       was still wherever the thread had left it, or on <body>. Never on the
       first paint, where the reader has not moved yet and stealing focus
       would scroll the page out from under them. */
    if (title && S.painted && !keyboardTab) {
      title.setAttribute('tabindex', '-1');
      title.focus({ preventScroll: true });
    }
    S.painted = true;
    /* The Ask button lives in the list HEAD, not in the engine's action bar:
       the bar is hidden with an empty dataset (v3's .oa-data-empty rule), and
       an empty room is exactly where the first question has to come from. */
    var head = $('oa-forum-listview').querySelector('.oa-forum-listhead');
    var oldBtn = $('oa-forum-askbtn');
    if (oldBtn) oldBtn.remove();
    if (head && !S.archive) {
      head.appendChild(el('a', {
        class: 'v3-btn primary oa-forum-askbtn', id: 'oa-forum-askbtn',
        href: href({ room: S.room, season: S.season, ask: true }), text: 'Ask a question'
      }));
    }
    var seen = readSeen(S.me.uid);
    var mount = $('oa-forum-list');
    if (!mount) return;

    /* WHICH ROOM THIS MOUNT IS FOR. Switching rooms mounts the engine again
       while the previous mount's read is still in flight, and its prepare()
       then wrote the OLD room's count and rows over the new room's. Ordering,
       not a race worth locking: the superseded mount just stops writing the
       shared state. */
    var forRoom = S.room;
    var forSeason = S.season;

    S.list = OAList.mount({
      mount: '#oa-forum-list',
      source: readThreads,
      perPage: 20,
      urlPrefix: '',
      prepare: function (rows) {
        rows.sort(function (a, b) {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return (b.lastAt || 0) - (a.lastAt || 0);
        });
        if (forRoom !== S.room || forSeason !== S.season) return rows;
        var count = $('oa-forum-listcount');
        if (count) count.textContent = plural(rows.length, 'question', 'questions') + ' this season';
        S.rows = rows;
        paintWatchNew(rows, seen);
        return rows;
      },
      filters: [
        { key: 'tags', label: 'Tags', type: 'pick', field: 'tags', order: M.TAGS },
        { key: 'q', label: 'Search questions', type: 'text', fields: ['title', 'excerpt'], placeholder: 'A word from the title or the first lines' }
      ],
      card: {
        title: function (r) { return r.title; },
        /* The handle alone: the counts and the last activity are appended as
           their own elements in onCard, so each fact is said once and in one
           place (owner, 2026-09-05: the card printed the answer count twice,
           in a side column and again here). */
        subtitle: function (r) { return r.by; },
        badges: function (r) {
          var out = [];
          if (r.pinned) out.push({ text: 'Pinned', cls: 'oa-label-pinned' });
          if (r.locked) out.push({ text: 'Locked', cls: 'oa-label-locked' });
          if (unreadOf(r, seen) && !S.archive) out.push({ text: 'New', cls: 'oa-label-new' });
          r.tags.forEach(function (t) { out.push({ text: t, cls: 'oa-label-tag' }); });
          return out;
        },
        rows: function () { return []; }
      },
      cardOpen: function (r) {
        return {
          note: 'Open the thread',
          run: function (row) { go({ room: S.room, season: S.season, t: row.id }); }
        };
      },
      /* THE QUESTION CARD IS THE STACK OVERFLOW ONE (owner, 2026-09-05: "I
         want the forum to look like stackoverflow"): a tally column on the
         left, then the title, the first lines, and a footer carrying the
         tags on one side and who asked on the other.

         That LAYOUT is also what settles the collision the owner reported
         the same day. The first attempt stacked everything in one column,
         which read as a list of paragraphs; the real fault was never the
         column, it was that the tag chips sat ABOVE the title (and that
         .oa-label is `display: inline` site-wide, so their padding bled into
         the rows around them). Tags belong under the excerpt, which is where
         Stack Overflow has always put them and where nothing can crowd the
         heading. */
      onCard: function (li, r) {
        li.classList.add('oa-forum-q');
        var answers = Math.max(0, r.n - 1);
        var answered = !!r.accepted;
        var head = li.querySelector('.oa-card-head');
        var t = li.querySelector('.oa-card-title');
        if (t && r.excerpt) t.insertAdjacentElement('afterend', el('p', { class: 'oa-forum-ex', text: r.excerpt }));

        /* THE ANSWERED BOX IS THE ONE THING THE TALLY SAYS TWICE OVER: an
           outline while a question merely has answers, filled with a tick
           once the member who asked has said which of them worked. It is
           read off the thread's own row, so no card costs a post read. */
        li.insertBefore(el('div', { class: 'oa-forum-stats' }, [
          el('span', { class: 'oa-forum-stat', title: plural(r.score, 'like', 'likes') + ' on the question, less its dislikes' }, [
            el('b', { text: String(r.score) }), el('i', { text: Math.abs(r.score) === 1 ? 'vote' : 'votes' })
          ]),
          el('span', {
            class: 'oa-forum-stat is-answers' + (answers ? ' has' : '') + (answered ? ' is-accepted' : ''),
            title: answered ? 'Answered: the member who asked ticked one of these' : plural(answers, 'answer', 'answers')
          }, [
            el('b', { text: String(answers) }), el('i', { text: answers === 1 ? 'answer' : 'answers' })
          ])
        ]), li.firstChild);

        /* the footer: the engine wrote the badges above the title and the
           handle below it, so both are MOVED here rather than drawn twice */
        var foot = el('div', { class: 'oa-forum-qfoot' });
        var badges = li.querySelector('.oa-badges');
        var sub = li.querySelector('.oa-card-sub');
        foot.appendChild(badges || el('div', { class: 'oa-badges' }));
        if (sub) {
          sub.textContent = '';
          sub.appendChild(el('span', { class: 'oa-forum-asker', text: r.by }));
          if (r.lastAt) sub.appendChild(el('span', { class: 'oa-forum-when', text: 'active ' + ago(r.lastAt) }));
          foot.appendChild(sub);
        }
        /* OUTSIDE THE HEAD, WHICH IS A BUTTON. The engine draws the card's
           head as a <button>, and a control inside a button is not markup a
           browser will make focusable: the tag chips carried role="link" and
           a click handler and were reachable by pointer and by nothing else.
           As a sibling of the head they can be real anchors, which the
           keyboard, the middle button and "open in a new tab" all understand,
           and which the page's own link handler already follows in place. */
        if (head) head.insertAdjacentElement('afterend', foot);
        Array.prototype.forEach.call(foot.querySelectorAll('.oa-label-tag'), function (b) {
          var tag = b.textContent;
          var a = el('a', {
            class: b.className, 'data-tag': tag, text: tag,
            href: href({ room: S.room, season: S.season, tags: tag }),
            title: 'Questions tagged ' + tag
          });
          b.parentNode.replaceChild(a, b);
        });
      },
      strings: {
        loading: 'Loading questions…',
        emptyFiltered: 'No questions match these filters.',
        emptyFilteredHint: 'Try removing a filter, or clear them all to see every question in the room.',
        emptyData: S.archive ? 'This room holds no questions from that season.' : 'No questions yet in this room.',
        emptyDataHint: S.archive ? 'Pick another season from the list beside this one.' : 'Be the first: press Ask a question above.',
        loadError: 'The questions could not be loaded.',
        loadErrorHint: 'Please reload the page. If it keeps happening, this room may not be open to your account.',
        unit: 'questions'
      }
    });
  }

  /* -------------------------------------------------------- the thread */

  function postsOf(d, tid) {
    return threadsCol(d, S.season, S.room).doc(tid).collection(C.posts);
  }

  function drawThread() {
    var host = $('oa-forum-thread');
    if (!host) return;
    show(host, true);
    host.innerHTML = '<p class="oa-hint">Loading the thread…</p>';
    var thread = null, posts = [];
    db().then(function (d) {
      var ref = threadsCol(d, S.season, S.room).doc(S.tid);
      return Promise.all([ref.get(), postsOf(d, S.tid).orderBy('n').get()]);
    }).then(function (r) {
      if (!r[0].exists) throw new Error('That thread could not be found in this room.');
      thread = r[0].data() || {};
      thread.id = S.tid;
      r[1].forEach(function (doc) {
        var v = doc.data() || {};
        v.id = doc.id;
        posts.push(v);
      });
      posts.sort(function (a, b) { return (Number(a.n) || 0) - (Number(b.n) || 0); });
      if (S.archive || thread.locked) return { votes: {} };
      return call('forumThreadVotes', { room: S.room, tid: S.tid }).catch(function () { return { votes: {} }; });
    }).then(function (r) {
      S.votes = (r && r.votes) || {};
      var seen = readSeen(S.me.uid);
      seen.seen[S.tid] = Number(thread.n) || posts.length;
      writeSeen(seen);
      renderThread(host, thread, posts);
      if (location.hash && /^#p\d+$/.test(location.hash)) {
        var target = document.getElementById(location.hash.slice(1));
        if (target) target.scrollIntoView();
      }
      var h1 = $('oa-forum-title');
      if (h1 && !location.hash) { h1.setAttribute('tabindex', '-1'); h1.focus(); }
    }).catch(function (err) {
      host.innerHTML = '<div class="oa-note is-warn"><p><strong>The thread could not be loaded.</strong> ' +
        esc(friendly(err)) + '</p><p><a href="' + esc(href({ room: S.room, season: S.season })) + '">Back to the questions</a></p></div>';
    });
  }

  /* A web address in a post is drawn as a link (owner, 2026-09-05). It runs
     over text esc() has ALREADY escaped, which is what makes it safe: `&`,
     `<` and `"` are entities by then, so nothing here can close an attribute
     or open a tag, and the pattern itself admits only http, https and www,
     never a `javascript:` href. `noopener noreferrer` keeps the forum's
     address out of the other site's referrer, and `nofollow` means a forum
     nobody can crawl cannot be used to pass rank. Trailing sentence
     punctuation is not part of the address; a closing bracket only counts as
     punctuation when the address does not open one of its own. */
  /* The lead admits the two ENTITIES esc() has already made of a quote and an
     apostrophe: a URL between quotation marks ("see https://x.org/y") was
     preceded by a `;` by the time this ran and so was never linked at all.
     Case-insensitive because a phone capitalises the first letter of a
     sentence, and `Www.example.org` is the same address. */
  var LINK_RX = /(^|[\s(]|&quot;|&#39;)((?:https?:\/\/|www\.)[^\s<]+)/gi;
  var TRAIL_ENTITIES = ['&quot;', '&#39;', '&gt;', '&amp;'];

  function linkify(escaped) {
    return escaped.replace(LINK_RX, function (all, lead, raw) {
      var url = raw;
      var trail = '';
      while (url) {
        /* an entity the escaper made of the punctuation AFTER the address:
           the closing quotation mark of "see https://x.org/y" is five
           characters by now, and taking one at a time would leave `&quot` */
        var ent = '';
        for (var ei = 0; ei < TRAIL_ENTITIES.length; ei++) {
          var e2 = TRAIL_ENTITIES[ei];
          if (url.length > e2.length && url.slice(-e2.length) === e2) { ent = e2; break; }
        }
        if (ent) { trail = ent + trail; url = url.slice(0, -ent.length); continue; }
        var last = url.charAt(url.length - 1);
        /* A CLOSING BRACKET THE ADDRESS OPENED IS PART OF IT. Wikipedia's
           own titles end that way, and the test read the wrong way round:
           with one of each it stripped the bracket and linked
           `..._(discipline`, which 404s. Keep it while the address closes no
           more brackets than it opens; strip it when it closes more, which
           is the "(see https://x.org/y)" case. */
        if (last === ')' && url.split(')').length <= url.split('(').length) break;
        if ('.,!?)'.indexOf(last) === -1) break;
        trail = last + trail;
        url = url.slice(0, -1);
      }
      if (!url || url === 'www.') return all;
      var href = url.charAt(0) === 'w' || url.charAt(0) === 'W' ? 'https://' + url : url;
      return lead + '<a href="' + href + '" target="_blank" rel="noopener noreferrer nofollow">' +
        url + '</a>' + trail;
    });
  }

  function bodyHTML(text) {
    return String(text || '').split(/\n{2,}/).map(function (para) {
      return '<p>' + linkify(esc(para)).replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  /** Is the reader the maintainer? Asked of the one definition, so the page
      and the function cannot disagree about who may remove somebody's post. */
  function amAdmin() {
    var A = window.OAAccounts;
    return !!(A && A.isAdmin && A.isAdmin());
  }

  /** THE ORDER THE ANSWERS ARE READ IN. Accepted first, then the best liked,
      then the oldest, which is the arrangement the site the owner asked this
      to resemble has used for fifteen years; the other reading, strictly as
      they were written, is one press away and says so above them. The
      NUMBERING never moves with it: `n` is a post's name, a quote points at
      it, and the permalink under each answer is that number. */
  function sortAnswers(answers, thread, mode) {
    var acc = String((thread && thread.accepted) || '');
    var out = answers.slice();
    if (mode === 'oldest') {
      out.sort(function (a, b) { return (Number(a.n) || 0) - (Number(b.n) || 0); });
      return out;
    }
    out.sort(function (a, b) {
      var av = a.id === acc, bv = b.id === acc;
      if (av !== bv) return av ? -1 : 1;
      /* A TOMBSTONE KEEPS ITS LIKES AND LOSES ITS PLACE. The words are gone,
         so the votes are about something nobody can read; sorted by them a
         well-liked deleted answer sat at the top of the band, above every
         answer that is still there. It stays in the thread, at the bottom,
         because `n` is its name and a reply may quote it. */
      if (!!a.hidden !== !!b.hidden) return a.hidden ? 1 : -1;
      var an = (Number(a.up) || 0) - (Number(a.down) || 0);
      var bn = (Number(b.up) || 0) - (Number(b.down) || 0);
      if (an !== bn) return bn - an;
      return (Number(a.n) || 0) - (Number(b.n) || 0);
    });
    return out;
  }

  /** The answers band alone, repainted where it stands: an answer ticked or
      the order changed must not rebuild the box below it, which may be
      holding something half written.

      AND AN OPEN EDITOR IS CARRIED ACROSS, for the same reason one layer in:
      an in-place edit lives INSIDE the band, so `innerHTML =` threw away
      whatever the reader had typed the moment they ticked an answer or
      changed the order. It is detached before the repaint and put back on
      the post it belongs to, with its own listeners intact. */
  function paintAnswers() {
    var ol = $('oa-forum-answers');
    if (!ol || !S.thread) return;
    var open = ol.querySelector('.oa-forum-editing');
    var openFor = open ? open.getAttribute('data-editing-pid') : '';
    if (open) open.parentNode.removeChild(open);
    var answers = S.posts.slice(1);
    ol.innerHTML = sortAnswers(answers, S.thread, S.sort).map(function (p) {
      return postHTML(p, S.thread, S.readOnly, false, S.live);
    }).join('');
    wirePosts(ol, S.thread, answers, S.readOnly);
    keepFocus(ol, 'li[data-pid="%"] .oa-forum-acc');
    if (open) {
      var host = ol.querySelector('li[data-pid="' + String(openFor).replace(/"/g, '\\"') + '"] .oa-forum-text');
      if (host) {
        host.hidden = true;
        host.insertAdjacentElement('afterend', open);
      }
    }
  }

  function renderThread(host, thread, posts) {
    var first = posts[0] || {};
    /* A THREAD WHOSE QUESTION HAS GONE IS CLOSED (owner, 2026-09-05: "the
       entire thread should be deleted too, and noone should be able to reply
       in such a thread"). Deleting a question now hides its thread, so this
       reads as closed only for rows written before that rule; the function
       refuses an answer to one either way, and the maintainer's Delete on the
       question finishes it off the list. */
    var gone = !!first.hidden && Number(first.n) === 1;
    var readOnly = S.archive || !!thread.locked || !!thread.hidden || gone;
    /* READ-ONLY IS ABOUT NEW POSTS, AND ONLY THAT. Three controls are not
       new posts and the functions say so: forumVote refuses on an archive,
       a locked thread and a hidden post; forumAccept and forumDelete refuse
       on an archive and a hidden THREAD and allow a LOCKED one, because
       locking stops new posts and does not make somebody's own words
       un-deletable or a question un-answerable. Drawn under readOnly they
       were withheld exactly where the function would have allowed them,
       which is a control the reader cannot find rather than one that fails
       on the press. `frozen` is the half both of them share. */
    var frozen = S.archive || !!thread.hidden;
    /* answers still standing: a deleted one no longer holds the question down */
    var live = posts.filter(function (p) { return Number(p.n) !== 1 && !p.hidden; }).length;
    var answers = posts.slice(1);
    S.thread = thread;
    S.posts = posts;
    S.readOnly = readOnly;
    S.frozen = frozen;
    S.live = live;
    var out = '';
    out += '<nav class="oa-forum-crumbs" aria-label="You are here"><a href="' + esc(href({ room: S.room, season: S.season })) + '">Questions</a> &rsaquo; ' +
      '<span>' + esc(thread.title) + '</span></nav>';
    out += '<header class="oa-forum-th"><h1 id="oa-forum-title">' + esc(thread.title) + '</h1>' +
      '<div class="oa-forum-thmeta">' +
        '<span>Asked <b title="' + esc(stamp(thread.t)) + '">' + esc(ago(thread.t)) + '</b></span>' +
        '<span>Active <b title="' + esc(stamp(thread.lastAt)) + '">' + esc(ago(thread.lastAt)) + '</b></span>' +
        '<span>Season <b>' + esc(label(S.season)) + '</b></span>' +
        (thread.pinned ? '<span class="oa-label oa-label-pinned">Pinned</span>' : '') +
        (thread.locked ? '<span class="oa-label oa-label-locked">Locked</span>' : '') +
      '</div>' +
      '<div class="oa-forum-thtags">' + (Array.isArray(thread.tags) ? thread.tags : []).map(function (t) {
        return '<a class="oa-label oa-label-tag" data-tag="' + esc(t) + '" href="' + esc(href({ room: S.room, season: S.season, tags: t })) + '">' + esc(t) + '</a>';
      }).join('') + '</div></header>';

    out += '<ol class="oa-forum-posts oa-forum-qpost" id="oa-forum-posts">' +
      postHTML(first, thread, readOnly, true, live) + '</ol>';
    out += '<div class="oa-forum-answers-h"' + (answers.length ? '' : ' hidden') + '>' +
      '<h2>' + answers.length + ' ' + (answers.length === 1 ? 'Answer' : 'Answers') + '</h2>' +
      '<label class="oa-forum-sort">Sorted by ' +
        '<select id="oa-forum-sort">' +
          '<option value="score"' + (S.sort === 'score' ? ' selected' : '') + '>Highest score (default)</option>' +
          '<option value="oldest"' + (S.sort === 'oldest' ? ' selected' : '') + '>Oldest first</option>' +
        '</select></label></div>';
    out += '<ol class="oa-forum-posts" id="oa-forum-answers"></ol>';
    host.innerHTML = out;
    paintAnswers();
    wirePosts($('oa-forum-posts'), thread, posts, readOnly);
    var sort = $('oa-forum-sort');
    if (sort) {
      sort.addEventListener('change', function () {
        S.sort = sort.value === 'oldest' ? 'oldest' : 'score';
        paintAnswers();
      });
    }

    // the answer box lives OUTSIDE the list of posts
    var compose = $('oa-forum-compose');
    if (compose) {
      compose.innerHTML = '';
      if (gone && !S.archive) {
        compose.innerHTML = '<div class="oa-note"><p>This question was deleted, so the thread is closed. ' +
          'Nothing more can be added to it.</p></div>';
      } else if (readOnly) {
        compose.innerHTML = '<div class="oa-note"><p>' + (S.archive
          ? 'This season is archived. The thread stays readable and nothing can be added to it.'
          : 'This thread is locked. It stays readable and nothing can be added to it.') + '</p></div>';
      } else {
        compose.appendChild(replyBox(thread, first));
      }
      show(compose, true);
    }
  }

  function postHTML(p, thread, readOnly, isFirst, liveAnswers) {
    var mine = p.by === S.me.handle;
    /* what each control's own function allows; see renderThread */
    var frozen = S.archive || !!(thread && thread.hidden);
    var canVote = !frozen && !(thread && thread.locked) && !p.hidden;
    var canTouch = !frozen;
    var up = Number(p.up) || 0, down = Number(p.down) || 0;
    var net = up - down;
    var v = Number(S.votes[p.id]) || 0;
    var n = Number(p.n) || 0;
    var what = isFirst ? 'question' : 'answer';
    /* the tick: on the thread, never on the post, so there is one place it
       can be read from and nothing to keep in step */
    var accepted = !isFirst && String((thread && thread.accepted) || '') === p.id;
    var canAccept = !isFirst && canTouch && !p.hidden && !!thread && thread.by === S.me.handle;
    var saved = isSaved(S.tid, isFirst ? '' : p.id);
    var out = '<li class="oa-forum-post' + (isFirst ? ' is-first' : '') + (accepted ? ' is-accepted' : '') +
      '" id="p' + n + '" data-pid="' + esc(p.id) + '" data-n="' + n + '">';
    out += '<div class="oa-forum-vote">';
    if (canVote) {
      out += '<button type="button" class="oa-forum-v up" data-v="1" aria-pressed="' + (v === 1 ? 'true' : 'false') + '" ' +
        'aria-label="Like this ' + what + '"' + (mine ? ' disabled title="You cannot vote on your own post"' : '') + '>&#9650;</button>';
    }
    out += '<b class="oa-forum-score" title="' + plural(up, 'like', 'likes') + ', ' + plural(down, 'dislike', 'dislikes') + '">' + (net > 0 ? '+' : '') + net + '</b>';
    if (canVote) {
      out += '<button type="button" class="oa-forum-v down" data-v="-1" aria-pressed="' + (v === -1 ? 'true' : 'false') + '" ' +
        'aria-label="Dislike this ' + what + '"' + (mine ? ' disabled title="You cannot vote on your own post"' : '') + '>&#9660;</button>';
    }
    out += '<span class="oa-forum-updown">' + up + ' / ' + down + '</span>';
    /* THE TICK. The member who ASKED gets a button; everybody else gets the
       mark itself, and only once it is there, because a control nobody may
       press is worse than no control. */
    if (canAccept) {
      out += '<button type="button" class="oa-forum-acc" data-act="accept" aria-pressed="' + (accepted ? 'true' : 'false') + '" ' +
        'title="' + (accepted ? 'This is the answer you ticked. Press to untick it.' : 'Tick this as the answer to your question') + '" ' +
        'aria-label="' + (accepted ? 'Untick this answer' : 'Tick this as the answer') + '">&#10003;</button>';
    } else if (accepted) {
      out += '<span class="oa-forum-acc is-on" title="The member who asked ticked this as the answer" ' +
        'aria-label="Accepted answer">&#10003;</span>';
    }
    if (!p.hidden) {
      out += '<button type="button" class="oa-forum-save" data-act="save" aria-pressed="' + (saved ? 'true' : 'false') + '" ' +
        'title="' + (saved ? 'Saved in this browser. Press to remove it.' : 'Save this ' + what + ' in this browser') + '" ' +
        'aria-label="' + (saved ? 'Remove this ' + what + ' from your saved list' : 'Save this ' + what) + '">' + ICON_SAVE + '</button>';
    }
    out += '</div><div class="oa-forum-pbody">';
    if (p.hidden) {
      out += '<p class="oa-forum-removed">' + (p.hiddenBy === 'admin'
        ? 'This ' + what + ' was removed by the maintainer.'
        : 'This ' + what + ' was deleted by its author.') + '</p>';
    } else {
      if (p.quote && p.quote.text) {
        out += '<blockquote class="oa-forum-quote"><cite><span class="oa-forum-handle">' + esc(p.quote.by) + '</span> wrote in ' +
          '<a href="#p' + (Number(p.quote.n) || 0) + '">#' + (Number(p.quote.n) || 0) + '</a></cite><p>' + esc(p.quote.text) + '</p></blockquote>';
      }
      out += '<div class="oa-forum-text">' + bodyHTML(p.body) + '</div>';
    }
    out += '<div class="oa-forum-pfoot"><div class="oa-forum-pacts">';
    if (!readOnly && !p.hidden) {
      if (isFirst) out += '<button type="button" class="oa-forum-act" data-act="reply">Answer this question</button>';
      out += '<button type="button" class="oa-forum-act" data-act="quote">Quote</button>';
    }
    out += '<a class="oa-forum-act" href="' + esc(href({ room: S.room, season: S.season, t: S.tid, hash: 'p' + n })) + '" title="A link to this post">#' + n + '</a>';
    if (!readOnly && !p.hidden && mine) {
      var left = Number(p.t) + M.EDIT_WINDOW_MS - Date.now();
      if (left > 0) {
        out += '<button type="button" class="oa-forum-act" data-act="edit">Edit · ' + Math.max(1, Math.ceil(left / 60000)) + ' min left</button>';
      }
    }
    /* Delete: your own post at any time, with no window, and ANY post for the
       maintainer (owner, 2026-09-05). A question somebody has answered cannot
       be deleted at all, so the control says why rather than failing on the
       press; a maintainer is not held by that rule. */
    if (canTouch && !p.hidden && (mine || amAdmin())) {
      var stuck = isFirst && !amAdmin() && liveAnswers > 0;
      out += '<button type="button" class="oa-forum-act is-del" data-act="delete"' +
        (stuck ? ' disabled title="A question with answers cannot be deleted. It can go once every answer has been deleted."' : '') +
        '>' + (mine ? 'Delete' : 'Remove') + '</button>';
    } else if (canTouch && isFirst && p.hidden && (mine || amAdmin())) {
      /* A THREAD LEFT HEADLESS BY THE OLD RULE. Its question is already a
         tombstone and its thread is still standing, so forumDelete's second
         press has one thing to do: shut it. That path had no control at
         all, because every button here hung off !p.hidden. */
      out += '<button type="button" class="oa-forum-act is-del" data-act="delete" ' +
        'title="This question is already deleted. Closing the thread takes it off the list.">Close this thread</button>';
    }
    out += '</div><div class="oa-forum-who">' +
      '<span class="oa-forum-handle' + (mine ? ' is-me' : '') + '">' + esc(p.by) + '</span>' +
      '<span title="' + esc(stamp(p.t)) + '">' + (isFirst ? 'asked ' : 'answered ') + esc(ago(p.t)) + '</span>' +
      (p.editedAt ? '<span title="' + esc(stamp(p.editedAt)) + '">edited</span>' : '') +
      '</div></div></div></li>';
    return out;
  }

  /** Wire the posts inside ONE root: the question's list and the answers band
      are painted separately, so each wires its own and a repaint of the band
      cannot leave the question carrying two of every listener. */
  function wirePosts(root, thread, posts, readOnly) {
    if (!root) return;
    var byId = {};
    posts.forEach(function (p) { byId[p.id] = p; });
    Array.prototype.forEach.call(root.querySelectorAll('.oa-forum-post'), function (li) {
      var pid = li.getAttribute('data-pid');
      var p = byId[pid];
      if (!p) return;
      Array.prototype.forEach.call(li.querySelectorAll('.oa-forum-v'), function (b) {
        b.addEventListener('click', function () { vote(li, p, Number(b.getAttribute('data-v'))); });
      });
      Array.prototype.forEach.call(li.querySelectorAll('[data-act]'), function (b) {
        var act = b.getAttribute('data-act');
        b.addEventListener('click', function () {
          if (act === 'reply') focusReply();
          else if (act === 'quote') quoteFrom(li, p);
          else if (act === 'edit') editPost(li, p);
          else if (act === 'delete') deletePost(thread, p, b);
          else if (act === 'accept') acceptAnswer(thread, p, b);
          else if (act === 'save') savePost(li, thread, p, b);
        });
      });
    });
  }

  /* TICKING THE ANSWER. The member who asked, and only they: the function
     refuses everyone else with `asker` whatever this page draws. The tick is
     one field on the thread, so what comes back is what the whole page reads
     from, and the band is repainted so the answer moves to the top where the
     order says it should be. Pressing the ticked one again unticks it. */
  function acceptAnswer(thread, p, btn) {
    if (S.frozen) return;
    var on = String(thread.accepted || '') === p.id;
    btn.disabled = true;
    call('forumAccept', { room: S.room, tid: S.tid, pid: on ? '' : p.id }).then(function (r) {
      thread.accepted = String((r && r.accepted) || '');
      S.thread = thread;
      /* the band is repainted and reordered under the press, so the button
         itself is discarded; without this, focus falls to <body> and the new
         pressed state is announced to nobody */
      refocus = { host: 'oa-forum-answers', key: p.id };
      paintAnswers();
      say(thread.accepted ? 'Ticked as the answer.' : 'The tick is off.');
    }).catch(function (err) {
      btn.disabled = false;
      say(friendly(err), true);
    });
  }

  /* SAVING one. Nothing is sent anywhere: the mark is this browser's, the
     button says so in its own title, and the side card is where the list of
     them is read back. */
  function savePost(li, thread, p, btn) {
    var isFirst = Number(p.n) === 1;
    var what = isFirst ? 'question' : 'answer';
    var on = toggleSaved(S.tid, isFirst ? '' : p.id, thread.title, p.n);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Saved in this browser. Press to remove it.' : 'Save this ' + what + ' in this browser';
    btn.setAttribute('aria-label', on ? 'Remove this ' + what + ' from your saved list' : 'Save this ' + what);
    say(on ? 'Saved in this browser.' : 'Removed from your saved list.');
  }

  /* Deleting is not a one-way door anywhere else on this site; here it is,
     and the confirmation says so rather than asking a bare "are you sure".
     A question always takes its thread with it, so the wording says so and
     the page goes back to the list; the maintainer's own wording says they
     are removing somebody else's post rather than deleting their own. */
  function deletePost(thread, p, btn) {
    var isFirst = Number(p.n) === 1;
    var mine = p.by === S.me.handle;
    /* The question is ALREADY a tombstone and the thread is still standing:
       there are no words left to take away, so the wording does not promise
       to take any. */
    if (isFirst && p.hidden) {
      if (!window.confirm('Close this thread? Its question was already deleted, so nothing more is taken away; the thread simply comes off the list.')) return;
      btn.disabled = true;
      call('forumDelete', { room: S.room, tid: S.tid, pid: p.id }).then(function () {
        go({ room: S.room, season: S.season });
      }).catch(function (err) {
        btn.disabled = false;
        say(friendly(err), true);
      });
      return;
    }
    var msg = isFirst
      ? (mine
          ? 'Delete this question? The whole thread goes with it, and the words cannot be brought back.'
          : 'Remove this question as the maintainer? The whole thread goes with it, answers included, and the words cannot be brought back.')
      : (mine
          ? 'Delete this answer? Its place in the thread stays so the numbering still reads, but the words go, and they cannot be brought back.'
          : 'Remove this answer as the maintainer? Its place in the thread stays, but the words go, and they cannot be brought back.');
    if (!window.confirm(msg)) return;
    btn.disabled = true;
    call('forumDelete', { room: S.room, tid: S.tid, pid: p.id }).then(function (r) {
      if (r && r.thread) go({ room: S.room, season: S.season });
      else go({ room: S.room, season: S.season, t: S.tid });
    }).catch(function (err) {
      btn.disabled = false;
      say(friendly(err), true);
    });
  }

  function vote(li, p, want) {
    if (S.frozen || (S.thread && S.thread.locked) || p.hidden) return;
    var had = Number(S.votes[p.id]) || 0;
    var v = had === want ? 0 : want;
    var btns = li.querySelectorAll('.oa-forum-v');
    Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
    call('forumVote', { room: S.room, tid: S.tid, pid: p.id, v: v }).then(function (r) {
      S.votes[p.id] = v;
      p.up = Number(r.up) || 0;
      p.down = Number(r.down) || 0;
      var net = p.up - p.down;
      li.querySelector('.oa-forum-score').textContent = (net > 0 ? '+' : '') + net;
      li.querySelector('.oa-forum-score').title = plural(p.up, 'like', 'likes') + ', ' + plural(p.down, 'dislike', 'dislikes');
      li.querySelector('.oa-forum-updown').textContent = p.up + ' / ' + p.down;
      Array.prototype.forEach.call(btns, function (b) {
        b.setAttribute('aria-pressed', Number(b.getAttribute('data-v')) === v ? 'true' : 'false');
        b.disabled = false;
      });
    }).catch(function (err) {
      Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
      say(friendly(err), true);
    });
  }

  /* -------------------------------------------------- the answer box */

  /* THERE ARE NO "how do you know" RADIOS, and their absence is the point
     (owner, 2026-09-05). The box used to ask every poster to mark a post
     Plain, First-hand or Rumour: a question with no good reason to be asked,
     whose third answer offered the one thing rule 5 forbids. Both are gone
     from the model, the functions and this page, so a post is somebody
     saying something and nothing labels it otherwise. */

  function acceptBox(id) {
    if (S.me.guideAt) return '';
    return '<label class="oa-forum-accept"><input type="checkbox" id="' + id + '">' +
      'I have read <a href="#oa-forum-guide">the forum guide</a>: no names, no contact details, no rumours.</label>';
  }

  function replyBox(thread, first) {
    var wrap = el('div', { class: 'oa-forum-compose', id: 'oa-forum-reply' });
    wrap.innerHTML =
      '<h2>Your answer <span class="oa-forum-as">as <span class="oa-forum-handle is-me">' + esc(S.me.handle) + '</span></span></h2>' +
      '<div class="oa-forum-quotebox" id="oa-forum-quotebox" hidden></div>' +
      '<div class="oa-forum-editor">' +
        '<textarea id="oa-forum-body" rows="6" maxlength="' + M.BOUNDS.body + '" placeholder="Answer the question. Plain text, a few paragraphs at most." aria-label="Your answer"></textarea>' +
        '<div class="oa-forum-bar">' +
          '<button type="button" class="oa-forum-send" id="oa-forum-send">Post your answer</button>' +
        '</div>' +
      '</div>' +
      acceptBox('oa-forum-accept') +
      '<p class="oa-forum-guardmsg" id="oa-forum-guardmsg" aria-live="polite"></p>' +
      '<p class="oa-forum-msg" id="oa-forum-msg" aria-live="polite"></p>';
    var ta = wrap.querySelector('#oa-forum-body');
    var guard = wrap.querySelector('#oa-forum-guardmsg');
    ta.addEventListener('input', function () { liveGuard(ta, guard); });
    wrap.querySelector('#oa-forum-send').addEventListener('click', function () { sendReply(wrap, ta); });
    return wrap;
  }

  function liveGuard(ta, msgEl) {
    var why = G.check(ta.value);
    msgEl.textContent = why ? G.WHY[why] : '';
    return !why;
  }

  function say(msg, isErr) {
    var m = $('oa-forum-msg') || $('oa-forum-ask-msg');
    /* A read-only thread draws no answer box and therefore no message line.
       An error still has to be seen; a "saved in this browser" does not, and
       an alert for one would be worse than saying nothing. */
    if (!m) { if (msg && isErr) window.alert(msg); return; }
    m.textContent = msg || '';
    m.className = 'oa-forum-msg' + (isErr ? ' is-err' : '');
  }

  function focusReply() {
    var ta = $('oa-forum-body');
    if (ta) { ta.focus(); ta.scrollIntoView({ block: 'center' }); }
  }

  /** Quote a post: the selection inside its body if there is one, else the
      whole body cut to the bound at a word boundary. A COPY of the words as
      they stand; the function checks they really are in the post. */
  function quoteFrom(li, p) {
    var text = '';
    var sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && li.querySelector('.oa-forum-text') &&
        li.querySelector('.oa-forum-text').contains(sel.anchorNode)) {
      text = String(sel.toString() || '').trim();
    }
    if (!text) text = String(p.body || '').trim();
    if (text.length > M.BOUNDS.quote) {
      var cut = text.slice(0, M.BOUNDS.quote);
      var sp = cut.lastIndexOf(' ');
      text = (sp > M.BOUNDS.quote * 0.6 ? cut.slice(0, sp) : cut).trim();
    }
    if (!text) return;
    S.quote = { n: Number(p.n) || 0, by: p.by, text: text };
    var box = $('oa-forum-quotebox');
    if (box) {
      box.innerHTML = '<div><cite><span class="oa-forum-handle">' + esc(p.by) + '</span> wrote in #' + S.quote.n + '</cite>' +
        '<p>' + esc(text) + '</p></div>' +
        '<button type="button" class="oa-forum-act" id="oa-forum-unquote" aria-label="Remove the quote">Remove</button>';
      show(box, true);
      box.querySelector('#oa-forum-unquote').addEventListener('click', function () {
        S.quote = null;
        show(box, false);
      });
    }
    focusReply();
  }

  function sendReply(wrap, ta) {
    var body = String(ta.value || '').trim();
    var btn = wrap.querySelector('#oa-forum-send');
    var accept = wrap.querySelector('#oa-forum-accept');
    if (!body) { say('Write something first.', true); return; }
    if (!liveGuard(ta, wrap.querySelector('#oa-forum-guardmsg'))) { say(REASONS[G.check(body)] || 'That cannot be posted.', true); return; }
    if (accept && !accept.checked) { say(REASONS.guide, true); accept.focus(); return; }
    btn.disabled = true;
    say('Posting…');
    var data = { room: S.room, tid: S.tid, body: body };
    if (S.quote) data.quote = { n: S.quote.n, text: S.quote.text };
    if (accept && accept.checked) data.acceptGuide = true;
    call('forumPost', data).then(function (r) {
      if (accept) { S.me.guideAt = Date.now(); writeMe(S.me); }
      go({ room: S.room, season: S.season, t: r.tid || S.tid, hash: 'p' + (r.n || '') });
    }).catch(function (err) {
      btn.disabled = false;
      say(friendly(err), true);
    });
  }

  /* --------------------------------------------------------- editing */

  function editPost(li, p) {
    var text = li.querySelector('.oa-forum-text');
    if (!text || li.querySelector('.oa-forum-editing')) return;
    var box = el('div', { class: 'oa-forum-editor oa-forum-editing' });
    box.innerHTML =
      '<textarea rows="6" maxlength="' + M.BOUNDS.body + '" aria-label="Edit your post">' + esc(p.body) + '</textarea>' +
      '<div class="oa-forum-bar">' +
        '<span class="oa-forum-actions"><button type="button" class="oa-forum-cancel" data-edit="cancel">Cancel</button>' +
        '<button type="button" class="oa-forum-send" data-edit="save">Save</button></span></div>' +
      '<p class="oa-forum-guardmsg" aria-live="polite"></p>';
    text.hidden = true;
    box.setAttribute('data-editing-pid', String(p.id));
    text.insertAdjacentElement('afterend', box);
    var ta = box.querySelector('textarea');
    var guard = box.querySelector('.oa-forum-guardmsg');
    ta.addEventListener('input', function () { liveGuard(ta, guard); });
    box.querySelector('[data-edit="cancel"]').addEventListener('click', function () {
      /* the body is found from the box's OWN parent rather than held from
         when it opened: the band may have been repainted under it since,
         and putting a detached node back would show nothing */
      var body = box.parentNode && box.parentNode.querySelector('.oa-forum-text');
      box.remove();
      if (body) body.hidden = false;
    });
    box.querySelector('[data-edit="save"]').addEventListener('click', function () {
      var body = String(ta.value || '').trim();
      if (!body) { guard.textContent = 'Write something, or press Cancel.'; return; }
      if (!liveGuard(ta, guard)) return;
      var save = box.querySelector('[data-edit="save"]');
      save.disabled = true;
      call('forumEdit', { room: S.room, tid: S.tid, pid: p.id, body: body })
        .then(function () { go({ room: S.room, season: S.season, t: S.tid, hash: 'p' + p.n }); })
        .catch(function (err) { save.disabled = false; guard.textContent = friendly(err); });
    });
    ta.focus();
  }

  /* ------------------------------------------------------ asking */

  function drawAsk() {
    var host = $('oa-forum-compose');
    if (!host) return;
    var cand = S.room === 'candidates';
    host.className = 'oa-forum-ask';
    host.innerHTML =
      '<nav class="oa-forum-crumbs" aria-label="You are here"><a href="' + esc(href({ room: S.room, season: S.season })) + '">Questions</a> &rsaquo; <span>Ask a question</span></nav>' +
      '<h1>Ask a question</h1>' +
      '<p class="oa-forum-lede">It goes out under your handle, never your name. Take a minute over the title; it is what people scan.</p>' +
      '<form id="oa-forum-askform" novalidate>' +
        '<div class="oa-forum-f"><span class="oa-forum-flabel">Where</span>' +
          '<div class="oa-forum-banner' + (cand ? '' : ' is-open') + '"><div><span class="oa-forum-bt">' + (cand ? 'Candidates’ room' : 'Open forum') + ' &middot; ' + esc(label(S.season)) + '</span>' +
          '<span class="oa-forum-bs">' + (cand ? 'Only this season’s candidates.' : 'Anyone with a confirmed account, faculty included.') +
          ' You post as <span class="oa-forum-handle is-me">' + esc(S.me.handle) + '</span>.' +
          (S.me.rooms.candidates && S.me.rooms.open ? ' To ask in the other room, switch rooms at the top of the page first.' : '') +
          '</span></div></div></div>' +
        '<div class="oa-forum-f"><label for="oa-forum-ask-title">Title</label>' +
          '<input type="text" id="oa-forum-ask-title" maxlength="' + M.BOUNDS.title + '" autocomplete="off" placeholder="One sentence, specific">' +
          '<p class="oa-forum-hint">One sentence, specific. &ldquo;Offer question&rdquo; will get fewer answers than &ldquo;Is a second-year release normal to ask for?&rdquo;</p></div>' +
        '<div class="oa-forum-f"><label for="oa-forum-ask-body">Details</label>' +
          '<div class="oa-forum-editor"><textarea id="oa-forum-ask-body" rows="8" maxlength="' + M.BOUNDS.body + '" placeholder="Plain text, a few paragraphs at most."></textarea></div>' +
          '<p class="oa-forum-guardmsg" id="oa-forum-ask-guardmsg" aria-live="polite"></p></div>' +
        '<div class="oa-forum-f"><label for="oa-forum-tag-in">Tags</label>' +
          '<div class="oa-forum-tagsin" id="oa-forum-tagsin"><span id="oa-forum-tagchips"></span>' +
            '<input type="text" id="oa-forum-tag-in" autocomplete="off" placeholder="Type a tag and press Enter" aria-describedby="oa-forum-taghint"></div>' +
          '<ul class="oa-forum-tagsugg" id="oa-forum-tagsugg" role="listbox" aria-label="Suggested tags"></ul>' +
          '<p class="oa-forum-hint" id="oa-forum-taghint" aria-live="polite">' + TAG_HINT + '</p></div>' +
        acceptBox('oa-forum-ask-accept') +
        '<p class="oa-forum-msg" id="oa-forum-ask-msg" aria-live="polite"></p>' +
        '<div class="oa-forum-actions" style="margin-top:18px">' +
          '<button type="submit" class="oa-forum-send" id="oa-forum-ask-send">Post question</button>' +
          '<a class="oa-forum-cancel" href="' + esc(href({ room: S.room, season: S.season })) + '">Cancel</a>' +
          '<span class="oa-forum-hint">Editable for fifteen minutes after posting.</span>' +
        '</div>' +
      '</form>';
    show(host, true);

    var tags = [];
    var chips = $('oa-forum-tagchips');
    var input = $('oa-forum-tag-in');
    var sugg = $('oa-forum-tagsugg');
    var body = $('oa-forum-ask-body');
    var guard = $('oa-forum-ask-guardmsg');
    body.addEventListener('input', function () { liveGuard(body, guard); });

    function drawChips() {
      chips.innerHTML = '';
      tags.forEach(function (t) {
        var chip = el('button', {
          type: 'button', class: 'oa-chip', 'data-tag': t, 'aria-label': 'Remove the tag ' + t,
          onclick: function () { tags = tags.filter(function (x) { return x !== t; }); drawChips(); input.focus(); }
        }, [el('span', { class: 'oa-chip-label', text: t }), el('span', { class: 'oa-chip-x', 'aria-hidden': 'true', text: '×' })]);
        chips.appendChild(chip);
      });
      input.disabled = tags.length >= M.TAG_MAX;
      input.placeholder = tags.length >= M.TAG_MAX ? 'Five is the most' : (tags.length ? 'Another tag' : 'Type a tag and press Enter');
    }
    function tagHint(msg) {
      var n = $('oa-forum-taghint');
      if (n) n.textContent = msg || TAG_HINT;
    }
    function add(raw) {
      var s = M.slug(raw);
      if (!s || !M.tagOk(s) || tags.indexOf(s) !== -1 || tags.length >= M.TAG_MAX) { input.value = ''; drawSugg(); return; }
      /* THE GUARD RUNS HERE TOO. A tag is [a-z0-9-]{2,24}, which is exactly
         the shape a telephone number and an ORCID iD survive, so forumPost
         checks every one of them; shown here first, the refusal names the
         box the reader is typing in rather than arriving on the send with a
         sentence about a post. */
      var why = G.check(s);
      if (why) {
        input.value = '';
        tagHint(REASONS[why]);
        drawSugg();
        return;
      }
      tagHint('');
      tags.push(s);
      input.value = '';
      drawChips();
      drawSugg();
    }
    function drawSugg() {
      var q = M.slug(input.value);
      sugg.innerHTML = '';
      if (input.disabled) return;
      var seen = {};
      var pool = [];
      Object.keys(S.tally).forEach(function (k) { if (M.tagOk(k)) { pool.push([k, Number(S.tally[k]) || 0]); seen[k] = true; } });
      M.TAGS.forEach(function (k) { if (!seen[k]) pool.push([k, 0]); });
      pool = pool.filter(function (p) { return tags.indexOf(p[0]) === -1 && (!q || p[0].indexOf(q) !== -1); })
        .sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); });
      if (!q) pool = pool.slice(0, 8);
      else pool = pool.slice(0, 6);
      pool.forEach(function (p) {
        var li = el('li', { role: 'option' }, [el('button', { type: 'button', 'data-tag': p[0], onclick: function () { add(p[0]); input.focus(); } }, [
          el('span', { text: p[0] }), el('i', { text: p[1] ? plural(p[1], 'question', 'questions') : 'suggested' })])]);
        sugg.appendChild(li);
      });
      if (q && !seen[q] && M.TAGS.indexOf(q) === -1 && M.tagOk(q)) {
        var li2 = el('li', { role: 'option' }, [el('button', { type: 'button', 'data-tag': q, onclick: function () { add(q); input.focus(); } }, [
          el('span', { text: 'Create the tag “' + q + '”' }), el('i', { text: 'press Enter' })])]);
        sugg.appendChild(li2);
      }
    }
    input.addEventListener('input', function () { tagHint(''); drawSugg(); });
    input.addEventListener('focus', drawSugg);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(input.value); }
      else if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); drawChips(); drawSugg(); }
    });
    $('oa-forum-tagsin').addEventListener('click', function (e) { if (e.target === e.currentTarget) input.focus(); });
    drawSugg();

    $('oa-forum-askform').addEventListener('submit', function (e) {
      e.preventDefault();
      var title = String($('oa-forum-ask-title').value || '').trim();
      var text = String(body.value || '').trim();
      var accept = $('oa-forum-ask-accept');
      var send = $('oa-forum-ask-send');
      if (input.value.trim()) add(input.value);
      if (!title) { say('Give the question a title.', true); $('oa-forum-ask-title').focus(); return; }
      if (G.check(title)) { say(G.WHY[G.check(title)], true); $('oa-forum-ask-title').focus(); return; }
      if (!text) { say('Write the details.', true); body.focus(); return; }
      if (!liveGuard(body, guard)) { say(G.WHY[G.check(text)], true); body.focus(); return; }
      if (!M.tagsOk(tags)) { say(REASONS.tags, true); input.focus(); return; }
      if (accept && !accept.checked) { say(REASONS.guide, true); accept.focus(); return; }
      send.disabled = true;
      say('Posting…');
      var data = { room: S.room, title: title, tags: tags.slice(), body: text };
      if (accept && accept.checked) data.acceptGuide = true;
      call('forumPost', data).then(function (r) {
        if (accept) { S.me.guideAt = Date.now(); writeMe(S.me); }
        go({ room: S.room, season: S.season, t: r.tid });
      }).catch(function (err) {
        send.disabled = false;
        say(friendly(err), true);
      });
    });
    $('oa-forum-ask-title').focus();
  }

  /* ------------------------------------------------------------- go */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
