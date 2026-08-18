/* ---------------------------------------------------------------------------
   Operations Academia — instant publish.

   TWO doorbells, one job each. When a job posting changes in Firestore, start
   the GitHub build that publishes it, so a new posting or an edit reaches the
   site in about a minute instead of waiting for the 20-minute schedule; and
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

    const res = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${GH_DISPATCH_TOKEN.value().trim()}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'operations-academia-functions',
      },
      body: JSON.stringify({
        event_type: EVENT_TYPE,
        client_payload: { id: event.params.id, status: after.status },
      }),
    });

    if (res.status === 204) {
      logger.info('build dispatched', { id: event.params.id, status: after.status });
    } else {
      // 401: the PAT is wrong or expired (fine-grained PATs default to 30-day
      // expiry — set a long one deliberately). 404: the PAT cannot see the
      // repo. Either way the scheduled build still publishes within 20 min.
      logger.error('dispatch refused', { http: res.status, body: await res.text() });
    }
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

    const res = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${GH_DISPATCH_TOKEN.value().trim()}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'operations-academia-functions',
      },
      body: JSON.stringify({
        event_type: REVIEW_EVENT_TYPE,
        client_payload: { id: event.params.id, status: after.status },
      }),
    });

    if (res.status === 204) {
      logger.info('sheet read dispatched', { id: event.params.id, status: after.status });
    } else {
      logger.error('dispatch refused', { http: res.status, body: await res.text() });
    }
  });
