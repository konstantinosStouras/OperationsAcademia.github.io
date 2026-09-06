/* ---------------------------------------------------------------------------
   A stand-in for the Firebase compat SDK, served in place of the real one by
   v2/_scraper/page-test.mjs.

   WHAT IT IS FOR, AND WHAT IT IS NOT. The account merge is the one part of
   this site that cannot be checked by looking at a page: it moves data between
   two accounts, in an order chosen so that a failure never loses anything, and
   the failure it guards against — an alert deleted before its copy landed, a
   job posting stranded under a sign-in that no longer exists — leaves no trace
   on screen. This shim makes that sequence OBSERVABLE: an in-memory Firestore
   and two auth sessions, with every operation appended to `window.__fb.log` in
   the order it was issued.

   It is deliberately NOT a Firebase emulator and proves nothing about Firebase
   itself — not the security rules (those are asserted from the rules file in
   selftest.mjs), not query semantics, not what a real popup does. It answers
   one question: given two accounts, does the merge write, hand over and delete
   the right things, in the right order.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  // The page asks for three compat bundles; all three are answered with this
  // file, so the second and third must be no-ops rather than a reset.
  if (window.__fb) return;

  var seed = window.__FAKE_FB || {};
  var docs = Object.create(null);          // "path/to/doc" -> plain object
  var log = [];

  window.__fb = {
    log: log,
    docs: docs,
    dump: function () { return JSON.parse(JSON.stringify(docs)); },
    ops: function (kind) {
      return log.filter(function (e) { return !kind || e.op === kind; })
                .map(function (e) { return e.path; });
    },
    /** Index of the first operation matching op+path substring, or -1. Used to
        assert ORDER, which is the whole point of the merge's design. */
    at: function (op, needle) {
      for (var i = 0; i < log.length; i++) {
        if (log[i].op === op && log[i].path.indexOf(needle) !== -1) return i;
      }
      return -1;
    }
  };

  function record(op, path, data) { log.push({ op: op, path: path, data: data || null }); }

  (seed.docs || []).forEach(function (d) { docs[d.path] = Object.assign({}, d.data); });

  /* ------------------------------------------------------------- firestore */

  /* `data()` answers a COPY, as the SDK does: a page that decorates what it
     read (the forum stamps `id` onto a thread it fetched) must not write into
     the store behind the shim's back, or a check over `__fb.docs` would see
     the page's own bookkeeping as a field the simulator wrote. */
  function snapOf(path) {
    var d = docs[path];
    return { id: path.split('/').pop(), exists: !!d, data: function () { return d ? Object.assign({}, d) : d; } };
  }

  function DocRef(path) {
    this.path = path;
    this.id = path.split('/').pop();
  }
  DocRef.prototype.collection = function (name) { return new Col(this.path + '/' + name); };
  DocRef.prototype.get = function () {
    record('get', this.path);
    return refusedRead(this.path) || Promise.resolve(snapOf(this.path));
  };
  /* Like the SDK: `merge` DEEP-merges (a nested map's keys are added to,
     not replaced — which is exactly why oa-jobreview writes `edits` with
     `mergeFields`, and the shim has to reproduce it or the browser check
     cannot see the difference); `mergeFields` replaces the named fields whole
     and leaves the rest of the document alone. */
  function deepMerge(into, from) {
    var out = Object.assign({}, into);
    Object.keys(from).forEach(function (k) {
      var v = from[k], had = out[k];
      out[k] = (v && typeof v === 'object' && !Array.isArray(v) &&
                had && typeof had === 'object' && !Array.isArray(had))
        ? deepMerge(had, v) : v;
    });
    return out;
  }
  DocRef.prototype.set = function (data, opts) {
    record('set', this.path, data);
    var had = docs[this.path];
    if (opts && opts.mergeFields && had) {
      var next = Object.assign({}, had);
      opts.mergeFields.forEach(function (k) { if (k in data) next[k] = data[k]; });
      docs[this.path] = next;
    } else if (opts && (opts.merge || opts.mergeFields) && had) {
      docs[this.path] = deepMerge(had, data);
    } else {
      docs[this.path] = Object.assign({}, data);
    }
    return Promise.resolve();
  };
  DocRef.prototype.update = function (patch) {
    record('update', this.path, patch);
    if (!docs[this.path]) return Promise.reject(new Error('not-found: ' + this.path));
    docs[this.path] = Object.assign({}, docs[this.path], resolveIncrements(docs[this.path], patch));
    return Promise.resolve();
  };
  DocRef.prototype.delete = function () {
    record('delete', this.path);
    delete docs[this.path];
    return Promise.resolve();
  };

  function childrenOf(prefix) {
    return Object.keys(docs)
      .filter(function (p) {
        return p.indexOf(prefix + '/') === 0 &&
               p.slice(prefix.length + 1).indexOf('/') === -1;
      })
      .sort();
  }

  /** What a QuerySnapshot answers with. The pages use `.docs`, `.size` and
      `.forEach` interchangeably (my-postings iterates, account.html counts),
      so the stand-in must carry all three or a page under test fails on a
      method the real SDK has. */
  function querySnap(snaps) {
    return {
      docs: snaps,
      size: snaps.length,
      empty: !snaps.length,
      forEach: function (fn) { snaps.forEach(fn); }
    };
  }

  /** A READ THE RULES WOULD REFUSE. `refuseReads: ['users/', 'jobSubmissions']`
      rejects any document read, list or query whose path begins with one of
      them, with the code and shape Firestore itself sends.

      It exists for a state no shim can reach any other way: in production a
      read of your own data is refused when the ID token the rules read still
      carries the claims the account had before it confirmed its address, and
      an account minutes old is exactly the one that has such a token. What
      the page must do about it is the same either way, which is what this
      lets a browser check drive. */
  function refusedRead(path) {
    var pre = seed.refuseReads || [];
    for (var i = 0; i < pre.length; i++) {
      if (String(path).indexOf(pre[i]) === 0) {
        return Promise.reject({ code: 'permission-denied',
          message: 'Missing or insufficient permissions.' });
      }
    }
    return null;
  }

  function Col(path) { this.path = path; }
  Col.prototype.doc = function (id) {
    // no id = mint one, as the real SDK does for `collection(x).doc()`
    if (id === undefined || id === null || id === '') {
      id = 'auto' + (Object.keys(docs).length + 1) + '_' + this.path.replace(/\//g, '_');
    }
    return new DocRef(this.path + '/' + id);
  };
  Col.prototype.add = function (data) {
    var id = 'auto' + (Object.keys(docs).length + 1);
    return new DocRef(this.path + '/' + id).set(data).then(function () {
      return new DocRef(this.path + '/' + id);
    }.bind(this));
  };
  Col.prototype.get = function () {
    record('list', this.path);
    return refusedRead(this.path) ||
      Promise.resolve(querySnap(childrenOf(this.path).map(snapOf)));
  };
  /* The queries the pages actually issue — where(==), orderBy, limit, get —
     chainable the way the compat SDK chains them. Grown for the Admin area
     checks (2026-08-23): the feedback inbox reads
     where('status').orderBy('createdAt').limit(n), which the old where-only
     stub answered with a TypeError. Still not an emulator: equality filters
     and one order key, which is every query in this repository's assets. */
  function Query(path, filters, sort, max) {
    this.path = path;
    this.__f = filters || [];
    this.__s = sort || null;
    this.__n = max || 0;
  }
  Query.prototype.where = function (field, op, value) {
    return new Query(this.path, this.__f.concat([[field, value]]), this.__s, this.__n);
  };
  Query.prototype.orderBy = function (field, dir) {
    return new Query(this.path, this.__f, [field, dir === 'desc' ? -1 : 1], this.__n);
  };
  Query.prototype.limit = function (n) {
    return new Query(this.path, this.__f, this.__s, n);
  };
  Query.prototype.get = function () {
    record('query', this.path + this.__f.map(function (f) {
      return '?' + f[0] + '==' + f[1];
    }).join(''));
    var no = refusedRead(this.path);
    if (no) return no;
    var snaps = childrenOf(this.path).map(snapOf);
    this.__f.forEach(function (f) {
      snaps = snaps.filter(function (s) { return s.data()[f[0]] === f[1]; });
    });
    if (this.__s) {
      var k = this.__s[0], dir = this.__s[1];
      snaps.sort(function (a, b) {
        var x = a.data()[k], y = b.data()[k];
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      });
    }
    if (this.__n) snaps = snaps.slice(0, this.__n);
    return Promise.resolve(querySnap(snaps));
  };
  Col.prototype.where = function (field, op, value) {
    return new Query(this.path, [[field, value]]);
  };
  Col.prototype.orderBy = function (field, dir) {
    return new Query(this.path).orderBy(field, dir);
  };
  Col.prototype.limit = function (n) {
    return new Query(this.path, [], null, n);
  };

  /* A write batch. Grown for the roster's broadcast (2026-08-24), which sends
     a message and its thread bookkeeping as ONE write: two sequential writes
     can half-fail, leaving the recipient holding a message the roster does not
     know about. Not a transaction — the real thing is atomic and this simply
     replays the calls in order on commit, which is all a test needs to observe
     that both documents land. `doc()` with no id mints one, as the SDK does. */
  function Batch() { this.__ops = []; }
  Batch.prototype.set = function (ref, data, opts) {
    this.__ops.push(function () { return ref.set(data, opts); });
    return this;
  };
  Batch.prototype.update = function (ref, patch) {
    this.__ops.push(function () { return ref.update(patch); });
    return this;
  };
  Batch.prototype['delete'] = function (ref) {
    this.__ops.push(function () { return ref['delete'](); });
    return this;
  };
  Batch.prototype.commit = function () {
    return this.__ops.reduce(function (chain, op) {
      return chain.then(op);
    }, Promise.resolve());
  };

  function firestoreFor() {
    return {
      collection: function (name) { return new Col(name); },
      batch: function () { return new Batch(); }
    };
  }
  /* `increment` is resolved at write time, as the server does: the roster's
     broadcast bumps an existing thread's unread count with it rather than
     re-stating a value read minutes earlier. */
  function Increment(n) { this.__inc = n; }
  function resolveIncrements(had, patch) {
    var out = Object.assign({}, patch);
    Object.keys(out).forEach(function (k) {
      if (out[k] instanceof Increment) out[k] = (typeof had[k] === 'number' ? had[k] : 0) + out[k].__inc;
    });
    return out;
  }
  firestoreFor.FieldValue = {
    serverTimestamp: function () { return '<serverTimestamp>'; },
    increment: function (n) { return new Increment(n); }
  };

  /* ------------------------------------------------------------------ auth */

  /* A user is VERIFIED unless the seed says otherwise: every existing check
     models a reader whose address is confirmed (a Google sign-in, say), and
     since the e-mail verification gate (2026-09-04) an unverified password
     account is signed out for everything but the "Check your inbox" card. To
     drive that gate, seed { emailVerified: false, providerData: [{ providerId:
     'password' }] }; `reloadVerifies` makes user.reload() confirm the address,
     which is what a real reload does once the link has been pressed. */
  function makeUser(spec, appName) {
    var u = Object.assign({ emailVerified: true, providerData: [{ providerId: 'google.com' }] }, spec);
    u.reload = function () {
      record('reload', u.uid);
      if (seed.reloadVerifies) u.emailVerified = true;
      return Promise.resolve();
    };
    u.getIdToken = function (force) {
      record('getIdToken', u.uid + (force ? ':force' : ''));
      return Promise.resolve('fake-id-token');
    };
    u.sendEmailVerification = function (opts) {
      record('sendEmailVerification', u.uid, opts || null);
      if (seed.sendVerificationFails) return Promise.reject({ code: seed.sendVerificationFails });
      return Promise.resolve();
    };
    u.delete = function () {
      record('deleteUser', u.uid);
      if (seed.deleteFails) return Promise.reject({ code: seed.deleteFails });
      var app = APPS[appName];
      app.__user = null;
      app.__fire();
      return Promise.resolve();
    };
    u.linkWithPopup = function () {
      record('link', u.uid);
      return Promise.resolve({ user: u });
    };
    u.reauthenticateWithPopup = function () {
      record('reauth', u.uid);
      return Promise.resolve({ user: u });
    };
    u.reauthenticateWithCredential = u.reauthenticateWithPopup;
    return u;
  }

  function Auth(appName) {
    this.__appName = appName;
    this.__cbs = [];
  }
  Auth.prototype.onAuthStateChanged = function (cb) {
    this.__cbs.push(cb);
    var app = APPS[this.__appName];
    setTimeout(function () { cb(app.__user || null); }, 0);
    return function () {};
  };
  Auth.prototype.signOut = function () {
    record('signOut', this.__appName);
    APPS[this.__appName].__user = null;
    APPS[this.__appName].__fire();
    return Promise.resolve();
  };
  Auth.prototype.setPersistence = function () { return Promise.resolve(); };
  Auth.prototype.signInWithPopup = function () { return this.__signIn('popup'); };
  Auth.prototype.signInWithEmailAndPassword = function () { return this.__signIn('password'); };
  Auth.prototype.createUserWithEmailAndPassword = function () { return this.__signIn('password'); };
  Auth.prototype.sendPasswordResetEmail = function () { return Promise.resolve(); };
  /* The verification link's code, applied by verify-email.html. Records the
     code so a check can see it was the one on the address, and refuses with
     whatever the seed names (auth/expired-action-code, auth/invalid-action-code). */
  Auth.prototype.applyActionCode = function (code) {
    record('applyActionCode', String(code));
    if (seed.applyActionCodeFails) return Promise.reject({ code: seed.applyActionCodeFails });
    return Promise.resolve();
  };
  Object.defineProperty(Auth.prototype, 'currentUser', {
    get: function () { var app = APPS[this.__appName]; return (app && app.__user) || null; }
  });
  Auth.prototype.__signIn = function (how) {
    var appName = this.__appName;
    record('signIn', appName + ':' + how);
    // The default app is the account already signed in; any OTHER app is the
    // second session a merge opens, i.e. the account being kept.
    // `signInUser` is who a sign-in THROUGH THE BOX produces on a page that
    // opened with nobody signed in (a signed-out reader pressing Sign in)
    var spec = appName === '[DEFAULT]' ? (seed.user || seed.signInUser) : (seed.keptUser || seed.user);
    if (seed.secondSignInFails && appName !== '[DEFAULT]') {
      return Promise.reject({ code: seed.secondSignInFails });
    }
    var u = makeUser(spec, appName);
    APPS[appName].__user = u;
    APPS[appName].__fire();
    /* The credential's own word for "this account did not exist a moment ago".
       Default FALSE: the accounts module redirects a new sign-up to the personal
       area and asks it for an affiliation, and neither belongs in the dozens of
       checks that sign an EXISTING reader in. `seed.newUser` opts in. */
    return Promise.resolve({ user: u, additionalUserInfo: { isNewUser: !!seed.newUser } });
  };

  /* ------------------------------------------------------------------ apps */

  var APPS = Object.create(null);

  function App(name, autoUser) {
    this.name = name;
    this.__auth = new Auth(name);
    this.__user = autoUser ? makeUser(seed.user, name) : null;
    APPS[name] = this;
  }
  App.prototype.auth = function () { return this.__auth; };
  App.prototype.firestore = function () { return firestoreFor(); };
  App.prototype.delete = function () {
    record('deleteApp', this.name);
    delete APPS[this.name];
    return Promise.resolve();
  };
  App.prototype.__fire = function () {
    var u = this.__user;
    this.__auth.__cbs.forEach(function (cb) { try { cb(u); } catch (e) {} });
  };

  /* --------------------------------------------------------- functions

     Two callers. sendVerificationEmail (the "Check your inbox" card) is
     recorded so a check can see it was tried FIRST, refused with whatever the
     seed names (functions/not-found is the shape of a function that is not
     deployed, the branch the card must fall back on: user.sendEmailVerification
     above), and otherwise answered with a canned receipt. With `noFunctions`
     the namespace has no functions() at all, which is the load-failure branch.

     THE FORUM'S SEVEN CALLABLES are simulated over `docs` (forumSim below), so
     the forum block in page-test.mjs can drive the page through a whole
     conversation without a Cloud Function: join, a question, a reply with a
     quote, an edit, a vote and the guide seed all land as documents the page
     then reads back through the same fake Firestore. It is a SIMULATOR, not
     the functions: it writes the shapes the page reads (the key lists in
     assets/oa-forum-model.js), refuses with the codes and reasons member.js
     answers with, and proves nothing about the real functions, which
     _functions/test/forum-emulator.mjs drives against the emulator. What it
     lets the browser suite measure is what the PAGE does with those answers,
     and that no uid, address or profile id reaches the markup. `seed.refuse`
     ({ forumPost: { code: 'resource-exhausted', reason: 'posts' } }) makes
     one callable refuse, for the refusal-wording checks. */
  var FORUM_NAMES = ['forumJoin', 'forumPost', 'forumEdit', 'forumDelete', 'forumAccept',
    'forumVote', 'forumThreadVotes', 'forumModerate'];
  var SIM_HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  var simN = 0;

  function simRefuse(code, reason) {
    var err = { code: 'functions/' + code, message: reason || code, details: { reason: reason } };
    return Promise.reject(err);
  }
  function simMinute() { return Math.floor(Date.now() / 60000) * 60000; }
  /* the season under way, the roll page-test.mjs itself computes (a July roll:
     getUTCMonth() is 0-based, so June is 5 and July 6) */
  function simSeason() {
    var d = new Date();
    return d.getUTCFullYear() + (d.getUTCMonth() >= 6 ? 1 : 0);
  }
  function simUser() {
    var app = APPS['[DEFAULT]'];
    return (app && app.__user) || null;
  }
  function simVerified(u) {
    var pd = (u && u.providerData) || [];
    var provider = pd.length && pd[0] && pd[0].providerId;
    return !!u && (u.emailVerified === true || (typeof provider === 'string' && provider !== 'password'));
  }
  function simAdmin(u) {
    return !!u && u.emailVerified === true && String(u.email || '').toLowerCase() === 'kstouras@gmail.com';
  }
  function simProfile(u, Y) {
    var best = null;
    childrenOf('candidateSubmissions').forEach(function (p) {
      var v = docs[p];
      if (!v || v.uid !== u.uid || Number(v.year) !== Y) return;
      if (v.status !== 'queued' && v.status !== 'published') return;
      if (!best) best = { id: p.split('/').pop(), data: v };
    });
    return best;
  }
  function simThreads(Y, room) { return 'forumSeasons/' + Y + '/rooms/' + room + '/threads'; }
  function simWrite(path, data) { docs[path] = Object.assign({}, data); record('set', path, data); }
  function simGuideText() {
    var g = window.OAForumGuide;
    try { if (g && typeof g.text === 'function') return g.text(); } catch (e) { /* fall through */ }
    return 'About this forum. Thirteen rules.';
  }
  function simSlug(s) {
    var m = window.OAForumModel;
    if (m && m.slug) return m.slug(s);
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  }

  /* whether this browser has accepted the guide in this simulated session:
     the handle document's guideAt, in the one form the sim needs */
  var simAccepted = false;

  function forumSim(name, data) {
    data = data || {};
    var u = simUser();
    if (!u) return simRefuse('unauthenticated', 'auth');
    if (seed.refuse && seed.refuse[name]) return simRefuse(seed.refuse[name].code, seed.refuse[name].reason);
    var Y = simSeason();
    var handle = seed.handle || 'quiet heron 42';
    var admin = simAdmin(u);
    var verified = simVerified(u);
    var profile = simProfile(u, Y);
    var rooms = { candidates: admin || !!profile, open: verified };
    var now = simMinute();

    if (name === 'forumJoin') {
      if (!verified) return simRefuse('permission-denied', 'verified');
      if (profile && !docs['candidateMarkers/' + u.uid]) {
        simWrite('candidateMarkers/' + u.uid, { sub: profile.id, year: Y, joinedAt: now });
      }
      if (!docs['forumSeasons/' + Y]) {
        simWrite('forumSeasons/' + Y, { season: Y, createdAt: now, secretVersion: 'env', guides: {} });
      }
      return Promise.resolve({ data: {
        season: Y, handle: handle, guideAt: seed.guideAt || 0, banned: false, rooms: rooms, rollsOn: Y + '-07-01'
      } });
    }

    var room = String(data.room || '');
    if (room !== 'candidates' && room !== 'open') return simRefuse('invalid-argument', 'room');
    if (name !== 'forumModerate' && !rooms[room]) {
      return simRefuse('permission-denied', room === 'open' ? 'verified' : 'candidate');
    }
    var threads = simThreads(Y, room);
    var guard = window.OAForumGuard;
    function bad(text) { return guard && guard.check ? guard.check(String(text || '')) : ''; }

    if (name === 'forumModerate') {
      if (!admin) return simRefuse('permission-denied', 'admin');
      if (data.op === 'seedGuide') {
        var head = docs['forumSeasons/' + Y] || { season: Y, createdAt: now, secretVersion: 'env', guides: {} };
        var gtid = 'sim-guide-' + room;
        /* a second press REFRESHES the pinned thread from the module rather
           than refusing, so the panel and the thread stay one text after the
           rules are edited (_functions/forum/moderate.js) */
        if (head.guides && head.guides[room]) {
          var seeded = head.guides[room];
          var gp = null;
          childrenOf(threads + '/' + seeded + '/posts').forEach(function (pp) { if (Number(docs[pp].n) === 1) gp = pp; });
          if (!gp) return simRefuse('not-found', 'thread');
          var fresh = simGuideText();
          if (docs[gp].body === fresh) return Promise.resolve({ data: { ok: true, tid: seeded, updated: false } });
          simWrite(gp, Object.assign({}, docs[gp], { body: fresh, editedAt: now }));
          return Promise.resolve({ data: { ok: true, tid: seeded, updated: true } });
        }
        simWrite(threads + '/' + gtid, {
          season: Y, room: room, title: 'About this forum', tags: ['about'], by: 'Moderator', t: now, lastAt: now,
          lastBy: 'Moderator', n: 1, excerpt: 'How this room works, in thirteen rules.', score: 0,
          accepted: '', pinned: true, locked: true, hidden: false
        });
        simWrite(threads + '/' + gtid + '/posts/' + gtid + '-p1', {
          season: Y, room: room, tid: gtid, n: 1, by: 'Moderator', body: simGuideText(), t: now,
          up: 0, down: 0, quote: null, hidden: false, hiddenBy: ''
        });
        var guides = Object.assign({}, head.guides || {});
        guides[room] = gtid;
        simWrite('forumSeasons/' + Y, Object.assign({}, head, { guides: guides }));
        return Promise.resolve({ data: { ok: true, tid: gtid } });
      }
      if (data.op === 'pin' || data.op === 'lock') {
        var tpath = threads + '/' + String(data.tid || '');
        if (!docs[tpath]) return simRefuse('not-found', 'thread');
        var patch = {};
        patch[data.op === 'pin' ? 'pinned' : 'locked'] = data.on !== false;
        simWrite(tpath, Object.assign({}, docs[tpath], patch));
        return Promise.resolve({ data: { ok: true, tid: data.tid } });
      }
      return simRefuse('invalid-argument', 'bounds');
    }

    if (name === 'forumPost') {
      var body = String(data.body || '').trim();
      if (!body || body.length > 4000) return simRefuse('invalid-argument', 'bounds');
      if (bad(body)) return simRefuse('invalid-argument', bad(body));
      /* the real forumPost refuses a member's FIRST post until the guide is
         accepted (failed-precondition {reason:'guide'}), so the simulator
         does too, or the page's accept box would be decoration here */
      if (!seed.guideAt && !simAccepted && data.acceptGuide !== true) return simRefuse('failed-precondition', 'guide');
      if (data.acceptGuide === true) simAccepted = true;
      var excerpt = body.replace(/\s+/g, ' ').slice(0, 200);
      if (!data.tid) {
        var title = String(data.title || '').trim();
        if (!title || title.length > 120) return simRefuse('invalid-argument', 'bounds');
        if (bad(title)) return simRefuse('invalid-argument', bad(title));
        var tags = Array.isArray(data.tags) ? data.tags.map(simSlug) : [];
        if (!tags.length || tags.length > 5) return simRefuse('invalid-argument', 'tags');
        var tid = 'sim-t' + (++simN);
        var pid1 = 'sim-p' + (++simN);
        simWrite(threads + '/' + tid, {
          season: Y, room: room, title: title, tags: tags, by: handle, t: now, lastAt: now, lastBy: handle,
          n: 1, excerpt: excerpt, score: 0, accepted: '', pinned: false, locked: false, hidden: false
        });
        simWrite(threads + '/' + tid + '/posts/' + pid1, {
          season: Y, room: room, tid: tid, n: 1, by: handle, body: body, t: now,
          up: 0, down: 0, quote: null, hidden: false, hiddenBy: ''
        });
        var tallyPath = 'forumTags/' + Y + '_' + room;
        var counts = Object.assign({}, (docs[tallyPath] || {}).counts || {});
        tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
        simWrite(tallyPath, { counts: counts });
        return Promise.resolve({ data: { tid: tid, pid: pid1, n: 1 } });
      }
      var tp = threads + '/' + String(data.tid);
      var thread = docs[tp];
      if (!thread) return simRefuse('not-found', 'thread');
      if (thread.locked || thread.hidden) return simRefuse('failed-precondition', 'locked');
      /* a thread whose QUESTION has gone is closed, however the head reads
         (_functions/forum/post.js) */
      var head1 = null;
      childrenOf(tp + '/posts').forEach(function (pp) { if (Number(docs[pp].n) === 1) head1 = docs[pp]; });
      if (!head1 || head1.hidden) return simRefuse('failed-precondition', 'locked');
      var quote = null;
      if (data.quote) {
        var qn = Number(data.quote.n);
        var qtext = String(data.quote.text || '').trim();
        var src = null;
        childrenOf(tp + '/posts').forEach(function (pp) { if (Number(docs[pp].n) === qn) src = docs[pp]; });
        if (!src || src.hidden || !qtext || qtext.length > 600 || String(src.body).indexOf(qtext) === -1) {
          return simRefuse('invalid-argument', 'quote');
        }
        quote = { n: qn, by: src.by, text: qtext };
      }
      var n = (Number(thread.n) || 0) + 1;
      var pid = 'sim-p' + (++simN);
      simWrite(tp + '/posts/' + pid, {
        season: Y, room: room, tid: data.tid, n: n, by: handle, body: body, t: now,
        up: 0, down: 0, quote: quote, hidden: false, hiddenBy: ''
      });
      simWrite(tp, Object.assign({}, thread, { n: n, lastAt: now, lastBy: handle }));
      return Promise.resolve({ data: { tid: data.tid, pid: pid, n: n } });
    }

    var tpath2 = threads + '/' + String(data.tid || '');
    var th = docs[tpath2];
    if (!th) return simRefuse('not-found', 'thread');

    /* the tick that says "this answered my question": the ASKER alone, one
       field on the thread, and an empty pid clears it (forum/accept.js) */
    if (name === 'forumAccept') {
      if (th.hidden) return simRefuse('failed-precondition', 'locked');
      if (th.by !== handle) return simRefuse('permission-denied', 'asker');
      var want = String(data.pid || '');
      if (want) {
        var ap = docs[tpath2 + '/posts/' + want];
        if (!ap) return simRefuse('not-found', 'thread');
        if (Number(ap.n) === 1 || ap.hidden) return simRefuse('failed-precondition', 'answer');
      }
      simWrite(tpath2, Object.assign({}, th, { accepted: want }));
      return Promise.resolve({ data: { accepted: want } });
    }

    if (name === 'forumThreadVotes') {
      var votes = {};
      childrenOf(tpath2 + '/posts').forEach(function (pp) {
        var vd = docs[pp + '/votes/' + SIM_HASH];
        if (vd) votes[pp.split('/').pop()] = vd.v;
      });
      return Promise.resolve({ data: { votes: votes } });
    }

    var ppath = tpath2 + '/posts/' + String(data.pid || '');
    var post = docs[ppath];
    if (!post) return simRefuse('not-found', 'thread');

    if (name === 'forumEdit') {
      if (post.by !== handle) return simRefuse('permission-denied', 'author');
      if (Date.now() >= Number(post.t) + 15 * 60 * 1000) return simRefuse('failed-precondition', 'window');
      var nb = String(data.body || '').trim();
      if (!nb || nb.length > 4000) return simRefuse('invalid-argument', 'bounds');
      if (bad(nb)) return simRefuse('invalid-argument', bad(nb));
      simWrite(ppath, Object.assign({}, post, { body: nb, editedAt: now }));
      return Promise.resolve({ data: { editedAt: now } });
    }

    /* the author's own post, no window, or ANY post for the maintainer. The
       body is erased and the slot kept; a QUESTION goes only when no reply is
       still standing, and takes the thread with it
       (_functions/forum/delete.js) */
    if (name === 'forumDelete') {
      if (th.hidden) return simRefuse('failed-precondition', 'locked');
      var isAdmin = String((seed.user && seed.user.email) || '').toLowerCase() === 'kstouras@gmail.com';
      if (!isAdmin && post.by !== handle) return simRefuse('permission-denied', 'author');
      var whole = false;
      /* already gone: a second press is a success, and for a QUESTION it
         finishes the job by shutting a thread left standing */
      if (post.hidden) {
        if (Number(post.n) === 1 && !th.hidden) {
          whole = true;
          simWrite(tpath2, Object.assign({}, th, { hidden: true }));
        }
        return Promise.resolve({ data: { ok: true, thread: whole } });
      }
      if (!post.hidden) {
        var question = Number(post.n) === 1;
        if (question && !isAdmin) {
          var live = Object.keys(docs).filter(function (k) {
            return k.indexOf(tpath2 + '/posts/') === 0 && docs[k] && !docs[k].hidden
              && Number(docs[k].n) !== 1;
          });
          if (live.length) return simRefuse('failed-precondition', 'answered');
        }
        simWrite(ppath, Object.assign({}, post, {
          body: '', hidden: true,
          hiddenBy: isAdmin && post.by !== handle ? 'admin' : 'author', editedAt: now
        }));
        /* the tick goes with the answer it named, as the function does */
        if (String(th.accepted || '') === String(data.pid || '')) {
          th = Object.assign({}, th, { accepted: '' });
          simWrite(tpath2, th);
        }
        if (question) {
          whole = true;
          simWrite(tpath2, Object.assign({}, th, { hidden: true }));
        }
      }
      return Promise.resolve({ data: { ok: true, thread: whole } });
    }

    if (name === 'forumVote') {
      if (th.locked || th.hidden) return simRefuse('failed-precondition', 'locked');
      if (post.by === handle) return simRefuse('failed-precondition', 'own');
      var v = Number(data.v) || 0;
      if (v !== 1 && v !== -1 && v !== 0) return simRefuse('invalid-argument', 'bounds');
      var vpath = ppath + '/votes/' + SIM_HASH;
      var old = docs[vpath] ? Number(docs[vpath].v) || 0 : 0;
      var du = (v === 1 ? 1 : 0) - (old === 1 ? 1 : 0);
      var dd = (v === -1 ? 1 : 0) - (old === -1 ? 1 : 0);
      var up = (Number(post.up) || 0) + du, down = (Number(post.down) || 0) + dd;
      simWrite(ppath, Object.assign({}, post, { up: up, down: down }));
      if (v === 0) { delete docs[vpath]; record('delete', vpath); }
      else simWrite(vpath, { v: v, t: now });
      if (Number(post.n) === 1) simWrite(tpath2, Object.assign({}, th, { score: (Number(th.score) || 0) + du - dd }));
      return Promise.resolve({ data: { up: up, down: down } });
    }
    return simRefuse('not-found', 'thread');
  }

  function functionsFor() {
    return {
      httpsCallable: function (name) {
        return function (data) {
          record('callable', String(name), data || null);
          if (seed.callableFails) {
            // `callableMessage` is what the function said, the way the SDK
            // hands it over on err.message (the throttle names its reason there)
            return Promise.reject({ code: seed.callableFails, message: seed.callableMessage || seed.callableFails });
          }
          if (FORUM_NAMES.indexOf(String(name)) !== -1) return forumSim(String(name), data);
          return Promise.resolve({ data: { sent: true, to: 'r***@example.edu' } });
        };
      }
    };
  }

  var firebase = {
    apps: [],
    initializeApp: function (config, name) {
      name = name || '[DEFAULT]';
      var app = new App(name, name === '[DEFAULT]' && !!seed.user);
      firebase.apps.push(app);
      return app;
    },
    app: function (name) {
      name = name || '[DEFAULT]';
      if (!APPS[name]) throw new Error('no-app: ' + name);
      return APPS[name];
    },
    auth: function (app) {
      return (app || APPS['[DEFAULT]'] || firebase.initializeApp({})).auth();
    },
    firestore: function () { return firestoreFor(); }
  };

  if (!seed.noFunctions) {
    firebase.functions = functionsFor;
    App.prototype.functions = functionsFor;
  }

  firebase.auth.GoogleAuthProvider = function () { this.providerId = 'google.com'; };
  firebase.auth.OAuthProvider = function (id) { this.providerId = id; };
  firebase.auth.EmailAuthProvider = { credential: function (e, p) { return { e: e, p: p }; } };
  firebase.auth.Auth = { Persistence: { NONE: 'none', LOCAL: 'local' } };
  firebase.firestore = firestoreFor;

  window.firebase = firebase;
})();
