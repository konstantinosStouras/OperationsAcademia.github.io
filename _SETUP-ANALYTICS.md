# The analytics page — what it needs, and what can never come back

`analytics.html` draws its own charts now, from one served file
(`data/analytics.json`) built daily by `_scraper/build-analytics.mjs`. This is
the setup guide for its three sources. **Nothing here is required for the page
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

## Source 2 — Google Analytics 4  ·  **needs five things from you**

Only worth doing if you want the industry-standard numbers and are content to
run cookies. In return it sees the visitors the first-party record misses.

**1. Decide whether you want it at all.** GA4 sets cookies and profiles
visitors. The site is EU-facing (Dublin, Fontainebleau), so switching it on
means a consent banner and a Privacy Policy change — neither of which exists
today, and neither of which I have added, because that is a decision about
your visitors rather than a bug fix.

**2. The Measurement ID** — `G-XXXXXXXXXX`. Firebase already issues
`G-2CX86W7PHB` for the `operations-academia` project, and `assets/oa-firebase.js`
deliberately omits it with a comment saying why. **Tell me whether that is the
property you want, or whether you made another one in 2023.** Nothing has ever
sent it an event, so whichever it is, it is empty.

**3. The tag on the live site.** One `gtag.js` snippet in every root page's
`<head>`. **I have not added this** — see (1). It is a two-line change once you
say the word.

**4. The Property ID** — a plain number like `123456789`, from GA4 →
Admin → Property details. **This is not the Measurement ID**; the Data API
wants the number. Set it as the repository variable `GA4_PROPERTY_ID`.

**5. A service account that may read it:**

```
# in Google Cloud, on any project
gcloud iam service-accounts create oa-analytics-reader
gcloud iam service-accounts keys create key.json \
  --iam-account oa-analytics-reader@<project>.iam.gserviceaccount.com
# then enable the API
gcloud services enable analyticsdata.googleapis.com
```

Then — **the step everyone misses** — in **GA4 → Admin → Property access
management**, add that service account's e-mail address as a **Viewer**. The
builder names this in its own error message if it gets a 403, because a key
that exists but was never granted access looks exactly like a broken key.

Paste `key.json` whole as the repository secret **`GA4_SERVICE_ACCOUNT`**.

**What GA4 will not give you: history.** It cannot be backfilled. Data starts
the day the tag goes live, and the years 2014–2023 are gone from Google's side.

---

## Source 3 — the historical archive  ·  **needs one export from you**

The old spreadsheets may still hold the rows the add-on pulled before it died.
That is now the **only** copy of 2014–2023 anywhere. The two the page used
were:

```
1lnrl5hsmj0WreUkxJ2iE-hsYo1aSgmrQO0RaKhCm0sY
2PACX-1vTWggAd-lHzkKLA_c3PhXLrAwAMkYuNYJkflrEL7zXzRYIQrrqg3l46_OASdhiRa2pgi1zwOb3WZWSb   (a publish-to-web id)
```

**Please check whether they still open and still have their data tabs.** If
they do, export each tab as CSV and I will commit them as
`data/analytics-history.json`, in this shape:

```json
{
  "from": "2014-03-01",
  "to":   "2023-06-30",
  "days":   { "2014-03-01": [3, 4, 11] },
  "pages":  [{ "path": "/jobs.html", "title": "Jobs", "views": 12000, "avgSec": 96 }],
  "universities": [{ "name": "Duke University", "visits": 412 }]
}
```

Once committed it is **frozen** and never re-fetched — UA is gone, so it can
never grow.

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
