# Repository conventions

This repo is the source of **operationsacademia.org** (the Operations job
market site), served by GitHub Pages from `master`. No build step — HTML/CSS/JS
are committed and served as-is; the data files under `data/` are written by the
GitHub Actions workflows (`_scraper/` + `.github/workflows/oa-*.yml`) from
Firestore, which is the source of truth for submissions.

`_PLAN.md` is the architecture plan and decision log — consult it before
structural changes (which pages are rebuilt, which are legacy, what is
scheduled for retirement). `_AUDIT.md` records the content audit.

## Three trees, served at once

| Tree | What it is |
|---|---|
| **root** | The live site: the single-page redesign, promoted 2026-08-17. |
| **`/v2/`** | The 2026 vendor-free rebuild — the root between the 16th and the 17th. Archived, working, `noindex`. |
| **`/v1/`** | The 2014-2026 Awesome-Tables site. Archived verbatim, `noindex`. Do not edit: it is a historical record — with the one exception argued under "A link nobody can preview" below, where its pages' own ADDRESSES were re-pointed at themselves. |
| **`/v3/`** | Redirect stubs only. The redesign was previewed here before promotion. |

Three rules hold this together, and **`node _scraper/link-check.mjs` enforces
all of them** (it runs in CI):

1. **No tree navigates into another.** The live site may link an archive's
   FRONT DOOR (`/v1/`, `/v2/`) and nothing deeper; an archived page may point
   back at the live site, which is how a reader who lands on one gets out;
   an archive never reaches into another archive. Break this and nothing 404s
   — the site just quietly becomes two sites, which is precisely what a
   promotion does if the links are not swept.
2. **A tree links to its own pages RELATIVELY.** That is what let the redesign
   be previewed under `/v3/` at all, and what will make the next promotion a
   directory move again.
3. **The shared substrate is absolute and lives at the root**: `/data`,
   `/images`, `/assets/leaflet|css|js|fonts`, `/changelog.json`. Every version
   reads the one copy the workflows write — that is why an archive keeps
   working. A page that moved down a directory with a relative `data/jobs.json`
   would ask for `/v2/data/jobs.json` and render its "could not be loaded"
   state with nothing on screen saying why.

Each archive keeps its OWN frozen `assets/oa-*.js|css` beside it, so the live
site is free to move on. `_scraper/archive-v2.mjs --check` holds `/v2/` to its
archive rules (noindex, a banner with the way back, absolute shared paths, and
no page still claiming through its canonical/og:url to be the home page).

**When you promote a new design, the work is the swap AND the sweep.** Move the
tree, then rebuild every page the new design was borrowing from the old one —
a card on the front page that opens a page in the previous design is the
failure mode, not a missing file.

## Two sources of job postings, and only one of them is the database

`data/jobs.json` is built by `_scraper/build-jobs.mjs` from **both**:

1. **`jobSubmissions` in Firestore** — everything posted through the site's own
   form. The database is the source of truth for these: they are edited,
   withdrawn and hidden there, which is why the old form-sheet sync was retired
   (re-reading a sheet reverted people's edits — see the header of
   `oa-jobs-sheet-sync.yml`).
2. **The maintainer's job market TRACKING SHEET** — one Google workbook per
   market cycle, a tab per kind of position ("2026 Jobs", "2026 NTT/PD"), read
   daily into `data/jobmarket.json` by `_scraper/sync-jobmarket-sheet.mjs`
   (`.github/workflows/oa-jobmarket-sheet.yml`). Setup and behaviour:
   **`_SETUP-JOBMARKET-SHEET.md`**.

The ownership is opposite, and that is the whole design. A posting from the
tracking sheet is **maintained in the sheet**: it is rebuilt from the workbook
on every run, an edit there reaches the site, and a row DELETED there comes off
the site. So those rows are deliberately never copied into Firestore —
`migratable()` in `migrate-to-firestore.mjs` skips them, because a document
would win over the sheet at the next build and a deleted row could never leave.
For the same reason they are excluded from the orphan carry in `build-jobs.mjs`
(a missing `data/jobmarket.json` still removes nothing — only a file that
exists and no longer lists a posting does). Both of those worries are now
answered rather than avoided — see the next section — but they are answered by
the BUILD, on the sheet's own terms, not by a migration; `migratable()` still
skips these rows.

### …and the maintainer can edit both, through the same form

A posting's Edit and Take down controls are drawn only where the page can name
a `jobSubmissions` DOCUMENT for the row (`docIdFor` in `assets/oa-jobedit.js`),
so the tracking sheet's postings — which had none by design — carried no
controls at all: the maintainer could edit every posting on the site EXCEPT the
ones the sheet publishes. **Every workbook row now gets a MIRROR**: an inert
document (`status: 'sheet'`, a value no query in the pipeline reads) created and
refreshed from the workbook by `syncSheetMirrors` in `build-jobs.mjs`, whose
only job is to be an editing handle. `sheetMirrorDoc`/`mirrorDiffers`/
`unclaimedSheetRows` in `jobs-model.mjs` are the pure half.

**Saving an edit is the hand-over, and the status is the whole of it.**
`post-a-job.html` sets `status: 'queued'` on every edit it saves — it always
has — so a mirror simply becomes an ordinary live submission, and a status
other than `sheet` means the maintainer has taken the posting over:
`build-jobs.mjs` then publishes the document and DROPS the workbook's row
(`unclaimedSheetRows`, applied before the merge — left in, the sheet row
arrives last and wins, which would make an edit look saved and change nothing).
The workbook stops maintaining that one posting, and the run says so.

**What the workbook KEEPS is existence.** A row deleted there takes its posting
off the site whether or not a document exists for it — the property that made
copying these rows into the database unsafe in the first place, kept by pinning
each mirror to its row with `sheetId`. So `migratable()` still refuses them:
mirrors are the sheet's own, not a migration.

**Taking a posting down is keyed on the id as well as the reference.** `ref` is
issued by the FORM and by nothing else, so the 94 postings from the legacy
import and the 16 from the workbook have none — today that is every row in
`data/jobs.json`. Keyed on `ref` alone, the takedown removed nothing: the row
was carried on as an ORPHAN, the button said "Taken down", and the posting
stayed on the site for ever. `removalSpecs` (jobs-model.mjs) and the `{ id }` spec in
`mergeRows`/`mergeCandidateRows`/`mergePlacementRows` are the fix, in all three
pipelines. It also decides WHOSE WORD to take: an id is honoured only on a
document the build itself wrote, and a reference only for the account that
published the row — both are printed in `data/jobs.json`, so an unscoped
removal is a signed-in stranger taking down somebody else's posting.

**When the sheet changes shape, fix it in `_scraper/jobmarket-sheet.mjs` —
never by hand-editing `data/`.** That file is rewritten from the workbook every
half hour, so a patched row comes back within the hour, exactly as with the
country spellings below. Columns are matched by header alias and a header it
does not know is REPORTED in the run's log rather than guessed at; add the alias
there.

**It is not the maintainer's workbook.** "OM Job Market" is owned by
`omjobmarket2023@gmail.com` and crowdsourced — contributors add their own
postings and, when a season opens, their own tabs. So a heading cannot be
corrected at the source, and the pipeline has to be able to read a tab that
names a column wrongly.

### A header that names one column wrongly, and the four months it cost

The "2026 Jobs" tab — created by the sheet's contributors when the 2026-2027
market opened — heads its school column **"Location"**, the same word it uses
for the town beside it. Every other tab heads it "School". `institution` is
required and no alias reads "location", so that row was refused as a header;
the scan moved to the next row and took a POSTING as one, because "University
of Hong Kong" begins with an alias of `institution` and a comment reading "an
expected start date of July 1, 2027" contains an alias of `posted`. Both
required fields were satisfied by prose. The date was then read out of a
comment column empty on almost every row, so every row was skipped. The tab
logged `"2026 Jobs": 0 posting(s), 94 row(s) skipped` every morning and the
site simply never showed the season — 22 postings on the jobs page where the
sheet held 89.

Three rules came out of it, and they are separate on purpose:

1. **A row of postings is never a header** (`looksLikeData`), however many
   aliases its prose contains. A link or a date is decisive — a column is not
   NAMED after either — and two long sentences are counted rather than trusted,
   so a wordy label survives.
2. **A header that names most of its columns is repaired, not discarded**
   (`repairColumns`). The one required field it failed to name is settled from
   the DATA — the institution column is the one whose values NAME institutions,
   read with the same `UNIVERSITY`/`BUSINESS_SCHOOL` patterns `typeFromNames`
   uses, as a SHARE of the column (measured on the live tab: 92% of the school
   column, 0% of the two beside it, with "KU Leuven", "ESMT Berlin" and
   "Stanford GSB" among the 8% that name nothing). Then the header is re-read
   AROUND that column, which is what makes the repair minimal: the tab's second
   "Location" becomes the town, and the deadline, the link and the notes — all
   of which whole-tab inference would have lost — are kept. It fires only for a
   field without which nothing publishes, only when the header did not name it,
   and never on a tab whose header is right.
3. **A tab that is read and yields nothing is an error, not a quiet tab.** It
   is a `::error::` annotation AND a `stalenessOf` reason of its own
   (`unread-tab`), checked BEFORE the age test: from outside it looks exactly
   like a quiet market, every other signal says the sheet is healthy, and it is
   the one failure here a person has to go and fix.

**Which season a posting belongs to: the tab is a FLOOR** — on top of the
APPLY-BY CASCADE, since 2026-08-26 (see "Which seasons a posting is IN" above;
what follows is why the floor exists, and it still does). The site's roll rule
used to read the market year off the posting's date alone, which is right
except for a school advertising early — 24 of that tab's 89 postings are dated April to June
2026, two saying "an expected start date of July 1, 2027" in their own comment,
and by date alone all 24 file under the season that has just closed, which is
the one page they are of no use on. The tab settles it (`cycleYear`), because
naming the cycle is the whole reason it exists. A floor and never a ceiling: it
can carry a posting forward into the season its tab was made for and can never
push one back into a closed season, so a row added late to an old tab keeps the
later year its date gives it and nothing already published moves.

A sheet that stops being updated looks exactly like a quiet job market from the
site, so it is made visible deliberately: `stalenessOf`/`shouldWarn` e-mail the
maintainer once (then weekly) when the sheet has gained nothing for three weeks,
cannot be read, reads as empty, or has a tab that gave nothing. Nothing already
published is ever removed by one of those failures.

## Which seasons a posting is IN — the deadline decides, and they OVERLAP

The market year used to be read off the POSTING DATE, everywhere. That is
wrong for exactly the postings that matter most in the spring (owner,
2026-08-26): a school advertising in May for a search closing in September is
recruiting for the season that opens in July, and by its posting date all 24
such rows on the 2026 tab filed under the season that had just closed — the
one page they are of no use on.

**The cascade, in the owner's own order** (`marketYearOf` in
`_scraper/jobs-model.mjs`, returning `{ year, from }`):

1. the **final apply-by** (`applyByDate`) — the hard closing date;
2. failing that, the **suggested apply-by** (`reviewDate`) — the first-review
   / full-consideration date;
3. failing both, the **posting date**, which is where this started.

Step 1 fails precisely when the search is open-ended. `applyByDate` is empty
exactly then — "Until filled." is the ABSENCE of a closing date, not a date,
which is the same reading `deadlineOpen` already turns on — so "if that field
is Until filled" and "if that field is empty" are one test and the cascade
needs no separate look at the prose.

**It only ever moves a posting FORWARD**, and that is what makes it safe to
apply over a season already imported: a deadline is on or after the day the
advertisement went up and `marketYear` rises with the date, so the answer is
never EARLIER than the posting date's own. The tracking sheet's tab cycle
stays a floor on top of it (`marketYearAtLeast`, applied in `rowsFromTab`),
and the two hardly ever argue — measured over the 543 served postings,
**fourteen of the seventeen** rows whose deadline outruns their posting date
already carry the year the cascade gives them. The tab had been standing in
for a deadline nobody was reading.

### Nothing already published is re-filed — it is REPORTED

A row's `year` is half its `id` (`jobId`), `keyOf` keys a ref-less row by that
id — which today is every row served — and `mergeRows` joins on it. So a
published posting whose season moved is one the merge can no longer match: the
old row is carried on as an ORPHAN beside the new one and **the posting is
published twice**, with the card anchor and the Edit button's join key
pointing at a row nobody sees. `collapseSameDay` cannot fold them either,
because its key carries the year.

So the cascade classifies a row **at birth**, where no id has been minted and
nothing has joined to it:

* `rowFromSubmission` applies it to a document with **no** season; a stored
  one wins outright, which is not deference to the client but `jobId`;
* `rowsFromTab` applies it to every workbook row, under the tab-cycle floor;
* `postingYear()` in `assets/oa-jobform.js` is the **browser twin** — a new
  posting is filed by the dates the poster types and the note beside them says
  which market it will be listed under, repainting as those dates change. It
  has to exist because the form SENDS `year` and a stored year then wins.
  `testFormMarketYearParity` pins the two against one fixture list, the way
  `typeGuess`/`typeFromNames` are pinned — and the fixture makes each of the
  three steps name a DIFFERENT season, because a fixture whose answers
  coincide passes a form reading the wrong date, which is what the first draft
  of it did. An EDIT keeps the season it was filed under, everywhere.

…and the disagreements among what is already published are **reported**:
`marketYearReview` (forward only — a stored year AHEAD of the cascade is the
tab cycle doing its documented job) → `data/jobs-yearcheck.json`, written by
`build-jobs.mjs` on its own diff → the **"Market year to check"** panel and
tile on `/admin-area`.

**The LIST is a served file, and stays one.** It is DERIVED — nothing decides
what is flagged, the next build recomputes it, and a posting corrected in the
tracking workbook simply leaves it. It carries only what `data/jobs.json`
already publishes, which is what keeps it clear of the no-e-mail rule every
served file is held to. Its tile is **due-able** — it is something the
maintainer can clear — but it is out of `pendingCounts()`, which runs on EVERY
page for the account-menu badge: a served-file fetch in that `Promise.all`
would make every page pay a read for a number only this page shows (the
Registered-users rule, one paragraph over).

### …and a posting is in TWO seasons at once, because they overlap

Deciding which season a posting is FOR does not make it the only season the
posting is IN (owner, 2026-08-27): *"a school advertising in May for a search
that closes in September should be posted in the current job market year
immediately public on the website AND also continue to be shown for the next
job market year, since there is overlap between the two years."* It is being
advertised now, in the season under way, and it is recruiting for the one that
opens in July. A model that can name only one of those has to be wrong about
one of them — and the one it was wrong about is the one the poster is looking
at today.

So `year` stays exactly what it was — ONE season, the cascade's answer, minted
at birth and never moved, for the `jobId` reason above — and **`years` is the
whole span**: `marketYearsOf(row)` in `_scraper/jobs-model.mjs`, ascending,
every season from the one it was ADVERTISED in (`posted`), through the one it
is FILED under (`year`), to the one its DEADLINE falls in. 96 of the 568
served postings span two seasons; none spans three, and none can span far —
`deadlineDay` refuses a closing date more than 730 days from the posting date,
so `MARKET_SPAN_MAX` (3) is a guard against junk rather than a policy.

**It is DERIVED, on every build, from fields the row already publishes**, so
it needs no decision, no document and no migration. `withMarketYears` is the
one writer, pure and idempotent and by-value, and it is applied wherever a row
is made or carried:

* `rowFromSubmission`, last — after `healReviewDate`, which is what settles
  the suggested date the span may be read from;
* `rowsFromTab`, so `data/jobmarket.json` states it too;
* `build-jobs.mjs` over the **merged set**, which is the only place a carried
  ORPHAN — a posting with no document behind it — can gain one;
* `import-legacy-tables.mjs`, on write and in `--heal-names`, because the
  archive has no daily build (nine of its 159 rows span two seasons);
* `sync-jobmarket-sheet.mjs --heal-names`, which is how the committed file
  gained the field without waiting for the workbook to change.

**AFTER the heal count in build-jobs, deliberately, and skipped in
`diffRows`.** The field is derived from `posted`, `year` and the two apply-by
dates, so the run that first writes it changes every row exactly once:
counting that as a heal would have named 568 innocent postings in the log, and
diffing it would have mailed the maintainer 568 phantom edits — both mistakes
this file already records, one paragraph apart.

**What reads it.** The archive's "Job market year" filter is `field: 'years'`
(`previous-markets.html`), so a search advertised in one season that closes in
the next is found under either — the values are the same year strings, so
`?filterB=2025` still works, and the page fills the span in for a row from
either of its two files that predates the field. The card names both seasons.
The Excel download keeps "Market year" as one sortable number and says the
rest in **"Also listed under"**. `postingYears()` in `assets/oa-jobform.js` is
the browser twin, so the note under the form promises the seasons before the
posting is sent; `testFormMarketYearParity` pins it against `marketYearsOf`
over one fixture list, both halves built against the same day (the fallback
leg is "today", and a stub that differs measures itself).

**`inCurrentMarket` is deliberately UNCHANGED.** Its three legs already put a
spanning posting on the jobs page in both seasons — the posting-date leg
during the first, the `year >= current` leg through the second — so the
overlap needed nothing there, and widening leg 3 to the span would have
revived expired postings from a closed season onto the live page. The archive
is still exactly the complement of that predicate; what changed is only which
year buckets the archive files a row under.

**AND IT CHANGES WHAT THE REPORT ABOVE MEANS, WITHOUT RETIRING IT.** A flagged
posting is no longer MISSING from the season its dates name — it is listed
under both — so the card reports a disagreement to READ rather than a posting
to rescue, and "leave it where it is" is a complete answer. That is what makes
settling one the ordinary outcome rather than correcting the workbook, which
is why the panel says so and why the decisions are stored at all. (Retiring
the report was tried in the same change and reverted: the overlap answers
"where is this posting listed", not "is its filing right", and the owner had
just asked for the panel to be made clearable rather than removed.)

### …and the DECISIONS are stored, because it could not be cleared

Owner, 2026-08-27: *"I reviewed these jobs but can't clear that queue."* The
panel offered exactly two exits and neither is the answer for a posting that
is filed correctly. **Correct it in the workbook** MOVES it, and by the
paragraph below two of the four the report named that day were plainly where
they belonged. **Wait for the deadline** does not clear it either: Nanyang's
passed on 28 July and it was still listed, because what put it there is the
ROLL, not the deadline. So the tile sat at 4 for ever, while its own comment
in `oa-adminarea.js` already called it "something the maintainer clears — by
settling each posting", which nothing implemented.

    yearChecks/{posting id}   what the maintainer has READ — nothing else
      status: 'settled'       …and left where it is
      stored / should         the pair of seasons the CARD showed
      t                       when

`assets/oa-yearcheck.js` is the pure half (dual-mode, `DOC_KEYS` pinned both
ways against `_firestore.rules`). Three rules hold it together:

* **The decision is keyed on the DISAGREEMENT, not on the posting.**
  `covers()` honours a document only while the report still says exactly that
  pair. Correct a deadline afterwards and the posting comes back, saying so —
  the maintainer has not seen the new pair. That is the `resolutionHash`
  discipline the sibling repository's feedback resolutions use, and it is the
  whole safety argument: a settle cannot silence a disagreement nobody read.
* **Absence means SHOW** — the opposite way round from the job-review queue,
  and deliberately. There, absence means withhold, because a queue that fails
  to write must not leak an unreviewed posting onto the site. Here the
  postings are ALREADY published and the risk runs the other way, so a
  decisions read that fails leaves every posting listed with the settling
  controls withheld, never an empty list.
* **Settling is never a one-way door** (the `newsOverrides` rule): a settled
  posting leaves the list — the list is meant to get shorter — into a
  collapsed panel below it, one click from Bring it back, which DELETES the
  document. There is no second stored state, because absence already means
  "not read yet".

**The "no rules deploy" argument no longer holds**, which is what makes this a
change of position rather than a contradiction: it was written when deploying
rules meant an interactive `firebase deploy` nothing in CI could perform, and
since 2026-08-24 the rules publish themselves. **Inert until they do**, as
always.

### "Open the posting" opens THE POSTING, on the page that has it

The same report, 2026-08-27: the link *"takes me to the full list of jobs, as
opposed to the page of this specific posting so that I can edit it, or remove
it"* — and for Nanyang it opened the list of THIS season, which by definition
could not contain a posting filed under the last one.

It was `jobs.html#job-<id>`, and **neither half of it worked**. A card only
exists while it is one of the ten being RENDERED, of a list built from a fetch
that has not landed when the browser looks for the fragment — `v3.js` resolves
the hash at boot and finds nothing, and nothing else ever looked. And the PAGE
was wrong for half of them: a posting flagged here is one whose season
disagrees with its own dates, which is exactly the population most likely to
have rolled out of the window `jobs.html` shows.

* **`?job=<id>` is the list engine's own `cfg.focusParam`** (`assets/oa-list.js`).
  It is **not a filter**: the row is taken from `rows` ahead of every filter
  and every page, so a search the reader left running cannot hide it. The card
  is opened and scrolled to once; the filter bar, the sign-in lock wrapped
  around it and the result bar go away (a bar over a list of one narrows
  nothing); a `.oa-focusbar` above the card offers the way back, and it is
  **outside all three**, or a signed-out reader following a shared link would
  be locked into it. An id the page does not carry gets an empty state of its
  own — never "try removing a filter", beside a bar the focus has hidden — and
  the PAGE supplies the hint naming the other one, which the engine cannot
  know. A link already copied as `#job-<id>` is honoured once and rewritten to
  the parameter.
* **`assets/oa-jobnav.js` says WHICH page**, from the row itself and at the
  moment the card is drawn — a build runs every twenty minutes and a deadline
  passes at midnight, so deciding in the browser is the only reading that
  cannot be stale. It is also **the one definition** of `marketYear` /
  `marketStart` / `marketLabel` / `inCurrentMarket` for the whole live site:
  `jobs.html`, `previous-markets.html` and the one-pager's jobs teaser carried
  a byte-identical copy each and the report needed a fourth, which is the
  four-copies-of-one-answer shape `oa-countries.js`, `oa-schools.js` and
  `oa-news.js` all exist to prevent. `testJobNavModule` pins it against
  `jobs-model.mjs` over **every served posting at four instants**, the two
  sides of the roll included — not over a fixture list, because the two halves
  disagreeing is the whole failure it removes. `/v2/` keeps its own frozen
  copies, by the rule the three trees are held to.
* **The hiding rule lives in `v3.css`, not `oa-list.css`**, and that was
  measured rather than preferred: `body.v3 .oa-filters { display: grid }` is
  one specificity point above anything the engine's own stylesheet can write,
  so the same rule there is silently inert — which is how
  `previous-markets.html` showed its bar over a single-posting view while
  `jobs.html` did not (there the LOCK WRAPPER was what got hidden). The
  `.oa-data-empty` rule beside it had the matching gap and got `.v3-lock` too.

**Where it overshoots, and why that is the maintainer's call.** A search
advertised in September that stays open until the following July has a
deadline a few weeks past the roll, and reading it literally files a plainly
2025-2026 search under 2026-2027. Two of the four postings the report names
today are that shape (Nanyang, posted 2025-09-24 closing 2026-07-28; Tulane,
posted 2025-09-04 closing 2026-07-01) and two are the genuine article
(McGill and Mannheim, both advertised AFTER the July roll and still filed
under the season before it). Nothing here can tell them apart without
guessing — the only signal is how far into its own season the posting was
made, and a magic April-to-June window is not a rule worth writing. A person
reading four cards can, which is what the panel is for.

Tests: `testMarketYearCascade`, `testFormMarketYearParity`,
`testJobNavModule` and `testYearCheckDecisions` in `_scraper/selftest.mjs`
(the cascade, the forward-only property asserted over every served posting,
that a stored year is kept, the report's field list and that it carries no
address, the shared window rule's parity with the pipeline, the decision
keys pinned both ways against the rules, and the wiring in every file), the
SPAN in the same block (the owner's own case and its inverse, that it always
contains the stored year, that `withMarketYears` is by-value and idempotent,
that all THREE served files state it, the wiring in all five writers, and
that `diffRows` never calls it an edit), and
in `_scraper/page-test.mjs` the market-year block (the tile, the cards, both
seasons named, a link per posting computed from the shared module, the
settle → collapsed-panel → Bring-it-back cycle with the tile following, and a
name carrying markup rendered inert) plus the `?job=` block, which drives the
deep link on BOTH pages in a real browser — one card, opened, the bar and the
lock out of the way, a way back a signed-out reader can press, the legacy
`#job-` form, and the "not on this page" state — and the archive's own
overlap check, a spanning posting found under the season it is NOT filed
under, narrowed by university because the list paginates and "not on page 1"
is not "not listed".

**A browser check must not move with the corpus.** Two pins in that suite named
"University of Mannheim" outright; its postings rolled out of the season the
page shows, both went red, and the `.oa-card` print check downstream of them
threw and took the whole suite with it — nothing but a data commit between
green and red. They read the institution off the RENDERED page now (`DEEP_UNI`
— what is under test is that a legacy deep link still selects AN institution),
which is stronger than recomputing the window in Node because it cannot
disagree with what the page is showing. The market-year fixture's own "rolled"
row is dated for the same reason: to stay in the past whatever day this runs.

## The HigherEdJobs postings are checked against their own ads

The tracking sheet has no deadline column for most rows, so they reach the site
as "Until filled." — the ingest's default for an empty cell, not something
anyone checked. Where the posting links to **higheredjobs.com** the ad states
its closing date in a field of its own, so it is read:
`_scraper/higheredjobs.mjs` (pure: parse an ad, decide what it changes) +
`_scraper/higheredjobs-verify.mjs` (fetch, cache, apply) +
`.github/workflows/oa-higheredjobs-verify.yml` (daily, after the sheet read).
What each ad said is cached in `data/higheredjobs.json`.

**`validThrough` in the page's schema.org block is NOT the deadline** — it is
when HigherEdJobs stops listing the ad, ~18 months out (a post closing on
20 Aug 2026 carries `2028-02-06`). Only the fields in `DEADLINE_FIELDS` may be
read; two selftests pin that this stays true. When an employer labels the
closing date some new way, **add the label to `DEADLINE_FIELDS` — never
hand-edit `data/`**, exactly as with the country aliases: `jobmarket.json` is
rebuilt from the workbook every morning, so the sheet sync re-applies the cache
on every read and a patched row would come back the next day.

**A deadline the maintainer typed into the sheet is never overwritten.** The
pass only fills a row that had none; a disagreement is reported as a warning
naming both dates, so the sheet is corrected at the source. An ad that cannot
be read changes nothing — this is an enrichment and must never fail a run.

Local runs: `node _scraper/higheredjobs-verify.mjs --apply-only` (re-apply the
committed cache) or `--scan`. A real read needs egress to higheredjobs.com,
which this build environment denies (403), so it happens on the runners.

## …and every OTHER advertisement is read too

HigherEdJobs is 156 of the sheet's 449 postings; the rest link to ~120 other
hosts — Interfolio (36), Chronicle (27), the INFORMS career center (18),
Inside Higher Ed (15), and a long tail of one-per-university applicant
tracking systems (Workday, PeopleAdmin, Cornerstone, Taleo, Oracle…). Those
were never checked at all, so their postings published "Until filled." and
their review cards asked the maintainer to open every advertisement by hand.

    _scraper/adverts.mjs           parse any ad, decide what it changes (pure)
    _scraper/adverts-verify.mjs    fetch, cache, apply — and the queue pass
    .github/workflows/oa-adverts-verify.yml   daily, after the two above

One generic HIGH-PRECISION parser — schema.org JobPosting JSON-LD plus a
labelled-field scan over the three shapes these systems write facts in
(`<strong>Label:</strong>`, `<th>/<td>`, `<dt>/<dd>`) — plus the one adapter a
host actually needs: Workday pages are a JavaScript shell, so they are read
from the tenant's public CXS JSON endpoint (`workdayApiUrl`). A page in a
shape it cannot read parses to `unreadable` and CHANGES NOTHING — that is
what makes a generic parser safe across a hundred hosts (the PDFs some rows
link to, and any bot-walled board, land there too). Google Docs, LinkedIn and
higheredjobs.com are never fetched — the last because that host has its OWN
pipeline, and two caches for one advertisement would disagree silently
(`isAdvertUrl`; one URL, one owner, pinned in the selftest).

**Two lessons from elsewhere in this repo are LOAD-BEARING here.**
`validThrough` — and every label naming the LISTING's end ("End date",
"Expires") — is NEVER read as a deadline anywhere in the module: on a board
it is when the AD comes down, ~18 months out on HigherEdJobs and the paid
listing's end on the Madgex boards. It is recorded separately as
`listedUntil` and shown labelled as what it is. And an ambiguous all-numeric
date ("05/10/2026" — Coventry writes day-first, Salt Lake City month-first)
is REFUSED rather than guessed: unlike the sheet ingest's `deadlineDay`,
which has a cell that must mean something and a posting date to test a repair
against, a scraped page can afford "no date, prose kept".

**What it writes, and where.** For the PUBLISHED postings it is exactly the
HigherEdJobs pass again: what each ad said is cached in `data/adverts.json`,
deadlines fill ONLY rows the sheet left open-ended (both fields move
together), a deadline the maintainer typed is never overwritten — the
disagreement is a warning naming both dates — and `sync-jobmarket-sheet.mjs`
re-applies the cache on every workbook read, or the morning rebuild would
revert every filled deadline. For the PENDING queue it records what the ad
says ON the review document as `ad` (title, institution, closing date,
`listedUntil`, whether the listing is even still up) — never in `data/`,
because a pending posting is not public and everything under `data/` is
served to anyone who asks. The review card and the review e-mail then draw it
beside `dup` and `biz`, and like them it is RAISED, NEVER DECIDED: the
card's "Use this closing date" button only fills the box, and nothing
publishes until the maintainer approves. The queue pass writes the `ad`
block and nothing else — never the decision, never the edits (the selftest
pins the merge as the file's only document write). A pending HigherEdJobs ad
IS read here (via that host's own parser), because the published HigherEdJobs
pass only ever sees approved rows.

**The ad's three names are CLASSIFIED against the site's own vocabulary**
(owner, 2026-08-24: "categorize the University, the Business School Name and
Department correctly"). The parsers also read the school and department a
page states (`SCHOOL_LABELS`/`DEPARTMENT_LABELS` — a value that merely
repeats the organisation's own name is nothing), and `advertPlace` in
`adverts.mjs` turns the stated names into the site's three: a hiring
organisation that is really a SCHOOL — "Harvard Business School", the
Interfolio shape — is filed under its university via
**`universityForSchool`** in `vocab.mjs` (the `businessSchoolOf` discipline
inverted: canonicalised, folded, and only an UNAMBIGUOUS answer given), the
three then go through the posting form's own `canonColumns()`, and an empty
school whose department the directory can place is settled by
`schoolForUnit`. Curated, never guessed — a name the vocabulary has never
seen is offered exactly as stated, and `settlePlace` canonicalises whatever
the maintainer adopts. The review card draws the classification with a
**Use these names** button (the stated school/department get a button each
where the vocabulary had no answer), the review e-mail says the same thing,
and the QUEUE pass now runs BEFORE the published one — the pending postings
are the ones the maintainer is actively deciding, so a run's read budget
goes to their cards first.

**`_ADVERT-HOSTS.md` is the inventory of where the advertisements live** —
the distinct websites carrying this and last market year's postings (the
years from the site's own roll rule, never from whatever stray years the
data holds), drive/docs links excluded as user-uploaded copies whose address
changes every time. A snapshot, regenerated by
`node _scraper/adverts-verify.mjs --hosts --write` over the committed data
(offline); each host names the pipeline that reads it.

**When an employer labels the closing date some new way, add it to
`DEADLINE_LABELS` in `adverts.mjs` — never hand-edit `data/`** (the
HigherEdJobs rule, same reason: the data is rebuilt every morning). The
school/department labels grow the same way (`SCHOOL_LABELS`,
`DEPARTMENT_LABELS`). Local runs: `--apply-only`, `--scan`, `--hosts`,
`--selftest`; a real read happens on the runners (this environment's egress
denies every one of these hosts), and the workflow's `dry_run`/`scan`
dispatch inputs are how a new host's readability is measured before anything
is written. The queue pass needs `FIREBASE_SERVICE_ACCOUNT` and is a clean
no-op without it.
## Two deadlines per posting: suggested and final

Many searches have no fixed closing date yet name the day that matters most —
the first-review / full-consideration date ("First review of applications will
begin on September 8, 2026, and will continue until the position has been
filled"). Those postings read a bare "Until filled." So a posting carries TWO
dates (owner, 2026-08-23): **`reviewDate`**, the SUGGESTED apply-by, and
**`applyByDate`**, the FINAL one — which alone still drives the market roll
(`deadlineOpen`): a review date passing does not close a search. The card shows
"Suggested apply by" (only where known) above "Final apply by"; the jobs page
filters on each (**Suggested deadline**: Review ahead / Review passed / No
review date — its own vocabulary, because "Expired" is the wrong word for a
date that closes nothing; **Final deadline** keeps the vendor page's three
words AND its `deadline` URL key, so every saved link works); the posting form
asks the two dates as two questions, the review card offers the box, and the
alert e-mails + the alerts page's preview name both ("suggested apply by … ·
final apply by …").

**The suggested date is read out of the prose the sources already carry** —
`extractReviewDate` / `extractFinalDate` / `healReviewDate` in
`jobs-model.mjs`, the deadlineDay discipline throughout: every pattern demands
the reviewing/consideration context in the same sentence as a date WITH a
four-digit year, an ambiguous `10/12/2025` is refused rather than guessed, and
a posting the extractor is unsure of keeps reading "Until filled." exactly as
the owner asked. A suggested date ON OR AFTER the final one is dropped
wherever it is set (equal is the deadline said twice — half the corpus; later
contradicts it): in `healReviewDate`, in `applyEdits`, in the form's own
validation, and when the HigherEdJobs verify fills a closing date onto an
open-ended row. `healReviewDate` is pure, idempotent and fill-empty — the
`healPlace` pattern — applied at `rowFromSubmission`, the sheet ingest
(`rowsFromTab`, which also trims the captured sentence so the Kansas card
reads "Suggested apply by: September 8, 2026 · Final apply by: Until
filled."), the sync's `--heal-names`, and the whole merged set in
`build-jobs.mjs` beside `healCountry` — so rows from every writer heal on
every build, and the committed files were healed once with the same function
(17 postings gained their date). `extractFinalDate` reads only an explicitly
LABELLED closing date ("Final date: Thursday, Nov 5, 2026" — UCLA's
application-window cell); a bare "deadline" heading clauses away from a date
is exactly the mislabelled-header mis-read and never fires. And the source's
own labelled WINDOW can settle both fields at once: UCLA reached the site
with its review date recorded as the closing date while its own words on the
row said "Next review date: Oct 5 … Final date: Nov 5" — where the stored
closing date IS the text's stated review date and the same text labels a
final date after it, the stated final date wins and the review date takes
its own field (`window` in healReviewDate; both labels must be explicit and
agree with the stored date, so it can never fire on a date the maintainer
simply typed). `reviewDate` is in
`PUBLIC_FIELDS` (skipped when empty, like `ref`), in the jobSubmissions rules'
`shapeOk` and the jobReviews `edits` list, and `testTwoDeadlines` /
`testTwoDeadlinesWiring` in selftest.mjs pin the extractor, every guard and
every surface. The `/v2/` archive deliberately ignores the new key — its
frozen assets read `applyBy`/`applyByDate` exactly as before.

## The frozen archives, and how the maintainer edits them

`data/past-postings.json`, `data/recent-faculty.json` and
`data/universities.json` are written ONCE by `_scraper/import-legacy-tables.mjs`
from Google Sheets and committed — `.github/workflows/oa-legacy-import.yml` has
no schedule. They have no Firestore backing and never will, so the three pages
that render them (`previous-markets.html`, `recent-faculty.html`, and the
Leaflet map on `universities.html`) were read-only for EVERYBODY, the
maintainer included: correcting a school's name meant editing a spreadsheet and
dispatching a workflow by hand.

**`assets/oa-rowedit.js` corrects a row AT READ TIME**, from a public-read,
admin-write Firestore collection `rowOverrides` (`<dataset>__<rowId>`). It is
the `newsOverrides` pattern already shipped on `/whats-new`, generalised: the
committed JSON stays the source of truth, an override MASKS or REWORDS one of
its rows, the correction reaches every visitor, and **re-running the import
cannot undo it** — the overlay is applied on top of whatever the import
produces. One module serves all three: `apply()` for the rows a page renders,
`onCard()` for an OAList card, `onPopup()` for a map pin (`assets/oa-uni-map.js`
gained `prepare`/`onPopup`/`refresh` hooks for exactly this).

**It is deliberately NOT an add path.** An override only ever changes a row that
already exists. A school the archive does not carry is added upstream, in the
sheet the import reads — two places that can both create the same row is the
parallel bookkeeping `build-jobs.mjs` warns about, and it rots: the import would
later publish the school itself and the site would list it twice.

**Hiding is never a one-way door.** A row the maintainer takes down is hidden
from every visitor but still shown TO THEM, faded and carrying Restore — filter
it out for everybody and there is nothing left on the page to press to bring it
back. `newsOverrides` had exactly that shape (and no `allow delete`, because
`request.resource` is null on a delete so an `allow write` condition errors and
evaluates false); both were fixed together.

**Adding a field to the editor means adding it to the rules in the same
change** — `selftest.mjs` pins every key `oa-rowedit.js` can write against the
`hasOnly` list in `_firestore.rules`, so a field with no rule fails the build
rather than the maintainer's save.

`previous-markets.html` carries TWO kinds of row and therefore two editors: the
postings folded in from `data/jobs.json` are real submissions and get the FULL
form (`oa-jobedit.js`), and it is the ONLY page that reaches them — the jobs
page and the one-pager both filter to the market under way. `oa-rowedit.js`
stands down wherever `oa-jobedit.js` has drawn.

**None of this is live until the rules are deployed.** No workflow runs
`firebase deploy` — it needs an interactive login — so after any change to
`_firestore.rules`, run `firebase deploy --only firestore:rules` from the
repository root. See `_SETUP-FIREBASE.md` §4.

## The Universities directory — one card per university, editable by anyone signed in

`universities.html` is a CARD DIRECTORY since 2026-08-24 (owner: one card per
university — its business school, its engineering/non-business school, each
school's departments inside it), with the Leaflet map kept as the second view
behind a Cards ⇄ Map switch (mounted lazily; the map half is unchanged —
`data/universities.json` + `rowOverrides`).

    _scraper/directory-model.mjs   what merges with what, and why (pure)
    _scraper/build-directory.mjs   writes data/directory.json + directory-meta.json
    assets/oa-directory.js         grouping, the OAList mount, the edit layer
    assets/oa-directory.css        the page's own chrome, theme tokens throughout

**`data/directory.json` is a BUILT file** — offline and deterministic, merged
from the curated archive (`data/universities.json`), the `oa-institutions.js`
seed and BOTH postings files, every name through `canonColumns()`. It is
rebuilt as the last step of `oa-jobs-build.yml`, so **a posting always fits
under a card, and a posting from a place no source lists CREATES its card in
the run that published it** (the owner's rule). Two bounded folds keep the
table clean without guessing: a school-less posting joins the ONE schooled row
carrying its department (the `fillSchoolFromDirectory` discipline), and a bare
acronym department folds into the ONE row whose initials spell it (the
search's own acronym rule). A row's `id` is derived from the folded names
(`rowKey` — `institutionKey` for the university part) and is what an edit is
keyed on, so it never depends on array position.

**`directoryEdits` is the read-time overlay, and ANY REGISTERED USER writes
it** (owner, 2026-08-24) — the `rowOverrides` pattern with the write opened
from the maintainer to every signed-in account. An edit stores only what
differs from the committed file; `add: true` marks a row contributed whole;
every document carries `by` (pinned to the writing uid by the rules, so
attribution cannot be forged), `name` and `t`, and **every card shows "Last
edited by <name> on <date>"**. Renaming a row so its names match another
row's MERGES the two on screen — that plus the maintainer-only `hidden` flag
(the duplicate's takedown, faded-with-Restore for them, never a one-way door)
is the merge tool. The maintainer alone also deletes a document ("Reset to
file") and alone sees the **"Last edited" filter** (an `order`ed, `className`-
hidden OAList filter — two small generic options added to the engine for it),
which exists to drive a review sweep. `testDirectoryModel`/
`testDirectoryWiring` in selftest.mjs pin the merge rules and the
module↔rules field lists BOTH WAYS; page-test.mjs measures who is offered
which control, the attribution line, and the page's mobile gate (it is in
`MOBILE_PAGES` now — the cards are an OAList mount; the map view keeps its own
phone block, which switches views first). **Inert until the rules are
redeployed**: `firebase deploy --only firestore:rules --project
operations-academia`.
## Nothing from the tracking sheet publishes itself

A posting crawled from the job market workbook is **queued for the maintainer,
not published on sight**. It appears at the top of `admin-area.html` — the
maintainer's Admin area, above the feedback inbox (it lived on feedback.html
until the Admin area gathered every review queue) — every field editable;
approving it puts it on the site at the next build, rejecting keeps it off
for good.

The reason is that the pipeline **derives** things the sheet never said — the
market year, the type of institution, the canonical country, the entry level,
and the closing date read off the HigherEdJobs advertisement. Those reached
visitors before anyone had looked at them.

    _scraper/jobreview.mjs         what is publishable, and what an edit is (pure)
    assets/oa-jobreview.js         the panel on admin-area.html
    _scraper/jobreview-mailer.mjs  one e-mail per queued posting
    oa-jobreview-mail.yml          runs it every 15 minutes

**The queue is a Firestore collection (`jobReviews`), never a file under
`data/`.** Everything in `data/` is served by Pages to anyone who asks — CI even
checks that no e-mail address reaches it — so a posting "not yet public" cannot
sit there in any form. `data/jobmarket.json` therefore becomes what it always
claimed to be: the **approved** postings, and nothing else.

Three rules worth keeping:

- **Absence means withhold.** A row with no queue document is never published.
  Expressed that way round — rather than "a rejection means withhold" — so a
  queue that fails to write cannot leak a posting onto the site.
- **An unreachable queue changes nothing.** Without it there is no way to know
  what was approved, and both answers are wrong: publishing everything defeats
  the gate, publishing nothing deletes every posting on the site. So
  `data/jobmarket.json` is left exactly as it is, the same rule the sync
  already applies to a workbook it cannot read.
- **An edit is a correction laid on top, never a rewrite of the row.** The sheet
  stays the source of truth; `edits` is re-applied on every build, so the
  workbook can be re-read every morning without discarding the maintainer's
  work. Same shape as the HigherEdJobs cache and `rowOverrides`.

`EDITABLE` in `jobreview.mjs`, the `FIELDS` list in `oa-jobreview.js` and the key
list in `_firestore.rules` must agree — **selftest.mjs pins all three together,
and BOTH WAYS**: a field the panel offers that the model does not accept is a
tick box that saves and silently does nothing, which is what "Associate
Professor" and "Full Professor" were (the site's five `LEVELS` know only "Other
Ranks"). `id`, `year`, `posted` and `source` are deliberately NOT editable: they
tie the posting to its sheet row, and changing one would make the next sync
queue it again as new. Correct those in the workbook.

**The card asks the posting form's own three name questions, in its words, with
its cascade.** It used to offer FOUR boxes for a place that has three —
`department`, the line the card shows, beside the school and the unit it is
joined from — and nothing kept them in step: correcting the school published a
row whose line still said what the workbook had said, and the selftest's "the
line equals its two parts joined" guard would then stop the whole site
publishing. `department` is DERIVED now (`settlePlace` inside `applyEdits`,
which also puts all three names through the same `canonColumns()` every other
ingest uses — an alias added today reaches a posting queued last week), it
stays in `EDITABLE` and the rules only because an old document may still carry
one (`SHOWN` is what the panel draws), and the card previews the line under the
two boxes exactly as the posting form does. The three boxes mount
**`assets/oa-place-picker.js`** — see the cascade section below — so typing
"University of Chicago" narrows School to Booth and School narrows Department,
the same behaviour the poster gets.

**A crawled posting is checked against the site for DUPLICATES before the
maintainer is asked about it.** A school that advertises through the site's own
form is routinely also entered in the tracking workbook, and the crawled copy
then arrives in the queue as a fresh posting. So the sheet sync runs every
queued row through `duplicatesOf` (jobreview.mjs, pure) against
`data/jobs.json` — same market year, same university (`institutionKey`, so a
"The" cannot hide a match), and either the same advertisement link or the same
department; two rows whose entry levels share nothing are two advertisements
(the Houston lesson), and our own home page in a link column identifies
nothing. The flags are stored on the queue document (`dup`, in `DOC_KEYS` and
the rules' `hasOnly` — pinned both ways by the selftest), re-checked on every
sync so they appear when the duplicate is posted later and clear when it is
taken down, and RAISED, never decided: the review card draws an amber warning
naming the postings it may repeat (measured in page-test.mjs, hostile input
included) and the review e-mail says the same thing. Approve still publishes;
Reject still keeps the crawled copy off.

**The same advertisement twice is not a decision to make** (owner, 2026-08-26:
"check the Link to the advert — if it already exists in a previous posting that
is live or in the queue, then remove that new job from the queue"). A crawled
row whose **advert link** already belongs to a posting the site is showing, or
to one already waiting in the queue, is DROPPED at ingest rather than queued —
`advertRepeat` in `jobreview.mjs` decides it, the sheet sync applies it, and
the maintainer never sees the card.

**Deciding on a shared link is exactly what this repository threw away once**,
so it is scoped by MEASUREMENT rather than by hope. The section below records a
file-level "no two postings name the same advertisement" rule written, measured
and abandoned because City University of Hong Kong links its whole vacancies
page from two market YEARS' postings and UCD links one CoreHR endpoint from
two. Measured over the 542 served postings on 2026-08-26, grouped by (market
year, university, advert link): **481 groups hold exactly one posting and
exactly one holds two** — UCD's endpoint, carrying MIS and Supply Chain
Management. Within a year at one university the link identifies the
advertisement 481 times out of 482, and the one exception is told apart by its
DEPARTMENT. So the three contradictions, each keeping a real posting:

* the market year and the university must match (the CityU case);
* two rows that both name a department, differently, are two advertisements
  behind one endpoint (the UCD case);
* two rows whose entry levels share nothing are two searches from one
  department (the Houston lesson `collapseSameDay` already carries).

Run over the whole served corpus, **none of the 542 is judged a repeat of
another** — the check that says the guards are not merely plausible. Anything
short of a match still gets the amber `dup` flag it got before; this only
removes what it can show is one advertisement twice.

**Dropped means REJECTED, never deleted.** `partition` re-queues a row whose
document is gone, so deleting would re-drop it every sync for ever; a rejection
is the one state that both keeps it off the site and stays out of the pending
list the panel draws. The reason goes in `note` and the posting it repeats in
`dup` — **both already allowed by the rules, so this needed no redeploy**, and
no document is left in a shape the panel is then refused permission to update
(the `sync-user-directory` lesson). The comparison set is what is live PLUS the
rows already queued PLUS the fresh rows the same run has just accepted, so a
workbook listing one advertisement twice queues it once.

It keys on the ADVERT link alone, never on "posted at" — `duplicatesOf` can
afford the wider net because a person reads its answer; this one cannot.
Pinned both ways in `selftest.mjs`, including the UCD and CityU cases and the
sync's own source (rejects, never deletes).

### Every posting under review, and a button to ask again

Dropping a row as it is CRAWLED leaves the queue as it was: every posting
already under review the day that shipped was crawled before the rule existed,
and nothing was ever going to sweep them (owner, 2026-08-26: *"Check ALL jobs
currently under review … apply for all jobs under review"*). So the queue is
swept too — the pending documents FIRST, then the fresh rows measured against
what survived.

**A per-row check cannot sweep a set**, and that is the whole reason
`findAdvertRepeats` exists: two queued rows naming one advertisement are each a
repeat of the OTHER, so checking them independently against the same list drops
BOTH and loses the posting altogether. It keeps what it has already kept, so
exactly one survives — and the rows go in **oldest first** (`queuedAt`), so the
survivor is the one that has been waiting longest.

Three consequences the sweep must carry with it, each pinned: a posting on its
way out is not also **re-flagged** (`dup`/`biz` on a document being rejected),
is not **refreshed** from the sheet, and is not counted among the decisions
still **waiting** on the maintainer. And the write is a TRANSACTION that only
ever moves a document out of `pending` — every other write in that file is
careful never to overwrite a decision made in the browser mid-run, and this one
writes a decision, so it has to look first. A posting approved a second ago is
theirs.

**And the maintainer can ask on demand**: *Check for duplicate adverts*, beside
Approve-all on the crawled tab of `/admin-area`. It is the SAME RULE — the
button and the pipeline read one dual-mode file, `assets/oa-advert-dup.js`,
which `_scraper/jobreview.mjs` re-exports rather than carrying its own copy (the
drift every shared module here exists to prevent; `oa-schools.js`,
`oa-countries.js`, `oa-news.js` are the same shape). Four things it does
deliberately:

* it sweeps the **whole crawled queue**, not the page on screen — a repeat is
  always in the same market year as what it repeats, so no page could show a
  pair the sweep should have left alone;
* it re-reads `data/jobs.json` with **`cache: 'no-cache'`**, because Pages
  serves `data/` with ten minutes of freshness and a stale copy would keep a
  repeat of something published nine minutes ago;
* it **reports before it writes** — every drop is named in the confirmation with
  the posting it repeats, and dismissing it writes nothing;
* it judges the row **as it will publish**, the maintainer's unsaved edits
  included: a link just corrected on the card is the link the check reads.

It is drawn for ONE posting too, unlike Approve-all's `> 1`: a single queued
posting can perfectly well repeat one that is already live, which is the case
that was reported. It is on the crawled tab alone — a user-added posting is
already on the site, and taking it off is its poster's decision or the Take-down
control, never a sweep.

`page-test.mjs` measures the money path in a real browser against its own seeded
pair and its own routed `jobs.json`: dismissing writes nothing, accepting
rejects the repeats (never deletes them), the OLDER of a pair survives, the
document says why it went, and a second press reports that it found nothing.

### "Already listed" is a DECISION, not a deployment

The button missed the case it was built for (owner, 2026-08-26): one of two
identical Stanford MS&E postings was approved, and pressing *Check for
duplicate adverts* then failed to catch the other.

Both halves of the comparison had lost it at once. An approved posting is **out
of the queue** — the panel lists `status == 'pending'` only, and `retire()`
drops it the moment the decision lands — and it is **not in `data/jobs.json`**
either, because that is a built file and the build had not run. For that window
its twin was measured against a set holding NEITHER copy, so nothing could
match.

That is not a race to paper over. `data/jobs.json` lags **every** approval by up
to a build, so "already posted" has to mean what the maintainer has DECIDED, not
what has been deployed. The comparison set is therefore the served file **plus
every approved queue document** — one equality query in the panel (no composite
index), `split.publish` in the sheet sync (already through `approvedRow`). A
posting that has published is in both and matches the same either way; a refused
approved-queue read degrades to the served file alone, which is the old
behaviour, never to a lost sweep.

Pinned both ways, and the browser test seeds the exact shape: `rp4` pending and
`rp5` approved, one advertisement between them, with the served file EMPTY of
both. Reverting the fix makes that test time out rather than fail quietly — the
twin is never caught.

## An approved posting is on the maintainer's jobs page at once

Owner, 2026-08-26: *"when I press a job under review to become public, it should
immediately show up in the list of job postings available to the public."*

Approving writes Firestore; the BUILD turns that into a row in
`data/jobs.json`. Until it runs the posting is in neither place — out of the
queue and not on the site — which reads exactly like an approval that did not
save.

**The doorbell that was supposed to close that gap has never rung.**
`publishOnReview` and `publishOnChange` are in `_functions/index.js` and neither
is deployed: the `oa-jobreview-decided` dispatch has **zero runs, ever**, and
all 251 `oa-jobs-changed` dispatches were sent by `github-actions[bot]` — the
sheet workflow's own final curl — never by the function. So an approval waits
for the build's 20-minute schedule while the card said "publishing starts now".
That is this file's own recorded trap: *a doorbell that was never deployed looks
exactly like a site that is simply slow*. One `firebase deploy --only functions
--project operations-academia` fixes it for everybody; nothing in CI performs
it.

So the approval is **echoed**, the way a saved EDIT already is
(`assets/oa-fresh.js`): the published row is left in that browser's
localStorage and every page rendering `jobs.json` overlays it at read time. Two
things had to grow for it:

* **the echo can now ADD a row**, not only change or remove one. An edit
  overlays a row that exists; an approval creates one, so `overlay` inserts it
  and marks the echo spent the moment the served file carries that id.
* **`OAFresh.approvedRow`** — a browser twin of `jobreview.mjs`'s own, with
  `canonColumns` INJECTED so the file keeps no dependency and the parity test
  can drive it in Node. It is pinned against the real one over a case table
  covering every branch: the derived department line, the derived Apply-by
  line, a suggested date on or after the closing one, an edited line that says
  the search stays open, our own Further-info link following a renamed
  university, e-mails stripped, and dated-from-approval versus grandfathered.
  **A mismatch there would be a private fiction shown to the maintainer for a
  build**, which is exactly what this module's third promise forbids.

The three honesty properties are unchanged and all three are measured in a real
browser: PER BROWSER (a second context with the same served file shows nothing),
it stands down against the build (a build that STARTED after the approval has
the last word), and it echoes only what the build would publish.

**And the copy now says what is true of this installation** — "Approved — and on
your own jobs page straight away. Everyone else sees it at the next build." —
with `selftest.mjs` pinning that nothing the maintainer READS claims a doorbell
nobody has deployed.

**A crawled posting that mentions "business" is flagged under Business School,
and its card NAMES the school** (owner, 2026-08-23). `typeFromNames` used to
read only the employer's name and the field column, so Berkeley advertising a
business-flavoured post filed under "University". It now judges the WHOLE
posting's text — the field column, the advertised title, the notes and the
advertisement's own address — and the bare word "business" (word-bounded, so
"agribusiness" is not it) is evidence enough: the row arrives typed
`Business School`. The sync then asks the site's own vocabulary which school
that IS at that university — `businessSchoolOf` in `vocab.mjs`, the
`schoolForUnit` discipline: answered from the school's own name
(`BUSINESS_SCHOOL_NAME_RX`), through `institutionKey` so any spelling reaches
the entry, and only when UNAMBIGUOUS — and `businessCheck` in `jobreview.mjs`
stores the answer on the queue document as **`biz`** (`{ school }`; `null`
when the posting is not business-typed or its School box already names a
business school). Like `dup` it is in `DOC_KEYS` and the rules' `hasOnly`
(pinned both ways), computed for fresh queue documents AND re-checked on every
sync for pending ones — judged on the row the sheet NOW gives, the refreshed
copy when one is being written that run — and RAISED, never decided: the
review card mentions the school ("The site's directory lists **Haas** …") with
a **Use it as the School** button that only fills the box, the review e-mail
says the same thing, and nothing publishes until the maintainer approves. A
university the directory cannot answer for still gets the flag, saying the
directory has none — the fix is a row in `assets/oa-institutions.js`, the same
rule as everywhere: grow the database, never guess.

**The comments are the posting's DESCRIPTION, and the rank is the Entry
level** (owner, 2026-08-26). The crawler used to open every card's comments
with two columns of the workbook that are not descriptions of the job — the
rank and the town, "AP · Smithfield, RI ·" — on the reasoning that the row's
shape had nowhere else to put them. It has: the rank IS the Entry level, and
the town is the university's, which the site's own Universities directory
holds. So `rowsFromTab` carries only what the sheet says ABOUT THE JOB — its
notes column, and a deadline cell that could not be believed as a date, whose
words are about this posting's own closing date. **`city` stays MAPPED and is
never read**: the tab that heads its school column "Location" needs the second
"Location" to have a name of its own, or the town is back in play as the
institution (see "A header that names one column wrongly").

**And a search advertised across ranks ticks BOTH boxes.** `levelsFromRank`
decides the first four levels by precedence — a visiting assistant
professorship is a visiting post, not an assistant professorship — and the
tenure-track reading that is left is the one exception, because the workbook
routinely advertises one search at several ranks. The owner's rulings, all
pinned in `testJobMarketSheetParsing`: **"AP" is an assistant professorship**
(the sheet's own shorthand); **"Junior level (Assistant or untenured Associate
Professor)"**, **"Open Rank"**, **"Assistant/ Associate"**, **"Assistant/Open
rank"**, **"Assistant/ Associate Professor"** and **"AP/Assoc/Full"** are
Assistant Professor AND Other Ranks together. That is why the senior tokens are
matched BARE (`associate`, `assoc`, `full`) rather than demanding the word
"Professor" beside them — most of these never spell it out. The invariant it
must not cost, and the reason Other Ranks is still tested against what is LEFT
once the entry-level title is removed: **a post advertised ONLY at entry level
never carries Other Ranks**, or the Entry level filter stops narrowing
anything.

Nothing has to be repaired by hand for either: the workbook is re-read every
half hour and `data/jobmarket.json` rebuilt from it, a PENDING queue document's
copy of the row is refreshed by `refreshQueued` on every sync, and an APPROVED
one is re-derived at publish time (`approvedRow` reads the fresh row and lays
the maintainer's edits over it). An edit the maintainer typed is still theirs.

**A deadline the pipeline is unsure of publishes as "Until filled."** (owner,
2026-08-23). `sheetDay` guesses US order on an ambiguous all-numeric cell —
right for a date Google itself wrote, wrong for a contributor typing
day-first: "5/10/2026" meaning the fifth of October published as the tenth of
May, a deadline BEFORE the advertisement went up. `deadlineDay` in
`jobmarket-sheet.mjs` now believes a parsed deadline only when it is PLAUSIBLE
against the posting date — on or after it, within `DEADLINE_WINDOW_DAYS`
(730) of it. An ambiguous day/month whose US reading fails that test is
re-read the other way round first (the one honest repair — only one of the
two readings can be a date the advertisement could have meant); a cell
neither reading can save, or that never parsed at all, publishes NO date —
which the page already shows and buckets as "Until filled." — and its own
words are carried onto the card as `Deadline as listed: …` in the comments,
so the maintainer can settle it on review instead of the claim being silently
lost. The HigherEdJobs verify still fills genuinely-known deadlines from the
advertisements themselves, unchanged.

**An approval also DATES the posting from the day it was approved**
(`approvedRow` in jobreview.mjs — applyEdits plus the re-stamp, used by
`partition` AND by build-jobs' direct read of the queue, so the two writers
cannot disagree). `addedAt` is what the e-mail alerts window on, and the
queue's copy carries the day the CRAWLER first saw the row — days before
anyone could read it on the site, so a posting approved after a subscriber's
last digest fell outside every window and was announced to nobody.
Grandfathered documents are exempt, and the discriminator is exact: partition
stamps their `reviewedAt` and `queuedAt` from the same instant, while a real
decision's `reviewedAt` is the browser's own later write.

**A workbook posting is given the school its department sits in** —
`fillSchoolFromDirectory` in `vocab.mjs`, applied by the sheet sync at ingest
(and by its `--heal-names`). The workbook's one hiring-unit column holds the
department, so fifteen of its sixteen postings arrived with a department and NO
school — "University of California, Berkeley" + "Operations and Information
Technology Management", with Haas missing — while `data/vocab.json` (the
Universities directory + the `oa-institutions.js` seed) already knew the
answer. Curated, never guessed: only where the school is EMPTY, only where
exactly ONE school at that university carries the department, and never from a
name the site does not already publish. It is the offline twin of the form's
`inferSchool`. A posting it cannot settle (a programme rather than a
department, a department named differently from the school's own, Rutgers'
school-as-university) is the maintainer's call, made on the review card's
cascade — never a guess. **To make a future posting resolve, add its
(university, school, department) row to `assets/oa-institutions.js`** — the
same rule as everywhere else: grow the database, never hand-edit `data/`.

**It is inert until `_firestore.rules` is redeployed** (`firebase deploy --only
firestore:rules`) — until then the panel says permission-denied — and the
e-mail half is inert until `SMTP_*` is set, which stamps nothing, so the
postings are announced once it exists.

### The gate arriving is not a reason to retract

Sixteen of the sheet's postings were on the site before the queue existed, and
the first morning it answered they would all have had no document and therefore
come DOWN — off the jobs page, after e-mail alerts about them had gone out.
Already public is already reviewed in the only sense that matters here, so
`partition(rows, docs, { published })` takes the ids the site is showing and
enters those rows APPROVED, with the reason written into the document's `note`.
Rejecting one still takes it down. Everything the site is not already showing is
queued pending, which is the whole of the gate for every posting from here on.

### Two sources, one panel

The postings the maintainer reviews come from two places and their jobs
differ (owner, 2026-08-23), so `oa-jobreview.js` draws the panel as two tabs:

* **Auto-crawled jobs** — the tracking sheet's queue above: a GATE, held back
  until approved, every field editable on the card, Approve-all included.
* **User-added jobs** — postings made through the site's own form
  (`jobSubmissions`). These are LIVE within a minute — the form promises as
  much and nothing about this panel changes that — so their tab is a
  dedicated, editable to-do list, never a gate: *Open & correct* opens the
  poster's own form, *Mark reviewed* writes the `reviewedAt` stamp the
  submissions model names. The job half of the "Posted through the site"
  panel moved here (one queue, one surface — the drift rule that swept
  feedback.html); the candidate half stays there, and the submissions MAILER
  still announces both kinds.

The market-year tabs are kept INSIDE each source tab, and every list ranks
the NEXT market's postings first — 2028's before 2027's before 2026's, the
newest advertisement breaking ties within a market — because the market a
posting is FOR is the one its review is urgent for. The "Job postings to
review" tile and the account-menu badge count both tabs (`waitingJobs` in
`oa-adminarea.js`), so the tile and the panel beneath it cannot disagree.
`page-test.mjs` measures all of it against the seeded queue.

### A season is not six postings

The queue's unit of work is a market, not a posting: the "2026 Jobs" tab alone
opens with 89, and a whole workbook in scope holds several hundred across two
seasons. Three things follow, and each of them is what keeps the gate from
becoming the bug it was built to prevent — postings not on the site:

- **The panel approves a page at once.** `approveAll` in `assets/oa-jobreview.js`
  does exactly what the per-card path does, edits included, one write at a time
  with the failures counted rather than thrown. A gate that can only be cleared
  89 times does not get cleared.
- **The queue is split by market year**, newest season first and selected by
  default, which is what makes "approve everything here" safe to press: a
  posting approved from a closed season is correct and lands on Previous
  markets, and is not what someone clearing this queue in September is doing.
- **A burst is one e-mail.** One per posting is the owner's choice and right for
  the market ticking over; 89 of them is a mail bomb from the site's own address
  that the provider would cut off half way. Above `BURST` (12) the mailer sends
  a single list instead, stamping `mailedAt` per document so the two paths share
  one high-water mark.

**Approving publishes at the next BUILD** — build-jobs.mjs reads the approved
queue documents directly (`approvedRow`, ahead of the next sheet read), and
`publishOnReview` in `_functions/index.js` rings the sheet read the moment a
decision lands, with the build chained on its completion. Either way an
approval is on the site in a couple of minutes; the half-hour sheet schedule
is the safety net, not the promise. If any of that changes, change the panel's
and the e-mail's promise with it.

## …and what is posted through the site's own forms is ANNOUNCED

Two queues reach the maintainer and only the sheet's ever said anything: a job
posting or a candidate profile made through `post-a-job.html` /
`post-a-candidate.html` went into Firestore, was published by the next build,
and nobody was told. For candidates that was the worse half — profiles are held
behind the reveal date (`data/candidates-reveal.json`), so they reach no served
file, draw no card anywhere on the site, and there was NO screen that could
show them at all (the only route to one was guessing its document id).

    _scraper/submissions-review.mjs   which submissions are waiting (pure)
    _scraper/submissions-mailer.mjs   one e-mail per submission
    assets/oa-submissions.js          the candidate half of the panel on admin-area.html
    oa-submissions-mail.yml           runs it every 15 minutes

The PANEL half is split since 2026-08-23: `oa-submissions.js` draws the
candidate profiles, while user-added JOB postings are listed by the review
panel's own "User-added jobs" tab (`oa-jobreview.js` — see "Two sources, one
panel" above). Both surfaces read the same LIVE statuses and tick with the
same `reviewedAt` stamp, so a card marked reviewed on either is marked for
the mailer too; the mailer itself still announces both kinds.

**It is a NOTIFICATION, never a gate.** The forms promise "within a few
minutes" and keep it; the e-mail says a posting is already live, and says a
candidate profile is held until the reveal date — which is why the e-mail (and
the panel it links to) is the only place the maintainer will see one. The
bookkeeping lives ON the submission itself, not in a new collection:
`announcedAt` is the mailer's high-water mark (stamped only after a send
succeeds, so a run that cannot send announces the same submission next time),
and `reviewedAt` is the panel's "I have looked at this" tick. Both collections
were already admin-read and admin-write in `_firestore.rules`, so **no rules
redeploy was needed** — selftest.mjs pins that, because a feature that needs
one looks installed and is inert.

**The feature arriving is not a reason to send a hundred e-mails.** Anything
created before `SINCE` that the site is ALREADY showing is stamped without an
e-mail — both conditions, and the date is what makes the pair safe: "already on
the site" alone would swallow a genuinely new posting, because the build
publishes it within a minute of its arrival. A backlog submission the site is
NOT showing is announced — that is exactly the held-candidates case. Above
`BURST` (12) a batch goes as one list, sharing the review mailer's reasoning.

### …and the maintainer's e-mail says WHO posted it

Owner, 2026-08-29: *"include to the email sent to the admin (and only) who made
such a posting. If it was a user show their name and email … else show 'Posted
by: auto-crawler from..' e.g. the JM Google Sheet."*

Two roads reach the jobs page and only a person walks one of them, and from the
maintainer's inbox the two were indistinguishable: the review e-mail and the
submission e-mail carried the same fields and neither said where the posting had
come from, so "did somebody send this, and who?" could only be answered by
opening the Admin area and finding the card.

**`postedBy(doc, row)` in `jobs-model.mjs` is the one definition**, because both
mailers need the same answer and two copies of one rule disagree silently — the
reason `oa-countries.js`, `oa-schools.js` and `oa-jobnav.js` all exist. It lives
there because that file already owns `source`, which is the field that settles
it.

**THE SOURCE WINS OVER THE DOCUMENT.** A tracking-sheet MIRROR is an ordinary
`jobSubmissions` document the moment the maintainer edits it (`sheetHandover`),
so "a document exists, therefore a person made it" would report the workbook's
own rows as somebody's submission with no name on it. A source `CRAWLER_SOURCES`
knows is a crawler whatever else the document carries; only then is a person
looked for. A source nobody here knows is named as ITSELF rather than guessed at
or dropped, and a document with neither says *"not recorded"* — a blank line in
a message whose whole point is to answer this question is worse than an honest
one.

The review mailer supplies the source as a FACT about its own collection
(`jobReviews` holds the tracking sheet's rows and nothing else), so a document
written before the row carried one still reads as the crawler; that is a fact,
not a second rule, and `postedBy` goes on answering from the data for every
other caller. It links the workbook where `data/jobmarket-sheets.json` names the
current one — never a hard-coded id, because "one workbook per cycle" is that
file's whole premise.

**"(AND ONLY)" IS THE HALF A TEST HAS TO HOLD.** The address is the maintainer's
to see and nobody else's: it is not in `PUBLIC_FIELDS`, so it never reaches
`data/`; `stripRowEmails` keeps it out of the text there; and it must never be in
the e-mail the POSTER receives, which is checked by slicing that renderer out of
the mailer's source and asserting it reaches for no admin-only field. **That
slice is bounded at BOTH ends and its length asserted** — this file's own
selftest fixtures name `chairEmail` a few hundred lines further down, and a slice
taken on the wrong marker passes every negative check by vacuity.

### …and the POSTER hears when their posting goes live

The same message: *"any user who submits a job posting, should receive an email
with the details of their posting once it becomes publicly shown on the website,
and thank them for using OperationsAcademia.org and wishing them all the best to
fill their position."*

The site told them nothing after the thank-you screen, which said in as many
words that no confirmation e-mail would be sent. They had a reference number and
a promise of "a few minutes", and no way to know the minutes had passed short of
going and looking. That copy is now false and was corrected in the same change,
along with the Privacy Policy — a site that sends a message and says so nowhere
is wrong whatever its rules allow.

    partitionLive        WHEN, in _scraper/submissions-review.mjs (pure)
    renderLivePostingEmail  WHAT, in _scraper/submissions-mailer.mjs
    thankPosters         the pass, off the same read as the maintainer's

**"PUBLICLY SHOWN" IS MEASURED, NEVER ASSUMED.** The condition is that the
posting's row is in the served `data/jobs.json` this run has just read — the same
set `partitionSubmissions` already reads for its grandfather rule. So the e-mail
cannot go out ahead of the build, cannot go out for a posting a guard held back,
and cannot claim a link that would 404. **What it prints is the SERVED row**, so
a name the build canonicalised, a deadline it healed and the market years it
derived read exactly as a visitor reads them — and it is built from that row
rather than from the document, which is structurally why the chair's details and
the private note cannot be in it.

**WHICH row is `matchServed`, and the first version of this shipped it wrong.**
The obvious join is the id the submission derives — and it is the one thing that
cannot be used, because `jobId` is (market year, institution, posting date) and
names **no department**. Two colleagues at one school posting on one day derive
the SAME id; the build knows this and renumbers them with `assignIds` (`-2`,
`-3`); a pass that RE-derives the id looks up the base and gets the FIRST of
them. Every later poster was sent a stranger's posting — wrong department in the
subject, a link to somebody else's card, their own reference number printed
beside it — and then stamped, so the right e-mail could never follow. It is not
a corner: **four of the thirteen postings made through the form that the site is
showing today carry such a suffix**, from two same-day groups six days apart, and
an unclaimed workbook row can take the base id and push a user posting to `-2`
just as easily.

So the join is, in order: **`ref`** — the form issues it, it is unique per
submission, it is in `PUBLIC_FIELDS` so the row carries it, and nothing else on
the site has one (the workbook's rows and the legacy import have none), which
makes it the only key here that identifies a SUBMISSION rather than a place and
a day; then **`publishedId`**, the id the build actually published, stamped onto
the document by build-jobs (only for documents queued at build time, so a second
chance rather than the rule); then the **derived id**, and only when exactly one
submission in the batch derives it and the row it finds carries no `ref` of its
own.

**"Not sure" means do nothing** — no e-mail AND no stamp, so the next run tries
again. A collision can therefore cost a delayed message and never a wrong one.
That is also why a reference the served file does not carry is simply passed
over: the posting has not published yet, or `collapseSameDay` folded it into a
sibling, and neither is a reason to fall back to a key that can pick somebody
else's row.

**The guard that missed it built its served row by calling the function under
test** (`rowsById([job.row(doc.data)])`), so `assignIds` never ran and no
collision could occur — a fixture that cannot reproduce production proves
nothing about it. The tests drive the real `assignIds` now, in both suites.

**The link is `OAJobNav.hrefFor`**, the site's own page rule, so a posting whose
season has rolled opens on Previous markets rather than on a jobs page that by
definition cannot contain it — the defect that module was written for.

**ONE MARK PER THING THAT CAN HAPPEN.** `liveMailedAt` joins `announcedAt` and
`reviewedAt` rather than sharing either: an SMTP hiccup on the maintainer's copy
must not make the poster unthankable, a tick on the Admin area must not silence
an e-mail, and **a correction must not thank anybody twice** — saving an edit
sets `status` back to `queued` and re-publishes the posting, and the stamp being
already there is the whole of what makes that safe. Sent first, stamped after,
like every other mark here.

**A submission with no reachable address is skipped ENTIRELY** — neither mailed
nor stamped — because an address can be added by a later correction, and a stamp
would make that correction unthankable for ever.

**And a posting the CRAWLER made is passed over whatever address it carries.**
Once the maintainer edits a tracking-sheet mirror it is an ordinary
`jobSubmissions` document, and it can perfectly well carry their own address —
at which point "thank you for using OperationsAcademia.org, we wish you every
success with your search" is addressed to the person who runs the site, about a
row read out of a spreadsheet. `postedBy(doc, row).kind !== 'user'` is the test,
which is the same shared rule the maintainer's "Posted by" line uses, so the two
cannot disagree about what a crawled posting is.

**It has its OWN grandfather date, `LIVE_SINCE`.** Every posting ever made
through the form is live and unthanked on the first run, and thanking a year of
them at once is a mail-out nobody asked for from an address that has never
written to them; those are stamped silently. Sharing `SINCE` — the maintainer
announcement's, set when that shipped ten days earlier — would have done exactly
that. **Two features, two ship dates, two dates.** Moving `LIVE_SINCE` back is
the one-line way to reach postings made before it, and it will write to every
poster the served file carries from that day on.

**JOB POSTINGS ONLY, and deliberately.** A candidate profile is HELD until the
reveal date and appears with everyone else's on the day; "your profile is live"
is a different message with a different trigger. The capability is `tellsPoster`
on the kind, so a second kind is one entry in `KINDS` rather than a branch in the
mailer.

**No rules change, and that is pinned rather than remembered.**
`jobSubmissions` has no `keys().hasOnly()` and no key ceiling on its owner's
update, so an Admin-SDK stamp cannot freeze a posting against its own owner —
the `sync-user-directory` trap. `announcedAt` and `reviewedAt` are already
written the same way.

**A dispatched `--dry-run` prints into the Actions log of a PUBLIC repository**,
so the poster pass names the DOCUMENT it would write to and never the address —
the served files' "nothing public carries an e-mail" rule applied to the one line
here that held a real person's.

Tests: `testPostedByAndLiveEmail` in `_scraper/selftest.mjs` (the shared rule
both ways, the source-wins case, that the poster's e-mail carries nothing
private, that "publicly shown" is measured against the served file, the join
against the real `assignIds` with its collision and its "not sure, do nothing"
branch, the once-only mark, the no-address skip, the crawled-posting skip, the
rules claim, and the corrected copy on both pages), plus each mailer's own
`--selftest` — the review one for the line and the workbook link, the
submissions one for the whole poster e-mail rendered end to end, three same-day
siblings each getting their OWN posting, and the candidate exclusion measured
against a served set that WOULD match (an empty one made it pass for the wrong
reason: with nothing published, no kind could produce mail, so flipping
`tellsPoster` onto candidates left the suite green).

## Nothing on "What's new" publishes itself either

`changelog.json` says WHAT was announced. Firestore `newsOverrides/{changelog
id}` says what the maintainer has DONE about it — and **an entry with no
document is withheld**, exactly as in the job-review queue above.

    status: 'approved'   published — every visitor sees it
    status: 'pending'    not reviewed yet — only the maintainer sees it
    status: 'removed'    taken down — it leaves the list entirely
    title / summary      an optional rewording, applied wherever it is shown

Three rules the owner asked for (2026-08-18), and they only work together:

* **A removed entry LEAVES the list** — for the maintainer too. It used to stay
  on the page struck through, carrying "Hidden — only you can see this", which
  is exactly the clutter Remove was pressed to be rid of.
* **And removing is still not a one-way door.** Filtering it out for everybody
  was what made Remove irreversible before: nothing was left on the page to
  press, and the only way back was the Firestore console. So the removed
  entries go into a **collapsed disclosure below the list**, drawn only for the
  maintainer. The list is clean and the door stays open.
* **A new entry is not public on sight.** `changelog.json` is committed by
  whoever ships a change, and the entry reached visitors AND the e-mail digests
  the moment it landed. Now it waits, flagged for the maintainer, with Publish
  (and **Publish all N** — a change here routinely ships two or three entries,
  and a gate that can only be cleared one at a time does not get cleared).

**The gate arriving is not a reason to retract.** The 35 entries already on the
site have no document, and the whole log would have gone pending on the first
load. An entry dated before `REVIEW_FROM` is approved by default — a DATE
rather than a list of ids, so nothing has to be backfilled and no list has to be
maintained. Back-dating stays safe for the same reason it already was: the
mailer windows by date, so a back-dated entry precedes every subscriber's
window and reaches nobody.

**One file, four consumers: `assets/oa-news.js`** (dual-mode, like
`oa-alert-match.js`). The front page's newest-five list, `whats-new.html`, the
alerts preview and `_scraper/alerts-mailer.mjs` all read the decisions through
it. That is not tidiness: the two pages carried a renderer each and had already
drifted — the front page could edit an entry and the full log could not, one
read the admin address from a literal and the other from `OAFB.adminEmail` —
and the mailer read the raw log, so **an entry taken off the site was still
e-mailed**. `/v2/` keeps its own frozen assets, so rather than carry a copy of
the gate its alerts preview simply stopped reading the live log at all.

**The mailer holds the STREAM at the oldest unreviewed entry**
(`updateWindowEnd`, pure and unit-tested). Each alert's window is a high-water
mark on the DATE of the newest entry sent, so sending an entry dated after one
that is still unreviewed pushes the mark past it — and publishing that older
entry later would then reach nobody, silently and for ever. The digest stops the
day before the oldest entry waiting: publish it or remove it and everything
behind it goes out on the next run, in the order it was written. Delayed, never
lost — including for a subscriber who has never had an update digest, whose
31-day first-window cap is measured back from the END of the window rather than
from NOW, so an entry held longer than a month does not slide out of it while it
waits. **A decision read that FAILS is caught**, not left to reject: it withholds
everything since the gate (the safe direction) rather than killing the job
digests too, which have nothing to do with the update log.

`DOC_KEYS` in `oa-news.js` and the `hasOnly()` list in `_firestore.rules` are
pinned against each other by `testNewsReview()` in `selftest.mjs`, both ways —
a key with no rule is a permission-denied at save time and a maintainer told to
redeploy rules that are already deployed. The browser half (what a visitor sees,
what the maintainer sees, that a removed entry is off the list AND in the panel)
is measured in `page-test.mjs`. **Inert until the rules are redeployed**:
`firebase deploy --only firestore:rules --project operations-academia`.

## The Admin area — one page for everything waiting on the maintainer

`admin-area.html` (owner, 2026-08-23) gathers every review queue in one place:
the job postings to review (drawn by `oa-jobreview.js` in two source tabs —
the `jobReviews` queue held for approval and the user-added `jobSubmissions`,
live but not yet marked reviewed),
**candidate profiles including the ones held for the reveal** — the gap the
page was made to close: the front page said "2 profiles have already been
filed" while the maintainer had no way to SEE them, because held profiles are
kept out of `data/candidates.json` until the reveal date and the candidates
page therefore had nothing to draw its Edit buttons on — the feedback inbox
(`oa-feedback.js`), and "What's new" entries awaiting publication (listed
THROUGH `OANews.partition`, never a second reading of the gate; the publish
controls stay on `whats-new.html`).

The review queue and the inbox MOVED here from `feedback.html`, which is now
purely the public form — the move came with the sweep: `jobreview-mailer.mjs`
points its e-mails at `/admin-area`, and the selftest pins feedback.html clean
of the panels. `oa-feedback.js` serves both pages by mounting the form and the
inbox independently, each only where its markup exists.

**The account menu carries "Admin area N"** — the number of items waiting —
drawn for the maintainer alone (`adminish()` in `oa-accounts.js`: the resolved
session must match `OAFB.adminEmail` verified; the pre-resolve hint's address
alone decides so the menu's first paint is its final form). The count follows
the menu-badge rules above (cache first, refresh once per session, exact where
the data is loaded) and is computed by ONE function for both consumers —
`OAAdminArea.pendingCounts()` in `assets/oa-adminarea.js`, which
`oa-accounts.js` loads on demand (with `oa-news.js`) in the maintainer's
browser only, so the badge and the page's summary tiles can never disagree:
pending `jobReviews` + `heldCount` from `data/candidates-meta.json` (the same
file the front page announces from) + open `feedback` + pending changelog
entries.

**The summary strip ends on one STATISTIC — the Registered-users card**
(owner, 2026-08-23): a `count()` aggregate over `registeredUsers`, the
contentless per-account tally every sign-in already writes (oa-accounts.js).
It is /lit/'s registered-users tile with the visibility inverted — there the
figure is public, here it is **the maintainer's alone**: the collection is
admin-read in `_firestore.rules` (it was public-read, which nothing public
ever consumed) and the Admin area is the one place it is shown. The card is
deliberately NOT a queue: `registeredCount()` in `oa-adminarea.js` is separate
from `pendingCounts()`, so the "Admin area N" badge never counts it (a figure
nobody can clear would inflate it for ever) and no other page's badge refresh
pays a read for it. **The count is of PEOPLE, not sign-ins**: merging two
accounts deletes the duplicate's mark (`runMerge` step 5, while the merge can
still write as that user — the owner-delete the rules allow), so the figure
comes down on its own; a mark orphaned any OTHER way (an account deleted in
the Firebase console) stays until something like /lit/'s registered-users
audit exists here. The tightened read rule is **inert until redeployed**
(`firebase deploy --only firestore:rules --project operations-academia`) —
the card works either way, since the admin passes both rules; only the
public's API access waits on the deploy.

Candidate cards offer **Edit**, which opens the SAME form the candidate used
(`post-a-candidate.html?edit=<docId>` — the rules already let the admin read
and write any profile; no rules change shipped with this page, which
`testAdminArea` in `selftest.mjs` pins), and Take down / Put it back as status
changes (`hidden`/`queued`), never deletes. A withdrawn profile gets no
restore button — the candidate withdrew it themselves.

**The whole path is measured, not trusted**: a block in `page-test.mjs`
drives the badge, the tiles, the panels and the takedown against
`_fake-firebase.js` with a seeded queue — the expected numbers computed from
the same served files the code reads, a held profile asserted onto the
admin's screen with its Edit control, and a hostile submission (markup in a
name, a `javascript:` link) asserted inert. The shim grew chainable
`where().orderBy().limit()` queries for it.

The page is `noindex` (a named exception in `link-check.mjs`) and carries **no
`og:*` block** (`card: false` in share-check's PAGES): nobody shares the
maintainer's desk, and an `og:url` on it would claim an identity for a page
that answers only the admin. Drawing or hiding any of it grants nothing — the
collections are admin-read in `_firestore.rules`, which is the authorisation.

## Who has registered, and messaging them

The Admin area could **count** registered accounts and learn nothing else about
them. That was not an oversight — it was three separate deliberate decisions
meeting: `registeredUsers/{uid}` is contentless by contract (`hasOnly(['t'])`),
`profiles/{uid}` is owner-only with no admin clause, and **the e-mail address is
not in Firestore at all**; it lives in the Firebase Auth record, which no browser
can read for anyone but itself. So the maintainer saw "42" and had no way to know
who they were or to reach any of them.

    userDirectory/{uid}        the roster row — owner-written, maintainer-read
    messages/{uid}             one thread per account, keyed on the uid
    messages/{uid}/items/{id}  the messages themselves

**The address cannot be forged.** `email` must equal `request.auth.token.email`
— the pin-it-to-the-writer trick `directoryEdits.by` already uses — so a roster
row says what the account really signs in as rather than whatever its owner
typed. `first` is **write-once** (`request.resource.data.first == resource.data.first`
on update), which is why the owner may read their own row: the browser has to
send the stored value back, and it costs one read per session to do it.

**Identity could not go into `registeredUsers`, and the reason is the sibling
site.** On `/lit/` the same collection is PUBLIC-read, so a name and an address
there would be world-readable. The two sites are kept in the same SHAPE, so
neither puts identity in the tally.

**`registeredUsers.t` is not a joined date.** It is `set()` once per session, so
it is *last seen*; the roster says "First seen" and "Last seen" and never
"Joined". The true joined date is Auth's own `creationTime`, which only the Admin
SDK can read.

**The threads are TOP-LEVEL, and that is load-bearing.** Firestore ORs every
matching rule, so under the blanket `match /users/{uid}/{document=**} { allow
read, write: if isOwner(uid); }` a narrower rule can only ever GRANT more: the
owner's blanket write could not be taken away, and a user could forge a message
from the maintainer in their own inbox or clear the flag saying they owe a reply.
A top-level collection carrying a `uid` field is the shape `jobSubmissions` uses,
and the only one the maintainer can LIST at all. Keying the thread on the uid
also means the doc id IS its owner's uid, so `isOwner(uid)` on the items
subcollection is the id-composition guard in its strongest form — a stranger
cannot post into someone else's thread.

**It is IN-APP, not e-mail** (owner, 2026-08-24). Nothing here sends mail: there
is no SMTP path, no `List-Unsubscribe`, no delivery to stamp. That is also what
makes "no opt-out" defensible — a message lands in the person's own area on the
site, not in their inbox. The addresses carry `mailto:` links so the maintainer
can write from their own client when e-mail is what they want, and **the Feedback
page remains how a VISITOR starts a conversation**; this direction is the
maintainer's, so a person with no thread sees "no messages" and a pointer to
Feedback rather than a compose box the rules would refuse.

**A reply is a queue; the roster is a statistic.** "Message replies waiting"
joined `pendingCounts()` and the badge's key list (now six), because it is
something the maintainer can clear. The roster did not — the Registered-users
card stays out of every total for the reason its comment gives, that a figure
nobody can clear would inflate the badge for ever. It DID become a link, since
it now has somewhere to go; it was a `<span>` precisely because it opened
nothing.

**The user's badge counts what is UNREAD**, not how many messages the page
lists — the one badge on this site whose number is deliberately not the number
of cards below it, because a read conversation is not an empty one. It is one
`get()` of the person's own thread, so no query and no composite index.

`assets/oa-users.js` is its own file on purpose: `oa-accounts.js` fetches
`oa-adminarea.js` in the maintainer's browser on **every** page to compute the
badge, and roster rendering, sorting and CSV do not belong in that download.
**There was no CSV precedent in this repo**; `csvCell` quotes every field,
doubles internal quotes and defuses a leading `=`, `+`, `-` or `@`, because these
are names people typed and a spreadsheet would otherwise execute one.

The merge deletes the duplicate's roster row (or one person is listed twice for
ever, the bug the `registeredUsers` delete exists to prevent) but deliberately
NOT its thread: only the maintainer may delete one, and nothing here sends
anything, so an orphan costs no e-mail — unlike the alert subscriptions, which is
why those must go. The Admin area lists such a thread under "Threads with no
account". The merge hunk is byte-identical in `/v2/assets/oa-accounts.js`, which
`selftest.mjs` pins, so the collection name is read defensively there
(`(OAFB.col && OAFB.col.userDirectory) || 'userDirectory'`) — the archive's
frozen `col` map does not carry it.

**A reply needs a thread to reply to.** The items rule requires the parent
thread to `exists()` before an owner may write into it. Without that, an owner
could write unbounded documents under their own uid that no thread head points
at — invisible on a page that LISTS threads, and so an unbounded write channel
nobody would ever see. It also makes "only the maintainer opens a conversation"
true in the rules rather than only in the copy, at one billed read per reply.

**A broadcast is not an answer.** Sending to somebody who has replied leaves
`needsAdmin` as it was; only opening the thread and pressing "Mark answered"
clears it. Clearing it on send would drop an unanswered reply out of the queue
silently. The message and its bookkeeping go as ONE batched write, because half
of them landing would leave the recipient holding a message the roster does not
know about and the panel calling it undelivered.

**An account with no e-mail claim still gets a row.** The address is pinned to
`request.auth.token.email` but may be ABSENT — a provider sign-in need not carry
one, and demanding it would silently leave exactly those accounts off the
roster.

The rules publish themselves now (see "…and the FIRESTORE rules publish
themselves" above); both panels say what to press rather than showing a bare
permission-denied, and they say **reload first**, because the copy of the panel
reporting a missing deploy may itself predate it — which is exactly what
happened the morning it went live.

### A reader can take a message off their own list

Owner, 2026-08-27: *any past message may be removed from the user's list of
messages.* Two rules already written down in this file meet here, and between
them they settle the whole shape:

* **a thread whose history either party can rewrite is not a record of
  anything** — the sentence the items rule was built around. So this cannot be
  a delete. The words stay where they were said, the maintainer's copy of the
  conversation is whole, and what changes is ONE reader's own list, which is
  theirs to tidy;
* **hiding is never a one-way door** (`newsOverrides`, `rowOverrides`,
  `directoryEdits`). Filter the message off the page entirely and there is
  nothing left to press to bring it back. So the removed ones sit in a
  **collapsed panel below the list**, one click from Restore, and the list
  itself stays clean.

**One boolean, `hiddenForUser`, and the owner may touch nothing else on a
message.** `diff(resource.data).affectedKeys().hasOnly(['hiddenForUser'])` is
what keeps "remove it from my list" from becoming "edit what you said to me":
the body, `from` and the timestamp are all outside it. `ITEM_OWNER_KEYS` in
`oa-users.js` is pinned against that branch both ways, exactly as `ITEM_KEYS`
is against the create rule.

**It is always written as a boolean and the field is never deleted.** The rule
tests `hiddenForUser is bool`, so restoring with `FieldValue.delete()` would be
refused — and "you can always put it back" would be false exactly once, which
is the failure this repository has already shipped twice under a different
name. Restore writes `false`.

**The Admin area still shows a removed message**, faded at the same 0.55
`.oa-dir-hidden` uses and labelled *Removed from their list*. That is not a
leak of anything — the maintainer wrote or received it — it is so that a
maintainer quoting back a message the other person can no longer see is not
talking past them.

**The reply box is drawn OUTSIDE the list**, after the removed panel. A reader
who removes every message still has a thread and must still be able to answer
in it; the empty list then says where the messages went, which is a different
state from the "you have no messages" one a person the maintainer has never
written to sees.

**The badge does not move.** It counts what is UNREAD, not what the page lists
— the one badge on this site whose number is deliberately not the number of
cards below it — so removing a message is not a way to clear it, and the panel
below does not inflate it either.

The sibling `/lit/` carries the same two collections in the same SHAPE, and it
carries this control too (owner, the same day) — same rule, same collapsed
panel, same faded-and-labelled copy on the maintainer's side. In step in shape,
not in code, as always: there the card is an overlay inside one huge
`index.html` rather than a page of its own, and its Remove button is an inline
`onclick`, so the document id goes through that page's `escAttr` rather than
`esc`. Disclosed on the Privacy Policy beside the roster, because "removing
hides it from you and the maintainer keeps their copy" is exactly the sort of
thing a policy that says nothing gets wrong.

**Inert until the rules are redeployed** — which now happens by itself after a
green check on master (see "…and the FIRESTORE rules publish themselves"); until
then the button reports that it is not switched on rather than a bare
permission-denied.

### The roster is seeded from Auth, or it lists whoever happened to come back

"31 Registered users" over a roster listing **one person** (owner, 2026-08-25).
Both numbers were right, which is what made it unreadable: `registeredUsers` is
the contentless mark every sign-in writes, while a `userDirectory` ROW is
written by the BROWSER, once per session — and the rules permitting that write
had been published minutes earlier. So the roster held precisely the people who
had signed in since. A panel whose own copy says "everyone who has signed in
since the roster shipped" is honest and no help to a maintainer who wants to
reach their users today.

**Firebase Auth knows all of them and only the Admin SDK can ask.**
`_scraper/sync-user-directory.mjs` (`.github/workflows/oa-user-directory.yml`,
daily + on demand) reads every account and writes the row the browser would
have — plus the one field CLAUDE.md recorded as unobtainable: the TRUE joined
date, Auth's `creationTime`, in place of "first seen by this site".

Three properties, and the first is the one that could have gone badly wrong:

* **Four keys and no more.** `rowOk()` pins a row to
  `hasOnly(['name','email','first','seen'])`. The Admin SDK bypasses the rules,
  so a fifth key would be written happily — and would then freeze that row
  against **its own owner** for ever, because the browser's merge produces a
  document `hasOnly` refuses. The selftest reads the allowed list out of the
  rules and pins it against `ROW_KEYS` both ways.
* **Dates only move in the safe direction.** `first` takes the earliest known
  (Auth's real joined date corrects a later "first seen"), `seen` the latest, so
  a sync can never contradict what the site itself watched happen.
* **A name the site holds is never overwritten** by Auth's `displayName`: the
  browser writes the name the account shows itself under, which is derived from
  the profile and is the better one where they differ.

An account already current costs no write, so a daily fire commits nothing. The
dispatch exists for the case that created the gap: right after a rules deploy.

### Both review tabs can be cleared a page at a time

`approveAll` was gated to the crawled tab on the reasoning that "approve-the-page
belongs to the GATE alone" — right about approving, wrong about the arithmetic:
the user-added tab opened with **86** postings and no way to clear them (owner,
2026-08-25), which is the same "a gate that can only be cleared 89 times does not
get cleared" that motivated the bulk action in the first place. Both tabs carry
one now; what must never cross over is the VERB. Approving publishes; a
user-added posting is already live, so its button ticks rows off the list and
says exactly that, and `page-test.mjs` pins that the word "approve" never appears
on it. The shared button is re-claimed by whichever tab drew last — wired only on
the crawled path, the user tab would have carried the previous page's handler.

**A filter with one value is still drawn.** The market-year row hid itself unless
a tab held two seasons, and an empty space where a control belongs reads as the
control being MISSING — which is how it was reported.

Tests: `testUsersAndMessages` in `_scraper/selftest.mjs` (the rules against the
module BOTH WAYS for all FOUR key sets — the roster row, the thread head, a
message, and the one key its READER may change — the pinned address, the
write-once `first`, the owner's narrowed updates, that a reader can hide a
message and never delete one, CSV injection, nulls-last sorting, and the wiring
on all four pages) and the roster/messaging block in `_scraper/page-test.mjs`
(the money path in a real browser, hostile input included, the remove/restore
round trip asserted to leave the body, `from` and the timestamp untouched, a
thread whose messages are all removed still answerable, plus the 390px gate).

## What "immediate" costs, and where the waiting used to be

A posting is decided in Firestore and served from `data/` by GitHub Pages, so
publishing is always a pipeline. The rule is that **nothing waits for a
schedule that a decision could have started**.

* **A posting made or edited on the site** — `publishOnChange` in
  `_functions/index.js` dispatches `oa-jobs-changed` and `oa-jobs-build.yml`
  runs at once. About a minute.
* **A posting APPROVED in the review queue** — `publishOnReview` dispatches
  `oa-jobreview-decided` to `oa-jobmarket-sheet.yml`, because
  `data/jobmarket.json` holds the approved rows and only that job writes it,
  and `oa-jobs-build.yml` then runs on that workflow's `workflow_run`
  completion to merge the file. Two workflows, one chain, about two minutes.
  It used to be two independent schedules — up to half an hour, then up to
  twenty minutes more — which is most of an hour after the maintainer had
  already decided.
* **An e-mail alert whose criteria a new posting matches** —
  `oa-alerts-mail.yml` runs on the build workflow's SUCCESSFUL completion as
  well as hourly, so an "as soon as something appears" subscription is served
  minutes after the posting publishes rather than by the top of the next
  hour. Cheap by construction: each alert's high-water mark means a fire with
  nothing new sends nothing, and a failed build (which committed nothing)
  does not fire it at all.

The schedules stay as the safety net and every job is idempotent, so a missed
doorbell costs a delay and never a posting.

### One event, one build

The sheet read rang the build's doorbell by `curl` AND `oa-jobs-build.yml` was
already chained to it by `workflow_run: [completed]`. Both fired, so one sheet
read started **two builds three seconds apart** (2026-08-26: #856 from the
curl, #857 from the chain), from the same base, doing identical work.

**The shared `oa-jobs-data-*` concurrency group cannot dedupe that** —
`cancel-in-progress: false` QUEUES the second run rather than dropping it,
which is right for two genuinely different fires and useless for one event
counted twice. The loser rebuilt `data/`, had its push rejected, and its
rebase **conflicted in `data/jobs-meta.json`** — a generated file carrying a
timestamp, so the same lines always differ and a textual rebase of it cannot
succeed.

Nothing was ever lost (the next 20-minute tick republishes), but the run went
red, and a red run of that build reads exactly like its own "Publishing has
STOPPED" alarm — the one failure this repository has trained itself to drop
everything for. **Crying wolf on that alarm is the cost worth removing.**

Two causes, both removed:

* **the duplicate doorbell.** The curl is gone; the `workflow_run` chain was
  always the more robust half (it fires whatever the conclusion, and needs no
  token). `repository_dispatch: [oa-jobs-changed]` STAYS on the build — that
  is the Cloud Function's own doorbell for a posting made or edited on the
  site, a different producer. It reads as dead code while the functions are
  undeployed, and tidying it away would silently break the instant path the
  moment they are, so the selftest pins it.
* **the stale checkout.** `actions/checkout` defaults to `github.sha`, and on
  a `workflow_run` event that is the head of the run that TRIGGERED it — which
  the producer has already moved past by committing before it finished. So the
  build rebuilt `data/` from a base one commit behind BY CONSTRUCTION, and both
  of that day's failures were on this path. It names `ref: ${{ github.ref_name }}`
  now — the same ref the Commit step pushes to — which makes the push a
  fast-forward.

`testReviewWiring` pins all three as rules rather than as facts about one
file: a workflow the build listens to may not also dispatch to it, whichever
workflow that is; any data writer running on `workflow_run` must name the
branch tip; and the build keeps answering `oa-jobs-changed`.

### …and the READER of a chained build was stale too — the approval nobody heard about

Owner, 2026-08-27: *"there are many job postings in my under review area. When
I approve any of them and become public, they should be sent to those users
with email alerts."* The dating was right — `approvedRow` has stamped an
approved posting from its approval since the day that bug was fixed, and the
served file proves it (411 postings dated the morning of the mass approval, 28
dated the day this was reported). The MACHINERY was right. The mailer never saw
the postings.

`oa-alerts-mail.yml` runs on the build's `workflow_run` completion and checked
out **`github.sha`**, which on that event is the head of the run that TRIGGERED
it — and the build **commits `data/jobs.json` before it finishes**. So the
instant path read the commit BEFORE the postings it had just been fired to
announce, every single time, by construction. It is the identical trap the
build itself was fixed for one day earlier; the guard written that day iterated
`WRITERS`, and a READER of `data/` chained to a writer slipped straight through
it. **A stale read is as silent as a stale base**, and here it was worse.

**Worse, because an empty jobs list was not a harmless no-op.** The job window
was the only one of the three still measured on a WALL CLOCK: `since =
lastSentAt`. An alert carrying jobs AND updates found no new postings in the
stale file, sent its change-log digest anyway, and advanced `lastSentAt` to
NOW — so the posting approved minutes earlier, correctly dated, was behind the
mark for ever. The hourly cron that would otherwise have caught it an hour
later found nothing left to catch. **Approve a posting; the subscribers who
asked to hear about new postings never do.**

Two fixes, deliberately independent, because either one alone leaves a race:

* **`ref: ${{ github.ref_name }}`** on the alerts checkout, exactly as on the
  build. The guard now iterates `[...WRITERS, 'oa-alerts-mail.yml']` and its
  comment says the rule is about every consumer of `data/`, in either
  direction. `oa-deploy-rules.yml` is deliberately NOT in that list: it is
  chained to the CHECKS, which commit nothing, and publishing the ruleset that
  was actually tested is the whole point of it.
* **`lastJobAt`** — the job window is now a mark on the POSTINGS, the newest
  `addedAt` a digest actually carried, which is the shape `lastUpdateDate` and
  `lastCandidateAt` have had all along and for this exact stated reason ("never
  at a wall clock a profile published mid-run could slip behind"). Jobs were the
  one topic left out. `lastSentAt` still means WHEN a digest went out, which is
  what `isDue` measures, and the fallback chain `lastJobAt || lastSentAt ||
  createdAt || 31 days` migrates every existing subscription without re-sending
  anything. It needs **no rules change** — alerts live under the blanket
  `users/{uid}/**` owner rule — and the alerts page saves with `{merge:true}`,
  so editing an alert cannot wipe it.

**A merge carries it.** `ALERT_FIELDS` in `oa-accounts.js` copies the
high-water marks with a subscription precisely so a merged alert does not look
brand new; `lastJobAt` joined them, in the live file AND in `/v2/`'s frozen
copy, which the selftest pins byte-for-byte.

**The halves were tested apart, which is how this survived.** The queue knew a
posting was dated from its approval; the matcher knew how to window; nothing
joined the two. `testJobReview` now drives the whole path in one — approve,
publish, window, match — against the same matcher the browser and the mailer
read, with the crawl-dated row asserted NOT to match as the positive control,
plus a rejection announcing nothing and a grandfathered approval never
re-announced. `alerts-mailer.mjs --selftest` pins the mark from the file's own
source (the branch that writes it needs Firestore and a mailbox), including
that a wall clock never becomes the job mark and that the idle branch moves no
window at all.

The alerts workflow is also pinned to the build **by its current name**:
`workflow_run` matches on the literal string, so renaming a workflow silently
unchains every listener.

### A rejected push is REBUILT, never rebased

Everything under `data/` is a build OUTPUT, so a rejected push has nothing to
reconcile. `git pull --rebase` sat in the Commit step and asked git to merge
two independently GENERATED copies of the same file: `data/jobs-meta.json`
carries a `generated` timestamp and row counts, so the same lines always
differ and the rebase **conflicted by construction** — which is how the
duplicate build above ended its run red. And where it had SUCCEEDED it would
have been worse than failing: it would have pushed a `data/` snapshot built
BEFORE the other writer's commit, dropping their rows with nothing anywhere to
show it had happened.

The recovery that suits generated files is the other one: **throw our commit
away, take their tip, and rebuild on top of it** — `git fetch` → `git reset
--hard FETCH_HEAD` → build → re-check → commit, five times before giving up.
The result carries BOTH writers' work, because the build derives everything
from Firestore plus the committed files rather than from what we had a minute
ago.

**That needed the build to be ONE thing, which is why `_scraper/build-all.mjs`
exists.** A workflow step cannot re-run the steps before it, so while "what a
build is" lived in four YAML steps the retry could not perform one — reaching
for a rebase was the only move available to it. The four builders are now a
list in one script, in dependency order, and the workflow calls it twice: once
as its own step, once from inside the loop. **A new builder goes in `BUILDERS`
and nowhere else** — nothing in the workflows names a `build-*.mjs` any more,
so one added beside them would simply never run, and the only symptom would be
a dataset that quietly stopped moving (the selftest pins the list against the
directory).

Four properties hold it together, each pinned in `testReviewWiring` and each
verified by reintroducing the bug:

* **no rebase** (read with the comments stripped — the step still EXPLAINS the
  rebase it no longer does, and a guard that could not tell the explanation
  from the command would have to be satisfied by deleting the explanation);
* **the rebuilt dataset goes through the SAME `selftest --publishing` gate**
  the first pass passed, or a retry could commit exactly what that gate exists
  to refuse;
* **the Commit step carries the build step's whole credential set.** Losing it
  fails silently rather than loudly: without `FIREBASE_SERVICE_ACCOUNT` the
  three Firestore builders are skipped, so the rebuild would leave the other
  writer's `data/` as it found it, see nothing to commit, and exit 0 saying
  *"the other writer published it all"* while this run's postings went nowhere;
* **the per-step Firebase gate survives the fold** — `plan()` skips the three
  Firestore builders without the secret and always runs the offline directory
  build, which is exactly the `if: steps.gate.outputs.ready == 'true'` the four
  steps carried.

Re-running is safe, and not by luck: the build already fires on a schedule, a
dispatch and a `workflow_run`, so running it twice in quick succession is its
ordinary life. Every builder REPLACES `data/` from its sources;
`transferUploads` files an advert into Drive only while the document still has
`adUploadPath && !adUrl`; and the "what changed" e-mail diffs the previous
SERVED file against the one about to be written, so rebuilding on the new tip
makes it more accurate rather than duplicating it — what the other writer
already published is no longer a change.

Finding nothing to commit after a rebuild is a **success**, not a failure, and
the commonest outcome of a real race: the writer that beat us had already
published everything we held.

**The functions are deployed BY HAND** (`firebase deploy --only functions
--project operations-academia`, from the repository root), and a doorbell that
was never deployed looks exactly like a site that is simply slow — there is no
error anywhere, everything still publishes, just on the schedule. That is worth
checking first whenever "it takes ages to appear" comes up:
`firebase functions:log` should show `build dispatched` / `sheet read
dispatched`. The setup page's paths were stale after the promotion (it said
`cd v2`, where there are no functions any more); they are fixed.

**The last stretch of the delay is the reader's own browser.** Pages serves
`data/*.json` with ten minutes of freshness, so a visitor who had the page open
recently was shown what they already had, however fast the pipeline was. Every
fetch of `data/` and `changelog.json` passes `cache: 'no-cache'`, which
REVALIDATES rather than re-downloads — a 304 with no body when nothing changed.
**A new fetch of a served data file must carry it.**

Copy that promises a time is part of this: the forms and the review panel say
"within a few minutes", and if the cadence ever changes, they change with it.

**And the EDITOR does not wait even that long** (owner, 2026-08-24: "when the
admin edits a posted job, the edits should be shown immediately"). Saving an
edit — or taking a posting down — leaves an ECHO in that browser's
localStorage (`assets/oa-fresh.js`), and every page that renders
`data/jobs.json` overlays it at read time: the jobs page the editor opens
next already shows the correction, while the pipeline publishes it for
everyone else exactly as before. It is the header-hint idea applied to a
posting, and it is honest by construction: PER BROWSER (nothing leaves the
machine, so no visitor can see an unpublished value); echoing ONLY what the
build would publish (a pinned subset of `PUBLIC_FIELDS`, the Apply-by line
composed by a parity-pinned browser twin of `composeApplyBy`, values taken
from the form AFTER `canonColumns()` and the name fixes); and STANDING DOWN
against the build, not against hope — the echo is dropped when the served
row carries every echoed value, when `data/jobs-meta.json`'s `generated`
stamp shows a build begun after the save has published (its sanitisers have
the last word, even where they disagree), or after an hour. The overlay is
hooked into `OAList.load` (one place, every consumer) plus
previous-markets.html's own fetch; the stash is written by the edit form and
by oa-jobedit's takedown. `testFreshEcho` in selftest.mjs pins the parity
twins, the field whitelist and all the wiring; page-test.mjs measures the
echoed card on the rendered jobs page. A posting's identity (`id`, `year`,
`posted`) is deliberately not echoable — an edit does not move a posting,
and the echo must not either.

## The admin change e-mail reports what CHANGED, not what was healed

"[OA] Job postings changed: 22 edited", daily, for postings nobody had touched
(owner, 2026-08-25: *"you are not editing these jobs all the time, right? then
why the emails?"*). Two independent causes, and together they accounted for all
23 of the phantom edits measured against the live data.

**One: the diff was taken against the WRONG SIDE of the pipeline.**
`build-jobs.mjs` computed `collectChanges(existing, freshVisible, …)` —
`freshVisible` being the rows as the DOCUMENTS and the WORKBOOK state them,
while the file it then writes is `rows`: the same postings after the merge, the
collapse, and every heal the build applies on the way out (`healCountry`,
`healReviewDate`, `stripRowEmails`, `healPlace`, and mergeRows' preservation of
`addedAt`). Those heals are the whole point — the source keeps saying what it
always said and the build keeps correcting it — so diffing the served file
against the RAW rows reported every correction as a fresh edit on every write,
for ever. UCLA's suggested/final deadline split, a canonicalised department, a
regenerated "Further info" link: all permanent, none of them an edit.

It is `collectChanges(existing, rows, …)` now, which is the honest comparison —
the previous served file against the one about to replace it — and it fixes a
second symptom of the same slip: the log **overcounted new postings in the
other direction**, announcing `+12 new` on the run that added 3, because nine
of the twelve were duplicates `collapseSameDay` folded away after the count was
taken. The `+ ref` listing under it iterates `rows` for the same reason; it had
been naming postings nobody could then find on the site.

**Two: `addedAt` was diffed at all.** It records when the dataset first saw a
posting, it is the only cursor the e-mail alerts have, and `mergeRows` carries
it over from the previous row precisely so a re-read never re-stamps it. Nobody
edits it. It is skipped in `diffRows` beside `id` and `adPending` now — 17 of
the 23 were this one field, and the block that sends the e-mail already claimed
"bookkeeping writes never produce an e-mail", which is only true with both
halves in place.

**A genuine edit still mails**, which is the point of the feature: if a poster
or the maintainer changes a posting, `rows` differs from `existing` and the
before/after goes out. Measured after the fix: an unchanged rebuild reports 0.

While proving it, a third defect in the same block: the run log's
`N posting(s) healed against the directory or their own deadline prose` counted
by OBJECT IDENTITY (`r !== visible[i]`). `healCountry` returns the row itself
when it changes nothing, but `stripRowEmails` spreads unconditionally — so every
row was a new object, the line reported ALL 541 every run, and then named the
first eight as though they were the healed ones. It compares by value now. A log
line that names innocent rows is worse than no log line: it is what made those
eight postings look like the ones being edited.

Pinned by `testChanges` in `selftest.mjs` — the `addedAt` skip, an unchanged
rebuild reporting nothing, a collapsed row never counted as new, and the
build's own source read back to check it diffs `rows` and never `freshVisible`
again (reproducing it for real needs Firestore and the workbook).

## A text search holds SEVERAL terms

Every `type: 'text'` filter in `assets/oa-list.js` takes more than one term:
typing filters live as it always did, and **Enter banks the term as a chip** so
the next one can be typed straight away. `sel[key]` is a `Set` for text filters
and pickers alike, with the half-typed word kept beside it in `drafts[key]`.

**The terms are OR'd, and that is the only reading that returns anything.** A
posting has ONE institution, so "columbia" AND "insead" is empty by
construction; a reader typing both means "either". A single term behaves
exactly as before, which is what keeps every saved link working.

The URL carries **one parameter per term** (`?institution=utah&institution=princeton`),
so a multi-term search is shareable, and a legacy `?filterA=` deep link — the
universities map still emits one per school — lands as a chip the reader can
see and remove rather than as bare text in the box.

**Chips must never move the control above them.** The v3 bar is a grid; its
items were bottom-aligned, so a filter carrying chips was a taller cell and
pushed its own control upwards, leaving "2 selected" floating above the boxes
beside it. The items are top-aligned instead, and the Clear button — which has
no label of its own — gets that height back from an empty `.oa-label-spacer`
styled by the same rule as a real label, rather than from a pixel value that
would silently drift when the type changes. `page-test.mjs` measures the
baseline per row and fails if any control leaves it.

## A guard that fires on a legitimate posting stops the whole site publishing

`oa-jobs-build.yml` rebuilds `data/`, runs `selftest.mjs` over what it is about
to commit, and commits nothing if that is red. That is right — a broken dataset
must not ship — and it has one failure mode worth knowing, because it happened:
a posting sat in Firestore marked **Live**, the maintainer's page said so, and
it was never on the site, because every build for hours had gone red and
therefore committed nothing. Nothing was broken in the pipeline; nothing was
published either, and the two look identical from outside.

Both red guards were pinning a PAST repair over the WHOLE of a live file:

* "every Houston posting names its college and department the one way" — a new
  Houston posting that named its college and no department failed it. Naming
  no department is allowed;
* "every Tulane posting names one school" — a posting arrived with an empty
  School field and `Freeman School of Business` in the Department one.

So: **a guard about specific rows names those rows** (the Houston pair is keyed
on its own date now), and **a guard over a whole file asserts a RULE that any
legitimate row satisfies** — that the names are canonical, which `canonPlace`
already pins over every row. An empty field is not a second spelling.

The Tulane shape was a real ingest gap and is fixed as one: `assemble()` in
`oa-schools.js` moves a **school typed into the department box** across into
the school field, the mirror of the fused-school-field split it already did,
and **curated, never guessed** — the value must be a name `SCHOOL_LIST` or its
aliases already know, so a real department is never promoted for carrying a
school-ish word, and a row that named both is untouched.

The build now also prints a `::error::` saying publishing has stopped when the
re-check is what failed, so the log names the consequence rather than just the
assertion.

It happened a third time on 2026-08-24, twice in one morning, and both were
the same shape again. (1) One posting arrived from Firestore with a contact
e-mail address in its text, and the served-file guard — right that nothing
under `data/` may carry one — stopped every build from 03:14. The address is
now removed AT INGEST (`stripEmails`/`stripRowEmails` in jobs-model.mjs,
applied in `rowFromSubmission`, the review queue's `applyEdits`, the sheet
sync, and over build-jobs' whole merged set — the healCountry pattern; a
marker says something was removed, and stored URLs are never rewritten).
(2) The two advert-verify passes wrote jobmarket.json's copy of EVERY sheet
row back into jobs.json, reverting heals only the build applies — UCLA's
suggested/final deadline split — and the mirror guard stopped their commits.
They now patch ONLY the deadline fields of ONLY the rows they filled
(`patchDeadlines` in jobs-model.mjs). `testGuardRepairs` pins both, wiring
included.

### It happened again, at the scale the queue was built for

The morning the maintainer approved a season — **449 postings in one sitting** —
both halves of the pipeline went red and the site's data stopped moving. The
sheet read failed on ONE row and therefore wrote none of the 449 to
`data/jobmarket.json`; the build, reading the approved queue documents directly
behind it, then failed on eight guards and committed nothing either. Everything
was working. Nothing published.

Five separate faults, and the shape of each is worth keeping:

* **Two boxes for one fact.** The review card offered "Apply by" beside
  "Closing date", one posting was approved with the line emptied and the date
  left behind, and `selftest.mjs` asserts over the served file that *the date
  shown and the date filtered on are the same date*. That is precisely the
  `department` bug one section down, on the deadline — so the same remedy:
  `settleDeadline` in `applyEdits` DERIVES the line (`derived: true`, out of
  `SHOWN`), the card previews what will be published under the date box, and
  words about a search with no closing date go in the comments.
* **A guard about two rows, keyed on their date.** The Houston pair guard
  matched `/houston-20250923/` and caught three new legitimate postings of the
  same day. A guard about specific rows NAMES those rows.
* **A guard asserting on a tie-break.** The `RULED` rulings look a university
  up in `data/vocab.json`, which is keyed by whichever spelling has the most
  postings — `pickForm` calls that "a tie-break, not a policy" — and one new
  posting under "University of Texas at Dallas" moved the entry off "The
  University of Texas at Dallas". Anything asserting about a PLACE asks
  `institutionKey` (`uniEntry` in selftest.mjs), never the current spelling.
  `AWAITING_OWNER` is keyed the same way.
* **An exemption narrower than the thing it exempts.** The mirror round-trip
  guard excused a row whose `type` the workbook left blank; the workbook may
  leave ANY of the fields a submission needs blank, and three postings arrived
  short of a different one each. It is keyed on `SUBMISSION_NEEDS` now, pinned
  against `rowFromSubmission` itself so the list cannot drift.
* **A tidiness sweep with a publishing-sized consequence.** Sixteen pairs of
  department names — the workbook writes the FIELD where the site asks for a
  department, so "OM" arrives beside "OM/SCM" and "SCM/OM" — stopped the whole
  site. Two of them were not pairs at all: `similarNames` matched its substring
  tier against raw text, so "IS" was found inside "Decision". That check is
  word-aligned now, which also stops the posting form offering the same
  nonsense as a "did you mean".

**And the last of those changed a rule.** `selftest.mjs` has two jobs with very
different costs: as the PR check (`oa-checks.yml`) red means somebody reads the
failure and nothing on the live site moves; as a data writer's re-check red
means that workflow commits NOTHING — not the offending row, everything. So the
two duplicate-NAME sweeps, which are about tidiness rather than about the data
being right, now report in the second role and fail in the first.
`node _scraper/selftest.mjs --publishing` selects it, every workflow that
writes `data/` passes it (both its precondition run and its re-check), and
`oa-checks.yml` deliberately does not — pinned both ways, because the flag
missing from a writer is this outage and the flag creeping into the PR check
would leave nothing enforcing it anywhere. The pairs are named in the run log
either way.

**Two sources can mint one id, and the later writer wins.** A posting's id is
(market year, institution, date) plus an ordinal for the same day, and ids are
how `mergeRows` joins — so when the workbook's three Houston rows of 2025-09-23
were approved they took `2026-university-of-houston-20250923` and `…-2` from
the two LEGACY rows that held them, and those two went off the site with their
advertisement links. Nothing warned; the only reason it was noticed at all is
that a guard named those ids. Whether that matters is the maintainer's call —
the workbook and the legacy sheet are plainly describing one Bauer hiring
round, so this may be a merge rather than a loss — but the MECHANISM is luck,
not design, and a fix would have to change ids, which are permalinks and the
join key for `rowOverrides`, the review queue, the mirrors and the Edit button.
Not attempted here.

**What is still the owner's to settle.** The fourteen surviving pairs are in
`AWAITING_OWNER`, and every one of them exists because the workbook's
hiring-unit column holds a FIELD ("OM", "BA", "SCM/OM", "IS/OM/SCM/BA") rather
than a department name, which the pipeline then publishes as the department.
Ruling on them one at a time treats the symptom; the remedies are to name the
department in the sheet, or to teach `jobmarket-sheet.mjs` that a field code is
not a hiring unit and carry the sheet's own words onto the card the way an
unbelievable deadline already is (`Deadline as listed: …`). Neither is done
here: it changes what a posting PUBLISHES, and 449 of them were approved as
they stood.

### …and a fourth time, because the flag was only half the fix

The demotion above moved TWO of the three near-duplicate sweeps to `tidy`. The
third — "every OM-list school lands on ONE school group" in
`testDirectoryWiring` — was left on `eq`, and `--publishing` cannot help a
sweep that fails in both roles. On 2026-08-25 somebody posted a job at The
Hong Kong Polytechnic University and named its school **"Faculty of
Business"**, which is what the faculty is called; `oa-omlist.js` and
`oa-institutions.js` both carry it as "Faculty of Business (incl. Logistics
and Maritime Studies)"; the two spellings met in `data/directory.json` — which
`build-directory.mjs` merges FROM THE POSTINGS, so any poster can grow that
list — and the sweep went red. Five consecutive builds committed nothing. The
sibling sweep two thousand lines above reported the SAME pair as a warning and
passed, which is how thoroughly this was a decision about the guard rather
than about the data.

What it cost is the exact thing the owner reported: three user-added postings
and nine the maintainer had just approved sat unpublished, `data/jobs.json`
frozen at 07:24, with the site showing none of them and nothing anywhere a
reader — or the maintainer — could see. Every build's log said
`+12 new … wrote data/jobs.json`, because the build DID all of it; only the
commit was withheld.

Both halves are fixed. The sweep is `tidy` like its siblings. And the rule is
now pinned where it is actually decided rather than in the workflow files: an
assertion whose message says two names are one place must be a `tidy` call,
read out of `selftest.mjs`'s OWN source by `testReviewWiring` (the count is
pinned too, so deleting a sweep cannot be a way to make it quiet). **A new
near-duplicate sweep goes through `tidy`, always** — the PR check is where a
naming duplicate fails, and it is fixed by an alias, never by holding real
postings back.

The pair itself was settled in `SCOPED_SCHOOL_ALIASES`, not in either curated
module: the rule there already covers it ("the longer string is not a fuller
name but a parenthetical acronym, a campus note…"), the parenthetical
annotates a department the same record already carries as its own, and one
alias reaches both hand-compiled sources, survives a regeneration of either,
and canonicalises a posting typed with the annotation too.

## The job postings, as an Excel file

A registered reader can take the list away: a small **"↓ Download Excel"**
button under *Clear filters* on `jobs.html` writes an `.xlsx` of exactly the
postings the page is showing (owner, 2026-08-26). Filter first and the file is
that search; filter nothing and it is every posting on the page.

    assets/oa-xlsx.js       a minimal OOXML workbook writer (dual-mode)
    assets/oa-jobexport.js  what may be exported, and the button (dual-mode)
    assets/oa-list.js       `actions` — a page-declared control in the filter bar
    _scraper/_xlsx-read.mjs read one back, for the two guards

**The Contact details cannot be in it, and that is structural rather than
remembered.** The owner's instruction was explicit — the poster's name, their
e-mail, the area coordinator or department chair and theirs, and any private
note are "private information for the admin only" — and the exclusion holds
three separate times: those fields are not in `PUBLIC_FIELDS`, so they never
reach `data/jobs.json` and therefore never reach the browser; every column in
`COLUMNS` names the field it reads in `from`, so a field with no column is not
exported however the served file grows; and `selftest.mjs` pins the two against
each other BOTH WAYS, plus a sweep of the built workbook's own bytes for
anything e-mail-shaped. **A new column means a new `from`** — one without a
rule fails the build rather than the reader's privacy.

**Three PUBLIC fields are withheld anyway**, and they are named with a reason
each in the module: `owner` (a digest of the poster's account — the one column
that would let a downloader group the site's postings by the person who filed
them), `ref` (the reference the poster quotes to the maintainer about their own
submission) and `source` (internal bookkeeping).

**And the page's own buckets are withheld for a different reason.** "Closing
soon", "Review ahead" and "Last 7 days" are computed against TODAY (`DERIVE` in
`oa-list.js`), and a workbook is opened weeks after it is saved — a cell
reading "Closing soon" beside a deadline that passed a month ago is worse than
no cell. The real dates go instead, which is what lets the reader compute the
bucket and have it be true when they do.

**It is a workbook and not a CSV because of one word in the instruction**:
"any deadlines should be marked as Excel date types". A date in a CSV is a
string Excel re-reads under the reader's own locale — how `05/10/2026` becomes
the tenth of May in Salt Lake City and the fifth of October in Coventry, the
exact ambiguity `deadlineDay` refuses to guess at on the way IN. So
`oa-xlsx.js` writes real OOXML: a STORE zip, inline strings, real booleans,
date SERIALS under an ISO number format, and clickable hyperlinks with their
own per-sheet rels. There is no build step and no CDN here, so a library was
never an option; the shape is the sibling repository's
`lab/search-v2/admin/xlsx.js` (stouras.com) — **keep the two in step in SHAPE,
not in code**, like `oa-news.js` and `lit-news.js` — and this one adds the
dates and the links that file never needed. Excel's own limits are ENFORCED
rather than hoped for (32,767 characters a cell, unique tab names, the
schema's child order), because exceeding one produces not an error but a file
that opens to a repair dialog.

**The data is the FIRST sheet.** `pandas.read_excel` and R's `read_xlsx` both
default to sheet 0, so a notes sheet in front of it would be the first thing to
trip up the "easy processing" the file is for. *Columns* describes every column
in a sentence, and *About this file* records which filters produced it, how
many postings the page held in all, and what is deliberately not in it.

**The engine renders the button, and that is not tidiness.** `buildBar()`
empties the filter bar every time Clear filters is pressed, so a control the
page appended for itself would disappear at the first press and reappear
nowhere. `cfg.actions` declares one instead; `render()` calls its `refresh`
beside the Clear button's own disabled state, which is what keeps "Download
these 52 postings" honest as the list narrows.

**The gate is the site's own `whenSignedIn`**, not the sign-in lock. The lock
over the filter bar already hides the button from a signed-out visitor and the
lock card now names the download as a reason to register — but a nudge is not
an authorisation, so the module refuses on its own: pressing it signed out
offers the sign-in box and downloads nothing, and a press during the restore
window is QUEUED rather than lost. The data is a public file either way; an
account is how this community site knows who uses it.

`page-test.mjs` measures the money path in a real browser — signed out
downloads nothing and opens the box, signed in downloads bytes that really are
a workbook holding exactly the rows on screen, narrowing the search narrows the
file, and at 390px the button is a 42px full-width target like every other
control in the bar.

### Small is not the same instruction as quiet

The first build read the "small and discrete" instruction as *both*, and shipped
muted ink on no ground at all with the label **"↓ Excel"**. From a screenshot of
the dark theme (owner, 2026-08-27): that download is "not very intuitive for the
average user", and *Clear filters* beside it — a neutral 1px outline on a card
of neutral outlines — is "very subtle". Neither was a contrast failure: both
clear AA on their own ground and always did, which the theme audit confirms on
every run. They were **affordance** failures, and no contrast audit can see one.

So the two controls in that bar are now the colour they MEAN, and the colour is
doing the work a label cannot:

* **Clear filters is RED** (`--err`) — border and ink. It is the button that
  throws a search away, so red is what it is, not decoration. Still 45% faded
  while disabled, which is honest: with nothing selected there is nothing to
  clear, and its hover state is gated on `:not([disabled])` for the same reason
  — the old rule lit up whether or not the button did anything.
* **The Excel download is GREEN** (`--ok`) — border, ink and a pale ground
  (`--ok-soft`), filling solid on hover. Filling is the strongest signal a
  static page has that a thing is pressable, and it is exactly what a caption
  never does.
* **The label gained its VERB.** "Excel" names a format and never the act.
  It is wider for it, and *smaller than Clear* is what "small" actually asked
  for — so `page-test.mjs` measures it against Clear's own width rather than
  against the magic 120px it used to carry.

**Both rules live in TWO stylesheets and only one of them reaches the site.**
`assets/oa-list.css` is the engine's own, inherited by every page that mounts
OAList; `assets/v3.css` overrides it for the live design, and that override is
what `jobs.html` paints. A fix applied to one alone is invisible on the site or
lost on the next page — so `selftest.mjs` pins both files, and `page-test.mjs`
measures what the browser really paints, **in both themes**, resolving `--err`
and `--ok` through the page's own custom properties rather than hard-coding a
hex a later palette change would silently falsify.

`--err-soft` and `--ok-soft` were added to the palette for the two washes, and
are defined in BOTH themes — the dark ones translucent like `--brand-soft`, so
the tint works over whatever surface the button lands on. They are kept pale on
purpose: the ink sitting on them is `--err`/`--ok`, and a heavier green tint
drops the download under the 4.5:1 floor the theme audit measures.

Clear is the ENGINE's button, so the red reaches every list page — jobs,
previous markets, recent faculty, the universities directory and the one-pager's
mounts. That is the point of the engine owning the bar.

### …and both buttons share a line

Owner, the same day: *"pushing 'entry level' search field on the top line, so
that 'clear filters' and 'Download Excel' buttons appear in the same line,
within the 2nd line."* Those are one change, not two, and the arithmetic is
why. Measured at 1280px, the jobs bar had **five** tracks: the university
search spans two of them, so the top line was full at four controls and Entry
level fell to the second — which then carried four pickers and had a single
track left for the actions, far too narrow for two buttons abreast.

A **sixth track** (`minmax(150px, 1fr)`, scoped to `#oa-jobs`) fixes both ends
at once: the top line takes the search and four pickers — Entry level among
them — and the second takes three pickers and hands the actions cell the three
that are left. `150px` is measured, not guessed: the longest picker label
("All characteristics") still fits its button, and nothing on the page
truncates or scrolls sideways at any width from 320px up.

**`grid-column: auto / -1` does not do what the comment above it claimed.** It
had always read as "Clear stretches from wherever it lands to the bar's right
edge", and an auto start with a definite end spans exactly **one** track — so
the cell was a single 157px column and the two buttons wrapped inside it,
which is precisely the stacking the owner was asking to undo. It is
`span 3 / -1` on the jobs bar now.

The cell itself is a **wrapping flex row**: the empty label spacer takes the
full width (which is how it still reserves one label's height above the
buttons — the reason it exists), Clear takes whatever the download leaves, and
the download keeps the right edge, so the bar ends flush however wide either
label becomes. Both are 44px tall: two controls sharing a line share a
baseline, and the download is still the smaller of the two on the axis that
was ever in question — its width (136px against Clear's 357px at 1280px).

**Its `gap` is `0 10px`, and the row half being zero is load-bearing.** The
spacer reproduces a label's height and its 3px margin exactly, which is what
lands Clear on the same baseline as the pickers beside it; a row gap would
push it that much lower and break the one thing the spacer exists for. And
because the download now holds the right edge, the flush-edge check measures
the **cell** rather than Clear — what the bar promises is that its last line
ends flush, which is true under either arrangement.

The span rule runs from the **phone breakpoint up**, not from 1000px: at four
or five tracks the actions cell simply takes a line of its own, still flush
right with both buttons abreast. Only a phone stacks them — side by side each
would be half a screen — where the mobile rules give both the full width and a
42px target. `page-test.mjs` measures the row count, Entry level's line and
the two buttons' shared baseline at desktop width, and the full-width targets
at 390px.

## A department that SPONSORED the site, and what that may change

CUHK Business School's Department of Decisions, Operations and Technology
sponsored operationsacademia.org from 1 September 2025 to 1 September 2027
(owner, 2026-08-29). Their postings **lead the jobs page** and carry a purple
**"Sponsored"** mark — "professional and discrete but visible to all users of
the website".

    assets/oa-sponsors.js   who sponsored, when, and the whole rule (dual-mode)

**IT IS A CURATED TABLE READ IN THE BROWSER, not a field in `data/jobs.json`,
and the reason is that a sponsorship ENDS.** The window is tested when the card
is drawn, so on 1 September 2027 the mark stops appearing by itself — nothing
to run, nothing to remember. That is `oa-jobnav.js`'s own argument ("a build
runs every twenty minutes and a deadline passes at midnight, so deciding in the
browser is the only reading that cannot be stale") applied to a date somebody
is paying for. Three more reasons, each already recorded elsewhere in this
file: a derived field on every row would have mailed the maintainer 575 phantom
edits the first time it was written (the `withMarketYears` lesson, which is why
`diffRows` skips it); a served side file would need a builder, a place in
`BUILDERS`, and one more way for a red guard to stop the whole site publishing;
and `/v1/` and `/v2/` never load the file, so the archives do not move.

**What the mark may change is exactly two things — the badge and the
position.** It never changes what a posting SAYS, never hides or demotes
anybody else's, and never survives its own end date. The Excel download gains a
`Sponsored` column whose `from` names the three PUBLISHED fields the answer is
computed from, because there is no `sponsored` in the served file and
deliberately never will be.

**The sort is TOTAL, not "while no filter is set".** The owner's words were
"top of the list … without any user-defined search filters being applied yet",
which describes when they will SEE it rather than asking for a conditional
comparator — and a list that re-ordered itself as the reader typed would be a
worse surprise than a sponsor leading a search they are almost never in (narrow
by anywhere but Hong Kong and they are gone). `featured` has always worked this
way, and sponsored ranks ABOVE it: a sponsorship is a commitment the site made
to somebody, Featured is a note the maintainer left themselves. That ordering
is not hypothetical — the served file carries exactly one featured row.

**BOTH lists lead with the sponsor** — and that is a correction. The first
build left the one-pager's teaser date-ordered, reasoning that "the ten most
recent postings" would become false; the owner sent a screenshot of the mark
sitting on the SECOND card and said *fix*. The heading names WHICH ten, not
what order they are in, and the teaser's `prepare` still selects them by date
before the comparator runs — so a posting outside the newest ten is still not
shown and the heading stays true. `featured` keeps its old split, which is now
the odd one out rather than the precedent.

### The rule says NO, four times over

A sponsor mark is a claim the site makes on somebody's behalf, so the expensive
failure is not a missing badge — it is a badge on a posting that has not earned
one. The served file carries **eight** CUHK-family rows and exactly one of them
is the sponsor's:

* **`…, Shenzhen` and `CUHK Shenzhen` (five rows) are a DIFFERENT UNIVERSITY.**
  `institutionKey` keeps them apart on its own, which is the whole reason the
  match goes through it rather than through a substring.
* **`OM/IS` is not a department name.** It is the crowdsourced tracking
  workbook's field code, and reading it as the sponsor's department would be
  precisely the guess "curated, never guessed" forbids. Adding it is a
  one-line owner decision, not an inference.
* **A posting advertised BEFORE the window is not retrospectively theirs**, and
  a row with no posting date is never marked at all.
* **The mark is drawn only while the sponsorship is RUNNING** — present tense,
  which is what makes it honest.

**…and one place it had to say yes.** One row files the SCHOOL in the
institution field (`institution: "CUHK Business School"`), which
`institutionKey` correctly keeps as a key of its own and could therefore never
reach the record. That is an ordinary thing for a poster to do, so the record
carries an `alsoFiledAs` list — curated one measured spelling at a time, like
every alias table here, which is what stops it reaching "CUHK Shenzhen".

### The dependency that was missing, and why the tests could not see it

`oa-sponsors.js` asks `oa-schools.js` whether two spellings are one university
— and **neither `jobs.html` nor `index.html` loaded that file.** Only the
forms, the alerts page, `/admin-area` and the directory did. So in the browser
the factory was handed `undefined`.

The first draft fell back to a plain fold, and that is what made it dangerous:
"The Chinese University of Hong Kong" still matched itself, so **every check in
`selftest.mjs` passed** — Node resolves the dependency through `require` —
while the SITE silently stopped recognising "CUHK", "Chinese University of Hong
Kong" and "The Chinese University of Hong Kong (CUHK)". Three spellings, marked
in the tests and unmarked on the page, with nothing anywhere to say so. It is
the two-halves-disagreeing failure `oa-jobnav.js` was written to remove, and
**a fallback that is right most of the time is the worst possible shape for
it.**

Both halves are fixed and both are pinned: the pages load `oa-schools.js`
FIRST, and `uniKey` returns nothing at all without it — this says no when it
cannot tell, like every other curated table here. The guard EVALUATES the
module with no `OASchools` on the root rather than reading its source for a
`return fold(v)`, because a source check would pass the moment somebody wrote
the same fallback a different way.

**Anything else built on a curated module must load that module on the page
that reads it, and must be tested with it ABSENT.**

### The badge, and the two stylesheets

An **outline pill** (purple ink, pale purple ground, hairline border) plus a
**3px rail** down the card's left edge — the owner picked both. The outline is
load-bearing rather than decorative: every other label here is a solid block of
colour, so an outline reads as a different KIND of thing at a glance, and it is
what keeps it from being taken for a second `Featured`.

Purple because it is the one hue this deliberately neutral charcoal palette
never uses anywhere else. `--sponsor` / `--sponsor-soft` / `--sponsor-line` are
defined in **both** themes, following the `--ok` / `--err` idiom exactly — a
solid hex in light, a TRANSLUCENT wash in dark so the tint works over whatever
surface the badge lands on. Measured: 6.48:1 light, 7.26:1 dark, against a
4.5:1 floor.

**The rules live in TWO stylesheets and only one of them reaches the site** —
`oa-list.css` is the engine's, `v3.css` is the live design's override — so a
fix applied to one alone is invisible on the site or lost on the next page.

**And a THIRD rule is needed for a card inside a panel**, which is how the
rail was shipped broken. `body.v3 .v3-panel .oa-card { border: 0 }` has the
same specificity as `body.v3 .oa-card.oa-sponsored` (0,4,1 against 0,4,1 —
three classes and an element each) and sits ~600 lines LATER in the same file,
so load order decided it: the rail painted perfectly on the jobs page and was
silently blanked on the one-pager's teaser. The browser guard measured it on
`jobs.html` and nowhere else, so everything stayed green. It is the
"specificity AND load order" trap this file already records for the Leaflet
attribution box, and the lesson generalises: **a rule that can be beaten by a
rule of equal weight further down the file is not a rule** — win on
specificity, and measure the thing on every surface it is drawn on, not just
the first.
That is the trap already recorded under the Excel button, and `selftest.mjs`
pins both files. The badge names its own INK as well as its ground, or the base
`.oa-label`'s `#fff` would paint it white on white; the rail is a `border-left`
width on the card's own border rather than an extra element, so it cannot
overlap the rounded corners or the focus ring; and both rules use
`background-color`, never the `background` shorthand that blanks a
background-image.

### To renew, retire or add a sponsor

Edit `SPONSORS` in `assets/oa-sponsors.js` — university, school, department,
and the two dates (`from` inclusive, `to` **exclusive**). Nothing else, and
nothing under `data/`. Retiring one early is a date change; letting one lapse
needs no action at all.

Tests: `testSponsors` in `_scraper/selftest.mjs` (the record's shape, who it
marks and who it must not over the whole served file, both edges of the window,
the folded spellings, the comparator's antisymmetry measured over the real
list, the badge, the wiring on both pages, the load ORDER, the module driven
with its dependency absent, both stylesheets, both themes' tokens, and the
export column) and the sponsor block in `_scraper/page-test.mjs` (the rendered
lead card, the pill, the measured 3px rail, the contrast in both themes, and
that the home teaser is still ordered by date alone). **The browser block asks
the module what to expect rather than naming CUHK**, so it stays green on the
day the sponsorship lapses — a guard about a corpus must not move with the
corpus.

## What a reader who has not REGISTERED may read

Owner, 2026-08-29, from two screenshots of the site signed out: *"they should
only be able to see the list of (1) the sponsor and (2) the list of last 9
universities which posted, but if they click, the card should not expand. It
should only expand when a user is registered and has opened the full list …
a non-registered and non-signed-in user should never be able to view details
of job postings or candidates."*

    assets/oa-gate.js     who is reading, and what a click does (dual-mode)

**WHO is hiring stays open to everybody; WHAT the posting says does not.** The
card keeps its badges, its university and its department — a list of blurred
names would be no list at all, and the first half of that sentence asks for
the sponsor and the nine universities beside it to be READ. What goes is the
body: the entry level, the two deadlines, the comments, the advertisement.
For a candidate it is the same split, and it matters more — the name is what a
hiring committee is looking for, and the CV, the INFORMS days and the e-mail
address are that person's own.

**IT IS A NUDGE, NOT AN ACCESS CONTROL, AND IT CANNOT BE ONE HERE.** This is a
static site on GitHub Pages: `data/jobs.json` and `data/candidates.json` are
served to anybody who asks for them, and no rule in this repository can change
that without a backend to put them behind. So what the gate decides is WHAT
THE SITE SHOWS — a real product decision, the difference between a page that
reads as a directory of open positions and one that reads as a list of
universities with a reason to register — and **no page, no comment and no
e-mail may describe it as privacy or security.** `selftest.mjs` pins that
nothing does, and the module says it at the top where the next reader will
look.

### The values are ABSENT, not blurred

A blur over the real text is a picture of a lock rather than a lock: it is
selectable, copyable, and one keystroke of devtools from being read. So the
engine returns before the details table is built at all, and what the strip
blurs is **the row LABELS that posting would have shown** — the page's own
static wording, true per card (a posting with no suggested date does not
advertise one), and at that radius unreadable. It says "there is a table here
and an account opens it" in the one glance a reader gives a card, which is the
whole job. `user-select: none` is not there to stop anybody copying it; it is
there because a blurred run that highlights when dragged over reads as a
rendering fault.

### Three states, and only one of them is a lock

    locked      signed out. The strip blurs, the padlock is drawn, a press
                offers the sign-in box — and remembers WHICH card, so signing
                in lands the reader on the posting they pressed rather than at
                the top of a list they must find it in again.
    gated       signed in, on the one-pager's TEASER. Nothing is withheld; the
                card is a way IN. A press carries them to the full list with
                that posting open (`?job=<id>`), which is what "it should only
                expand when a user is registered and has opened the full list"
                asks for, literally.
    open        signed in, on a full list. Exactly what it always did.

`oa-card-gated` and `oa-card-locked` are two classes for that reason, and the
padlock is keyed on the second. **A single class named "locked" on a signed-in
reader's card is a statement in the document that is not true**, and the
styling keyed on it then says it out loud — which is how the first build
shipped a padlock in front of "Open it on the full list".

### Where it is mounted, and where it deliberately is not

`jobs.html`, the one-pager's jobs teaser AND its candidates, and
`previous-markets.html` — **a closed season is still a job posting**, and
leaving the archive open would have made the gate on the jobs page a matter of
waiting rather than of registering. Confirmed placements, recent faculty and
the Universities directory are none of the two things the owner named, and are
untouched. The `/v1/` and `/v2/` archives keep their own frozen assets and
never load this file, by the rule the three trees are held to.

### The parts that could quietly become lies

**The sign-in card's copy.** It ended "Everything below stays readable either
way", which was true of the list it was written for and became false the
moment the cards stopped opening. A promise the page breaks is worse than no
promise, so it now says what a reader without an account DOES get. It still
names the Excel download, because that card is the only place a signed-out
reader is told the download exists.

**One definition of "is this reader signed in".** `assets/oa-jobexport.js`
carried its own and now asks the gate, so the button that downloads the list
and the cards that show it can never disagree about who is reading. No silent
fallback when the module is missing — it says no, and the load order is pinned
— because a fallback that is right most of the time is the worst possible
shape for one, which is the lesson `oa-sponsors.js` learnt when its own
dependency was absent on two pages and every test went on passing.

**The decision is taken from the auth HINT first**, like the account chip:
anything painted from a remembered value must be painted in its final form or
not at all, and a gate that waited for the SDK would flash locked cards at
every signed-in reader and details at every signed-out one. `OAGate.watch()`
re-renders when the real state arrives, which is what the engine's
`rerender()` was added for.

**Nobody can sign in** — no accounts module, a blocked CDN, an ad blocker —
and the reader is still not registered, so they are still locked; but the
strip says *"Sign-in is unavailable at the moment"* and the head is disabled,
rather than offering a control that would do nothing when pressed. That is the
wording `oa-jobexport.js` already gives its disabled button.

### When a browser check needs a detail on screen, SIGN THE READER IN

The gate turned several existing checks into contradictions — a signed-out
page modelling a signed-in poster, a `?job=` deep link asserting a card was
open. `signedInPage()` near the top of `page-test.mjs` stands
`_scraper/_fake-firebase.js` up as one helper so a block needs three lines
instead of fifteen, and it waits for the session to RESOLVE, since measuring
between the hint and the answer is measuring a state neither reader is in.
**Anything asserting on a card's rows, its links or its printed body has to
say who is reading**; a page opened without the helper is a signed-out reader,
which is the other half of what has to be covered.

`OAGate.__setForTest` exists for the NODE checks only — there is no SDK there
to sign anybody in — and it can only ever reveal what is already in a public
served file, which is the argument `OAJobEdit.__setPermissionsForTest` is
written under.

## The analytics page draws its own charts, because the old ones died in 2023

`analytics.html` was four Google Sheets `pubchart` `<iframe>`s. The
spreadsheets behind them were filled by the **Google Analytics Spreadsheet
Add-on**, which spoke only the **Universal Analytics Reporting API** — and UA
stopped processing data on **1 July 2023**, with the properties themselves
**deleted on 1 July 2024**. So the add-on had been erroring for three years and
the charts had been frozen or blank for as long.

**Nothing said so, and that is the whole lesson.** A dead embed renders as an
empty box; a page that has stopped measuring and a site nobody visits look
identical from outside. It is the `og:url` failure and the never-deployed
doorbell wearing different clothes: *a thing that reports nothing when it fails
stays broken for as long as nobody happens to look*.

    assets/oa-analytics-model.js   the shape of a day and of a dimension, and what may come from where (pure, dual-mode)
    assets/oa-charts.js            the chart set (line, columns, bars, share) + duration/pct
    assets/oa-analytics.js         the page — fetch one file, draw every figure
    assets/oa-analytics.css        its chrome, theme tokens throughout
    _scraper/build-analytics.mjs   writes data/analytics.json from its gated sources
    .github/workflows/oa-analytics.yml   daily
    _SETUP-ANALYTICS.md            what each source needs, and how it is switched on

### Three sources, and a day belongs to exactly ONE of them

| | what it is | what it needs |
|---|---|---|
| `history` | `data/analytics-history.json` — which will never exist; see "the archive is CONFIRMED GONE" below | nothing, and nothing can be done: the spreadsheets were read and hold no measurement |
| `usage` | the site's own `usageSessions` (assets/oa-usage.js, every page since 2026-08-17) | `FIREBASE_SERVICE_ACCOUNT`, **already a secret here** — so this one works today |
| `ga4` | Google Analytics 4 through the Data API | `GA4_PROPERTY_ID` + `GA4_SERVICE_ACCOUNT`, and a tag on the live site |

**A FOURTH READ IS NOT IN THAT TABLE AND MUST NOT JOIN IT**: `visits`, the
`universityVisits` counters — which universities are reading, from the
visitor's own network (the section below). It measures something none of the
three can measure, so it is passed to `assemble()` separately rather than
entered into a precedence contest over days it has no claim on.

`mergeDays` picks ONE source per day by `SOURCE_ORDER` and **never adds two
together**. Two sources measuring the same Tuesday are two measurements of one
number, not two numbers; summing them would double every day of the overlap —
a chart that looks right, moves in the right direction, and is wrong by a
factor of two.

**An unreachable source changes nothing.** The committed file stands, and the
days already served are carried forward as a floor (`carry` in `assemble`), so
a GA4 timeout costs a day of freshness rather than the history. That matters
more here than in the postings pipeline, because this file *is* the whole page:
a half-written one is a blank dashboard.

**The dead UA tag is still in the archives and nowhere else.**
`assets/js/ypo-parakolouthisi.js` is loaded only by `/v1/` and `/v2/`; the live
site's own tag is `assets/oa-ga4.js` (`G-RE8C5LD2FM`), added on the owner's
instruction on 2026-08-29 — GA4 yes, banner no — which is what the cookieless
section below is about. Firebase issues a Measurement ID of its own
(`G-2CX86W7PHB`) and `oa-firebase.js` deliberately omits it: one property, one
tag, or every page would report twice.

### The university charts, and the conclusion that was wrong

**"Which universities visited" came from UA's `networkDomain` — a reverse-DNS
lookup of the visitor's IP.** GA4 has no such dimension and nothing replaces
it. That much was checked, and from it the conclusion was drawn — and written
into this file, the model, the builder, the page and the changelog, and told to
the owner — that **the figures could never be shown again**. The owner said
otherwise (2026-08-29) and was right.

**What is true is that a BROWSER cannot see its own reverse-DNS.** What that
overlooks is that nothing says the browser has to: anything server-side
receives the connection and can see the address it came from, and this site has
Cloud Functions. So the site now does for itself exactly what UA used to do for
it — and rather better, because the answer is checked against the site's OWN
curated directory of operations departments rather than against whatever string
an ISP happens to publish. The failure shape is one this file names everywhere
else: *a check that answers the question you asked, taken for an answer to the
question you meant.*

    assets/oa-visit.js       one ping per browsing SESSION, from every public page
    _functions/index.js      recordVisit — resolves, classifies, counts
    assets/oa-netorg.js      which university a hostname belongs to (dual-mode)
    _scraper/build-netmap.mjs   domain -> university, DERIVED from the directory
    universityVisits/{day}   counters only; no client may read or write it

**THE IP IS NEVER STORED, and that is the shape rather than a promise.** It is
resolved in memory, the university name is kept, and everything else goes out
of scope when the request ends — not written, not logged. What reaches
Firestore is a counter per day per university: no identifier, no cookie, no
per-visitor row, consistent with the cookieless posture the GA4 tag runs under.
The selftest reads the handler's own source and fails if anything below the
lookup so much as names the address.

**An ISP is not counted at all.** `classify` has three answers — a university
the site publishes a department page for, an academic network it cannot name,
or nothing — and the third is the important one: "one visit from BT Broadband"
narrows a person far harder than "one visit from Oxford", and it answers no
question the chart asks.

**CURATED, NEVER GUESSED.** `data/university-domains.json` is DERIVED from the
`deptUrl` of each row in the Universities directory, so the universities the
site can NAME are exactly the ones it publishes a department page for, and it
grows the way everything else here grows: somebody adds a department. A domain
two universities both claim is **dropped** rather than picked between, and
reported — attributing a visit to the wrong university is worse than not naming
it, because a chart is read as fact and nothing on it would look wrong. The
lookup is on the REGISTRABLE DOMAIN alone, so `some-lab.mit.edu` is MIT and
`notmit.edu` can never be.

**It is a DENYLIST, and that direction was measured.** Requiring an academic
suffix instead dropped **28 real universities** — ETH Zurich (`ethz.ch`),
McGill, Toronto, Bocconi, Erasmus (`rsm.nl`), TUM, Copenhagen Business School,
UCD Smurfit — because outside the English-speaking world a university is very
often on a plain national domain. Losing a university silently is the quieter
and worse failure; a stray hosting domain in the map costs nothing, since
nobody's IP reverse-resolves to `wordpress.com`. `academia.edu` is why a
denylist is needed regardless: it ends in `.edu` and is a company.

**THE ADMIN DESK IS EXCLUDED STRUCTURALLY.** `admin-area.html` does not load
`oa-visit.js` at all — an inclusion list the selftest pins, not a runtime path
check that could drift from `NON_PUBLIC`. The archives never load it either,
since they carry their own frozen assets. **Adding a page means adding the
tag**, exactly as with the GA4 one.

**READ IT AS A SAMPLE, BECAUSE IT IS ONE.** Reverse DNS answers far less often
in 2026 than it did in 2014 — campus egress through a commercial CDN or a cloud
VPN, and a great deal of reading on phones. So every ping increments `seen`
whether or not a name came back, and the page prints what it placed against it:
*"of 12,000 visits, 3,455 (29%) were placed at a university listed here, and 900
more came from a university this site has no department page for. The rest were
on commercial or home connections, which are not recorded at all."* Without that
denominator a short chart reads as "no universities visit", which is precisely
the misreading the rest of this page was rebuilt to prevent.

**THE DENOMINATOR IS WHAT THE SENTENCE CLAIMS — the caption divides by the BARS,
never by `resolved`.** `resolved` counts every address reverse DNS answered for,
an internet provider included, so dividing by it would print "29% came from a
university" over a figure that counts BT Broadband. It is published anyway, and
for one reason: it is the only thing that tells a maintainer looking at a thin
chart whether reverse DNS is failing or the domain map simply does not know
those universities. Two very different fixes, and nothing else on the page
separates them. Academic networks it could not name are counted apart for the
same kind of reason — that is a different fact from "not a university".

**`frozen` still means something, and it is not "unrecoverable".** It means an
ARCHIVE of a closed period, measured under another rule — which is what the
2014-2023 figures would be if they ever turned up. The builder **never merges**
the two: adding a decade of UA counts to a month of resolver counts gives a
ranking that means nothing and cannot be explained on the page.

**IT IS INERT UNTIL THE FUNCTIONS ARE DEPLOYED**, and in this repository they
never have been — the three instant-publish doorbells above are undeployed,
which is why an approval still waits for the schedule. One `firebase deploy
--only functions --project operations-academia` switches on all four. Until
then the ping fails silently, the collection stays empty, the builder logs
`visits: universityVisits is empty`, and the page draws no figure rather than
an empty one. **A doorbell nobody deployed looks exactly like a site that is
simply slow**, and this is the same trap wearing the chart's clothes.

**`build-netmap.mjs` is in `BUILDERS`, after `build-directory.mjs`**, because
it is derived from the directory that builder writes — so a university that
gained a card in a run is recognisable from its network from that run on. It
writes into `_functions/` as well as `data/`, which is why the jobs build's two
`git add` lines name both. The vendored `netorg.js` and `university-domains.json`
are pinned byte-for-byte against their sources: `firebase deploy` ships only
`_functions/`, so a drifted copy would resolve visitors against a stale map in
production with nothing anywhere saying so.

Tests: `testUniversityVisits` in `_scraper/selftest.mjs` (the classifier and
its three answers, the last-entry X-Forwarded-For rule and why, the derived map
against the committed directory, the vendored copies, the handler's source read
back for what it must never do, the rules, the ping's presence on every public
page and its absence from the desk, and — the guard that would have stopped
this being written wrongly a second time — that no file still ASSERTS the
figures cannot come back, matched present-tense so the files may go on
RECOUNTING the mistake in order to correct it), plus the universities block in
`_scraper/page-test.mjs` (a live section carrying no archive chip and printing
its own coverage, and an archived one still labelled with its range).

### The two rules the charts themselves had to learn

* **A month the record has not covered is not a month with no visitors.** Under
  the default 90-day range the hiring-season chart drew eight zero-height bars
  — on a job-market site that reads as "nobody visits in September", which is
  backwards rather than merely missing. It reads the **whole record**, says so
  in its own subtitle, and an `empty` bucket draws no bar at all (the table
  says `—`, never `0`). The weekly rhythm stays range-responsive: 90 days is a
  fine sample of weekdays, where it is no sample at all of a year.
* **The dark theme re-steps the chart accent, and that was measured.** The
  daily chart draws a count and its trailing 7-day mean, so the two must be
  tellable apart. `--brand` against `--gold` separates at ΔE 31.6 in light and
  collapses to **14.9 in dark** — under the floor at which two overlaid lines
  can be told apart even with full colour vision. `--oa-chart-accent` is
  `#d98a24` there (ΔE 21.2, still ≥3:1 on the dark surface). This is the one
  place on the site where two of its colours must be distinguished **from each
  other** rather than from their background, which is a stricter test than
  contrast. The mean is dashed as well, so identity is never colour alone.

Drawing the marks here also takes the reader's theme (the old lede had to
apologise — "they render in their own light styling whichever theme you are
reading in"), gives every chart a `<table>` of its own numbers, makes no
third-party connection on a page that otherwise makes none, and sizes to a
phone instead of being fixed at 900px.

### It has its own workflow, and the builder guard was widened for it

`build-analytics.mjs` is deliberately **not** in `build-all.mjs`'s `BUILDERS`:
that build fires several times an hour and commits `data/` as one unit, and a
once-a-day read of a whole collection folded into it would make every posting's
publish wait on it and share its failure. The selftest's "a builder nobody
calls silently stops running" guard asserted `BUILDERS` equalled every
`build-*.mjs` on disk, so it widened to match its own stated purpose: **every
builder has a caller — `BUILDERS`, or a workflow naming it — and never both**
(both halves verified by reintroducing each bug). The second half is not
tidiness: a builder in both would run twice on one event from two bases, racing
its own commit, which is the duplicate-doorbell outage one layer down.

Tests: `testAnalytics` in `_scraper/selftest.mjs` (the one-source-per-day rule,
the trailing mean, the UTC weekday read — `new Date('YYYY-MM-DD')` rendered
locally shifts every bar by one for readers west of Greenwich — staleness,
the served file's shape and its freedom from addresses, the wiring, the
re-stepped accent, and that the workflow names the branch tip and never
rebases) and the analytics block in `_scraper/page-test.mjs`, which drives the
page in **both themes** with a realistic three-year corpus: the two lines
measured apart from what the browser actually paints, all twelve months drawn,
the frozen label, the empty state naming the cause and `_SETUP-ANALYTICS.md`,
a stale dataset naming its last day, markup in a page title rendered inert, and
the 390px gate. **The page-test check for "no iframes" reads the page with its
HTML comments STRIPPED** — the page still explains the four embeds it no longer
has, and a guard that could not tell the explanation from the thing would have
to be satisfied by deleting the explanation.

### GA4 runs COOKIELESS, which is what stands in for a consent banner

Owner, 2026-08-29: **add GA4, but do not put a banner on the website.** Those
two are compatible exactly one way, and it is worth understanding before
anyone edits `assets/oa-ga4.js`.

The tag configures gtag with **`client_storage: 'none'`** — GA4 keeps nothing
on the visitor's device: no `_ga` cookie, no localStorage, nothing. The
ePrivacy rule a cookie banner exists to satisfy is about **storing** things on
someone's device rather than about analytics as such, so a tag that stores
nothing has nothing to ask permission for. The Privacy Policy says this in as
many words, because a policy silent on it is the one thing that would make the
missing banner look like an oversight rather than a design.

**The cost is real and it has a consequence in the pipeline.** With no
identifier on the device GA4 cannot recognise a returning visitor, so its
`totalUsers` is nearer "sessions" than "people" — a day GA4 owned would report
two or three times the visitors that day really had. So **`SOURCE_ORDER` was
flipped to `['usage', 'ga4', 'history']`**: the site's own first-party record
keeps a stable per-browser id and CAN count distinct visitors, so it wins a
day both measured. GA4 earns second place on **coverage** — it sees visitors
whose browser never reaches Firestore at all (an ad blocker, a private window
with storage refused). Coverage, not identity.

**The two decisions are ONE decision, and the selftest pins them together.**
Turning `COOKIELESS` back to `false` re-introduces the `_ga` cookie and with
it the consent requirement, and simultaneously makes GA4 the better count of
people — so it must move with both a banner and `'ga4'` going back in front.
`testGa4Tag` fails if the flag flips alone.

Three further narrowings, each pinned: Google Signals and ad personalisation
off; a Global Privacy Control or Do Not Track signal means gtag is **never
fetched**, not fetched and asked to behave; and it reports only from
`operationsacademia.org` — `page-test.mjs` opens every page in a real browser,
so without that guard every CI run would post hits to the live property,
indistinguishable from real ones for ever. `anonymize_ip` is deliberately
absent and *explained*: it is a Universal Analytics parameter GA4 ignores, and
carrying it would imply a choice that was not made.

**Every served page carries the tag and no redirect stub does** — the six
meta-refresh stubs go to a fragment of the home page within a moment, so a hit
there would double-count the page they lead to. The selftest walks the
directory rather than a list, so a page added without the tag fails the build;
its only other symptom would be a gap in the figures nobody could see.

The **Property ID `384653143`** ("Operations Academia - GA4") is committed as
the workflow's default rather than made a setup step: it appears in console
URLs, it is useless without the service-account credential beside it, and a
repo variable still overrides it. The `G-` Measurement ID lives in
`oa-ga4.js`; the two are different numbers for different jobs — the tag
collects, the secret reads back — and the site measures correctly with only
the first.

### Only PUBLIC paths reach the served file

Owner, 2026-08-29: *do not show any admin pages or any past version pages, any
test pages, or any admin related data to public visitors.* The first build had
leaked all three into `data/analytics.json` — `/admin-area.html` (87 views) and
`/admin-area` (6), `/v3/` (21) and `/v3/post-a-job.html` (2).

**It is enforced in the BUILDER, not in the page**, and that distinction is the
whole point: `data/analytics.json` is served by Pages to anyone who asks — the
rule this repository already applies to e-mail addresses — so a path filtered
only at render time would still be sitting in a public file for anyone who
opened it directly. A non-public path must never be WRITTEN. The page applies
the same predicate as a second line, for a reader holding a copy cached from
before the fix.

**A non-public session is dropped WHOLE, not merely left out of the pages
list.** A session on the admin desk is not "how the site is used" by anybody
these public figures describe, and counting its pageviews would publish the
maintainer's own admin time — the "admin-related data" half of the
instruction. Someone who visits the desk AND public pages still counts, through
those other sessions. The GA4 leg does the same server-side with a
`dimensionFilter` on both reports, so the day totals mean "visitors who read a
public page".

**Normalise, THEN filter, and that order is load-bearing.** Pages serves both
`/admin-area` and `/admin-area.html` for one file and the build recorded both,
so a filter matching only the spelling somebody thought of would have leaked
the desk under its other name. The canonical form is the one the pages' own
canonical tags use — WITH the extension, `/index.html` folding to `/`.

**Two bugs the tests caught rather than opinions I held:**

* `^/(test|…)[^/]*` matched **`/testimonials.html`**, which would have silently
  hidden a legitimate page. That is the quieter failure of the two — a leak is
  visible to anyone who reads the file, a page missing from a list is visible
  to nobody — so every word must be the whole segment;
* a case-sensitive match let `/ADMIN-AREA` through. Pages would 404 on it, but
  "should never happen" is not a reason to publish it if it does.

**And normalising exposed a wrong number.** `/jobs.html` (467) and `/jobs`
(211) are one file, and plain first-claim-wins published **467** — a third of
the count lost in the direction nobody checks, because the row is still there
and still looks sensible. `mergePages` now separates two questions that were
briefly given one answer: WITHIN a source two spellings are one page and their
views ADD (with the average time re-weighted by views); ACROSS sources the
first claim stands whole, because two sources measuring one page are two
measurements of one number. Both pinned.

Tests: the block in `testAnalytics` pins the predicate both ways (withheld and
still-published, including `/testimonials.html` and `/version-history.html`),
the chokepoint, the two merge rules — and asserts over **the committed
`data/analytics.json` itself** that every path it publishes is public and
already normalised, which is the check that would have caught the leak.

### Several more plots, from Google Analytics — and one rule for all of them

Owner, 2026-08-29: *"add several interesting plots and use insights of the OA
website utilizing data from Google Analytics. What you show so far are data we
collect from the website on our own. make any plots interactive and convert
seconds to e.g. hours, minute, seconds if 'seconds' is too long."*

Five figures joined the four that were there: **when in the day people read
it**, **where readers are**, **how readers arrive**, **which sites send
readers**, and **what they read it on** — plus two tiles, how long a visit
lasts and how many pages it opens.

**A DIMENSION IS ASKED OF ONE SOURCE, AND OF THE SOURCE THAT CAN ANSWER IT.**
That is `mergeDays`' rule one notch stricter, and it bites harder here: two
systems counting the same Tuesday at least agree about what a Tuesday is,
where two systems counting "visits from Germany" disagree about the boundary
of a session, the meaning of a country and the clock an hour is read on.
Adding those, or preferring the larger, produces a number that is not a
measurement of anything. `mergeBreakdown` therefore takes the first
(highest-authority) claim WHOLE and refuses every later one.

The split needs no arbitration, because it falls out of what each source has.
The first-party record knows **when** — it stamps the instant every session
begins — and nothing else; it stores a page, an instant and a duration and
asks no more. GA4 knows **where, how and on what**, and cannot count people at
all. So the hours are the site's own (exact, and UTC), the four audience
figures are GA4's, and neither is ever assembled from both. GA4 is
deliberately NOT also asked for `hour`: it answers on the property's own
clock, and one chart whose meaning changed time zone with its source would be
worse than no chart.

**EVERY GA4 FIGURE COUNTS VISITS, NEVER VISITORS**, and that is the cookieless
decision one layer down. With no identifier on the device GA4 cannot tell a
returning reader from a new one, so calling a country's number "visitors"
would be exactly the overstatement `SOURCE_ORDER` exists to avoid. The records
carry `metric: 'visits'`, the page says visits, and the note at the foot says
why. `newVsReturning` is not asked for at all: cookieless it would measure the
tag's own configuration, and the first-party record could answer it only by
reading its whole collection to find each browser's first day — the unbounded
read the incremental query is shaped to avoid.

**A TALLY CANNOT BE ACCUMULATED THE WAY A DAY CAN**, which is why every
dimension states its own window. A day row merges with what is already served,
so re-reading a few days is enough; adding this run's hour-of-day counts to
the last run's would double every session in the overlap, and taking only the
fresh ones would turn *when people read the site* into *when people read it
this week*. So they are recomputed from scratch over a trailing
`BREAKDOWN_DAYS` (90) window on every run, the read reaches back to it, and
each record reports **the span its data actually covers** rather than the
nominal ninety days — a nominal window slides at every midnight and would
rewrite the served file daily on a site nobody had visited.

**That fixed a latent bug in the pages figure, which is the reason to notice
it.** `pages` was built from whatever slice the incremental read happened to
fetch — seven days, on every run after the first — while the tiles beside it
described the whole record, and nothing on screen said the two meant different
spans. It carries `pagesWindow` now and the figure prints it.

**A FIGURE NO SOURCE HAS ANSWERED FOR IS NOT DRAWN.** It is named at the foot
of the page under "Not on this page yet", and appears on its own once the
figures exist. A heading over an empty axis is precisely the shape of the
defect this whole page is a rebuild of, and the five GA4 figures are empty
today because the tag was switched on the same morning.

**The interactivity, and what each piece is for.** Every chart already had a
tooltip except the one nobody could interrogate at all — the bar lists — so a
row is now a focus stop that answers with **its share of the whole**, taken
from the pre-cut `total` (the classic way a top-ten chart overstates its
leader is to divide by the ten that fitted). The daily chart gained a
**metric switch** (visitors / visits / pageviews — three questions, one
control, rather than three lines nobody can separate), a **legend that is a
switch** (`aria-pressed`, pressed-out rather than vanishing, because hiding is
never a one-way door here either) and the **keyboard**: the plot takes focus
and the arrows walk the days. The column charts' hit areas take focus too. A
crosshair only a pointer can drive leaves the numbers table as the only way
in, which is the fallback rather than the chart.

**The share bars are deliberately not pies.** A pie asks a reader to compare
angles, which is the comparison people are worst at; one stacked bar asks them
to compare lengths on one axis, which is the one they are best at, and it
survives a phone where a pie's labels do not. Colour is never the only
channel: every part is named with its percentage in the legend beneath, in the
same order, and every part is a focus stop. `--oa-cat-1…6` is a categorical
ramp defined in BOTH themes and re-stepped in dark exactly as the accent is —
measured, closest pair anywhere in the ramp ΔE 22.9 (light) / 23.4 (dark),
above the 21.2 this file already accepts for two overlaid lines, and no two
NEIGHBOURING parts closer than 41.

**Seconds are said the way a person says them** (`duration` in oa-charts.js).
The most-read pages list was printing "1,952 seconds on average" — a number a
reader has to divide by sixty before it means anything. Below a minute seconds
are its unit and are kept; above it the smaller unit is zero-padded, so a
column stays aligned and "1h 1m" cannot be misread as "1h 10m"; seconds are
dropped once hours are involved, because carrying them implies a precision an
average does not have.

**Two guards had been passing for the wrong reason and were tightened.** The
browser check asserted "every chart gives its numbers as a table" by comparing
tables against SVGs — and the bar lists had neither, so the promise was
quietly unmet for the one figure that most needed it. It counts `.oa-chart`
hosts now, and asserts there are more of those than SVGs. And a bare
`.oa-range button` reached the new metric switch, which shares the range's
shape on purpose, so the range assertions are scoped to
`.oa-range:not(.oa-switch)`.

Tests: the dimension block in `testAnalytics` (the one-source-per-dimension
rule both ways, the pre-cut share, the clock order, the label rules including
that an address-shaped label is dropped WHOLE and takes its count with it, the
duration formatter, the page's `DIMENSIONS` table pinned against
`BREAKDOWN_IDS` both ways, that the builder asks GA4 for the four dimensions
and does NOT ask it for the hours, and the ramp defined in both themes) plus
the extended analytics block in `page-test.mjs`, which drives the real page:
the five figures drawn, twenty-four hour labels with the two dead night hours
drawing nothing, a tooltip by pointer AND by keyboard reporting 40% where the
visible rows would say 60%, the share parts filling their bar in three
distinct colours, "32m 32s" on screen with the raw seconds nowhere, the metric
switch re-plotting the chart, the legend putting a line away and bringing it
back, and — with no dimensions at all — the five figures ABSENT and named as
missing instead.

### The archive is CONFIRMED GONE, and the spreadsheet says how

Checked 2026-08-29, and the answer is final — **do not send anyone looking
again.** The owner exported all 30 tabs; every one of the 141,540 rows was
read. Not one surviving measurement. The tabs are structurally intact and hold
zeroes, `#REF!`, `#VALUE!` and `#N/A`.

The workbook records the cause in its own cells: every `Report_N` tab says
`Last Run On 2024-07-15 05:32` and `Total Results Found 0`, against UA view
`ga:81760839` for 2014-03-01 onwards. Google deleted UA properties on **1 July
2024**; two weeks later the add-on ran on its schedule, asked a view that no
longer existed, got zero rows — **and wrote those zero rows over ten years of
data.**

**So the data was not lost when Google deleted the property. It was lost when
the spreadsheet refreshed itself.** A scheduled job that overwrites its only
copy with whatever the source returns cannot tell "no results" from "no data".
That is precisely why `build-analytics.mjs` carries the opposite rule —
*an unreachable source changes nothing*, the committed file stands, and the
days already served are carried forward as a floor. The history source's
reader stays wired as a documented recovery path rather than being deleted,
the same reasoning that keeps `repository_dispatch: [oa-jobs-changed]` in
place while the functions are undeployed.

## Mobile standards for tables and lists — MUST consult

**Before building or changing ANY table / card-list page (job postings,
candidates, placements, past markets, or a new one), read
`_MOBILE-STANDARDS.md` and follow it.** In short: mount the shared `OAList`
engine (`assets/oa-list.js` + `assets/oa-list.css`) so the mobile rules are
inherited rather than re-implemented, and add the new page to the
`MOBILE_PAGES` list in `_scraper/page-test.mjs` in the same change. When a
new rule is needed, add it to `_MOBILE-STANDARDS.md` in the same change that
first applies it — the file is the living standard, not a snapshot.

## One spelling per country

`assets/oa-countries.js` is the **single definition** of what each country is
called — a dual-mode file (browser `window.OACountries`, Node `require`), like
`assets/oa-alert-match.js`. It holds the canonical `LIST` the posting form
offers, an `ALIASES` table, and `canon()`.

The country is free text on the form and was free text in the spreadsheets the
archive came from, so one country arrived under several names ("USA"/"UK"/"Hong
Kong SAR"/"Shenzhen, China"), each becoming its own entry in the jobs page's
Location filter. Canonical names are the **full** ones: `United States`, not
`USA`.

**When a new variant turns up, add it to `ALIASES` — never hand-edit the data.**
`data/jobs.json` is rebuilt from Firestore every morning, so a patched row comes
back the next day, whereas an alias fixes it permanently and for every past row
at once. `canon()` never invents: a country it does not recognise is published
under the name its poster gave it.

It is applied at every ingest (`jobs-model.rowFromSubmission`,
`import-sheet.mjs`) and on both sides of every comparison in the alert matcher —
that last one matters, because an alert saved under an old spelling would
otherwise stop matching silently.

### A US city is not the country it is named after

`canon()` reads a comma-separated value from the RIGHT, because the last part of
an address is its most administrative one. That is right, and it had one hole:
a part that is a US CITY sharing a country's name won before the state beside it
was ever considered. St. John's University is in **Jamaica, New York**, and the
site published it under the country **Jamaica**.

So `US_STATES` settles the country — the same "most administrative part wins"
rule the reverse scan already expressed, since a state sits below a country and
above a town. **Georgia is the one that needs care**: it is the only US state
that is also a country, so its NAME settles nothing ("Athens, Georgia" still
reads as the country, because guessing is worse than leaving it) while its
ABBREVIATION settles everything — dropping "GA" with the name left Emory's
`Atlanta, GA 30322` unreadable, which is a bug of its own.

### Where a university actually IS, and the nine postings filed under Greece

`country` drives the jobs page's Location filter, so a wrong one **does not look
wrong**: the posting quietly files itself under a country it has nothing to do
with, and nobody filtering by the right one ever sees it. Nine live postings —
American, Canadian and Singaporean universities — were published under Greece.

**The cause was a form field, not a pipeline.** `post-a-job.html`'s country box
carried no `autocomplete` attribute and is called `country`, so a browser filled
it from the EDITOR'S OWN address profile the moment they opened a posting to
correct something else, and saving published it. The institution box had
`autocomplete="organization"` — the poster's own employer, over the university
they are advertising. Both are `autocomplete="off"` now, and the selftest pins
them; the poster's own name and e-mail keep their autofill, which is what those
tokens are for. On the **candidate** form the affiliation genuinely IS the
person's own, so it keeps `organization` — the rule is whether the field
describes the person filling it in or somebody else.

**The authority for repairing what already happened is the site's own
Universities directory.** Every row of `data/universities.json` carries the
campus's postal address, and `countryFromAddress` reads the country off it;
`campusCountries` in `vocab.mjs` turns that into one answer per university.
`healCountry` corrects a row that contradicts it, and `build-jobs.mjs` applies it
to the MERGED set — the fault came from an editor, not from a source, so it must
be repaired whichever writer produced the row. **`sync-jobmarket-sheet.mjs`
applies it too**, on every read of the workbook and in its `--heal-names` mode:
`data/jobmarket.json` is a served file in its own right, so a wrong country
there files a workbook posting under a place it has nothing to do with even
before the build merges it. The selftest asserts over both files, and reads
both writers' source to check each really heals — a heal only one of them
applies is undone by whichever writes next.

Three properties make that safe, and all three are pinned:

* **A university with two countries is never healed.** INSEAD is in France and
  in Singapore, so its rows disagree and it has no answer here at all — the same
  discipline `schoolForUnit` applies to a department two schools both claim.
* **The parser never invents.** An address that is a map-URL fragment or a bare
  postcode returns `''`, and the audit then says nothing about that university
  rather than guessing.
* **The guard asserts only what the publisher guarantees.** The selftest checks
  `data/jobs.json`, which the build heals before writing, so it cannot fire on a
  legitimate new posting — the failure mode this file records twice. The
  ARCHIVE, which has no daily build, is swept by `country-audit.mjs` as its own
  CI step instead.

**A university the directory does not carry** has no address to read, so its
postings cannot be checked — `node _scraper/country-audit.mjs --all` lists them.
Map it in the Universities sheet, or add the campus country to `CAMPUS_COUNTRY`
in `_scraper/vocab.mjs`, which is grown one curated line at a time exactly like
`oa-institutions.js` and only where the country is not in doubt.

## One spelling per university, school and department

`assets/oa-schools.js` is the **single definition** of what each university,
school and department is called — the same dual-mode shape as
`assets/oa-countries.js` (browser `window.OASchools`, Node `require`), and held
to the same rules.

The three names were free text on the old form and packed into ONE column in
the sheets the archive came from, so one department arrived under half a dozen
names. Tulane's was posted as "Freeman School of Business", "Freeman School of
Business, Management Science", "…, Management Sciences Area", "A.B. Freeman
School of Business, Management Science Department" and "A. B. Freeman School of
Business / Management Sciecne" — five entries in every filter for one place.

What is canonical:

* the **full official name** of the university and the school ("A. B. Freeman
  School of Business"), as with countries;
* the **bare field name** of the department — "Management Science", never
  "Management Science Department", "Management Sciences Area", "Department of
  Management Science" or "…group". The wrapper word is how one school happens
  to organise itself and is exactly what differs between two people describing
  the same unit; the school it sits under is the neighbouring field already.

`canonPlace({institution, school, unit})` does all three at once, because WHICH
of the three a name belongs in is part of what it decides: a department fused
into the school field is moved across ("Kelley School of Business - Operations
and Decision Technologies"), and a legacy archive row that packs all three into
the university field is taken apart ("University of Pennsylvania (The Wharton
School), Operations and Information Management (OPIM) Department"). It is pure
and idempotent, so every writer can apply it on every rebuild.

**When a new variant turns up, add it to `INSTITUTION_ALIASES` /
`SCHOOL_ALIASES` / `UNIT_ALIASES` — never hand-edit the data**, for the reason
the country table gives: `data/jobs.json` is rebuilt from Firestore every
morning. `canon()` never invents — a school it has never seen is published
under the name its poster gave it, and a comma that is part of a name is left
alone ("University of California, Berkeley", "The Chinese University of Hong
Kong, Shenzhen", "Bayes Business School, Faculty of Management").

It is applied at every ingest — `jobs-model.rowFromSubmission`,
`import-sheet.mjs`, `jobmarket-sheet.mjs` — and in the posting form itself
(`assets/oa-jobform.js`), so a poster's own preview and their My postings page
read the way the posting will publish. `data/vocab.json`, the list the form
offers, is built from the canonical rows, so the next poster is offered the
spelling the site already uses.

It also has a third level: `byUniversity[uni].bySchool[school]`, and a
top-level `bySchool` for the case where the university is not known yet. See
the next section.

## A list worth opening: which schools EXIST

`assets/oa-schools.js` above says what a place is CALLED. `assets/oa-institutions.js`
says which places exist — a seed of the world's operations and supply chain schools
(178 records: a university, its business school, and the department doing operations
there), in the same dual-mode shape.

**It canonicalises nothing.** Two `canon()`s would be two answers to one question and
the disagreement would be silent, so a spelling that needs fixing is fixed in
`oa-schools.js` and a place that is missing is added to `oa-institutions.js`. Every
seeded row goes through `canonColumns()` on the way into the vocabulary, so a seeded
place and a place that has actually posted land on ONE spelling and ONE entry.

The seed is what the posting forms offer beyond the site's own history: without it
they could only ever list places that had already advertised here — 63 universities
— so a first-time poster from Bilkent, Cranfield, VinUniversity or Kühne Logistics
met a blank list and typed their name from scratch. It joins through the SAME
`directory` argument `data/universities.json` uses (`institutionSeed()` in
`build-jobs.mjs`), so it inherits everything that already applies to those rows,
and the count `n` still counts POSTINGS ONLY: a seeded name nobody has posted from
carries `n: 0` and claims nothing.

**A university's business school and its industrial engineering school are
different schools, not duplicates.** Departments hang off a (university, school)
pair, which is what `byUniversity[u].bySchool` is for. The seed's source is a
BUSINESS-school directory — one university, one school — so a second school comes
from the site's own directory beside it; the selftest asserts the requirement on the
BUILT vocabulary, where it actually has to hold, not on the seed.

**Two hand-compiled sources name one school long and short.** "Sloan School of
Management" and "MIT Sloan School of Management" were two rows in Toronto's, MIT's
and twenty other universities' school lists, with the postings on one and the
departments on the other. That is settled in `SCOPED_SCHOOL_ALIASES` — scoped
because most of these short forms are generic and a global "College of Business"
alias would rename every university's. The name kept is the FULL OFFICIAL one,
except where the longer string is a parenthetical acronym, a campus note or two
names fused with a slash; where a school has been RENAMED, the current name wins.
The selftest pins that no university offers one school under two names, and that
each university is offered once.

**An alias added today reaches yesterday's postings.** A posting with no document
behind it is carried from the previous `data/jobs.json` unchanged, so it never went
back through an ingest to hear about a new alias — the site published one school
under two names for ever, and the selftest's "every posting names its place the one
way" guard went red, which by design stops the build committing anything at all.
`healPlace` (`jobs-model.mjs`) is applied to every carried row in `build-jobs.mjs`;
it is pure and idempotent, so a run with no new alias changes nothing. The `id`
deliberately FOLLOWS the institution name, as it did when Penn State became The
Pennsylvania State University.

`data/past-postings.json` has no daily build to heal it, so it gets a mode of its
own: **`node _scraper/import-legacy-tables.mjs --heal-names`** (offline, no sheets)
— run it after adding an alias; it covers all three files the importer writes.

**A heal mode is not enough on its own, because `data/` is rewritten from the
sheets.** The importer must canonicalise ON WRITE as well, and originally it
canonicalised nothing at all. Healing only `past-postings.json` there was
caught by CI within the hour: the import job ran `--fetch`, wrote 254 raw
`universities.json` rows, and the selftest's "the map names every place the way
the site does" guard went red on 213 of them. All three write paths are now
healed and pinned by name in `selftest.mjs` — a heal that the next dispatch
undoes is not a fix.

The picker (`assets/oa-combo.js`, dual-mode so its ordering is unit-tested) opens
**alphabetically** — accents folded onto their base letter, so École sits between
Duke and Emory — and narrows as you type. The usage count still labels a row but no
longer orders one: count-first reads as no order at all once the list is three
hundred names long, where the reader knows the name they want and is looking for
it. The render cap went with it (60 → 400 → 1000, the last when the 2026-08-23
bulk approval took the vocabulary past 400 universities and VinUniversity fell
off the end): an alphabetical list cut short ends mid-alphabet and tells the
reader to keep typing without their being able to tell whether their
university is there at all.

**Anything that paints its own ground must name its own ink.** The picker's panel
set `background: #fff` and no colour, so under the dark theme it inherited `--ink`
and drew near-white names on white — 1.65:1, an invisible list rather than a
contrast near-miss. Its surfaces are theme tokens now, each keeping its old light
value as a fallback for the frozen archives, and `page-test.mjs` measures the
rendered ratio in BOTH themes (a fix that only darkened the panel would trade one
broken theme for the other).

**Where a school names its own unit, that name wins.** The bare-field-name rule
above is right in general — "Department", "Area" and "group" are exactly what
differs between two people naming one unit — and wrong for six schools the owner
ruled on (2026-08-18), where the wrapper IS the name: UT Dallas has an Operations
Management **Area**, Purdue a Supply Chain and Operations Management **Faculty**,
Yale an Operations **Department**, Emory an Information Systems **&** Operations
Management. `SCOPED_UNIT_ALIASES` keys them by university (safe for the same
reason the school table is: no other school at those six carries the name, which
the selftest asserts) and the answer is **TERMINAL** — returned exactly as
written, never put back through the rule that would undo it, and never through
`spell()`, which turns " & " into " and ". The lookup asks three ways — as
written, as `spell()` rewrites it, and as the generic rule would leave it —
because listing every wrapper a source might use is the losing game the bare-name
rule exists to avoid. Everywhere else the generic rule is untouched, which is the
whole safety argument for scoping it. `canonUnit(v, institution)` takes the
university, so `assemble` and the posting form's picker both pass it; a
`canonUnit` asked without one still answers the generic way, which is why
`isCanonicalUnit` consults the scoped names directly.

**A substring check is blind to a reordering, and it cost two duplicates.**
"Michael Smurfit Graduate Business School" and "UCD Michael Smurfit Graduate
School of Business" contain neither one another, nor do "Olin Business School"
and "Olin School of Business" — so both went on being offered twice through a
green suite. The selftest now compares names TWO ways: substring, and the
DISTINCTIVE WORDS as a set, dropping the generic ones ("school", "of",
"business") and the university's own name and initials. Department pairs that
are one group or two — only the owner can say — are named in `AWAITING_OWNER`
in `selftest.mjs` rather than silently tolerated: a new pair fails the build, a
listed one is reported by `node _scraper/selftest.mjs --open`, and an entry is
deleted when it is ruled on (the answer going into `SCOPED_UNIT_ALIASES`).
An entry may be listed AHEAD of its pair reaching the committed vocabulary —
it has to be: the posting that introduces the pair sits in Firestore until the
next green build, and demanding the entry and the pair arrive together made
that build impossible (red before the entry, red after it). The selftest
reports such an entry instead of failing on it; one still reported after its
pair has shipped or been settled is stale and should be removed.

**One spelling per place means EVERY dataset, not just the postings** (owner,
2026-08-18: "let's use the same consistent University Name, School Name,
Department Name, across the entire website"). `data/jobs.json` and
`data/past-postings.json` had been canonical for a while; the two datasets
`import-legacy-tables.mjs` writes had never been canonicalised at all — 213 of
the map's 254 rows and 9 faculty placements named their place some other way,
and the map is where a reader LANDS from every posting's "Further info" link.
So `--heal-names` covers all three files it writes, and `sync-jobmarket-sheet.mjs`
has a mode of the same name for the workbook's own postings. Each is offline and
idempotent; the selftest asserts all four datasets together.

Two rules the map heal follows: its `name` and `schoolDept` are DERIVED (the
three names joined) and are rebuilt with them, unless the sheet said something
of its own ("TBC"); and its **`id` never moves**, because the maintainer's
read-time corrections are stored against it (`rowOverrides`,
`<dataset>__<rowId>`) and a renamed id orphans every correction already made.

**A duplicate key in an object literal is silent.** Adding a second
`'Stanford University'` to `SCOPED_SCHOOL_ALIASES` did not merge or warn —
JavaScript kept the last and dropped the earlier rule, so an alias that had
worked for weeks stopped and the only symptom was Stanford listed twice.
`testNoDuplicateKeys` reads the tables from the SOURCE, because by the time the
module has evaluated the evidence is gone.

## The posting form's three name fields cascade

`post-a-job.html` asks for the university, the school and the department
separately, and the three are connected: choosing a university narrows the
school list to that university's schools, and choosing a school narrows the
department list to that school's departments. The lists come from
`data/vocab.json` (`byUniversity[uni].bySchool[school]`, plus a top-level
`bySchool`), and the picker renders a scope under its own heading —
`setScope()` in `assets/oa-combo.js`.

**The cascade is ONE file, `assets/oa-place-picker.js`, and two pages mount
it** — the posting form and the review queue's cards on `admin-area.html`, which
ask the maintainer the same three questions about the same three names. It used
to live inside `oa-jobform.js`, bound to three ids on one page; a copy for the
review panel would have been the drift every other shared module here exists to
prevent. `OAPlacePicker.wire({institution, school, unit}, {onChange})` returns
`{destroy}`, and a caller that re-renders its markup MUST call it: every picker
adds a `document`-level listener (the only way to see a click land outside its
own list), so `OACombo` grew a `destroy()` for exactly this, and the review
panel unmounts before each redraw. The module memoizes the `vocab.json` fetch
(one request per page, however many cards mount it; a failed read is not
remembered), and the selftest pins all of it.

**The vocabulary has a second source: `data/universities.json`**, the site's
own Universities directory. Its 254 curated (institution, school, department)
rows are what let the cascade work for a university that has never posted here
— they add names and, more importantly, they say which department sits in
which school. They carry NO posting count (the "4 postings" note stays a count
of postings), and they are put through `canonPlace()` like everything else,
since a directory row has never been through an ingest. `data/past-postings.json`
is deliberately NOT a source: its legacy rows never separated the institution
from the school and the department, so feeding it in would put the very mess
the vocabulary ends into the university picker.

**A scope is a HINT, never a restriction.** Typing searches the whole site
under a second heading, and a name nobody has posted before is still offered as
a new one — a school that opens a department tomorrow must stay postable. Two
rules follow, both pinned in `page-test.mjs`:

- changing the university **re-scopes the lists, never clears the fields**.
  What the poster typed is theirs;
- a NEAR MISS still finds the university: on leaving the field, text that can
  only be the beginning of one university becomes that university ("tulane" →
  "Tulane University"). Without it the cascade quietly went away — the school
  list opened at every school on the site and the posting was filed under a
  name nobody else uses — and the only thing on screen that said so was the
  absence of a heading. Text that could be several universities, or none, is
  left exactly as typed;
- the fields are put into the published spelling as the poster leaves them, by
  the same `canonPlace()` the submission goes through — so what they read back
  is what everybody else will read. The one exception: a lone institution with
  no school or department yet is canonicalised on its own, because
  `canonPlace()` reads a lone institution as one of the archive's fused
  one-column values and takes it apart.

Two smaller conveniences: a department the site has only ever seen in one
school fills that school in above it, and `assets/oa-combo.js` takes its idea
of "the same name" from its caller (`key`), so the picker itself needs no name
rules of its own.

**Grouping is not publishing.** `institutionKey()` in `assets/oa-schools.js`
answers "is this the same university?" — a trailing acronym and a leading "The"
folded away — and is used ONLY where names are grouped: `data/vocab.json` and
the form reading it back. `canonInstitution()` goes on publishing each posting's
own name, because its id and its permalink are built from it, and "Baruch
College, The City University of New York (CUNY)" is deliberately published
whole. The directory lists one university under several names; the picker must
not offer half its schools from one entry and half from the other.

**A slight respelling is offered a MERGE before it can become a second
entry.** The picker's "new name" row is what lets a school that opens a
department tomorrow stay postable — and it is also how one place quietly
becomes two ("Operation Managment" beside "Operations Management", each with
half the postings). So when the typed name is probably a respelling of one the
site already lists, the picker draws **"did you mean" rows pointing at the
existing entry directly above the add-new row** (`oa-combo.js`, fed by
`similar()` closures in `oa-place-picker.js`). A suggestion, never a
restriction: the add row stays, because only the poster knows whether their
department genuinely is new. The judgement is ONE function —
`similarNames(a, b, {university, fuzzy})` in `assets/oa-schools.js` — with two
strictnesses that must not be swapped: the STRICT tier (substring either way,
or identical distinctive-word sets) is what the selftest's duplicate sweep
holds the built vocabulary to, so it must never fire on two genuinely
different places; the FUZZY tier adds singular/plural, a one-letter slip in a
long word, and containment ("Management" inside "Operations Management") —
right for a waveable suggestion, and exactly what a build-failing assertion
must not use. The selftest's `samePair` reads the module, so the guard at the
door and the audit behind it cannot disagree.

**The Type of institution follows the chosen names.** `typeGuess()` in
`oa-schools.js` is the browser twin of the pipeline's `typeFromNames`
(`jobmarket-sheet.mjs`) — the selftest pins the two against each other over
one fixture list — and the cascade (which now takes the `f-type` select as an
optional fourth field) fills it the moment the names state the answer: "Lee
Business School" is a Business School, "Clarkson University" a University,
INSEAD states neither and fills nothing. Only ever an EMPTY select or its own
earlier guess (`data-oa-auto-type`); a value the poster picked is never
overruled, exactly like the three names.

**A name the site publishes WRONGLY can be corrected by the people who know
— and nothing renames itself.** `oa-schools.js`'s alias tables fix a wrong
spelling permanently, but only the maintainer can edit code. A signed-in
poster can now press **"Suggest a correction"** on `post-a-job.html`
(`assets/oa-namefix.js` → Firestore `nameFixes`, `status` pinned to
`'pending'` by the rules; `from` must be a name the vocabulary actually
offers, because a correction renames something that exists — a NEW place is
simply typed into the posting). The maintainer decides on `admin-area.html`
(a fifth queue, counted in the "Admin area N" badge; the card shows what the
target will PUBLISH as, and the correction itself can be corrected before
approving). The jobs build then reads the APPROVED ones, writes them into the
served **`data/name-fixes.json`** (names only — nothing under `data/` may
carry an e-mail) and applies them through `fixPlace()`:

* **an overlay AFTER canon, never a second canon.** `normalizeFixes()` puts
  every TARGET through `canon*()` first, so a fixed row is still canonical
  under the built-in rules and the "every posting names its place the one
  way" guard stays green without the selftest knowing a fix exists;
* applied at every point the build touches a row: fresh submissions
  (`rowFromSubmission`), carried orphans (`healPlace`), the tracking sheet's
  rows at publish time (their **ids are put back** — a sheet id is
  jobId-shaped and it is the join key to the workbook, the review queue, the
  mirror and the Edit button), and the vocabulary (`buildVocab`), so the
  pickers stop offering the old spelling on the next build;
* the browser loads the same file and applies the same two functions
  (`oa-place-picker.js`, and `collect()` in `oa-jobform.js`), so the poster's
  preview and the published posting cannot disagree;
* **an unreachable queue changes nothing**: the committed file stands, in
  both directions — no fix nobody approved, and no regression of a fix
  already in force;
* the FROZEN ARCHIVES are deliberately not touched — `rowOverrides` and
  `--heal-names` remain their repair paths — and a fix that keeps earning its
  keep is **promoted into the alias tables**, which reach everything.

`DOC_KEYS`/`ADMIN_EDIT_KEYS` in `oa-namefix.js` are pinned against the rules'
`hasOnly()` lists both ways, and against what the form and the panel actually
write, read from the source (`testNameFixes` in `selftest.mjs`). **Inert until
the rules are redeployed**: `firebase deploy --only firestore:rules --project
operations-academia`.

**Three names already in three columns go through `canonColumns()`, never
`canonPlace()`.** `canonPlace` takes apart a value that names more than one
thing — right for the archive's single column, and a guess anywhere else. Over
the posting form's three boxes it read "University of California, Los Angeles
(UCLA)" as a university and a department, publishing under "University of
California" (Berkeley, one word shorter, was left alone); over the Universities
directory's columns it made departments called "Camden, Operations Management"
out of Rutgers' campus and "Computing and Applied Sciences, Industrial
Engineering" out of half of Clemson's college. `canonColumns` keeps the
CURATED fused pairs — a name somebody wrote down as naming both really does —
and drops the separator guesswork, which across every name in the data fires
three times and is wrong twice.

**The site's own links follow the name.** Every posting carries a "Further
info" link into the Universities page, built from its institution
(`jobs-model.universitiesLink`). Canonicalising a name left six of them asking
for the spelling the posting was made under, four landing on nothing — so a
STORED link that is one of ours is regenerated (`ownUniversitiesLink`), while a
link the poster actually gave is never touched. `jobmarket-sheet.mjs` builds it
from the canonical name for the same reason.

**A rename can move a name a saved e-mail alert watches for.** An alert holds
free text, not a name, so nothing can canonicalise it the way `canonCountry`
does. Instead the site's own text search (`assets/oa-list.js`) and the alert
matcher (`assets/oa-alert-match.js`) — and the Universities map
(`assets/oa-uni-map.js`), where those links land — fold punctuation, read "&"
as "and", try
the needle's own canonical form ("SCM" → "Supply Chain Management") and match an
ALL-CAPS needle against the initials of the words in the field ("IEOR" finds
"Industrial Engineering and Operations Research", whose acronym the canon
dropped). THE SAME RULES IN BOTH FILES, pinned by the selftest: an alert that
matched what the site shows must go on matching it, and "what I see on the site"
and "what I am e-mailed" cannot mean different things.

## The posting form pre-fills from the site's records — and keeps them honest

Beside the cascade, `post-a-job.html` mounts **`assets/oa-uniinfo.js`** (owner,
2026-08-24: "when a user enters e.g. INSEAD, the rest fields should be
immediately filled matching what we have in the database"): a dual-mode module
that reads `data/directory.json` — the SAME table universities.html displays,
WITH the community's `directoryEdits` overlaid at read time, so a correction
made there (or through this very form) is the record the next poster is
offered — and fills, per typed name, everything the records answer
DEFINITELY: the university's one school, the one department in scope, a
unanimous type, a single-campus country, and — once the three names identify a
directory row — its `deptUrl` and its `characteristics` checklist (research
seminars, PhD programme, …), which the directory rows now carry from each
place's NEWEST posting (latest wins whole, so unticking a box is how a school
that stopped a programme says so). **Only a definite answer is ever filled**:
INSEAD lists two departments so the department stays empty, and its campuses
sit in three countries so the country does too — the directory model publishes
a multi-campus row's campus countries as a `countries` LIST with NO single
`country` (the `campusCountries` discipline; a posting-vote majority must
never dress that ambiguity up as an answer), and the cards list every one, so
a reader filtering the directory by Singapore finds INSEAD. Every fill lands
in an EMPTY field or over this module's own earlier fill (`data-oa-auto-*`,
the maybeFillType discipline), a fill the poster then CLEARS is a decision and
never refilled, and in EDIT mode the name fields are left entirely alone — a
posting whose owner left the school off must not gain one because the form was
opened.

**The write-back is one bounded thing.** The form's "The department's own
page" field (`f-deptUrl`) pre-fills from the record with a note asking the
poster to VERIFY it; it is never part of the submission document (the
jobSubmissions rules pin that field set — the selftest checks no `out.deptUrl`
ever appears), and after the posting is accepted a CHANGED link is filed as a
`directoryEdits/{rowId}` MERGE (deptUrl + attribution only, so a document
holding somebody's other corrections keeps them; an empty field never erases;
a hidden row is never written). Every OTHER pre-filled field travels with the
posting itself and reaches the directory through the ordinary pipeline — the
build re-reads the published rows. The row id is
**`OASchools.directoryRowKey`, the ONE definition** — directory-model.mjs
re-exports it — so the browser and the build cannot disagree about where a
correction files, including for a place posting here for the first time,
whose row the very build that publishes the posting creates. Pure halves
(`facts`, `overlay`, `deptUrlPatch`) and the rules/field parities are pinned
by `testUniInfo` in selftest.mjs; who actually SEES the fills — INSEAD's
school and type in, its department and country left, the overlaid link, the
filed correction — is measured in page-test.mjs.

## The account menu counts what it links to

"My postings" and "E-mail alerts" read the same whether you had none or a
dozen, so each carries its number now — the shape `/lit/`'s account menu uses.

A menu is on EVERY page of a static site, so a read per page per visitor is a
real cost. Three rules keep it cheap, and `testAccountCounts` pins all three:

* **Paint from the cache first.** The count is remembered per account in
  `localStorage` beside the name hint, so the badge lands with the menu.
* **Refresh once per SESSION, not per page** (`sessionStorage`), using a
  `count()` aggregate — one read whatever the collection holds.
* **An exact count is free where the data is already loaded.** `oa-myjobs.js`
  and `oa-alerts.js` call `OAAccounts.setCount()` from the list they just
  fetched, which costs nothing and is what keeps the badge honest the moment a
  posting is taken down.

**A count we do not KNOW shows nothing** — no badge is honest, a `0` is not —
and zero shows nothing either, since an empty pill beside "My postings" reads
as a fault rather than as "none yet". The cache is keyed to its own uid, a read
that lands after a sign-out is dropped, and signing out forgets it: a shared
machine must not show the next person the last one's numbers.

## A same-day collapse is keyed on the ADVERTISEMENT, not just the day

`collapseSameDay` folds repeat submissions of one posting together — same
market year, institution, department and date, keeping the fullest. That key
assumes a department advertises at most one post a day, and Houston's Bauer
College disproves it: two rows on 2025-09-23, one for Assistant/Associate/Full
"until filled" and one for Assistant only closing 15 October, each with its own
ad link.

They had survived only BY ACCIDENT — one of them omitted its school, so the two
`department` lines differed. The moment canonicalisation put both under the
same department, the collapse silently dropped a real advertisement, exactly
the failure `normKey`'s own comment records from a truncated key.

So a row joins an existing slot only when it does not CONTRADICT it about which
advertisement it is (`adKey`/`sameAdvertisement`). A missing link contradicts
nothing, which keeps the repeat-submission case the function exists for; and a
row pointing only at our own home page — what a sheet row carries when it names
no ad — names nothing. **Anything that makes two postings' names agree can turn
them into one, so a naming change is also a check on the row count.**

## The header paints its FINAL form on the first frame

Owner, 2026-08-18: reloading any page "blinks for a moment and shakes my user
name picture to the green default and then loads my current correct picture."
Both halves were measured in a real browser before anything was changed, with
the Firebase SDK stubbed SLOW rather than dead (a refused request collapses the
very window the bug lives in):

* `#oa-account` was **empty and 0px wide for ~130ms** — oa-accounts.js cannot
  run until the page has parsed — and when the chip landed the row re-flowed
  around it: the nav moved 62px, the theme toggle 185px. That is the shake.
* the chip then painted the **initials disc at 134ms and the photograph at
  796ms**, because the localStorage hint (`oaAuthHint`) carried the name but not
  the picture, so the photo could not arrive until Firestore answered.

The fix is the same idea the theme flash was already solved with — decide it
before the first paint, from what the last visit remembered:

1. **the hint carries the photo** (a profile photo is a 192×192 JPEG data URL,
   ~10–25 KB, capped at 96 KB) **and the chip's measured width**;
2. `profilePhoto()` may fall back to it **only while the profile has not
   loaded**, and only for the same uid — a loaded profile with no photo is an
   account with no photo, and falling through there would resurrect a picture
   the user had just removed, while a uid check is what stops the merge dialog
   wearing this account's face on another account's row;
3. **the inline snippet in every page's `<head>`** — the theme one, extended —
   stamps `data-oa-auth` on `<html>` and hands the stylesheet `--oa-chip-w`, so
   `v3.css` holds the chip's space open **before the browser draws anything**;
4. the width is re-measured **after `document.fonts.ready`**, because the name
   is set in Inter and a chip measured in the fallback face is the wrong width;
   and only where the name is SHOWN (≥901px — the narrow header's chip is an
   avatar and its padding, and storing that would under-reserve the wide one).

`page-test.mjs` drives it: it samples the header every animation frame through
a whole load and fails if the nav or the toggle moves, or if any painted state
is anything but the photograph. **Anything new in the header must keep both
properties** — a control that appears late must have its space reserved from
the head, and anything painted from a remembered value must be painted in its
final form or not at all.

## What the page does before the reader sees anything

The site is static and every page is served whole, so "fast" here is entirely
about what the browser is made to do BEFORE it can paint, and what it is made
to wait for afterwards. Measured on the home page in a real browser
(`_scraper/page-test.mjs` drives the same paths), the rules that came out of it:

* **Nothing on screen waits for Firebase.** The SDK is ~700 KB of third-party
  JavaScript; it used to be `rel=preload`ed in every `<head>`, competing with
  the page's own stylesheet at exactly the moment the first paint is assembled.
  The account chip is painted from the hint, so nothing needs it early. The
  `preconnect` stays — it warms the connection at no bandwidth cost.
* **One request per file per page.** `OAList.load(url)` memoizes by URL and is
  how anything reads a served dataset. The home page was fetching
  `data/jobs.json` twice (117 KB each) because the launcher card's selects and
  the ten-most-recent list each fetched it for themselves, and `placements.json`
  the same way. A failed read is not remembered, so one flaky request is not
  inherited by every list on the page.
* **The scripts are `defer`red.** They were plain classic scripts, so they
  serialised in front of DOMContentLoaded — and therefore in front of every
  list mount, every reveal and the account paint. The trailing inline block on
  the pages that have one is wrapped in a DOMContentLoaded handler in the same
  breath, because a deferred external runs BEFORE an inline script that reads
  what it defines. **Adding a script tag means adding `defer` to it**, and
  putting anything inline that reads `OAList`/`V3`/`OAAccounts` means waiting
  for that event.
* **Content is not held hostage to the whole script chain.** `.v3-reveal`
  blocks are hidden by the stylesheet until v3.js claims them, and that claim
  (`wireReveals`) happens at PARSE time — its first call, before anything that
  could throw — not in `boot()` on DOMContentLoaded behind seven other files.
  The hidden-by-default state is deliberate: a class added by a script at the
  end of the body arrives after the browser has painted, so opting IN to the
  animation would show the page and then hide it again.
* **A figure already at its target is not animated from zero.** The hero's
  counters read their own text; `now === target` used to fall through to 0, so
  the first paint said "0+ universities".

## The phone header carries the site's NAME

The wordmark used to be hidden below 640px (`.v3-header .v3-logo span + span {
display: none }`) because at full size it pushes the burger off a 390px screen.
Hiding the site's name on the devices most people arrive on is the wrong half
of that trade (owner, 2026-08-18), so the lockup is **scaled** instead: smaller
mark, smaller words, tighter gaps, `min-width: 0` so the logo is what gives when
the row is short. `page-test.mjs` measures 320/360/390/430 and fails if the
words are missing, if they run into the menu button, if the burger stops being
the topmost element at its own centre, or if the page scrolls sideways.

## Anything that paints its own ground must name its own ink

Three reports in one morning (2026-08-18) were all the same fault: the
vocabulary dropdown drew near-white names on a white card, the "Your changes
have been saved" panel showed a heading and then two invisible lines, and the
"Choose a file…" button was white on white. Each was a rule that set a
`background` and left `color` to be inherited — fine when it was written,
because there was only one theme, and wrong the moment `[data-theme='dark']`
put a near-white `--ink` on the page around it.

`assets/oa-ui.css` predated the palette and hardcoded ~130 light values.
They are now theme tokens, each **keeping its old value as the `var()`
fallback** — that is what lets `/v1/` and `/v2/`, which define none of them,
go on rendering exactly as they did. Only the semantic panels keep fixed
colours (success green, warning amber, the status pills), and those name a
colour for everything inside them.

Two things this turned up beyond the reports:

* **`--mut` missed AA on every surface it is used on** — 4.03:1 on `--bg-3`,
  4.29:1 on `--bg` — so the footer, the result counts and every hint on the
  site were a hair under readable. It is `#646c78` now, the smallest change
  that clears 4.5:1 everywhere.
* **The map's vendored Leaflet chrome**: the attribution box kept a near-white
  ground in dark theme under our flipped link colour (1.56:1), and the cluster
  badge wrote white on its own pale circles (1.36–2.24:1, in BOTH themes).
  Leaflet's stylesheets stay verbatim copies, so both corrections live in
  `oa-ui.css`, specific enough to win despite loading first.

Two traps this hit, both worth knowing before adding a rule:

* **Specificity AND load order.** The Leaflet attribution override sat in
  `oa-ui.css` at the same specificity as Leaflet's own rule
  (`.leaflet-container .leaflet-control-attribution`), and `leaflet.css` loads
  AFTER it — so the fix silently did nothing and the guard went on reporting
  1.6:1. Map chrome belongs in `assets/oa-uni-map.css`, which loads after all
  three Leaflet stylesheets.
* **`--on-brand`, not `#fff`, on anything filled with `var(--brand)`.** The
  checkbox tick and radio dot were fixed white on a brand-filled box, and
  `--brand` is LIGHT in dark theme — a white tick on a near-white box.
* **One rule naming input, select and textarea can still reach only two of
  them.** `.oa-rv-field` (the review card) set 13px on all three, but
  `.oa-form input[type='text']` — a class, an ATTRIBUTE and a type — outranks
  `.oa-rv-field input`, which has a class and a type. So every typed box on the
  card took the site's form styling at 15px while the select and the textarea
  sat at 13px beside them, measured at 40px against 34px tall; the owner saw it
  and asked why the fonts were smaller. The card sets no size or padding at all
  now — `.oa-form` styles all three, exactly as it styles the posting form the
  maintainer is correcting a posting to match — because the fix for an override
  that can only reach part of what it names is usually to DELETE it, not to
  out-specify it. **Writing a font-size or a padding for a form control means
  measuring all three kinds**, which `page-test.mjs` now does on that card.
* **`background` is a shorthand and blanks a background-IMAGE.** The same rule
  painted the card's controls with `background:`, which wipes the chevron
  `.oa-form select` draws (the browser's own is off under `appearance: none`).
  It is `background-color` there now. Worth knowing: `body.v3 .oa-form select`
  in v3.css does the same thing at a higher specificity, so **no select on the
  v3 site draws that chevron** — a pre-existing, site-wide condition, and
  restoring it needs a theme-aware arrow (the vendored SVG is a fixed `#555`,
  which would be near-invisible on dark).

**`page-test.mjs` measures it, and measuring is the point.** It walks one page
per kind of chrome in BOTH themes and reads what the browser actually paints,
compositing backgrounds rather than taking the first painted layer — a pill on
`rgba(198, 204, 212, 0.13)` is not light, it is 13% light over near-black, and
reading that layer alone reports a perfectly readable button at 1:1. Nothing is
exempt. **When you add a rule that paints a background, give it a colour in the
same change.**

**And it waits for the theme to be PAINTED, not for a stopwatch.** Every page
links a Google Fonts stylesheet that cannot load in CI, and until the cascade
settles the body shows a default grey that is neither theme; measured then,
every muted line reads as a dark-theme failure. A fixed delay reported 14 of
them, all artefacts, with the numbers moving between runs — which is what a
transient looks like. Waiting for `body.v3` does not help either: that class is
in the HTML. The wait asserts the thing itself — the body is painting the
theme's own `--bg` — and nothing downstream may be measured before it does.

## A link nobody can preview is a link nobody clicks

Somebody pasted this site's address into WhatsApp beside `stouras.com/lit`. The
other one drew a card — picture, title, a sentence. This one drew the hostname
twice and nothing else. Both are static sites on GitHub Pages and both had a
complete Open Graph block in the home page's `<head>`, which is why it had gone
unnoticed for months: **a preview that fails reports nothing to anybody.**

Two defects, and the second is the interesting one.

**Twenty-four of the twenty-five live pages carried no preview metadata at
all** — including `jobs.html`, the page people actually send each other. That
was a REGRESSION: before the rebuild, sixteen sub-pages carried `og:*` tags.
They were defective tags, but nothing noticed them leaving.

**And sixty-eight served files that were NOT the home page declared the home
page's address.** Facebook's crawler family — which serves WhatsApp, Messenger,
Facebook, LinkedIn and Viber — keys a preview on **`og:url`, not on the address
that was pasted.** Seventeen archived pages under `/v1/`, every one of them
`noindex,nofollow`, gave `og:url` as `https://www.operationsacademia.org`; and
fifty-one old copies under a directory called `back up` gave it as
`http://operationsacademia.org`, the plain-http apex form of the same place.
Sixty-nine served files, counting the real one, for one address.

Both halves of that had a cause worth remembering:

* **A directory is served unless its name starts with an underscore.** Pages
  runs Jekyll, Jekyll publishes anything not prefixed `_`, and `back up` was
  therefore a public, un-noindexed, fully-crawlable copy of the site — while
  `link-check.mjs` skipped it under a comment calling it "a directory with
  nothing served in it". It is `_backup/` now, which is the entire fix, and the
  belief the comment expressed is true for the first time. **Do not add a
  `.nojekyll` file to this repository.** It is the one change that would undo
  this silently: it turns Jekyll off, and with it the underscore rule that is
  the only thing keeping `_backup/`, `_scraper/` and `_functions/` off the web.
  `share-check.mjs` would still catch the duplicate `og:url` on the next push,
  which is the point of having it — but nothing would catch the rest.
* **`archive-v2.mjs`'s rule 5 was never backported to `/v1/`.** That rule —
  "no page still CLAIMS to be the root", re-pointing an archived page's
  canonical and `og:url` at its own address — was written on promotion day for
  the archive made *that* day. The archive made two days earlier never got it.
  `archive-v1.mjs` is retired and cannot be re-run, so the rule is recorded in
  its `archivePage()` for a future revival and the committed archive was
  patched to what the rule produces. **That is not a breach of "do not edit
  `/v1/`":** the verbatim promise is about a page's CONTENT. An address is not
  content, and a copy under `/v1/` that still calls itself the root is not a
  faithful record — it is a broken one.

### What every live page carries now, and why each tag is there

One block, directly under the `<title>` and **above every stylesheet,
preconnect and script** — Slackbot reads the first 32 KB of a document and
WhatsApp's parser gives up sooner, so a fat head above the tags is a documented
way to lose a card. Every word of it is DEFINED in the `PAGES` table in
`_scraper/share-check.mjs` and the check fails any page that disagrees with
it — so the table is the single source of truth by ENFORCEMENT rather than
by generation: nothing writes the pages from it, and a page edited by hand
goes red until the table agrees.

* `og:*` is read by Facebook, Messenger, WhatsApp, LinkedIn, Telegram, Slack,
  Discord, Signal, Viber and iMessage. It is RDFa: **`property=`, never
  `name=`** — backwards, it is invisible and nothing warns.
* `twitter:card` is the one preview tag with **no Open Graph equivalent**, so
  `og:*` alone can never yield X's large card. `twitter:*` is `name=`.
* `og:image:width` / `height` decide whether the **first** person to share a
  link sees the big card: Meta lays the card out from the declared numbers
  before it has finished downloading the file. They must match the file's real
  pixels, which is why `share-check.mjs` reads the JPEG's own SOFn header
  rather than trusting the tag.
* **Exactly one `og:image`.** Several are legal Open Graph and WhatsApp
  handles them badly.
* Under 300 KB, absolute `https`, no redirect, a file this repository actually
  has. WhatsApp silently drops a heavier thumbnail and the card degrades to
  plain text.
* `<meta name="description">` as well as `og:description`, because WeChat and
  Google read that one and not the Open Graph one.
* `og:locale` is **`en_GB`**, not `en_IE`. Facebook honours only the locales on
  its own published list and `en_IE` is not one of them — an unsupported value
  is ignored rather than rejected, so it fails silently, which is this whole
  section's theme. `stouras.com` uses the same value.
* `<link rel="image_src">` + the `itemprop` trio hand the **square** thumbnail
  to the clients that centre-crop to 1:1 (QQ in practice, WeChat's desktop
  client and WeCom possibly). See `_scraper/make-share-images.mjs`: one asset
  cannot serve both shapes, because a 1200×630 card centre-cropped to a square
  keeps the middle of the logo and none of the tagline.

**The six section stubs deliberately carry NOTHING** — so "every page previews" means every page a reader would send, not literally every file.

**The six section stubs deliberately carry NOTHING.** `candidates.html`,
`placements.html`, `faqs.html`, `contact.html`,
`directors-and-contributors.html` and `resources-for-candidates.html` are
`noindex` meta-refreshes whose canonical is a *fragment* of the home page. Any
`og:url` they carried would resolve to the home page's Open Graph identity —
the sixty-eight-claimants defect, recreated six times over. `card: false` in
`PAGES`, each with its reason. That is the shape `stouras.com`'s redirect
stubs have, and the reason its cards never broke.

**Two things went with it.** `/v2/` had the same defect one layer down: sixteen
of its pages gave `og:image` as `/images/OA_logo_1200x294.png` — a PATH, which
Open Graph does not accept and a crawler therefore ignores — and one gave
`OA_logo_1200x294`, with no directory and no extension, inherited from the 2014
site. That is now rule 3b of `archive-v2.mjs`, which is not retired and was
simply re-run. And **`sitemap.xml` listed every page extensionless** while its
canonical and `og:url` named the `.html` form; Pages serves both, so nothing
404'd — it was just two addresses for one page, which is the same split as the
main defect wearing different clothes. The sitemap now names what the pages
name, and `share-check.mjs` fails if the two part company again.

**robots.txt now names the preview crawlers explicitly.** They were already
allowed by the wildcard; the Sharing Debugger has a bug — 2014, and back in
2024 — where it answers 403 and blames `robots.txt` on a site whose only rule
is a permissive wildcard. Naming them removes that failure mode for nothing.

### What the check cannot see, and what to do about it

`share-check.mjs` proves the tags are right. It cannot prove a crawler can
REACH the page, and three things that produce **exactly** this symptom live
outside the repository:

1. **the Pages edge answering `facebookexternalhit` with a 403** — a
   documented, recurring, per-host GitHub Pages failure, which is precisely the
   shape of "one Pages site works and another does not";
2. **a Meta-side domain flag** — a job-board-shaped domain that mails postings
   is exactly the profile their integrity systems over-trigger on;
3. **a cached FAILED scrape** — Facebook keys the object on `og:url` and holds
   it until something re-scrapes; a URL nobody reshares can hold a failure
   indefinitely, and WhatsApp then pins it per device for days.

**All three are answered by one paste** into
<https://developers.facebook.com/tools/debug/>: read **Response Code** and
**Time Scraped**, then press *Scrape Again* two or three times. Do that after
any change here, and do it before concluding that a fix did not work — testing
on a handset that has already cached the old card proves nothing.

### WeChat, honestly

Mobile WeChat **does not unfurl a pasted link at all**, whatever the `<head>`
says. Tencent withdrew that in April 2017 for any page without a signed JS-SDK
integration, which needs a WeChat-verified Official Account and an ICP-filed
domain — neither available to a GitHub Pages site on a `.org` hosted outside
China. What DOES read these tags: the **desktop** WeChat client, **WeCom**, and
"share to WeChat" from a mobile browser. Those are what the square thumbnail
and the `<title>` are for — WeChat's fallback leans on `<title>` and drops
`og:description` even where it crawls, which is why every page's `<title>` was
made to stand on its own. There is no WeChat sharing debugger and no cache
purge; the only reliable way to force a re-read is to change the URL
(`?v=2`). Worth knowing separately: for readers **inside** mainland China,
GitHub Pages is unreliable and the Google Fonts these pages load are blocked,
so a card is not the binding constraint there.

## Deploying Firebase rules — ALWAYS name the project

    firebase deploy --only firestore:rules --project operations-academia

The Firebase CLI resolves its target from, in order: `--project`, the
`FIREBASE_PROJECT` env var, **the "active project" it remembers PER DIRECTORY
in its own global config**, and only then the default alias in `.firebaserc`.
The remembered one wins over `.firebaserc`, is invisible in the repository, and
survives between sessions.

**That is not hypothetical here.** `firebase deploy --only firestore:rules` run
in this folder published THIS repository's rules into the `stouras-answerarena`
database and printed "Deploy complete!". These rules end in a deny-all
catch-all and name none of that app's collections, so every read and write in
it was refused until its own rules were re-published. Nothing warned, at either
end. (The sibling `konstantinosStouras.github.io` holds six more Firebase
projects; the same thing had already happened once from `lab/search-v2`.)

So `check-project.mjs` runs as a **`predeploy` hook on every deployable section
of `firebase.json`** — `firestore`, `storage` and `functions`, because
`firebase deploy` with no `--only` runs all three. The CLI exports
`GCLOUD_PROJECT` to a predeploy hook, so the target is knowable before anything
is uploaded; a mismatch exits non-zero, which aborts the deploy. Run it
standalone to see where this folder would deploy: `node check-project.mjs`.

It reads the expected project from `.firebaserc`, never a literal, so there is
one place for that truth. `selftest.mjs` fails if a deployable section is left
un-hooked or if the guard starts hardcoding an id — and the guard is the net,
not the practice: **pass `--project` yourself.**

### …and the FIRESTORE rules publish themselves

"Nothing in CI deploys rules — it needs an interactive login" is what this file
said for months, and it was **half true and expensive**. `firebase deploy` does
need a login. Releasing a ruleset does not: the Admin SDK's Security Rules API
(`securityRules().releaseFirestoreRulesetFromSource`) publishes with a SERVICE
ACCOUNT, and `FIREBASE_SERVICE_ACCOUNT` has been a secret here all along —
eight workflows use it.

The cost of the belief was six features shipped INERT behind rules that were
committed and never published: the review queue, the news gate, the name fixes,
the directory edits, and the roster and messaging threads. That last one is how
it surfaced (owner, 2026-08-24) — an Admin-area panel whose code, page and rules
were all in the repository, listing nobody, under a red line telling the
maintainer to go and run a command. **A feature that needs a manual step to
become real looks installed and is not**, which is the failure shape this
repository names everywhere else.

    _scraper/deploy-rules.mjs                 publish _firestore.rules (pure guards + the release)
    .github/workflows/oa-deploy-rules.yml     after every green check on master, or one button

Four properties, and each is load-bearing:

* **It cannot reach another project.** The credential names its own project and
  the script refuses unless that equals `.firebaserc`'s default — this folder's
  rules have twice been published into `stouras-answerarena`, so the CLI guard's
  rule is applied to this road too, by `projectMismatch`.
* **It cannot publish the wrong FILE.** `sourceProblem` refuses an empty or
  truncated read, anything without `rules_version`, and — by name —
  `_storage.rules`, which declares a different service and sits one argument
  away.
* **It runs behind the checks, never on a raw push.** `workflow_run` on
  "OA — checks" succeeding on master: the offline guards are what pin the rules
  against the modules that write those collections, and publishing is the one
  action here the next run cannot undo. Same discipline as "a red selftest stops
  publishing", applied to the rules.
* **It is cheap to fire.** The live ruleset is read first and an identical one is
  a no-op, so a push that touched no rules mints nothing.

**Storage rules and the Functions still go through the CLI**, deliberately —
doubling what a bad run can reach, for a file that changes once a year, is not a
trade worth making. The one thing that can still stop a run is IAM: if the key
cannot release rulesets the script says so and names the role
(`roles/firebaserules.admin`) rather than failing obscurely.

So the rule for this repository is now: **change `_firestore.rules`, let the
checks pass, and it is live.** Both panels that report a permission-denied name
the workflow rather than a terminal.

## Tests that must stay green

    node _scraper/selftest.mjs      # offline model/pipeline checks
    node _scraper/share-check.mjs   # every page previews properly when shared:
                                    # the whole block present, og:url agreeing
                                    # with the canonical, exactly one og:image
                                    # whose declared size matches the file's
                                    # real pixels, and NO TWO SERVED FILES
                                    # claiming one og:url
    node _scraper/higheredjobs-verify.mjs --selftest   # its own round trip
    node _scraper/jobreview-mailer.mjs --selftest      # the review-queue e-mail
    node _scraper/selftest.mjs --publishing   # the same, in a data writer's
                                    # role: a duplicate NAME is reported rather
                                    # than stopping the site publishing
                                    # (it also pins the apply-by cascade that
                                    # decides a posting's market year, and the
                                    # posting form's browser twin of it)
    node _scraper/country-audit.mjs # every posting names the country its
                                    # university is in, against the addresses
                                    # in the site's own Universities directory
                                    # (--all lists the ones it cannot place)
    node _scraper/build-analytics.mjs --selftest   # the analytics assembly
                                    # (the selftest also pins WHAT AN
                                    # UNREGISTERED READER MAY READ — the gate's
                                    # decision, its wiring on every gated list,
                                    # both stylesheets, and that no page calls
                                    # it privacy or security)
    node _scraper/build-netmap.mjs --selftest      # domain -> university, derived
    node _scraper/link-check.mjs    # every internal link resolves, and no
                                    # version of the site reaches into another
    node _scraper/archive-v2.mjs --check   # /v2/ still holds the archive rules
    node _scraper/page-test.mjs     # Playwright browser checks, incl. the
                                    # 390px mobile gate over every list page,
                                    # the picker's alphabetical order and its
                                    # measured contrast in BOTH themes, and
                                    # WHO IS SHOWN WHAT — both readers, real,
                                    # one with no Firebase and one through the
                                    # site's own sign-in path
                                    # (PW_CHROMIUM=<path> pins the browser)

All five run in CI on every push (`.github/workflows/oa-checks.yml`); the jobs
build also runs the selftest AFTER writing `data/` and refuses to commit on
a failure, so a red selftest silently stops publishing — fix it promptly.

`page-test.mjs` skips itself with a friendly message when Playwright is not
installed, which is right on a laptop and wrong in CI — there it exits 1
instead (`process.env.CI`), because the workflow installs the browser two
steps earlier and the only thing a skip could mean is that the install broke.
A guard that reports green while running none of its checks is worse than no
guard. For the same reason the CI step does not use `playwright install
--with-deps`: that runs `apt-get` on every run whether or not the browser is
cached, and on 2026-08-18 a failing-over Ubuntu mirror hung it until the job
cap killed three runs of the same commit. The libraries ship with the runner
image; the apt call is kept bounded and best-effort, and the browser launch is
what proves it.

`page-test.mjs` drives BOTH served designs: the checks that assert on the old
chrome (`#nav`, `#header-wrapper`, `#titleBar`, `#navPanel`, `window.ga`,
jQuery) run against `V2 + 'page.html'`, and the rest against the root.
