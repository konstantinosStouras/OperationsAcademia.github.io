/* Full profiles are returned only by an authenticated Firebase callable. */
(function () {
  'use strict';
  var epoch = 0;
  if (window.OAAccounts) OAAccounts.onChange(function () { epoch++; });
  function user() {
    return window.OAAccounts && OAAccounts.resolved() ? OAAccounts.user() : null;
  }
  function previews() {
    return fetch('/data/candidate-previews.json', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('Candidate previews unavailable'); return res.json(); })
      .then(function (rows) {
        // Keep the signed-out contract even if an old cache contains extra keys.
        return (Array.isArray(rows) ? rows : []).map(function (row, i) {
          return { id: 'candidate-preview-' + (i + 1), year: row.year, affiliation: row.affiliation, previewOnly: true };
        });
      });
  }
  function load() {
    var account = user();
    if (!account) return previews();
    var uid = account.uid, started = epoch;
    return OAFB.readyFunctions().then(function (fb) {
      if (!user() || user().uid !== uid || epoch !== started) return { data: { rows: [] } };
      return fb.app().functions('us-central1').httpsCallable('readCandidateProfiles')({});
    }).then(function (result) {
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
  window.OACandidateData = { load: load, previews: previews };
}());
