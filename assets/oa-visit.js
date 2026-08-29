/* ---------------------------------------------------------------------------
   Operations Academia — one ping per session, so the site can say which
   universities read it.

   WHAT THIS SENDS: nothing. There is no body, no identifier, no cookie and no
   page path — the whole of the request is that it happened, and the only fact
   the other end takes from it is the network address the connection came
   from, which it turns into a university name and immediately forgets (see
   `recordVisit` in _functions/index.js). What is stored is a counter per day
   per university. It is the modern replacement for the reverse-DNS dimension
   Universal Analytics used to give this site for free, and the reason the
   "which universities visited" chart can be current again rather than an
   archive.

   ONCE PER SESSION, not once per page. The chart counts VISITS, and a reader
   who opens six postings made one visit. sessionStorage is the right memory
   for that — it is exactly a browsing session, it is not shared between tabs
   opened days apart, and it is never read back by anything.

   WHY IT IS ITS OWN FILE, AND NOT ON EVERY PAGE. `admin-area.html` does not
   load it, and that is a STRUCTURAL exclusion rather than a runtime check:
   the owner asked that no admin page and no archived tree feed the public
   figures, and a page that never runs the ping cannot be filtered wrongly by
   a rule that drifts. The archives at /v1/ and /v2/ carry their own frozen
   assets and never load this, so they are excluded the same way. The selftest
   pins both halves — every public page carries it, the admin desk does not.

   It runs on nothing: no dependency, no Firebase SDK, no listener left
   behind. A failure is silent by design — this is a statistic, and a reader
   must never wait on one or be told that one did not work.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* The deployed function's own URL. Region and project are pinned here
     rather than derived, because a wrong guess would post this site's traffic
     at somebody else's endpoint. */
  var ENDPOINT = 'https://us-central1-operations-academia.cloudfunctions.net/recordVisit';

  /* THE LIVE SITE ONLY. page-test.mjs opens every page in a real browser on
     every CI run, and without this each of those would file a visit
     indistinguishable from a reader's — the same guard, for the same reason,
     as the GA4 tag beside it. */
  var HOSTS = ['operationsacademia.org', 'www.operationsacademia.org'];
  if (HOSTS.indexOf(location.hostname) === -1) return;

  /* A refusal to be measured is honoured by NOT ASKING, never by asking and
     then behaving. The function checks the same headers itself, because a
     signal a server trusts the client to have obeyed is not being honoured. */
  var nav = navigator || {};
  if (nav.globalPrivacyControl === true || nav.doNotTrack === '1' ||
      window.doNotTrack === '1' || nav.msDoNotTrack === '1') return;

  try {
    if (sessionStorage.getItem('oaVisitPinged')) return;
    sessionStorage.setItem('oaVisitPinged', '1');
  } catch (e) {
    /* Storage refused — a private window, or site data blocked. Say nothing
       rather than ping on every page: an unbounded ping would count one
       reader as a dozen visits, which is a worse number than a missing one. */
    return;
  }

  try {
    fetch(ENDPOINT, {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',        // no cookies, in either direction
      keepalive: true,            // survives the reader navigating away
    }).catch(function () { /* undeployed, offline, blocked — all fine */ });
  } catch (e) { /* no fetch at all: an old browser simply is not counted */ }
}());
