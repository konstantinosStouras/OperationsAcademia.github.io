# Private Profile Analytics

The account menu and My personal area link to `profile-analytics`. A listing
selector covers both candidate profiles and jobs; the maintainer can select
all submissions. Reports are read from each submission's `analytics/current`
subdocument. Firestore checks the *current* submission owner on every read,
so a transfer revokes the old owner's access immediately. All client report
writes are denied. No report or visitor record is written to public `data/`.

## Collection and measurement

`oa-usage.js` keeps the existing page-session record and also writes immutable
`usageEventBatches` with at most 100 interactions. This preserves long visits
without overwriting early clicks or increasing page-session counts. The batch
writer retries the same document id; identical writes are idempotent. Raw
batches are readable only by the maintainer. Input values are never recorded;
link query strings and contact addresses are removed from click destinations.
Account deletion removes these batches; account merges move their ownership.

`oa-listing-tracking.js` records visible, expanded candidate/job cards, their
link clicks, and active time in 15-second checkpoints. A view is a viewing
episode: leaving and returning to a card can count again. Time requires a
focused, visible tab and interaction within the last 60 seconds. A heartbeat
can lose its final seconds on a browser crash; navigation delivery is best
effort. GPC/DNT and non-production hosts disable collection.

The private builder excludes listing owners, merged owner accounts, and admin
sessions from first-party figures. Unique viewers are approximate distinct
account/browser identifiers, not a verified count of people. It rebuilds
all-time and UTC calendar 30-day figures from retained batches, so reruns are
idempotent and record deletion is reflected on the next refresh. It currently
scans retained batches each run; monitor reads as traffic grows and partition
or incrementally aggregate before large-scale growth.

Country figures use GA4 `oa_listing_view` events, with a safe `page_location`
containing the public listing id in `oa_listing`. The Data API's standard
`pageLocation`, `country` and `date` dimensions avoid custom-dimension setup.
These counts have different coverage and can include owners' own visits; the
UI explicitly labels that distinction. External-site dwell time is unknown.
GA country failures preserve the last successful figures and their own date.

## Deployment and validation

1. Run Profile Analytics checks (model, browser, tracker and Firestore emulator).
2. Publish `_firestore.rules` through the existing guarded rules workflow.
3. Deploy the site and run `oa-analytics.yml`. The existing Firebase and GA4
   service-account secrets are used; no new secret or custom dimension is needed.
4. Verify real events and a private report after the next processing cycle.

The report refresh runs on the existing 15-minute analytics schedule; GitHub
can delay runs and GA4 can take longer to process events. New metrics are not
retroactively reconstructed from data the site never collected.

## New badges

`oa-feature-badges.js` hides every `.oa-nav-new` badge after the end of
15 November 2026 in Europe/London. Profile Analytics badges apply to accounts
created before 19 October 2026 in London, including existing accounts. The
registration cutoff is 18 October at 23:00 UTC (BST); expiry is 16 November at
00:00 UTC (GMT). Date boundaries are covered by the model tests.

## University reports

University rows use the current OA account affiliation, matched through the
same canonical university matcher as registration. They do not infer that a
university hired, endorsed or formally reviewed a candidate. Anonymous or
unmatched viewers appear as Unknown. Each row includes views, link clicks and
total active seconds divided by that row's view count; it is a weighted
average across visits, not an average of individual users' averages. Only
aggregate rows reach the listing owner. The existing IP/network lookup is
site-wide and cannot be retroactively joined to listing visits.
