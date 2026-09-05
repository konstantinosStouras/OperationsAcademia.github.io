/* ---------------------------------------------------------------------------
   Operations Academia — Google Analytics 4.

   THE SITE HAS MEASURED NOTHING SINCE JULY 2023. The old Universal Analytics
   tag (assets/js/ypo-parakolouthisi.js, UA-47739718-1) is loaded only by the
   /v1/ and /v2/ archives; the live redesign carried no analytics tag at all,
   and UA stopped processing in any case. Worse, the spreadsheet that held
   2014–2023 was overwritten with empty results by its own add-on on
   2024-07-15, so that decade is gone for good. Every day without a tag is a
   day permanently lost — which is the whole argument for this file.

   IT RUNS COOKIELESS, AND THAT IS THE LOAD-BEARING DECISION (owner,
   2026-08-29: add GA4, but no consent banner).

   `client_storage: 'none'` tells gtag to keep NOTHING on the visitor's device
   — no `_ga` cookie, no localStorage, nothing. That matters because the
   ePrivacy rule a cookie banner exists to satisfy is about STORING things on
   someone's device, not about analytics as such: store nothing and there is
   nothing to ask permission for. It is what makes "GA4 without a banner"
   coherent rather than merely convenient.

   WHAT IT COSTS, STATED PLAINLY: with no identifier on the device, GA4 cannot
   tell a returning visitor from a new one, so its `totalUsers` is much closer
   to "sessions" than to "people". That is why SOURCE_ORDER in
   assets/oa-analytics-model.js puts the site's OWN first-party record ahead of
   GA4 for a day both measured — the first-party record keeps a stable
   per-browser id and can therefore count distinct visitors, which cookieless
   GA4 structurally cannot. GA4's value here is coverage (it sees visitors
   whose browser never reaches Firestore), not identity.

   TO TURN COOKIES BACK ON: set COOKIELESS to false below. Do that ONLY
   alongside a consent banner — it re-introduces the `_ga` cookie, and with it
   the consent requirement this file is shaped to avoid.

   Three further narrowings, none of which costs anything worth having:
     - Google signals and ad personalisation are OFF, so nothing here feeds
       advertising audiences or cross-device profiles;
     - a visitor asking not to be tracked (Global Privacy Control, or the
       older Do Not Track) is not tracked, and the script never loads;
     - it only ever runs on the real site. A page opened from a file, from
       localhost, or by the CI browser checks sends nothing — page-test.mjs
       loads every page in a real browser, and without this guard every CI run
       would post hits to the live property.

   INERT UNTIL CONFIGURED, the discipline every gated thing here follows: with
   MEASUREMENT_ID unset the file loads, does nothing, and says so to the
   console once. Setup: _SETUP-ANALYTICS.md
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* The `G-…` Measurement ID of the "Operations Academia - GA4" property.
     NOT the Property ID (384653143) — that is a different number, it belongs
     to the Data API, and it lives in the workflow rather than here. */
  var MEASUREMENT_ID = 'G-RE8C5LD2FM';

  /* Store nothing on the visitor's device. See the header — this is what
     stands in for a consent banner, not a preference. */
  var COOKIELESS = true;

  /* The only hosts that may report. A page served from anywhere else is a
     developer's copy or a test run, and its hits would be indistinguishable
     from real ones in the property for ever. */
  var HOSTS = ['operationsacademia.org', 'www.operationsacademia.org'];

  if (!MEASUREMENT_ID || MEASUREMENT_ID.indexOf('PASTE_') === 0) {
    /* deliberately quiet-but-visible: a maintainer opening the console should
       learn why there is no analytics, rather than assuming it is broken */
    if (window.console && console.info) {
      console.info('OA analytics: no Measurement ID set — see _SETUP-ANALYTICS.md');
    }
    return;
  }

  if (HOSTS.indexOf(location.hostname) === -1) return;

  /* Global Privacy Control is a machine-readable legal signal in several
     jurisdictions; Do Not Track is not, but honouring it costs one line and a
     handful of hits. Either one means we do not load gtag at all — not that we
     load it and ask it to behave, which would still contact Google. */
  try {
    if (navigator.globalPrivacyControl === true) return;
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
  } catch (e) { /* an old browser with neither — carry on */ }

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  /* The address reported for the page, without a one-time code. The
     verification link opens verify-email.html with its code on the query
     string, and gtag would otherwise send the whole address to Google before
     the page's own script has had a chance to scrub it. */
  function pageLocation() {
    try {
      if (/[?&]oobCode=/.test(location.search || '')) return location.origin + location.pathname;
    } catch (e) { /* nothing sane to do */ }
    return location.href;
  }

  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID, {
    page_location: pageLocation(),
    /* no identifier on the device — the whole point, see the header */
    client_storage: COOKIELESS ? 'none' : 'browser',
    /* and no advertising audiences or cross-device profiles built from it */
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    /* GA4 truncates IP addresses before storing them and offers no switch, so
       there is deliberately no `anonymize_ip` here: it is a Universal
       Analytics parameter, GA4 ignores it, and carrying it would imply this
       file had chosen something it did not. */
  });

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(MEASUREMENT_ID);
  document.head.appendChild(s);
}());
