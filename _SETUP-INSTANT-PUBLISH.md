# Instant publish — setup

**What it does.** A posting created, edited, withdrawn or taken down appears on
the site in about a minute instead of at the next 20-minute build, and a
posting APPROVED in the review queue appears in about two. Candidate profiles
ring the same bell: once the reveal instant has passed, a new profile is on the
site in about a minute too (before it, the build's reveal gate still writes
nothing, so the early ring costs nothing and leaks nothing). And the reveal
itself has a bell: at 14:00 UTC on the day named in `data/candidates-reveal.json`
the profiles go public, so a scheduled function rings the build at that hour
every day and does nothing on every day but that one. Four small Cloud
Functions in `_functions/index.js` ring a GitHub workflow's doorbell
(`repository_dispatch`):

| Function | Watches | Starts |
|---|---|---|
| `publishOnChange` | `jobSubmissions` | **OA data — publish queued postings** (`oa-jobs-changed`) |
| `publishOnCandidateChange` | `candidateSubmissions` | the same build (`oa-jobs-changed`) — it runs `build-candidates.mjs` too |
| `publishOnReview` | `jobReviews` | **OA jobs — read the job market tracking sheet** (`oa-jobreview-decided`), which the build then follows automatically |
| `revealCandidates` | the clock: 14:00 UTC daily (Cloud Scheduler), reading `data/candidates-reveal.json` | the same build (`oa-jobs-changed`), on the reveal day only |

The reveal function is deliberately the ONLY thing that rings at 14:00. There
is no GitHub cron at that hour, and one must not be added: the build's own
:07/:27/:47 schedule already catches a lost ring (the reveal then lands at
14:07 at worst), and two producers for one event is the duplicate-doorbell
outage CLAUDE.md records under "One event, one build".

An approval takes two workflows because `data/jobmarket.json` holds the
approved rows and only the sheet read writes it; `oa-jobs-build.yml` runs on
that workflow's completion, so the two are one chain rather than two waits.

The workflows themselves are unchanged and their schedules stay as the safety
net, so nothing is lost if the functions are down — changes just take up to 20
minutes again, and an approval up to half an hour.

**THE FIRST THREE ARE LIVE.** They were deployed on 2026-08-27 and have dispatched
on every decision since. `revealCandidates` (2026-09-04) rides along with the
next `firebase deploy --only functions` and is inert until that deploy has
run; read the count back (five) rather than trusting the deploy log. To check rather than trust: filter this repository's
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
the 2026-08-29 run printed `Deploy complete!` over three functions when
`_functions/index.js` on master held four — `recordVisit` (the
university-visits counter) was simply absent from that clone, and it exists
only because the 2026-08-30 deploy that followed ran from a pulled checkout.
Read the deployed list back against `_functions/index.js` every time.

**NODE.JS 20 IS DECOMMISSIONED ON 2026-10-30, AND THE ANSWER LANDED ON
2026-08-30.** `_functions/package.json` names Node 22 and current SDKs
(`firebase-functions` ^7.3.2; `firebase-admin` ^14.3.0 — a major that removes
the namespaced `admin.*` API, which is why `recordVisit` now uses the modular
one), and the deploy carrying them has run: `firebase functions:list` reports
**every function on `nodejs22`** (four at that deploy; five once
`revealCandidates` is deployed). Nothing is owed before the deadline,
but read the next paragraph before believing any FUTURE runtime change has
landed, because the deploy will not tell you.

**"Skipped (No changes detected)" CANNOT SEE A RUNTIME CHANGE.** The CLI
decides what to redeploy from one hash, and that hash is

    sha1( source-zip-hash + env-vars-hash + secrets-hash )

(`lib/deploy/functions/cache/hash.js` in firebase-tools). **The runtime is not
one of its inputs.** So a change that moves ONLY `engines.node` deploys
nothing and prints `Deploy complete!` over functions still on the old runtime
— the stale-checkout trap above wearing different clothes, where the deploy
reports success and the thing you changed did not ship. The Node 22 upgrade
escaped it only by accident: it edited `index.js` and `package.json` together,
so the zip changed too and the hash moved with it.

So whenever a runtime moves, **verify it instead of reading the deploy log**:

```
firebase functions:list --project operations-academia
```

The **Runtime** column must say what `_functions/package.json` says. Where it
does not, name each function explicitly — the supported bypass, not a trick:

```
firebase deploy --only functions:publishOnChange,functions:publishOnCandidateChange,functions:publishOnReview,functions:revealCandidates,functions:recordVisit --project operations-academia
```

`--only functions` parses to an EMPTY filter list, which leaves every endpoint
un-targeted and so eligible for the skip; naming one sets its `targetedByOnly`
flag, and the skip predicate reads `!targetedByOnly && …`, so a named function
is always redeployed.

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

This deploys EVERY function in `_functions/`, which is five: the four
doorbells above, and **`recordVisit`** — the university-visit resolver behind
the Analytics page's "which universities visited" chart, which needs no secret
(`_SETUP-ANALYTICS.md`, source 4). `firebase functions:list` must read back
five; four means the checkout predates `revealCandidates`.

`revealCandidates` is a SCHEDULED function, so its first deploy also creates a
Cloud Scheduler job (`0 14 * * *`, UTC) and asks to enable the Cloud Scheduler
API, say yes. The job is visible in the Google Cloud console under Cloud
Scheduler; it fires the function every day, and the function itself decides
whether today is the reveal day. The function's log line `reveal: not today`
on an ordinary day is the proof it is running.

Always pass `--project`: the CLI remembers an "active project" per directory,
and a deploy from this folder has already gone into another project's database
once (see CLAUDE.md).

First deploy asks to enable a few APIs (Cloud Functions, Cloud Build,
Artifact Registry, Eventarc) — say yes. It takes a few minutes.

**IF THE DEPLOY DIES AT "Loading and analyzing source code".** On Windows this
has failed with

    User code failed to load. Cannot determine backend specification.
    Timeout after 10000.

**That message names the wrong culprit.** The CLI discovers your functions by
spawning the SDK's own loader, which serves the manifest over HTTP on a random
port just above 8000, and the timeout is reached by ONE path: a retry loop
that spins on `ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT`. Code that merely
loaded slowly would still connect, and code that threw would answer and give
you "Functions codebase could not be analyzed successfully" instead. So the
timeout means **the CLI could not open a socket to `127.0.0.1` on that port**,
and says nothing whatever about this repository's code — measured on
2026-08-30, `index.js` loads in 0.69 s against a ten-second budget on the very
machine that could not deploy.

Route around the port rather than hunting the firewall: the CLI has a
file-based discovery mode that opens no socket at all.

```
setx FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH true
```

`setx` is permanent and takes effect in NEW windows; plain `set` lasts only
for the window you type it in, which is easy to mistake for a fix that stopped
working. The file route is also the better diagnostic — unlike the port route
it reports the loader's own stderr, so a genuine load failure finally says
what it is.

`FUNCTIONS_DISCOVERY_TIMEOUT` is a red herring here, and is in SECONDS rather
than the milliseconds the error prints: no timeout helps when nothing ever
connects.

**AND `setx` IS MACHINE-WIDE, WHICH IS A CAVEAT WITH TEETH.** The variable
reaches every Firebase project deployed from that machine — the six in the
sibling `konstantinosStouras.github.io` included — and only
`firebase-functions` **>= 6.4.0** honours it (measured: 6.3.2 has no
`FUNCTIONS_MANIFEST_OUTPUT_PATH` handling, 6.4.0 does). A project on an older
SDK spawns a loader that ignores the variable and serves a port nothing will
read, so its deploy dies with `Timeout after 10000ms` — note **`ms`, and no
doc link**: that is the FILE route's timeout, where the port route's above
prints `10000.` with the link, and the two spellings are how you tell which
one bit you. The sibling's five functions packages were audited and brought to
^6.6.0 the day this shipped (its CLAUDE.md records the rule); if some OTHER
old checkout ever hits the `ms` form, clear the variable for that window only —
`set FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH=` (an empty value is falsy) —
or raise that project's `firebase-functions` above the floor.

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

`build dispatched` / `sheet read dispatched` / `reveal build dispatched` (on the
reveal day; `reveal: not today` on every other) = working. `dispatch refused (401)` = the PAT expired or is
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
