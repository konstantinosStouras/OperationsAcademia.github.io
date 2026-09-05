/* ---------------------------------------------------------------------------
   Operations Academia: instant publish, the visit resolver, and the
   verification mailer.

   SIX functions live in this file: four doorbells (publishOnChange,
   publishOnCandidateChange, publishOnReview, and the clock, revealCandidates),
   the university-visit resolver (recordVisit), and the e-mail verification
   mailer (sendVerificationEmail, set up in _SETUP-EMAIL-VERIFICATION.md). A
   deploy lists all six, and
   reading that count back is how a deploy from a stale checkout is caught.

   FOUR doorbells, one job each. When a job posting changes in Firestore,
   start the GitHub build that publishes it, so a new posting or an edit
   reaches the site in about a minute instead of waiting for the 20-minute
   schedule; when a CANDIDATE PROFILE changes, start the same build — it runs
   build-candidates.mjs too, and once the reveal instant has passed a new
   profile is public information the moment it is posted (before it, the
   build's own reveal gate still writes nothing, so ringing early costs
   nothing and leaks nothing);
   when the maintainer APPROVES a posting from the review queue, start the
   sheet read that publishes it, which is a different workflow because
   data/jobmarket.json holds the approved rows and only that job writes it.
   Approving is an act with an expectation attached — it used to sit invisible
   for up to half an hour, and then up to twenty minutes more while it waited
   for the build that merges the file it had just written; and
   at 14:00 UTC EVERY DAY (`revealCandidates`, a scheduled function rather
   than a Firestore trigger), read the site's own candidates-reveal.json and,
   when today is the reveal day, ring the same build, so the profiles go
   public at the instant the site names rather than at the build's next
   scheduled tick. The build's :07/:27/:47 schedule stays the safety net: if
   this ring is lost the reveal lands at 14:07 at worst. It is deliberately
   NOT a GitHub cron at 14:00 as well: two producers for one event is the
   duplicate-doorbell outage CLAUDE.md records (One event, one build).

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
   Steps with screenshots: _SETUP-INSTANT-PUBLISH.md (repository root)
   --------------------------------------------------------------------------- */

'use strict';

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
/* MODULAR, because firebase-admin 14 removed the namespaced surface whole:
   `admin.apps`, `admin.firestore()` and `admin.firestore.FieldValue` are all
   undefined there: the breaking change the CLI's upgrade warning promised,
   and the one the load-time smoke test caught (FieldValue.increment would
   have thrown on the first ping, after a deploy that looked clean). */
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const nodemailer = require('nodemailer');
const { renderVerifyEmail, siteVerifyLink } = require('./verify-email.js');

const GH_DISPATCH_TOKEN = defineSecret('GH_DISPATCH_TOKEN');

/* The mailbox the verification e-mail is sent from: the same four names the
   scheduled mailers read from the repository's secrets, held here in Secret
   Manager (_SETUP-EMAIL-VERIFICATION.md). */
const SMTP_HOST = defineSecret('SMTP_HOST');
const SMTP_PORT = defineSecret('SMTP_PORT');
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');

const SITE = 'https://www.operationsacademia.org';
const CONTACT = 'operationsacademia@gmail.com';

/** The Admin app, initialised once whichever function touches it first. */
function adminApp() {
  if (!getApps().length) initializeApp();
}

const REPO = 'konstantinosStouras/OperationsAcademia.github.io';
const EVENT_TYPE = 'oa-jobs-changed';
const REVIEW_EVENT_TYPE = 'oa-jobreview-decided';

/** The states a CLIENT (poster or admin UI) leaves a document in. The build's
    own stamp is 'published' — never dispatch on that, or the build triggers
    itself for ever. */
const CLIENT_STATES = ['queued', 'withdrawn', 'hidden'];

/** One repository_dispatch POST — the whole of what every doorbell does once
    it has decided to ring. Shared so the four cannot drift. */
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

/* ------------------------------------------------------------- the reveal

   THE REVEAL IS AN INSTANT, NOT A DAY (owner, 2026-09-04). Profiles are held
   until 14:00 UTC on the day named in data/candidates-reveal.json (07:00 in
   Los Angeles, 22:00 in Shanghai, still that calendar day for every reader),
   and the build's reveal gate (revealGate in _scraper/candidates-model.mjs,
   a caller of assets/oa-reveal.js) writes the rows only from that instant.
   Nothing in Firestore changes at 14:00, so no document trigger can ring
   the build for it; this scheduled function does. It reads the SAME served
   file the build reads, and when today (UTC) is the reveal day it rings the
   SAME doorbell the document triggers ring, with the same helper.

   The served file is Pages-cached for ten minutes, so the URL is cache-busted
   and the fetch asks for no store; a date edited on the reveal morning may
   still read stale at 14:00, in which case the build's own :07/:27/:47
   schedule publishes at 14:07, the safety net this doorbell is not a
   replacement for. It logs why it rang or did not, so the day's function log
   answers "did the reveal fire" without guessing. */

const REVEAL_HOUR_UTC = 14;   // keep equal to REVEAL_HOUR_UTC in assets/oa-reveal.js
const REVEAL_FILE = 'https://www.operationsacademia.org/data/candidates-reveal.json';

exports.revealCandidates = onSchedule(
  {
    schedule: '0 14 * * *',
    timeZone: 'UTC',
    secrets: [GH_DISPATCH_TOKEN],
    region: 'us-central1',
    // a failed run is caught by the build's own schedule seven minutes later;
    // retrying could only ring twice for one reveal
    retryCount: 0,
  },
  async () => {
    const today = new Date().toISOString().slice(0, 10);
    let revealAt = '';
    try {
      const res = await fetch(`${REVEAL_FILE}?v=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'user-agent': 'operations-academia-functions' },
      });
      if (!res.ok) {
        logger.warn('reveal: could not read candidates-reveal.json', { http: res.status });
        return;
      }
      revealAt = String((await res.json()).revealAt || '').trim();
    } catch (err) {
      logger.warn('reveal: could not read candidates-reveal.json', { error: String(err) });
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(revealAt)) {
      logger.info('reveal: no date announced', { revealAt, today });
      return;
    }
    if (revealAt !== today) {
      logger.info('reveal: not today', { revealAt, today, hourUtc: REVEAL_HOUR_UTC });
      return;
    }
    await ring(EVENT_TYPE, { reason: 'reveal', revealAt }, 'reveal build dispatched');
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
    /* Only a TRANSITION into a decision rings. The sheet sync itself creates
       documents already approved (grandfathered rows) or rejected (an advert
       already on the site), and every one of those used to dispatch a sheet
       read plus a chained build — for a row that was never waiting. */
    const before = event.data && event.data.before && event.data.before.exists
      ? event.data.before.data() : null;
    if (before && before.status === after.status) {
      logger.debug('skip: already decided', { status: after.status });
      return;
    }

    await ring(REVIEW_EVENT_TYPE, { id: event.params.id, status: after.status },
      'sheet read dispatched');
  });

/* ===========================================================================
   E-MAIL VERIFICATION. The sixth function, and a mailer rather than a
   doorbell.

   A person who registers with an e-mail address and a password must press a
   link in a message before the account can be used (the rules read
   `email_verified` off the token, see verified() in _firestore.rules).
   Firebase sends a verification message of its own, but from a
   firebaseapp.com address, in its own template, landing on a Firebase-hosted
   page. This function sends the site's own message instead, rendered by
   ./verify-email.js in the live site's palette, from the site's own mailbox,
   and pointing at verify-email.html on the site.

   HOW IT IS CALLED. The browser's accounts module calls it as a callable
   (`sendVerificationEmail`) right after registration and from the "send the
   e-mail again" button. If the callable is unreachable, the browser falls
   back to Firebase's own `sendEmailVerification`, so nobody is stranded while
   this function is not yet deployed or is down.

   WHAT IT MUST NEVER DO. The link carries a one-time code that verifies the
   address for whoever presses it, so neither the link nor the code is ever
   logged; a log line names the account and a redacted address and nothing
   more. A message goes to the address on the TOKEN, never to an address the
   client sends, so nobody can have a verification link mailed to somebody
   else. The address must be unverified, or there is nothing to do.

   THE RATE LIMIT IS OURS. Firebase's own resend limits apply to messages it
   sends, not to links the Admin SDK generates, so this function keeps a small
   document per account, `verifyMail/{uid}` { sentAt, count, day }, and
   refuses a second message inside 90 seconds or a seventh in a UTC day. The
   collection is written by this function alone, with the Admin SDK; no
   client rule names it and the catch-all rule denies it.
   =========================================================================== */

const VERIFY_MIN_GAP_MS = 90 * 1000;
const VERIFY_DAY_MAX = 6;

/** `a***@example.org`: enough to recognise in a log, never enough to write to. */
function redact(email) {
  const m = String(email || '').trim().match(/^([^@]{1,2})[^@]*(@.*)$/);
  return m ? `${m[1]}***${m[2]}` : '***';
}

exports.sendVerificationEmail = onCall(
  {
    region: 'us-central1',
    secrets: [SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS],
    /* A bounded fan-out: this is pressed once or twice per registration, and
       a flood should shed load rather than run up a bill. */
    maxInstances: 5,
    timeoutSeconds: 30,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in first.');
    }
    const uid = request.auth.uid;
    const token = request.auth.token || {};
    const email = String(token.email || '').trim();
    if (!email) {
      logger.warn('verification refused', { uid, reason: 'no-address' });
      throw new HttpsError('failed-precondition',
        'This account has no e-mail address to verify.');
    }
    if (token.email_verified === true) {
      logger.warn('verification refused', { uid, reason: 'already-verified' });
      throw new HttpsError('failed-precondition', 'This address is already verified.');
    }

    adminApp();
    const db = getFirestore();
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    const limitRef = db.collection('verifyMail').doc(uid);

    /* The slot is RESERVED in a transaction before anything is sent. Read,
       check, send and then write would let ten calls fired in the same
       second all read the same stamp, all pass, and each send a message from
       the site's mailbox; a transaction makes the check and the stamp one
       step, so the second caller reads the first one's reservation. A send
       that then fails puts the previous stamp back (below), so a failed
       attempt is not counted against the person who presses again. */
    const slot = await db.runTransaction(async (tx) => {
      const before = (await tx.get(limitRef)).data() || {};
      const count = before.day === today ? Number(before.count || 0) : 0;
      if (typeof before.sentAt === 'number' && now - before.sentAt < VERIFY_MIN_GAP_MS) {
        return { refused: 'too-soon' };
      }
      if (count >= VERIFY_DAY_MAX) return { refused: 'daily-limit' };
      tx.set(limitRef, { sentAt: now, day: today, count: count + 1 });
      return { before };
    });
    if (slot.refused === 'too-soon') {
      logger.warn('verification refused', { uid, reason: 'too-soon' });
      throw new HttpsError('resource-exhausted',
        'A message went out a moment ago. Give it a minute and look again.');
    }
    if (slot.refused === 'daily-limit') {
      logger.warn('verification refused', { uid, reason: 'daily-limit' });
      throw new HttpsError('resource-exhausted',
        'That is enough messages for today. Try again tomorrow, and look in spam.');
    }
    /** Put the stamp back as it was before this call reserved its slot. The
        document is restored WHOLE, so a `campaignAt` the existing-accounts
        campaign (_scraper/verify-existing-users.mjs) stamped on it survives
        a failed send here: that mark means "mailed once by the campaign" and
        has nothing to do with this call's slot. */
    const releaseSlot = async () => {
      try {
        if (Object.keys(slot.before).length) await limitRef.set(slot.before);
        else await limitRef.delete();
      } catch (e) {
        logger.warn('rate-limit stamp not restored', { uid, error: e.code });
      }
    };

    /* Firebase mints the one-time code; the site's own page is what the
       reader lands on. The continueUrl is where that page sends them next. */
    let generated = '';
    try {
      generated = await getAuth().generateEmailVerificationLink(email, {
        url: SITE + '/account.html',
      });
    } catch (e) {
      logger.error('verification token not minted', { uid, error: e.code });
      await releaseSlot();
      throw new HttpsError('internal', 'The verification message could not be made.');
    }
    /* The code is cut out of the minted address and put on the site's own
       page by siteVerifyLink, the ONE definition shared with the campaign
       mailer for existing accounts (_scraper/verify-existing-users.mjs), so
       the two senders cannot build the link differently. */
    const link = siteVerifyLink(generated, SITE);
    if (!link) {
      logger.error('the minted address carried no verification token', { uid });
      await releaseSlot();
      throw new HttpsError('internal', 'The verification message could not be made.');
    }

    /* The greeting. The profile is written by the registration form in the
       same breath as the account, so it is usually there; a missing one only
       costs the first name. */
    let firstName = '';
    try {
      const prof = (await db.collection('profiles').doc(uid).get()).data() || {};
      firstName = String(prof.firstName || '').trim();
    } catch (e) {
      logger.warn('profile not read for the greeting', { uid, error: e.code });
    }

    const msg = renderVerifyEmail({ firstName, email, link, site: SITE, contact: CONTACT });
    const port = Number(SMTP_PORT.value() || 587);
    const transport = nodemailer.createTransport({
      host: SMTP_HOST.value().trim(),
      port,
      secure: port === 465,
      auth: { user: SMTP_USER.value().trim(), pass: SMTP_PASS.value() },
    });
    try {
      await transport.sendMail({
        from: `Operations Academia <${SMTP_USER.value().trim()}>`,
        to: email,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      });
    } catch (e) {
      /* The SMTP error's own message can quote the rejected recipient in full
         ("550 5.1.1 <name@example.org>: Recipient address rejected"), which
         would undo the redaction beside it. So the code and the response
         number are logged and the message text never is. */
      logger.error('verification e-mail not sent', {
        uid, to: redact(email), error: e.code, response: e.responseCode,
      });
      await releaseSlot();
      throw new HttpsError('internal', 'The message could not be sent.');
    }

    /* The slot was reserved before the send (the transaction above); a send
       that failed has just given it back, so only a message that really
       went out counts against the person. */
    logger.info('verification e-mail sent', { uid, to: redact(email) });
    return { sent: true, to: redact(email) };
  });

/* ====================================================================   WHICH UNIVERSITY A VISITOR CAME FROM — the fourth function, and one of the
   two here that are not doorbells.
=======
   WHICH UNIVERSITY A VISITOR CAME FROM: the fifth function, and one of the
   two here that are not doorbells.

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

   LIVE SINCE 2026-08-30, and its road here is worth the paragraph: the three
   doorbells above went live on 2026-08-27, but the 2026-08-29 deploy was made
   from a checkout that PREDATED this file, so it printed "Deploy complete!"
   while the three skipped as unchanged and this function was not in the
   upload at all — a deploy from a stale checkout looks exactly like a
   successful one. The 2026-08-30 deploy, from a pulled checkout, shipped all
   four. If the collection ever reads empty again, check the deploy's
   per-function lines before the code.
   =========================================================================== */

/* `onRequest`, `getFirestore` and `FieldValue` are required at the top of the
   file with the rest of the Admin SDK, since the verification mailer above
   shares them. */
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
  adminApp();
  return getFirestore();
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
    const inc = FieldValue.increment(1);

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
