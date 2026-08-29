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
| Property | "Operations Academia - GA4" |
| Property ID | `384653143` — **not a secret**, committed as the default in `oa-analytics.yml`; a repo variable `GA4_PROPERTY_ID` overrides it |
| Measurement ID | `MEASUREMENT_ID` in `assets/oa-ga4.js` |
| Data API credential | repo secret `GA4_SERVICE_ACCOUNT`, granted **Viewer** on the property |

The tag and the Data API are **independent**: the tag collects, the secret
reads back. The site measures correctly with only the tag; the dashboard just
cannot plot GA4's numbers until the credential exists.

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

So those figures are an **archive** from here on. The page labels them
"Archive — 2014 to 2023" with the date range on the card, so nobody reads them
as current. If the spreadsheets are gone, they are gone for good — which is
why source 3 is worth ten minutes of your time before anything else here.

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
