/* Feature announcements share an expiry: end of 15 November, Europe/London. */
(function (root) {
  'use strict';
  var expires = Date.parse('2026-11-16T00:00:00Z');
  // Registration window ends at midnight on 19 October in London (BST).
  var registrationCutoff = Date.parse('2026-10-18T23:00:00Z');
  function eligible(user, now) {
    if (!user || (now == null ? Date.now() : now) >= expires) return false;
    var created = Date.parse(user.metadata && user.metadata.creationTime || '');
    return !Number.isFinite(created) || created < registrationCutoff;
  }
  function refresh() {
    if (!root.document) return;
    var expired = Date.now() >= expires;
    root.document.documentElement.toggleAttribute('data-oa-new-expired', expired);
    var user = root.OAAccounts && root.OAAccounts.user ? root.OAAccounts.user() : null;
    root.document.querySelectorAll('[data-profile-analytics-new]').forEach(function (badge) { badge.hidden = !eligible(user); });
  }
  var api = { eligible: eligible, refresh: refresh, expires: expires };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document) {
    root.OAFeatureBadges = api; refresh();
    root.document.addEventListener('visibilitychange', refresh);
    root.setInterval(refresh, 60000);
  }
}(typeof window !== 'undefined' ? window : globalThis));
