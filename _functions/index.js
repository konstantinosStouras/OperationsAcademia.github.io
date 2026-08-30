/* ---------------------------------------------------------------------------
   Operations Academia — instant publish.

   THREE doorbells, one job each. When a job posting changes in Firestore,
   start the GitHub build that publishes it, so a new posting or an edit
   reaches the site in about a minute instead of waiting for the 20-minute
   schedule; when a CANDIDATE PROFILE changes, start the same build — it runs
   build-candidates.mjs too, and once the reveal date has passed a new profile
   is public information the moment it is posted (before the date, the
   build's own reveal gate still writes nothing, so ringing early costs
   nothing and leaks nothing); and
   when the maintainer APPROVES a posting from the review queue, start the
   sheet read that publishes it, which is a different workflow because
   data/jobmarket.json holds the approved rows and only that job writes it.
   Approving is an act with an expectation attached — it used to sit invisible
   for up to half an hour, and then up to twenty minutes more while it waited
   for the build that merges the file it had just written.

   It deliberately does NOT build, e-mail, or touch Drive — the scheduled
   build owns all of that and is already idempotent. This is a doorbell, not a
   second pipeline: everything it triggers would also have happened on the next
   scheduled run, so a lost event costs at most 20 minutes, and a duplicate
   event costs nothing (the workflow's concurrency group holds one running and
   one pending run; further dispatches coalesce into the pending one).

   THE LOOP THIS MUST NOT CREATE. The build WRITES to these same documents —
   stamping status 'published', attaching the Drive link. If every write
   dispatched, build -> write -> dispatch -> build would cycle for ever. The
   guard is the status field: a client leaves a posting in 'queued',
   'withdrawn' or 'hidden' (the states the security rules allow it to set, or
   the admin path uses), while ONLY the build sets 'published'. So a write is
   dispatched exactly when its AFTER state is one a client produces.

   Setup (one-off):
     1. A fine-grained GitHub PAT, repo OperationsAcademia.github.io only,
        permission "Contents: read and write" — nothing else.
     2. firebase functions:secrets:set GH_DISPATCH_TOKEN   (paste the PAT)
     3. firebase deploy --only functions
   Steps with screenshots: v2/_SETUP-INSTANT-PUBLISH.md
   --------------------------------------------------------------------------- */

'use strict';

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

const GH_DISPATCH_TOKEN = defineSecret('GH_DISPATCH_TOKEN');

const REPO = 'konstantinosStouras/OperationsAcademia.github.io';
const EVENT_TYPE = 'oa-jobs-changed';
const REVIEW_EVENT_TYPE = 'oa-jobreview-decided';

/** The states a CLIENT (poster or admin UI) leaves a document in. The build's
    own stamp is 'published' — never dispatch on that, or the build triggers
    itself for ever. */
const CLIENT_STATES = ['queued', 'withdrawn', 'hidden'];

/** One repository_dispatch POST — the whole of what every doorbell does once
    it has decided to ring. Shared so the three cannot drift. */
async function ring(eventType, payload, okLine) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${GH_DISPATCH_TOKEN.value().trim()}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'operations-academia-functions',
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  });

  if (res.status === 204) {
    logger.info(okLine, payload);
  } else {
    // 401: the PAT is wrong or expired (fine-grained PATs default to 30-day
    // expiry — set a long one deliberately). 404: the PAT cannot see the
    // repo. Either way the scheduled build still publishes within 20 min.
    logger.error('dispatch refused', { http: res.status, body: await res.text() });
  }
}

exports.publishOnChange = onDocumentWritten(
  {
    document: 'jobSubmissions/{id}',
    secrets: [GH_DISPATCH_TOKEN],
    region: 'us-central1',
    // A missed event is caught by the 20-minute schedule; retrying a failed
    // dispatch could pile up against a GitHub outage for nothing.
    retry: false,
  },
  async (event) => {
    const after = event.data && event.data.after && event.data.after.exists
      ? event.data.after.data() : null;

    /* A delete: the served row is deliberately preserved by the build (see
       build-jobs.mjs on orphans), so there is nothing to publish faster. */
    if (!after) return;

    if (!CLIENT_STATES.includes(after.status)) {
      logger.debug('skip: build bookkeeping', { status: after.status });
      return;
    }

    await ring(EVENT_TYPE, { id: event.params.id, status: after.status },
      'build dispatched');
  });

/* ------------------------------------------------------------- candidates */

exports.publishOnCandidateChange = onDocumentWritten(
  {
    document: 'candidateSubmissions/{id}',
    secrets: [GH_DISPATCH_TOKEN],
    region: 'us-central1',
    retry: false,
  },
  async (event) => {
    const after = event.data && event.data.after && event.data.after.exists
      ? event.data.after.data() : null;
    if (!after) return;

    /* Same guard, same loop it must not create: build-candidates stamps
       'published' (and 'removed'), so only the states a client leaves ring
       the bell. Before the reveal date this dispatch is a no-op by
       construction — the build's revealGate writes no row — and after it, a
       new profile (or an edit, or a withdrawal) is on the site in about a
       minute, which is what makes "posted immediately once public" true. */
    if (!CLIENT_STATES.includes(after.status)) {
      logger.debug('skip: build bookkeeping', { status: after.status });
      return;
    }

    await ring(EVENT_TYPE, { id: event.params.id, status: after.status },
      'candidate build dispatched');
  });

/* --------------------------------------------------------------- approvals */

/** The states a decision leaves a queued posting in. `pending` is what the
    sheet read itself writes when it queues a row, so dispatching on it would
    have the sync trigger itself for ever — the same guard, and the same
    reason, as CLIENT_STATES above. A rejection is dispatched too: it takes a
    posting that was entered approved (the ones already public when the gate
    arrived) back off the site, and that should be as prompt as publishing. */
const DECIDED_STATES = ['approved', 'rejected'];

exports.publishOnReview = onDocumentWritten(
  {
    document: 'jobReviews/{id}',
    secrets: [GH_DISPATCH_TOKEN],
    region: 'us-central1',
    retry: false,
  },
  async (event) => {
    const after = event.data && event.data.after && event.data.after.exists
      ? event.data.after.data() : null;
    if (!after) return;

    if (!DECIDED_STATES.includes(after.status)) {
      logger.debug('skip: not a decision', { status: after.status });
      return;
    }

    await ring(REVIEW_EVENT_TYPE, { id: event.params.id, status: after.status },
      'sheet read dispatched');
  });

/* ===========================================================================
   WHICH UNIVERSITY A VISITOR CAME FROM — the fourth function, and the only
   one here that is not a doorbell.

   THE CHART THIS RESTORES, AND THE CLAIM IT CORRECTS. analytics.html used to
   show "which universities visited", measured from Universal Analytics'
   `networkDomain` — a reverse-DNS lookup of the visitor's IP, so a reader on
   their university's network resolved to `ox.ac.uk`, `mit.edu`, `nus.edu.sg`.
   GA4 removed that dimension and offers nothing in its place, which is true;
   from it the conclusion was drawn, and the owner was told, that the figures
   could never be shown again. That was wrong, and the owner said so.

   What is true is that a BROWSER cannot see its own reverse-DNS. Nothing says
   it has to: this site has Cloud Functions, and anything server-side sees the
   address the connection came from. So the site does for itself exactly what
   UA used to do for it — and rather better, because the answer is checked
   against the site's OWN curated directory of operations departments rather
   than against whatever string an ISP happens to publish.

   THE IP IS NEVER STORED. That is the shape of the thing, not a promise: the
   address is resolved in memory, the university name is kept, and everything
   else goes out of scope when the request ends. What reaches Firestore is a
   COUNTER per day per university — no identifier, no cookie, no per-visitor
   row, consistent with the cookieless posture the rest of the analytics runs
   under (see assets/oa-ga4.js). A day document is
   `universityVisits/{YYYY-MM-DD}`, admin-read and admin-written only; the
   deployed rules deny every client, and only the Admin SDK — this function
   and the nightly build — ever touches it.

   IT COUNTS WHAT IT COULD NOT NAME, and that is what makes the chart honest.
   Reverse DNS in 2026 resolves far less often than it did in 2014: many
   campuses now egress through a commercial CDN or a cloud VPN, and a great
   deal of reading happens on phones. So every ping increments `seen`,
   whether or not anything came back — the page divides by it and says what
   share of visits it could place. Without that denominator a thin chart would
   read as "no universities visit", which is precisely the misreading the rest
   of this page was rebuilt to prevent.

   NOTHING HERE IS LIVE UNTIL THIS FUNCTION IS DEPLOYED, and it is the one in
   this file that is not. The three doorbells above went live on 2026-08-27;
   the deploy of 2026-08-30 listed those three and never mentioned a fourth,
   because it ran from a clone that predated this function — a stale checkout
   deploys the stale set and still prints "Deploy complete!". One
       firebase deploy --only functions --project operations-academia
   FROM AN UP-TO-DATE CHECKOUT switches it on; read the deployed list back
   against this file afterwards. Until then the browser's ping simply fails,
   the collection stays empty, and the page says the figures are not being
   collected yet rather than drawing an empty chart.
   =========================================================================== */

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const dns = require('node:dns');

/* Both VENDORED by _scraper/build-netmap.mjs, because `firebase deploy` ships
   only this directory: a deployed function cannot require ../assets. The
   selftest pins the copies against their sources byte-for-byte, so a drifted
   copy fails the build rather than resolving visitors against a stale map. */
const netorg = require('./netorg.js');
const UNI_DOMAINS = require('./university-domains.json');

/** The only origins whose pages may ring this. A request from anywhere else
    is answered 204 and does nothing — the figure is about this site's
    readers, and an endpoint any page could call is an endpoint any page could
    fill with noise. */
const VISIT_ORIGINS = [
  'https://operationsacademia.org',
  'https://www.operationsacademia.org',
];

/** A reverse lookup that cannot hold the request open. c-ares is given one
    try and a short timeout; the race is belt and braces, because a resolver
    that never answers at all would otherwise pin an instance for its full
    function timeout for a figure nobody is waiting on. */
const RESOLVE_MS = 2000;
async function reverseDns(ip) {
  const resolver = new dns.promises.Resolver({ timeout: RESOLVE_MS, tries: 1 });
  let timer = null;
  const lookup = resolver.reverse(ip).then((names) => (names && names[0]) || '');
  const bail = new Promise((resolve) => { timer = setTimeout(() => resolve(''), RESOLVE_MS + 250); });
  return Promise.race([lookup, bail])
    .catch(() => '')                       // ENOTFOUND: an address with no PTR
    .finally(() => clearTimeout(timer));
}

function visitsDb() {
  if (!admin.apps.length) admin.initializeApp();
  return admin.firestore();
}

exports.recordVisit = onRequest(
  {
    region: 'us-central1',
    cors: VISIT_ORIGINS,
    invoker: 'public',
    memory: '256MiB',
    /* A hard ceiling on what a flood can cost. The figure is best-effort by
       design, so shedding load is the right failure: a missed ping is one
       uncounted visit, where an uncapped fan-out is a bill. */
    maxInstances: 10,
    concurrency: 40,
    timeoutSeconds: 10,
  },
  async (req, res) => {
    res.set('cache-control', 'no-store');

    /* ALWAYS 204, WHATEVER HAPPENED. The response must tell the browser
       nothing about the visitor — not whether their network resolved, not
       whether this site has heard of their university — because a page that
       could read that back would have turned a private server-side lookup
       into a client-side one. It is also why the ping needs no reply. */
    const done = () => { res.status(204).send(''); };

    if (req.method === 'OPTIONS') return done();          // preflight, handled by cors
    if (req.method !== 'POST') return done();

    const origin = String(req.headers.origin || '');
    if (!VISIT_ORIGINS.includes(origin)) return done();

    /* Honoured here as well as in the browser. The page already declines to
       ping under Global Privacy Control or Do Not Track, and a signal a
       server ignores because it trusts the client to have obeyed it is not
       being honoured at all. */
    if (req.headers['sec-gpc'] === '1' || req.headers.dnt === '1') return done();

    const ip = netorg.clientIp(req.headers['x-forwarded-for']);
    if (!ip) return done();

    const host = await reverseDns(ip);
    /* `ip` is not referenced again, is written nowhere, and is not logged:
       the whole of what survives this line is `host`, and below it only the
       university that host belongs to. */

    const hit = netorg.classify(host, UNI_DOMAINS);
    const day = new Date().toISOString().slice(0, 10);
    const inc = admin.firestore.FieldValue.increment(1);

    /* The counters, and only counters.

         seen      every ping — the denominator the page reports against
         resolved  the ones DNS answered for AT ALL, an ISP included. It is
                   not what the caption divides by (that would read "29% came
                   from a university" over a figure that counts BT Broadband);
                   it is the diagnostic that tells a maintainer looking at a
                   thin chart whether reverse DNS is failing or the domain map
                   simply does not know those universities. Two very different
                   fixes, and nothing else on the page distinguishes them.
         academic  an academic network this site publishes no department page
                   for — a different fact from "not a university", and the
                   thing that would otherwise be invisible.
         unis      one tally per named university.

       A NESTED MAP, never a dotted field path. `unis['St. John's University']`
       as a path would be read as three fields, and this site's own directory
       carries names with full stops in them. set({merge:true}) deep-merges a
       map, so the key is taken literally. */
    const patch = { day, t: Date.now(), seen: inc };
    if (host) patch.resolved = inc;
    if (hit && hit.university) patch.unis = { [hit.university]: inc };
    else if (hit && hit.academic) patch.academic = inc;

    try {
      await visitsDb().collection('universityVisits').doc(day).set(patch, { merge: true });
    } catch (e) {
      /* Never surfaced and never retried: this is a statistic, and a visitor
         must not wait on it or learn that it failed. */
      logger.warn('visit not recorded', { error: e.message });
    }
    return done();
  });
