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
  DocRef.prototype.set = function (data, opts) {
    record('set', this.path, data);
    docs[this.path] = (opts && opts.merge && docs[this.path])
      ? Object.assign({}, docs[this.path], data)
      : Object.assign({}, data);
    return Promise.resolve();
  };
  DocRef.prototype.update = function (patch) {
    record('update', this.path, patch);
    if (!docs[this.path]) return Promise.reject(new Error('not-found: ' + this.path));
    docs[this.path] = Object.assign({}, docs[this.path], patch);
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
  Col.prototype.doc = function (id) { return new DocRef(this.path + '/' + id); };
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
  Col.prototype.where = function (field, op, value) {
    var self = this;
    return {
      get: function () {
        record('query', self.path + '?' + field + op + value);
        return Promise.resolve(querySnap(
          childrenOf(self.path).map(snapOf)
            .filter(function (s) { return s.data()[field] === value; })));
      }
    };
  };

  function firestoreFor() {
    return { collection: function (name) { return new Col(name); } };
  }
  firestoreFor.FieldValue = { serverTimestamp: function () { return '<serverTimestamp>'; } };

  /* ------------------------------------------------------------------ auth */

  function makeUser(spec, appName) {
    var u = Object.assign({ providerData: [] }, spec);
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

  firebase.auth.GoogleAuthProvider = function () { this.providerId = 'google.com'; };
  firebase.auth.OAuthProvider = function (id) { this.providerId = id; };
  firebase.auth.EmailAuthProvider = { credential: function (e, p) { return { e: e, p: p }; } };
  firebase.auth.Auth = { Persistence: { NONE: 'none', LOCAL: 'local' } };
  firebase.firestore = firestoreFor;

  window.firebase = firebase;
})();
