# The analytics page — what it needs, and how each source is switched on

`analytics.html` draws its own charts now, from one served file
(`data/analytics.json`) built daily by `_scraper/build-analytics.mjs`. This is
the setup guide for its sources. **Nothing here is required for the page
to work** — it is honest and functional with no source at all — but each one
you switch on adds figures to it.

---

## First: why the old charts died

The page was four `<iframe>`s pointing at Google Sheets `pubchart` charts. The
spreadsheets behind them were filled by the **Google Analytics Spreadsheet
Add-on**, which spoke only the **Universal Analytics Reporting API**.

* **1 July 2023** — UA stopped processing data. The add-on's scheduled refresh
  has been erroring ever since, so the sheets stopped gaining rows.
* **1 July 2024** — Google **deleted** UA properties and their data. The
  property `UA-47739718-1` no longer exists.

A dead embed renders as an empty box and reports nothing to anybody, which is
why three years went by without it being noticed. That failure shape is the
whole reason the page now draws its own marks and says out loud when its
figures have stopped moving.

**The dead UA tag is still in the archives.** `assets/js/ypo-parakolouthisi.js`
is loaded only by the `/v1/` and `/v2/` pages and reports to a property that no
longer exists. The live site's own tag is `assets/oa-ga4.js` — see source 2.

---

## Source 1 — the site's own record  ·  **works today, needs nothing**

`assets/oa-usage.js` has written one `usageSessions` document per browsing
session, on every page, since 2026-08-17: which page, when it started, how long
it lasted, under a uid or a stable random per-browser id.

The builder reads it with **`FIREBASE_SERVICE_ACCOUNT`**, which is **already a
secret in this repository** — eight other workflows use it. So the moment
`oa-analytics.yml` runs, this source starts filling the daily-visitors, weekly
rhythm, hiring-season and most-visited-pages charts.

No cookies, no third party, no consent banner, and the data never leaves your
own Firebase project. **If you want only one source, this is the one to have.**

Its limits, stated plainly: it began on 2026-08-17, so it has no history; and
it counts only browsers that reach Firestore, so an ad blocker or a private
window with storage refused is invisible to it. It will read a little low
against GA4 for that reason.

---

## Source 2 — Google Analytics 4  ·  **live, and cookieless**

Switched on 2026-08-29 on the owner's instruction: **GA4 yes, consent banner
no.** Those two are only compatible one way, and it is worth understanding
before anyone changes it.

`assets/oa-ga4.js` configures gtag with **`client_storage: 'none'`** — GA4
keeps nothing on the visitor's device. No `_ga` cookie, no localStorage,
nothing. The ePrivacy rule a cookie banner exists to satisfy is about
**storing** things on someone's device, not about analytics as such, so a tag
that stores nothing has nothing to ask permission for. That is what makes the
absence of a banner coherent rather than merely convenient, and the Privacy
Policy says so in as many words.

Three further narrowings, none costing anything worth having: Google Signals
and ad personalisation are off; a Global Privacy Control or Do Not Track
signal means gtag is never even fetched; and it only reports from
`operationsacademia.org` — a page opened from localhost or by the CI browser
checks sends nothing, without which every CI run would post hits to the live
property.

**What it costs, and the consequence it carries.** With no identifier on the
device GA4 cannot recognise a returning visitor, so its `totalUsers` is far
closer to "sessions" than to "people". So **`SOURCE_ORDER` puts the
first-party record AHEAD of GA4** (`['usage', 'ga4', 'history']`): for a day
both measured, the source that can actually count distinct visitors wins. GA4
earns its second place on coverage — it sees visitors whose browser never
reaches Firestore at all.

**If cookies are ever turned back on** (`COOKIELESS = false`), two things
must move together: add a consent banner, and put `'ga4'` back in front in
`SOURCE_ORDER`. The selftest pins the pairing so neither half moves alone.

### The configuration

| | |
|---|---|
| Property | "Operations Academia - GA4" · stream id `5432892882` |
| Property ID | `384653143` — **not a secret**, committed as the default in `oa-analytics.yml`; a repo variable `GA4_PROPERTY_ID` overrides it |
| Measurement ID | `G-RE8C5LD2FM` — in `MEASUREMENT_ID`, `assets/oa-ga4.js` |
| Data API credential | repo secret `GA4_SERVICE_ACCOUNT`, granted **Viewer** on the property |

The tag and the Data API are **independent**: the tag collects, the secret
reads back. The site measures correctly with only the tag; the dashboard just
cannot plot GA4's numbers until the credential exists.

---

## Which figure comes from which source

The page draws two kinds of thing and they are gathered differently.

**Day rows** — visitors, visits and pageviews per day — go back as far as the
record does, and `mergeDays` gives each day to exactly one source.

**Dimension tallies** — the hour of the day, the countries, the channels, the
referring sites, the devices, and how long a visit lasts — cannot be
accumulated the same way. Adding this run's counts to the last run's would
double every session in the overlap the incremental read deliberately keeps,
and taking only the fresh ones would turn *when people read the site* into
*when people read it this week*. So they are **recomputed from scratch over a
trailing window on every run** (`BREAKDOWN_DAYS`, 90 days), and each record
states the span it actually covers. The page prints that span under every
figure drawn from one, because the tiles above it describe the whole record
and two spans on one screen with only one of them named invites a comparison
nobody meant.

Which source answers for which dimension is settled by what each one HAS, so
no precedence question arises:

| Figure | Source | Why it can only be that one |
|---|---|---|
| Visitors / visits / pageviews per day | usage, then GA4 | both measure it; the day goes to one of them, never to both |
| The weekly rhythm, the hiring season | derived from the day rows | nothing extra is fetched for either |
| **When in the day people read it** | **usage only** | it stamps the instant each session begins, so the hour is exact and it is UTC. GA4 would answer on the property's own clock, and one chart whose meaning changed time zone with its source is worse than no chart |
| **Where readers are** | **GA4 only** | the first-party record stores a page, an instant and a duration, and asks nothing else |
| **How readers arrive** (channel) | **GA4 only** | same |
| **Which sites send readers** | **GA4 only** | same |
| **What they read it on** (device) | **GA4 only** | same |
| How long a visit lasts | usage, then GA4 | both measure it; one of them owns it |
| **Which universities visited** | **the site's own resolver** | neither analytics system can answer it: GA4 dropped UA's reverse-DNS dimension and a browser cannot look up its own. A Cloud Function can, so the site does it itself — source 4 below |

**Every GA4 figure counts VISITS, never visitors.** Running cookieless the tag
keeps no identifier on the device, so GA4 cannot tell a returning reader from a
new one and its `totalUsers` is nearly its session count. Publishing a
country's number as "visitors" would be exactly the overstatement
`SOURCE_ORDER` exists to avoid.

**`newVsReturning` is deliberately not asked for at all.** Cookieless, GA4
reports very nearly every session as new — the figure would measure the tag's
configuration rather than the readers. The first-party record could answer it
honestly (its per-browser id is stable) but only by reading the whole
collection to find each browser's first day, which is the unbounded read the
incremental query is shaped to avoid. A figure that would be wrong from one
source and expensive from the other is better not drawn.

**A dimension with no source is not drawn.** A heading over an empty axis is
precisely the shape of the defect this page is a rebuild of, so the five GA4
figures simply appear on their own once the credential exists and the property
has days in it. (They were also NAMED, in a provenance note at the foot; the
owner removed that note on 2026-08-30, so not drawing them is the whole of it.)

**And every figure describes public pages only.** The non-public filter is
applied to the GA4 dimension reports as well as to the daily one, so the
country and channel tallies describe the same population as everything else on
the page.

---

## Source 3 — the historical archive  ·  **CHECKED, AND IT IS EMPTY**

**Do not go looking for this again.** It was checked on 2026-08-29 and the
answer is final.

The owner exported the whole workbook (30 tabs) and every one of its 141,540
rows was read. There is not one surviving measurement in it. The tabs are
structurally intact — headings, formulas, chart definitions — and hold nothing
but zeroes, `#REF!`, `#VALUE!` and `#N/A`.

**The workbook records how it happened, in its own cells.** Every `Report_N`
tab carries:

```
Last Run On            2024-07-15 05:32
Total Results Found    0
View (Profile) ID      ga:81760839          (a Universal Analytics view)
Start Date             2014-03-01
```

Google deleted Universal Analytics properties on **1 July 2024**. Two weeks
later the add-on ran on its schedule, asked a view that no longer existed for
2014-to-date, got **zero rows** — and wrote those zero rows over ten years of
data. The presentation tabs the charts read are formulas pointing at the
report tabs, so they resolved to `#REF!` and the charts went blank.

**So the data was not lost when Google deleted the property. It was lost two
weeks later, when the spreadsheet refreshed itself.** A scheduled job that
overwrites its only copy with whatever the source returns has no way to tell
"no results" from "no data", and that is the whole lesson: this pipeline
carries the opposite rule deliberately — *an unreachable source changes
nothing*, and the committed file stands (see `build-analytics.mjs`).

`data/analytics-history.json` will therefore never exist, and the reader for
it stays in place as a documented recovery path rather than being deleted —
the same reasoning CLAUDE.md records for keeping `repository_dispatch:
[oa-jobs-changed]` wired while the functions are undeployed. If a copy ever
surfaces (an old export, a colleague's download, a backup), drop it in as:

```json
{
  "from": "2014-03-01",
  "to":   "2023-06-30",
  "days":   { "2014-03-01": [3, 4, 11] },
  "pages":  [{ "path": "/jobs.html", "title": "Jobs", "views": 12000, "avgSec": 96 }],
  "universities": [{ "name": "Duke University", "visits": 412 }]
}
```

---

## Source 4 — which universities are reading  ·  **needs one deploy**

This is the figure the page lost and has got back, and the story is worth
three paragraphs because the wrong conclusion was written down here first.

**Where it used to come from.** "Which universities visited" was measured from
Universal Analytics' `networkDomain` / `networkLocation` dimensions — a
**reverse-DNS lookup of the visitor's IP address**, so a reader on their
university's network resolved to `ox.ac.uk`, `mit.edu`, `nus.edu.sg` and was
counted there.

**GA4 has no such dimension and Google offers no replacement.** That much is
true, and this file used to stop there and call the figures unrecoverable.
That was wrong. What is actually true is that a *browser* cannot see its own
reverse-DNS — and nothing said the browser had to. Anything **server-side**
receives the connection and can see the address it came from, and this site
has Cloud Functions.

**So the site does the lookup itself**, and rather better than UA did: the
answer is checked against this site's **own directory of operations
departments** rather than against whatever string an ISP happens to publish.

| | |
|---|---|
| `assets/oa-visit.js` | one ping per browsing session, from every public page. No body, no identifier, no cookie, no page path — the whole of the request is that it happened. Not loaded on `admin-area.html`, so the maintainer's own desk never feeds the figures. |
| `recordVisit` (`_functions/index.js`) | reads the address, reverse-resolves it, keeps the **university name**, discards the rest. |
| `data/university-domains.json` | domain → university, **derived** from each department's own page in the Universities directory by `_scraper/build-netmap.mjs`. Vendored into `_functions/` because `firebase deploy` ships only that directory. |
| `universityVisits/{YYYY-MM-DD}` | counters only — `seen`, `resolved`, `academic`, and one tally per university. Closed to every client in `_firestore.rules`. |

**The IP is never stored.** It is resolved in memory and goes out of scope
when the request ends; it is not written and not logged. An ISP or a
residential address is not counted at all — the chart is about universities,
and an ISP's name is both useless here and closer to personal data than a
university's is.

### To switch it on

```bash
firebase deploy --only functions --project operations-academia
```

No secret and no variable — but **two commands come first, and the second is
not optional**:

```bash
git pull
npm install --prefix _functions
firebase deploy --only functions --project operations-academia
```

`firebase-admin` arrived with `recordVisit`, and the CLI discovers what to
deploy by LOADING your local `_functions/index.js` — so a missing module throws
before it can see anything, and a checkout that predates the merge has nothing
to see. **Nothing is collected until that runs**, and the collection stays
empty, so the builder logs `visits: universityVisits is empty` and the page
simply does not draw the figure.

**COUNT THE FUNCTIONS IN THE OUTPUT.** A deploy from a stale checkout prints
`Deploy complete!` over the three instant-publish doorbells and never mentions
`recordVisit` at all — not deployed, not skipped, not named (owner, 2026-08-30).
There should be **four**.

**Check the URL the deploy prints** against `ENDPOINT` at the top of
`assets/oa-visit.js`, which expects the classic form:

```
https://us-central1-operations-academia.cloudfunctions.net/recordVisit
```

Second-generation functions are reachable at that address *and* at a
`…a.run.app` one; if the CLI prints something else, paste it in there. Nothing
breaks if it is wrong — the ping just fails silently, which is exactly the
failure this file keeps warning about, so **verify it rather than assume it**:

```bash
node _scraper/build-analytics.mjs --scan
```

An hour after the deploy that should report a non-zero `visits:` line. If it
still says the collection is empty, open the site, then look at
`firebase functions:log` for `recordVisit`.

### Read it as a sample, because it is one

Reverse DNS answers far less often in 2026 than it did in 2014: campuses
increasingly egress through a commercial CDN or a cloud VPN, and a great deal
of reading happens on phones. So every ping counts towards `seen` whether or
not a name came back, and **the page prints what it placed against it** — *"of
12,000 visits, 3,455 (29%) were placed at a university listed here"*. Without
that denominator a short chart reads as "no universities visit", which is
precisely the misreading the rest of this page was rebuilt to prevent.

If the share looks low, the day documents say which of two things to fix:
`resolved` counts every address DNS answered for at all, so **`resolved` high
and the tallies low** means the domain map does not know those universities
(give their departments a `deptUrl`), while **`resolved` low** means the
networks themselves are giving no name away, which nothing here can change.

To make a university recognisable, give its department a `deptUrl` on
`universities.html` — the map is rebuilt from the directory on every data
build. A domain two universities both claim is **dropped** rather than picked
between, and reported in the run log.

---

## The 2014–2023 archive is gone, and that part is settled

The figures above start from the day the resolver is deployed. The decade UA
measured is not recoverable — not because of the dimension, but because the
spreadsheet holding the copy was **overwritten with empty results by its own
add-on** on 2024-07-15, two weeks after Google deleted the property. All 30
tabs were read on 2026-08-29; every `Report_N` tab says `Total Results Found
0`. Source 3 above has the forensics.

If an untouched export ever surfaces it drops in as
`data/analytics-history.json` and is drawn as its own **frozen** section — a
closed period, labelled with its date range and **never merged** with the live
figures, because the two count different decades under different rules.

---

## Running it

```bash
node _scraper/build-analytics.mjs --scan       # what each source would give
node _scraper/build-analytics.mjs --dry-run    # build it, write nothing
node _scraper/build-analytics.mjs --selftest   # offline, no credentials
node _scraper/build-analytics.mjs              # write data/analytics.json
```

`.github/workflows/oa-analytics.yml` runs it daily and commits the result on
`master` only. Every source is independently gated: a missing credential is a
line in the log, not a failure, and **an unreachable source changes nothing** —
the committed file stands, because a half-written one is a blank dashboard.
