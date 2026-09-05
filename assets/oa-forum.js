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
    window: 'The fifteen-minute edit window has closed; the post stays as written. You can still delete it.',
    own: 'You cannot vote on your own post.',
    busy: 'The forum is busy right now. Please try again in a moment.',
    bounds: 'Too long, or empty. A title is at most ' + M.BOUNDS.title + ' characters and a post at most ' + M.BOUNDS.body + '.',
    tags: 'One to five tags, each 2 to 24 characters of letters, digits and hyphens, and none of them labelling the post a rumour.',
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
    quote: null,                    // { n, by, text } waiting above the reply box
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
    if (o && o.tags) p.set('tags', o.tags);
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
    var a = e.target && e.target.closest ? e.target.closest('a[href^="forum.html?"]') : null;
    if (!a || !S.me) return;
    var app = $('oa-forum');
    if (!app || !app.contains(a)) return;
    e.preventDefault();
    var to = a.getAttribute('href');
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
  function readSeen(uid) {
    try {
      var v = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null');
      if (v && v.uid === uid && v.seen) return v;
    } catch (e) { /* private mode */ }
    return { uid: uid, since: Date.now(), seen: {} };
  }
  function writeSeen(v) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ }
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
      if (!u) { hideAll(); show($('oa-needauth'), true); started = null; return; }
      if (started === u.uid) return;
      started = u.uid;
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

  /** forumJoin, once per session per account: the handle and the rooms. */
  function join(u) {
    var cached = readMe(u.uid);
    if (cached) return Promise.resolve(cached);
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
    if (S.tid) drawThread();
    else if (S.ask && !S.archive) drawAsk();
    else drawList();
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

  function drawTags() {
    var card = $('oa-forum-tagcard');
    var host = $('oa-forum-tags');
    if (!card || !host) return;
    var pairs = Object.keys(S.tally).map(function (k) { return [k, Number(S.tally[k]) || 0]; })
      .filter(function (p) { return p[1] > 0 && M.tagOk(p[0]); })
      .sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); })
      .slice(0, 12);
    if (!pairs.length) { show(card, false); return; }
    host.innerHTML = pairs.map(function (p) {
      return '<a href="' + esc(href({ room: S.room, season: S.season, tags: p[0] })) + '" data-tag="' + esc(p[0]) + '">' +
        esc(p[0]) + '<i>' + p[1] + '</i></a>';
    }).join('');
    show(card, true);
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
          pinned: !!v.pinned,
          locked: !!v.locked
        });
      });
      return rows;
    });
  }

  function drawList() {
    show($('oa-forum-listview'), true);
    var title = $('oa-forum-listtitle');
    if (title) title.textContent = S.room === 'candidates' ? 'Questions from candidates' : 'Questions in the Open forum';
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
        var count = $('oa-forum-listcount');
        if (count) count.textContent = plural(rows.length, 'question', 'questions') + ' this season';
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
           place (owner, 2026-09-05: the card printed the reply count twice,
           in a side column and again here). */
        subtitle: function (r) { return r.by; },
        badges: function (r) {
          var out = [];
          if (r.pinned) out.push({ text: 'Pinned', cls: 'oa-label-pinned' });
          if (r.locked) out.push({ text: 'Locked', cls: 'oa-label-locked' });
          var was = seen.seen[r.id];
          var unread = typeof was === 'number' ? r.n > was : (r.lastAt > (seen.since || 0));
          if (unread && !S.archive) out.push({ text: 'New', cls: 'oa-label-new' });
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
        var replies = Math.max(0, r.n - 1);
        var head = li.querySelector('.oa-card-head');
        var t = li.querySelector('.oa-card-title');
        if (t && r.excerpt) t.insertAdjacentElement('afterend', el('p', { class: 'oa-forum-ex', text: r.excerpt }));

        li.insertBefore(el('div', { class: 'oa-forum-stats' }, [
          el('span', { class: 'oa-forum-stat' }, [
            el('b', { text: String(r.score) }), el('i', { text: Math.abs(r.score) === 1 ? 'vote' : 'votes' })
          ]),
          el('span', { class: 'oa-forum-stat is-answers' + (replies ? ' has' : '') }, [
            el('b', { text: String(replies) }), el('i', { text: replies === 1 ? 'reply' : 'replies' })
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
        if (head) head.appendChild(foot);
        Array.prototype.forEach.call(li.querySelectorAll('.oa-label-tag'), function (b) {
          var tag = b.textContent;
          b.setAttribute('data-tag', tag);
          b.setAttribute('role', 'link');
          b.title = 'Questions tagged ' + tag;
          b.addEventListener('click', function (e) {
            e.stopPropagation();
            go({ room: S.room, season: S.season, tags: tag });
          });
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
  var LINK_RX = /(^|[\s(])((?:https?:\/\/|www\.)[^\s<]+)/g;

  function linkify(escaped) {
    return escaped.replace(LINK_RX, function (all, lead, raw) {
      var url = raw;
      var trail = '';
      while (url) {
        var last = url.charAt(url.length - 1);
        if (last === ')' && url.split('(').length > url.split(')').length) break;
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

  function renderThread(host, thread, posts) {
    var readOnly = S.archive || !!thread.locked || !!thread.hidden;
    var first = posts[0] || {};
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

    out += '<ol class="oa-forum-posts" id="oa-forum-posts">';
    posts.forEach(function (p, i) {
      out += postHTML(p, readOnly, i === 0);
      if (i === 0 && posts.length > 1) {
        out += '</ol><div class="oa-forum-replies-h"><h2>' + plural(posts.length - 1, 'reply', 'replies') + '</h2></div><ol class="oa-forum-posts">';
      }
    });
    out += '</ol>';
    host.innerHTML = out;

    // the reply box lives OUTSIDE the list of posts
    var compose = $('oa-forum-compose');
    if (compose) {
      compose.innerHTML = '';
      if (readOnly) {
        compose.innerHTML = '<div class="oa-note"><p>' + (S.archive
          ? 'This season is archived. The thread stays readable and nothing can be added to it.'
          : 'This thread is locked. It stays readable and nothing can be added to it.') + '</p></div>';
      } else {
        compose.appendChild(replyBox(thread, first));
      }
      show(compose, true);
    }
    wirePosts(host, thread, posts, readOnly);
  }

  function postHTML(p, readOnly, isFirst) {
    var mine = p.by === S.me.handle;
    var up = Number(p.up) || 0, down = Number(p.down) || 0;
    var net = up - down;
    var v = Number(S.votes[p.id]) || 0;
    var n = Number(p.n) || 0;
    var out = '<li class="oa-forum-post' + (isFirst ? ' is-first' : '') + '" id="p' + n + '" data-pid="' + esc(p.id) + '" data-n="' + n + '">';
    out += '<div class="oa-forum-vote">';
    if (!readOnly) {
      out += '<button type="button" class="oa-forum-v up" data-v="1" aria-pressed="' + (v === 1 ? 'true' : 'false') + '" ' +
        'aria-label="Like this post"' + (mine ? ' disabled title="You cannot vote on your own post"' : '') + '>&#9650;</button>';
    }
    out += '<b class="oa-forum-score" title="' + plural(up, 'like', 'likes') + ', ' + plural(down, 'dislike', 'dislikes') + '">' + (net > 0 ? '+' : '') + net + '</b>';
    if (!readOnly) {
      out += '<button type="button" class="oa-forum-v down" data-v="-1" aria-pressed="' + (v === -1 ? 'true' : 'false') + '" ' +
        'aria-label="Dislike this post"' + (mine ? ' disabled title="You cannot vote on your own post"' : '') + '>&#9660;</button>';
    }
    out += '<span class="oa-forum-updown">' + up + ' / ' + down + '</span>';
    out += '</div><div class="oa-forum-pbody">';
    if (p.hidden) {
      out += '<p class="oa-forum-removed">' + (p.hiddenBy === 'author'
        ? 'This ' + (isFirst ? 'post' : 'reply') + ' was deleted by its author.'
        : 'This ' + (isFirst ? 'post' : 'reply') + ' was removed.') + '</p>';
    } else {
      if (p.quote && p.quote.text) {
        out += '<blockquote class="oa-forum-quote"><cite><span class="oa-forum-handle">' + esc(p.quote.by) + '</span> wrote in ' +
          '<a href="#p' + (Number(p.quote.n) || 0) + '">#' + (Number(p.quote.n) || 0) + '</a></cite><p>' + esc(p.quote.text) + '</p></blockquote>';
      }
      out += '<div class="oa-forum-text">' + bodyHTML(p.body) + '</div>';
    }
    out += '<div class="oa-forum-pfoot"><div class="oa-forum-pacts">';
    if (!readOnly && !p.hidden) {
      out += '<button type="button" class="oa-forum-act" data-act="reply">Reply</button>';
      out += '<button type="button" class="oa-forum-act" data-act="quote">Quote</button>';
    }
    out += '<a class="oa-forum-act" href="' + esc(href({ room: S.room, season: S.season, t: S.tid, hash: 'p' + n })) + '" title="A link to this post">#' + n + '</a>';
    if (!readOnly && !p.hidden && mine) {
      var left = Number(p.t) + M.EDIT_WINDOW_MS - Date.now();
      if (left > 0) {
        out += '<button type="button" class="oa-forum-act" data-act="edit">Edit · ' + Math.max(1, Math.ceil(left / 60000)) + ' min left</button>';
      }
      /* No window on this one: your own words are yours to take back whenever
         you like (owner, 2026-09-05). */
      out += '<button type="button" class="oa-forum-act is-del" data-act="delete">Delete</button>';
    }
    out += '</div><div class="oa-forum-who">' +
      '<span class="oa-forum-handle' + (mine ? ' is-me' : '') + '">' + esc(p.by) + '</span>' +
      '<span title="' + esc(stamp(p.t)) + '">' + (isFirst ? 'asked ' : 'replied ') + esc(ago(p.t)) + '</span>' +
      (p.editedAt ? '<span title="' + esc(stamp(p.editedAt)) + '">edited</span>' : '') +
      '</div></div></div></li>';
    return out;
  }

  function wirePosts(host, thread, posts, readOnly) {
    var byId = {};
    posts.forEach(function (p) { byId[p.id] = p; });
    Array.prototype.forEach.call(host.querySelectorAll('.oa-forum-post'), function (li) {
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
        });
      });
    });
  }

  /* Deleting is not a one-way door anywhere else on this site; here it is,
     and the confirmation says so rather than asking a bare "are you sure".
     The opening post of a thread nobody has replied to takes the thread with
     it, so the wording differs and the page goes back to the list. */
  function deletePost(thread, p, btn) {
    var isFirst = Number(p.n) === 1;
    var alone = isFirst && Number((thread && thread.n) || 0) <= 1;
    var msg = alone
      ? 'Delete this question? Nobody has replied, so the whole thread goes. The words cannot be brought back.'
      : (isFirst
          ? 'Delete your question? The replies stay and the thread keeps its place, but your words and the title go, and they cannot be brought back.'
          : 'Delete this reply? Its place in the thread stays so the numbering still reads, but the words go, and they cannot be brought back.');
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
    if (S.archive) return;
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

  /* --------------------------------------------------- the reply box */

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

  var WARN = '<div class="oa-forum-warn"><strong>Read it once more for anything that identifies you.</strong> ' +
    'Your name, your school, your advisor, a paper title, an unusual detail of your case. Nobody can see who is behind a handle, but the words themselves can give you away. ' +
    'You can edit it for fifteen minutes, and delete it at any time.</div>';

  function replyBox(thread, first) {
    var wrap = el('div', { class: 'oa-forum-compose', id: 'oa-forum-reply' });
    wrap.innerHTML =
      '<h2>Your reply <span class="oa-forum-as">as <span class="oa-forum-handle is-me">' + esc(S.me.handle) + '</span></span></h2>' +
      '<div class="oa-forum-quotebox" id="oa-forum-quotebox" hidden></div>' +
      '<div class="oa-forum-editor">' +
        '<textarea id="oa-forum-body" rows="6" maxlength="' + M.BOUNDS.body + '" placeholder="Write your reply. Plain text, a few paragraphs at most." aria-label="Your reply"></textarea>' +
        '<div class="oa-forum-bar">' +
          '<button type="button" class="oa-forum-send" id="oa-forum-send">Post reply</button>' +
        '</div>' +
      '</div>' +
      acceptBox('oa-forum-accept') +
      '<p class="oa-forum-guardmsg" id="oa-forum-guardmsg" aria-live="polite"></p>' +
      '<p class="oa-forum-msg" id="oa-forum-msg" aria-live="polite"></p>' +
      WARN;
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
    if (!m) { if (msg) window.alert(msg); return; }
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
    text.insertAdjacentElement('afterend', box);
    var ta = box.querySelector('textarea');
    var guard = box.querySelector('.oa-forum-guardmsg');
    ta.addEventListener('input', function () { liveGuard(ta, guard); });
    box.querySelector('[data-edit="cancel"]').addEventListener('click', function () {
      box.remove();
      text.hidden = false;
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
          '<p class="oa-forum-hint" id="oa-forum-taghint">Up to five. Pick existing tags where you can; a new tag is fine if none fits. Tags are set when the question is asked.</p></div>' +
        acceptBox('oa-forum-ask-accept') +
        WARN +
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
    var TAGHINT = ($('oa-forum-taghint') || {}).textContent || '';
    function tagHint(msg) {
      var h = $('oa-forum-taghint');
      if (h) h.textContent = msg || TAGHINT;
    }
    function add(raw) {
      var s = M.slug(raw);
      /* A BANNED SLUG SAYS WHY. Dropping it in silence below, with the rest
         of what add() refuses, would read as a broken box; this is the one
         refusal here a poster has to be told the reason for, because the
         reason is a house rule and not a typo. */
      if (s && M.TAG_BANNED.indexOf(s) !== -1) {
        tagHint('There is no tag for a rumour: rumours and unverified stories are not posted here (rule 5 of the forum guide).');
        input.value = '';
        drawSugg();
        return;
      }
      if (!s || !M.tagOk(s) || tags.indexOf(s) !== -1 || tags.length >= M.TAG_MAX) { input.value = ''; drawSugg(); return; }
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
    input.addEventListener('input', drawSugg);
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
