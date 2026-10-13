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

### Detailed interaction collection (13 October 2026)

All current pages that load the shared tracker send `oa_site_click` to GA4
and `k: interaction` to the private usage batches. This includes plain-content
clicks, controls, keyboard-activated clicks, touch-generated clicks and middle
clicks, including cards rendered after page load and jobs on Previous markets.
The forum and archived trees
keep their existing exclusions. Gated cards never acquire a listing identity
or count as a listing view; their clicks have action `locked`.

Each interaction carries the following first-party fields (GA4 names in
parentheses): `c` (listing_id, without the `job-` prefix), `m` (the list mount,
mapped to listing_type), `p` (listing_part), `a` (interaction_action), `e`
(element_type), `r` (page_region), `z` (target_path), and `b` (mouse_button).
Parts distinguish title, subtitle, CV, website, contact, research areas/summary,
INFORMS talk/days, position type, deadlines, description, campus countries,
job file, posting source, further information and posting ID. Unknown detail
rows use `detail`; a structural DOM path distinguishes controls without sending
their text, IDs or destinations to Google. Paths can change with layout changes.
GA4 also receives `source_page`, stripped of queries and fragments.

Every new batch event has `v: 2`, page-visit identifier `s`, and increasing
sequence `n`. Group by the private batch's uid and event `s` for a visit;
order by `n`. These identifiers are not sent to GA4. Count only
`k: interaction` for detailed click totals: legacy element events and `k: link`
remain available for existing reports and must not be added to the same total.
Owner reports now show total listing clicks and a “What people click” table
with each detail's click count and its link-click subset. This breakdown counts
only semantic interaction events, deduplicated by viewer/page-visit/sequence
when those identifiers exist. Legacy link and element events are never added
to those counts. Labels come from a fixed vocabulary; arbitrary raw event text,
paths and visitor identifiers never enter the owner-facing breakdown.

Total and average active reading time are prominent summary cards. The summary measures the whole expanded listing; the detail table also shows
total and average active visible time per detail. External pages cannot be timed. Both
period selections recalculate the breakdown from retained events. Reports that
predate the breakdown show a pending message rather than a false zero; new
reports with no detail events show an explicit empty state. Detail coverage
starts on 13 October 2026, later than the legacy link totals.

The report builder resolves released candidates from the private candidate
snapshot, falling back to the former public file only before migration. Reports
continue to use the existing owner/admin-only submission subdocuments and the
same exclusion of owner, merged-owner and administrator activity.

`oa_page_engagement` / `k: page_engagement` adds focused, visible, non-idle
page seconds. Existing `oa_listing_engagement` / `k: engagement` retains
per-listing active seconds. Multiple visible expanded listings each accrue
time, so their totals must not be interpreted as exclusive page time.
Lifecycle checkpoints drain the usage queue after final segments are recorded;
in-flight batches also drain smaller queued tails. Delivery still depends on
the browser/network; blockers, opt-outs and crashes prevent complete coverage.

GA4 collects these event parameters without configuration. To use the new
parameters in GA4 Explorations, register the required event-scoped custom
dimensions (for example listing_type, listing_part, interaction_action and
source_page) and the custom metric active_seconds. High-cardinality listing IDs
and target paths are better analysed in event exports. The existing country
report continues using standard dimensions and needs no change.
See Google's [event parameter setup](https://developers.google.com/analytics/devguides/collection/ga4/event-parameters)
for the reporting registration requirement.

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

## Per-detail reading time (13 October 2026)

`part_view` / `oa_listing_part_view` starts a viewing episode for each title,
subtitle or semantic detail row in an expanded listing. `part_engagement` /
`oa_listing_part_engagement` records its active seconds, checkpointed every
15 seconds and on exit. At least half the element height and width must be
visible, capped at half the available viewport for oversized elements; the
fixed header is excluded. Time pauses for hidden/unfocused/idle tabs, collapsed
or gated cards, and offscreen details. This estimates exposure, not eye tracking.
Simultaneously visible details overlap in time; totals are not additive.
Repeated rows with the same semantic part count once per tick.

Schema 3 reports add `views`, `seconds` and `averageSeconds` to part rows and
`partTimeTrackingSince` to the report. Detail events are deduplicated using
viewer/session/sequence IDs and retain the existing owner/admin exclusions.
They never change listing views or total listing seconds. Old reports show
an unavailable dash; rows with time but no clicks are included. The existing
GA4 `listing_part` dimension and `active_seconds` metric apply to these events.
