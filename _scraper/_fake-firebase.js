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

  function snapOf(path) {
    var d = docs[path];
    return { id: path.split('/').pop(), exists: !!d, data: function () { return d; } };
  }

  function DocRef(path) {
    this.path = path;
    this.id = path.split('/').pop();
  }
  DocRef.prototype.collection = function (name) { return new Col(this.path + '/' + name); };
  DocRef.prototype.get = function () {
    record('get', this.path);
    return Promise.resolve(snapOf(this.path));
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
    return Promise.resolve(querySnap(childrenOf(this.path).map(snapOf)));
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
    var spec = appName === '[DEFAULT]' ? seed.user : (seed.keptUser || seed.user);
    if (seed.secondSignInFails && appName !== '[DEFAULT]') {
      return Promise.reject({ code: seed.secondSignInFails });
    }
    var u = makeUser(spec, appName);
    APPS[appName].__user = u;
    APPS[appName].__fire();
    return Promise.resolve({ user: u });
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

     The one callable the site makes (sendVerificationEmail, from the "Check
     your inbox" card). Records the name so a check can see it was tried
     FIRST, and refuses with whatever the seed names: functions/not-found is
     the shape of a function that is not deployed, which is the branch the
     card must fall back on (user.sendEmailVerification above). With
     `noFunctions` the namespace has no functions() at all, which is the
     load-failure branch. */
  function functionsFor() {
    return {
      httpsCallable: function (name) {
        return function (data) {
          record('callable', String(name), data || null);
          if (seed.callableFails) return Promise.reject({ code: seed.callableFails, message: seed.callableFails });
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
