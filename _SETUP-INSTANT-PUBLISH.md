# Instant publish — setup

**What it does.** A posting created, edited, withdrawn or taken down appears on
the site in about a minute instead of at the next 20-minute build, and a
posting APPROVED in the review queue appears in about two. Candidate profiles
ring the same bell: once the reveal date has passed, a new profile is on the
site in about a minute too (before it, the build's reveal gate still writes
nothing, so the early ring costs nothing and leaks nothing). Three small Cloud
Functions in `_functions/index.js` ring a GitHub workflow's doorbell
(`repository_dispatch`):

| Function | Watches | Starts |
|---|---|---|
| `publishOnChange` | `jobSubmissions` | **OA data — publish queued postings** (`oa-jobs-changed`) |
| `publishOnCandidateChange` | `candidateSubmissions` | the same build (`oa-jobs-changed`) — it runs `build-candidates.mjs` too |
| `publishOnReview` | `jobReviews` | **OA jobs — read the job market tracking sheet** (`oa-jobreview-decided`), which the build then follows automatically |

An approval takes two workflows because `data/jobmarket.json` holds the
approved rows and only the sheet read writes it; `oa-jobs-build.yml` runs on
that workflow's completion, so the two are one chain rather than two waits.

The workflows themselves are unchanged and their schedules stay as the safety
net, so nothing is lost if the functions are down — changes just take up to 20
minutes again, and an approval up to half an hour.

**THESE THREE ARE LIVE.** They were deployed on 2026-08-27 and have dispatched
on every decision since. To check rather than trust: filter this repository's
Actions by `event:repository_dispatch` and read the ACTOR — the function
carries the PAT from step 1 and shows as a person, where the two verify
workflows' own curls carry `GITHUB_TOKEN` and show as `github-actions[bot]`.
`oa-jobreview-decided` has no other sender at all, so it is the cleanest of the
two to read.

**PATHS MOVED WITH THE PROMOTION.** The functions used to live in `v2/`; they
are at the repository root now, which is also where `firebase.json` is. A
`cd v2 && firebase deploy` — what the earlier version of this page told you to
do — deploys nothing, and the doorbell that was never deployed looks exactly
like a site that is simply slow.

**PULL BEFORE YOU DEPLOY, AND COUNT THE LINES.** `firebase deploy --only
functions` deploys what is in the working copy, so a clone a few commits behind
deploys the older set and reports success over it. That is not hypothetical:
the first run on 2026-08-30 printed `Deploy complete!` over three functions
when `_functions/index.js` on master held four — `recordVisit` (the
university-visits counter) was simply absent from that clone, and it exists
only because a second deploy the same day ran from a pulled checkout.
Read the deployed list back against `_functions/index.js` every time.

**NODE.JS 20 IS DECOMMISSIONED ON 2026-10-30, AND THE ANSWER NEEDS ONE MORE
DEPLOY.** `_functions/package.json` names Node 22 and current SDKs since
2026-08-30 (`firebase-functions` ^7.3.2; `firebase-admin` ^13.10.0 —
deliberately not 14, which removes the namespaced `admin.*` API `recordVisit`
uses), but a runtime changes only when a deploy carries it: run
`firebase deploy --only functions --project operations-academia` from a
checkout with this change BEFORE 2026-10-30, or after that date nothing here
deploys at all — an emergency fix included — until one succeeds. Read the
four functions back against `_functions/index.js` as always.

The **before/after e-mail** needs no setup beyond SMTP: it is sent by the
build itself, to `kstouras@gmail.com`, whenever an edit or a takedown was
published. Until the `SMTP_*` secrets are set the message is printed into the
build log instead of e-mailed, so the record still exists.

## 1. A GitHub token the function may ring the doorbell with

The function needs permission to fire a `repository_dispatch` event — nothing
more.

1. GitHub → your avatar → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Token name: `OA instant publish`.
3. **Expiration**: custom, one year (the maximum). Put a note in your calendar —
   when it expires the function logs `dispatch refused (401)` and the site
   silently falls back to the 20-minute schedule, which is easy not to notice.
4. **Repository access**: *Only select repositories* →
   `OperationsAcademia.github.io`.
5. **Permissions** → Repository permissions → **Contents: Read and write**.
   Nothing else. (This is the permission `repository_dispatch` requires.)
6. Generate, and copy the `github_pat_…` value.

## 2. Give it to the function as a secret

From the repository root:

```
firebase functions:secrets:set GH_DISPATCH_TOKEN --project operations-academia
```

Paste the PAT when prompted. The secret lives in Google Secret Manager, not in
any file.

## 3. Deploy the function

```
npm install --prefix _functions
firebase deploy --only functions --project operations-academia
```

This deploys EVERY function in `_functions/`, which is four: the three
doorbells above, and **`recordVisit`** — the university-visit resolver behind
the Analytics page's "which universities visited" chart, which needs no secret
and is inert until this command has been run (`_SETUP-ANALYTICS.md`, source 4).

Always pass `--project`: the CLI remembers an "active project" per directory,
and a deploy from this folder has already gone into another project's database
once (see CLAUDE.md).

First deploy asks to enable a few APIs (Cloud Functions, Cloud Build,
Artifact Registry, Eventarc) — say yes. It takes a few minutes.

## 4. Verify

Post or edit a job on the site, then look at
**Actions → OA data — publish queued postings**: a run should appear within a
few seconds whose trigger reads `repository_dispatch`. The posting is live
when that run finishes (~1 minute, plus Pages' propagation).

Then approve a posting in the review queue on `admin-area.html`: a run of
**OA jobs — read the job market tracking sheet** should appear the same way,
and a run of the publish workflow straight after it, triggered by
`workflow_run`.

Function logs, if needed:

```
firebase functions:log --project operations-academia
```

`build dispatched` / `sheet read dispatched` = working. `dispatch refused (401)` = the PAT expired or is
wrong — mint a new one and re-run step 2, then redeploy (step 3) so the
function picks the new secret version up.

## Why this never loops

The build writes to the same documents it reads (stamping `published`,
attaching the Drive link). The function dispatches **only** when a document's
new state is one a *client* produces — `queued`, `withdrawn`, `hidden` — and
never on the build's own `published` stamp. A build therefore cannot trigger
itself.

## Cost

Firestore triggers bill per invocation; this site's posting traffic is a few
events a day against a free tier of 2 million a month. Effectively zero.
