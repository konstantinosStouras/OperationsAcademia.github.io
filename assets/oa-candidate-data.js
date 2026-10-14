/* Full profiles are returned only by an authenticated Firebase callable. */
(function () {
  'use strict';
  var epoch = 0, pendingPreview = null, privateRead = null, functionsReady = null;
  function functions() {
    if (!functionsReady) functionsReady = OAFB.readyFunctions().catch(function (error) {
      functionsReady = null;
      throw error;
    });
    return functionsReady;
  }
  // Share overlapping reads; a speculative response lives only in memory and
  // is consumed once. Never persist private profiles in browser storage.
  function readProfiles(account, warm) {
    var existing = privateRead;
    if (existing && existing.uid === account.uid &&
        (existing.pending || (existing.warm && Date.now() - existing.at < 10000))) {
      if (!warm) existing.warm = false;
      return existing.promise;
    }
    var entry = { uid: account.uid, pending: true, warm: !!warm, at: Date.now() };
    privateRead = entry;
    entry.promise = functions().then(function (fb) {
      if (!fb.auth().currentUser || fb.auth().currentUser.uid !== account.uid) return { data: { rows: [] } };
      return fb.app().functions('us-central1').httpsCallable('readCandidateProfiles')({});
    }).then(function (result) {
      entry.pending = false;
      return result;
    }, function (error) {
      if (privateRead === entry) privateRead = null;
      throw error;
    });
    return entry.promise;
  }
  if (window.OAAccounts) OAAccounts.onChange(function () { epoch++; });
  function user() {
    return window.OAAccounts && OAAccounts.resolved() ? OAAccounts.user() : null;
  }
  function previews() {
    if (pendingPreview) return pendingPreview;
    pendingPreview = fetch('/data/candidate-previews.json', { credentials: 'same-origin', cache: 'no-cache' })
      .then(function (res) { if (!res.ok) throw new Error('Candidate previews unavailable'); return res.json(); })
      .then(function (rows) {
        // Keep the signed-out contract even if an old cache contains extra keys.
        return (Array.isArray(rows) ? rows : []).map(function (row, i) {
          return { id: 'candidate-preview-' + (i + 1), year: row.year, affiliation: row.affiliation, previewOnly: true };
        });
      });
    var request = pendingPreview;
    request.then(function () { if (pendingPreview === request) pendingPreview = null; },
      function () { if (pendingPreview === request) pendingPreview = null; });
    return request;
  }
  function load() {
    var account = user();
    if (!account) return previews();
    var uid = account.uid, started = epoch;
    return readProfiles(account, false).then(function (result) {
      // Never admit a response that arrived after sign-out or an account switch.
      if (!user() || user().uid !== uid || epoch !== started) return [];
      var rows = result.data && Array.isArray(result.data.rows) ? result.data.rows : [];
      var targets = (result.data && result.data.previewTargets) || {};
      Object.keys(targets).forEach(function (previewId) {
        rows.forEach(function (row) { if (row.id === targets[previewId]) row.previewId = previewId; });
      });
      return rows;
    });
  }
  // Start the SDK and authenticated read alongside the account-profile check,
  // rather than waiting for that check and then downloading the Functions SDK.
  // OAAccounts still decides whether load() may return any private rows.
  if (window.OAFB && typeof OAFB.ready === 'function') {
    if (OAAccounts.hint && OAAccounts.hint() === 'in') functions().catch(function () {});
    OAFB.ready().then(function (fb) {
      var previous;
      fb.auth().onAuthStateChanged(function (account) {
        var next = account ? account.uid : '';
        if (next === previous) return;
        previous = next;
        privateRead = null;
        if (account && !account.isAnonymous) readProfiles(account, true).catch(function () {});
      });
    }).catch(function () {});
  }
  window.OACandidateData = { load: load, previews: previews };
}());
