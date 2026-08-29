# The analytics page — what it needs, and what can never come back

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

**Nothing is being collected today, either.** The UA tag lives in
`assets/js/ypo-parakolouthisi.js`, which is loaded only by the `/v1/` and
`/v2/` archive pages. The live redesign at the root carries **no analytics tag
at all**.

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

**A dimension with no source is not drawn.** It is named in the note at the
foot of the page instead, under "Not on this page yet". A heading over an empty
axis is precisely the shape of the defect this page is a rebuild of, so the
five GA4 figures simply appear on their own once the credential exists and the
property has days in it.

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

## The one thing that cannot be fixed, by anybody

**The two university charts cannot be revived.** "Which universities visited"
came from Universal Analytics' `networkDomain` / `networkLocation` dimensions
— the visitor's reverse-DNS.

**GA4 does not have that dimension, and there is no replacement.** Google
removed it, and the first-party record cannot stand in either: a browser
cannot see its own reverse-DNS, so no amount of code here can recover it.

So those figures would have been an **archive** from here on — and then the
archive turned out to be empty too (source 3 above). The page carries the
labelling either way: `universities.frozen` is true in the served file and the
card reads "Archive — 2014 to 2023" with its date range. With no rows behind
it the card simply never draws, which is a clean absence rather than an empty
box, and is the whole reason the section is rendered conditionally.

**There is nothing to go and look for.** That is the settled answer, not a
suggestion to try harder.

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
