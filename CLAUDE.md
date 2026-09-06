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

### …and every card ends with the posting's own ID

Owner, 2026-09-02: *"add the OA job posting ID to each job posting at the
bottom of it to be publicly shown for easy reference."* The id is the one name
a posting has everywhere — the permalink (`?job=<id>`), the join key for edits
and takedowns, the row the Admin area and the run logs name — and until now
nothing on the card showed it, so a reader writing in about a posting could
only describe it, and the maintainer could only guess which one they meant.

**`OAJobNav.refRow(row)` is the one definition**, drawn as the LAST row of the
details on every list that draws a posting (`jobs.html`, the one-pager's
teaser and `previous-markets.html`): the id as a link to its own permalink
(`hrefFor`, so "copy link address" is the shareable form of the same
reference), with the form's reference number beside it where the posting has
one — that is the number the poster was told to keep, and the two together
answer both people. It lives in `oa-jobnav.js` because that module already
owns `hrefFor`, and a row that names a page belongs beside the rule that
decides which page. The html carries its own escaping: an id is derived from
a name somebody typed.

**"Publicly shown" means every signed-in reader, not the maintainer alone**
— it is a card row like the others, so the gate treats it as one: a reader
who has not registered sees its LABEL in the blurred strip and nothing else,
which is the same answer the gate gives every other detail. The leak check
skips `id` already (it is the element's own id attribute), and the reference
never reaches a locked card because no row does.

Tests: `testJobNavModule` (the row's label and link, the reference beside it,
a crawled posting showing the id alone, markup rendered inert, and the wiring
on all three pages — last row, through the module, module loaded first) and
the gated-list block in `page-test.mjs`, which opens a card signed in on both
pages and reads the last row against the card's own element id.

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

**The doorbell that was supposed to close that gap had never rung** when this
shipped (2026-08-26): `publishOnReview` and `publishOnChange` were in
`_functions/index.js` and neither was deployed — the `oa-jobreview-decided`
dispatch had zero runs, ever, and every `oa-jobs-changed` dispatch to that date
was `github-actions[bot]`, the sheet workflow's own final curl, never the
function. So an approval waited for the build's 20-minute schedule while the
card said "publishing starts now" — this file's own recorded trap: *a doorbell
that was never deployed looks exactly like a site that is simply slow*.

**IT RINGS NOW.** The owner ran the `firebase deploy --only functions` this
paragraph asked for on 2026-08-27, and the claim above was checked against the
Actions history rather than left to stand (2026-08-30): `oa-jobreview-decided`
— which nothing but `publishOnReview` can send; no workflow curls it — first
fired at 09:19 that morning and has fired on every decision since, 29 runs in
its first two days, with the build chained on each. A redeploy on 2026-08-29
answered "Skipped (No changes detected)" for all three, which is what an
already-deployed, unchanged function answers. So an approval publishes in
about two minutes, and the ECHO below is not made redundant by it: it still
beats the two-minute chain for the person who pressed the button, and it is
the fallback the day the functions are ever down.

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

**And the copy says what is true of this installation, which has now meant
correcting it twice** — it read "publishing starts now" over an undeployed
doorbell, then "at the next build" once the echo shipped, which the 2026-08-27
deploy turned into an UNDER-promise that read as the doorbell still being dead.
It is "Approved — and on your own jobs page straight away. Everyone else sees
it within a couple of minutes." now, on both decision paths, with `selftest.mjs`
pinning the current cadence and banning both retired wordings — the "copy that
promises a time changes with the cadence" rule, enforced where it was twice
broken.

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

**AND IT FIRES ON THE BUILD, because the schedule cannot keep its promise.**
`post-a-job.html` tells a poster they will hear "as soon as it is publicly
shown", and *publicly shown* is decided by whether their row is in the
checkout's `data/jobs.json` — which is exactly what the build has just
committed. The cron asks for 96 fires a day and GitHub, which throttles
scheduled workflows on a busy repository, delivers about five: measured over
the last twelve fires on 2026-08-30 the **mean gap was six hours and the worst
twelve**. So the mailer is chained to the build's completion, same shape and
same reasoning as `oa-alerts-mail.yml`, and the cron is the safety net it had
already become. A promise the pipeline misses by most of a day is the
copy-versus-cadence gap this file already warns about.

Two things that chain needs, both pinned in `testReviewWiring`: the checkout
must name **`ref: ${{ github.ref_name }}`** — on a `workflow_run` event the
default `github.sha` is the TRIGGERING run's head, and the build commits before
it finishes, so the default reads the commit *before* the postings it was fired
about (the bug `oa-alerts-mail.yml` shipped with, and worse here, because a
stale read does not delay the poster's e-mail, it silently concludes there is
nobody to write to) — and the job is gated on a **successful** build, which
committed something. `oa-submissions-mail.yml` joins `DATA_CHAINED` for the
first and is pinned to the build's own NAME for the second.

**The other half of that sentence is kept by the doorbell, and that is
measured rather than assumed.** "It will appear on the job postings page within
a few minutes" depends on `publishOnChange` ringing the build the moment a
posting is stored, and it does: the build carries 15 `oa-jobs-changed`
dispatches whose actor is the function's PAT rather than `github-actions[bot]`
(see "What 'immediate' costs", where the actor is the whole discriminator).
Both halves of what the form promises are therefore true — but they are true
for different reasons, and only one of them is inside this repository: the
mailer's half is a workflow chain the selftest pins, the publish half is a hand
deployment that can lapse without a word.

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

## The reveal is an instant, not a day, and a candidate can see their own card first

Three owner requests, 2026-09-04: a candidate who has posted a profile can see
how THEIR OWN profile will appear before the reveal (only their own, never
anyone else's); the reveal happens at a time of day that suits readers from
California to Shanghai; and a candidate can edit anything at any time, with the
card then saying when. What was decided, so nobody re-opens it:

**14:00 UTC on the reveal day.** The gate was a UTC calendar day, so the first
scheduled build after midnight UTC revealed, which is 17:00 the previous day in
California. 14:00 UTC is morning in the Americas, afternoon in Europe and
evening in East Asia, all still that calendar day (07:00 Los Angeles, 10:00
New York, 15:00 London, 22:00 Shanghai for the October 2026 reveal). **No page
TYPES those four clocks**: they are the daylight-saving readings, and a reveal
set after the clocks go back (late October, November) is an hour earlier in
the first three. The review sweep found them typed in the FAQ, the form's
intro and the reveal note's fallback; every one now says the UTC hour and the
part of the day, and the clocks a page shows are filled by script from
`describeReveal`, all four or none, with the selftest refusing a typed
`HH:MM` before a city name on the served pages. **`assets/oa-reveal.js` is
the ONE definition** (dual-mode, the `oa-jobnav.js` shape): `revealInstant`
(null for anything but a real yyyy-mm-dd, so a typo can never reveal early),
`isRevealed`, `describeReveal` (the day with its weekday, `14:00 UTC`, the four
cities and the reader's own clock, computed with Intl from NAMED zones rather
than typed, so daylight saving follows on its own, and null where Intl cannot
answer) and `formatDay`, the site's one day-month-year formatter ("2 October
2026"; `longDate` in jobs-model is the other order and stays what it is).
`revealGate` in `candidates-model.mjs` is a thin caller of it, and the meta
carries `revealAtInstant` beside `revealAt`. Seven files compared a calendar day
against `revealAt`, none through a module; every one asks `isRevealed` now, and
`testCandidateReveal` pins the old comparison OUT of each file, because two
copies of "is it out yet" disagreeing is a profile one page calls held while
another calls it live.

**The trigger is a Cloud Function, not a cron.** Nothing in Firestore changes at
14:00, so no document trigger can ring the build; `revealCandidates` in
`_functions/index.js` is a scheduled function (`0 14 * * *`, UTC) that reads the
served `candidates-reveal.json` (cache-busted; Pages holds it ten minutes) and,
on the reveal day, rings the same `ring()` the other doorbells ring with the
same `oa-jobs-changed`. The build's :07/:27/:47 schedule is the safety net, so a
lost ring lands the reveal at 14:07 at worst. **Do NOT add a GitHub cron at 14:00
as well**: two producers for one event is the duplicate-doorbell outage under
"One event, one build", and the selftest refuses a workflow cron on that hour.
Like every function here it is inert until deployed; the deploy also creates
the Cloud Scheduler job, and `firebase functions:list` must read back FOURTEEN
(the four doorbells, `recordVisit`, `sendVerificationEmail` and the eight forum
callables).

**The alerts' reveal note is keyed on the instant, and its mark is lifted to
it.** `candidateNews` announced when the alert's mark preceded the reveal DAY;
it precedes the INSTANT now, so a mark stamped at 09:00 on the reveal day still
gets the note. And the note's stored mark is the newer of the instant and the
newest profile: every profile's `addedAt` is its posting time, weeks before the
reveal, so a mark that was only "the newest profile" sat before the boundary and
the next due run sent the note again (the old fixture hid it with a row dated
the day after the reveal; the new one has every profile posted before it). With
the module absent the old fallback stands: an empty mark announces, a set mark
lists.

**`updatedAt` is a public field, day-cut**, right after `addedAt` and skipped
when empty like `ref`; the card prints "Profile updated on 2 October 2026" only
when it is a later day than `addedAt` (the renderer is `oa-candcard.js`, the one
card builder the public list and the two previews share). It is NOT an alerts
cursor: the candidates topic lists by `addedAt` alone, so an edit never
re-announces a profile, and `mergeCandidateRows` keeps the previous `addedAt`
while taking the fresh `updatedAt`. The rules bound it (`str('updatedAt', 40)`
in `candShapeOk`, never in the merge hand-over's `hasOnly`); the create ceiling
of 34 stands, since the form writes it only on the edit path. Nothing gates Edit
on the reveal, before or after it, and the selftest pins that nothing does.

**Only the candidate sees their own card early, and the copy names the
maintainer too.** The account page reads `candidateSubmissions` by
`where('uid', '==', user.uid)`, which the rules already allow the owner
(`allow read: if isOwner(resource.data.uid) || isAdmin()`), and draws it
through the same renderer as the public list with a browser twin of the
build's projection pinned against the real one, so the preview is what the
build would publish and never anyone else's document. The `|| isAdmin()` is
why the line reads "only you and the site's maintainer": the Admin area lists
every held profile, and a site that reads something and says so nowhere is
wrong whatever its rules allow. The section also answers the two states the
first version headed as "will go public": a TAKEN-DOWN profile is anything
the build does not publish (it reads `queued` and `published` only, and
rewrites a candidate's `withdrawn` to `removed` within minutes, so testing for
the two words the page knew missed the one it lands in), headed "Your profile
(taken down)"; and a profile from a PAST season, headed as such, drawn when no
profile matches the market under way, with the card above offering this
season's rather than claiming one exists. And "Profile updated on" is stamped
only when something CHANGED (`dirty`, the test the preview already drew the
line by; the CV slot's Remove is a button and reports itself), so a Save over
an untouched form writes the stored stamp back rather than today.

**ONE renderer, ONE projection: `assets/oa-candcard.js`.** The card the
candidates list draws was inline in `index.html`; it is `cardConfig` now (the
same seven labelled rows in the same order, with `index.html` passing its own
three link helpers so the list's output is byte for byte what it was), and
`publicRowFromDoc` is the browser twin of `rowFromCandidateSubmission` +
`publicCandidateRow`, with the name canonicaliser, the market year and the
owner digest INJECTED the way `OAFresh.approvedRow` injects `canonColumns`. The
account page's own-card section and the form's live preview (`paintCardPreview`
in `oa-candidateform.js`, reading a QUIET `readForm()` that paints no error and
moves no focus while the reader types) both go through it, so a preview cannot
show a link the build refuses or a name it re-spells. `decorate` adds the
"Profile updated on" line only INSIDE a card body: a locked card has none, so
the blurred strip never advertises the line and the values stay absent rather
than hidden. The twin is pinned against the real projection over a fixture
table covering every branch, `FIELDS` against `CANDIDATE_PUBLIC_FIELDS` both
ways, and the load order on all three pages; `page-test.mjs` drives the account
preview with a second, foreign document that must never appear, the form's
preview following a keystroke, the updated-on line on exactly the served row
that earned it, the reveal note's local clock, and both pages at 390px.

Tests: `testCandidateReveal` in `_scraper/selftest.mjs` (the module to the
second, with and without Intl; the gate's parity; the meta's instant; every
consumer through the module and the old comparison out of each; the doorbell's
shape, hour and helper; no workflow cron at 14:00; the setup guide; the public
field, the rules and the three writers; Edit ungated), the reveal block of
`build-candidates.mjs --selftest`, `alerts-mailer.mjs --selftest` for the note's
instant and its lifted mark, and `submissions-mailer.mjs --selftest` for an
e-mail that stops saying "held" from the instant on.

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
figure is public, here the COLLECTION is **the maintainer's alone**: it is
admin-read in `_firestore.rules` (it was public-read, which nothing public
ever consumed) and the Admin area is the one place the live aggregate is
shown. **The COUNT itself is public since 2026-09-05** (owner: the number of
registered users belongs on the front page, as on /lit/): the roster sync
writes it to `data/users-meta.json` from Auth, which is the public path, and
the front page reads that served file; the collection's read rule did not
move, so a browser still cannot count the tally itself. The card is
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

An account already current costs no write, so a daily fire commits nothing to
the roster. The dispatch exists for the case that created the gap: right after
a rules deploy.

**Its scan prints the document, never the person.** The `--scan` and
`--dry-run` lines used to print each changed account's full address and name,
and the workflow's `scan` button runs exactly that mode into the Actions log of
a public repository. They carry the id and a redacted address now, through
`redact()` from `_mail.mjs`, and no name at all (the id already says which row
would change); the sync's own selftest and `testUserDirectorySync` sweep every
log line in `main()` for it, the way the campaign mailer's suite already did.

**The same read writes two SERVED files** (owner, 2026-09-05: the number of
registered users on the front page, as on /lit/, and a growth chart on the
analytics page). `usersMeta` writes `data/users-meta.json`, `{ generated,
count }`; `usersGrowth` writes
`data/users-growth.json`, `{ generated, first, days: [[yyyy-mm-dd, n], ...] }`,
one point per UTC day from the first account's creation day to the generated
day, cumulative and never decreasing, its last point equal to the count so
the two files cannot disagree. **The count is the Admin area's, not Auth's**
(owner, 2026-09-05: the front page said "130+" over a Registered-users tile
saying 106, "it should say 100+ instead"). Auth holds every account ever
CREATED, and many never became usable: a password registration whose address
was never confirmed, an account made and never signed in. The tile counts
`registeredUsers`, the mark a usable sign-in writes, and that is what the
figure has meant since the tile shipped. So `members(users, marks)` counts
the Auth accounts that are not disabled AND carry a mark, the run reads the
tally beside Auth and hands its uids to both writers, and the growth chart
dates those same people by Auth's `creationTime` (the mark's `t` is last
seen, not joined). A mark with no account behind it is not counted, so the
front page reads at or below the tile and never above. And **a merge takes
one off** (owner, the same day: "if two profiles merge, then the number of
registered users should decrease by one too"): `runMerge` deletes the
duplicate's mark and then its Auth account, and the join drops the
duplicate the moment the mark is gone, whether or not the account deletion
behind it succeeded, so the count is of people exactly as the tile's is. **A tally that cannot
be read, or reads as empty, writes neither file**: the committed ones stand
and the run says so, the unreachable-source rule. Pinned in the sync's own
selftest and `testUserDirectorySync` (the join, Auth alone never the count,
the orphan mark ignored, the collection name against `oa-firebase.js`, and
the write withheld without the tally). Counts and dates and NOTHING else, because
everything under `data/` is served to anyone who asks; the selftest pins the
key lists exactly and sweeps both files for an address. The committed seeds
are the valid empty shapes (`{"generated":"","count":0}`,
`{"generated":"","first":"","days":[]}`), so the front page hides its tile and
the chart is absent until a run with the credential writes real ones, and the
shape pin is never vacuous. `oa-user-directory.yml` is a data WRITER now: it
joined `WRITERS` in the selftest, runs `selftest.mjs --publishing` before and
after the sync, checks out `github.ref_name`, and commits the two files with
the rebuild-never-rebase retry (the sync is re-run on the other writer's tip,
never rebased). The growth file gains a point every day by construction, so
the job commits daily, like `data/analytics.json`. The sync's Admin SDK handle
is `firebaseAdmin()` from `_mail.mjs`, shared with the mailers, so there is
one definition of "the credential is missing or malformed".

### The front page's fifth key figure is BORN HIDDEN

The hero strip (`#v3-stats` in `index.html`) held four figures, three of them
seeded in the markup and raised by the live files (`V3.statTo` only ever
raises). The fifth, **registered users**, has no seed it could honestly carry:
nothing in this repository can write the count without the credential, and a
"0+" over a community of some dozens is a lie in the first thing a visitor
reads. So the tile is in the HTML with an EMPTY `<b>` and the `hidden`
attribute, and the page reveals it only when `data/users-meta.json` loads with
a count of ten or more, printed **rounded DOWN to the nearest ten with a
plus** ("60+"), so the number shown is never more than the count. Under ten
nothing changes, and a missing or seed file changes nothing either.

Two orderings are load-bearing and both are pinned. **Reveal BEFORE
`statTo`**: the count-up waits for the tile to scroll into view through an
IntersectionObserver, and a `display: none` element never intersects, so a
tile revealed after the call would sit on 0 for ever. And **the grid fits four
OR five**: `.v3-stats` was `repeat(4, minmax(0, 1fr))`, which puts a fifth
tile alone on a second row at every desktop width; it is column auto-flow now
(a hidden tile is `display: none` and claims no track), with the two phone
breakpoints switching back to row flow with their own templates. The fetch
carries `cache: 'no-cache'` like every read of `data/`. The FAQ's "Is my
personal information published?" answer says the count is public and who they
are is not, the same sentence the Privacy Policy already carries.

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

## Deleting an account, and why the two halves are not symmetric

Owner, 2026-09-05: *"There is no option for a user to completely delete their
profile. You should have it within their personal area … Also, the admin should
be able to delete a user."* Neither existed. The account page could edit a
profile and merge two accounts; the only way out was to write to the
maintainer, and the maintainer's own only route was the Firebase console.

    assets/oa-account-delete.js   what a deletion IS (pure), the panel, the roster's control
    accountDeletions/{uid}        the work order, one per account
    _scraper/purge-accounts.mjs   the sweep that carries it out, with the Admin SDK
    .github/workflows/oa-purge-accounts.yml   on the BUILD's completion, plus daily

**A PERSON CAN DO NEARLY ALL OF THEIR OWN DELETION IN THEIR OWN BROWSER**, and
that half is live the moment it merges. `_firestore.rules` already lets an
owner withdraw their postings and delete their alerts, their profile, their
`registeredUsers` mark and their roster row, and Firebase lets a session delete
its own sign-in — which is exactly the set of writes `runMerge` already makes
for the account it removes.

**THE MAINTAINER CAN DO ALMOST NONE OF IT.** `users/{uid}/**` is owner-only
with no admin clause, so no browser can delete somebody else's e-mail alerts —
and an alert left behind mails a person who no longer exists FOR EVER: the
mailer enumerates every subscription by collection group and never asks whether
the uid still exists, and unsubscribing needs a sign-in the account no longer
has. `profiles`, `registeredUsers` and `userDirectory` are owner-delete too, and
no browser can delete another account's **Auth** record at all. A browser-only
admin deletion would be a row of caught-and-ignored permission-denieds: green on
screen, and the sign-in still alive.

So a deletion is a **WORK ORDER** both sides write and one sweep carries out.

**A CALLABLE CLOUD FUNCTION WOULD HAVE BEEN FASTER AND WAS REJECTED.** It would
be inert until somebody ran `firebase deploy --only functions` by hand, and this
file has twice written down what that costs — *a feature that needs a manual
step to become real looks installed and is not*, and *a doorbell that was never
deployed looks exactly like a site that is simply slow*. It would also make the
deploy count SEVEN and sit between two source slices the selftest pins.
`FIREBASE_SERVICE_ACCOUNT` has been a secret here for months, so the workflow
road is live on merge with nothing to remember.

**EVERYTHING THE PERSON POSTED COMES OFF THE SITE**, said plainly, by name,
before the button is pressed. The alternative was considered and rejected:
leaving a job posting up means either keeping the document that carries the
poster's own name, address and private note — the opposite of deleting an
account — or deleting the document and leaving the published row ORPHANED,
carried by `build-jobs.mjs` for ever and beyond anyone's reach, the maintainer's
included. A posting nobody can correct or take down is worse for the school than
one that is gone.

### The order is the whole of it, and the two ends run it BACKWARDS

**In the browser: the work order FIRST, the sign-in LAST.** The order is written
before anything is taken away, so a browser closed half way through, a refused
write or a cancelled password check leaves something the sweep finishes from —
without it there is no way to know the account was meant to go, and the person
cannot ask again, because their alerts and possibly their sign-in have already
gone. The sign-in goes last for `runMerge`'s own reason: a session that has gone
cannot write, so anything still owed then is owed for ever. In between: withdraw
the postings, delete the alerts, delete the details, the tally mark and the
roster row. Then `OAAccounts.signOut()`, because the hint the header is painted
from before any script runs, and the menu's cached counts, belong to an account
that no longer exists.

**In the sweep: the sign-in FIRST**, which is the mirror image rather than a
contradiction. The Admin SDK needs no session — and while the sign-in exists a
tab the person left open goes on minting work, because `enterSession` re-creates
the `registeredUsers` mark and `syncDirectoryRow` re-creates the roster row,
each latched per TAB. Deleting it first stops any NEW token being issued.

**A POSTING IS WITHDRAWN, NEVER DELETED.** `build-jobs.mjs` says it in as many
words: *"taking a posting down is a STATUS CHANGE (withdrawn/hidden), never
deleting its document. Deleting the document would leave the row orphaned and
therefore preserved."* Both ends withdraw; only the sweep deletes the documents,
and only once four things are true.

### The password box that stopped a deletion, and the retry it made impossible

Owner, 2026-09-05, from a real deletion of their own test account: *"the site
asked me to add my password. I didn't remember my password. So at that step I
left it … But then, tried to delete my account and the site doesn't let me …
There is no reason we ask them to add their password. It's too complicated, not
needed."* Two defects, and the second was caused by the first.

**THE PROMPT WAS INHERITED FROM THE MERGE AND DOES NOT BELONG HERE.** Firebase
refuses to delete a session older than a few minutes until it is re-proved, and
`deleteCurrentSignIn` answers that by asking for the password back. The MERGE
has to: nothing else can finish a merge. A DELETION has the sweep, which
removes the sign-in with the Admin SDK and needs no password from anybody. So
the deletion path passes `{ reauth: false }`, tries, and treats a refusal as
the ordinary outcome for anyone who did not sign in a minute ago. The card says
when the sign-in goes rather than claiming it has gone.

**AND A SECOND ATTEMPT WAS REFUSED, WHICH IS THE WORSE HALF.** The work order
is written FIRST, before anything is taken away, precisely so an interrupted
run can be finished. But `allow update: if false` is what makes the sweep's
own stamps safe, and to Firestore a `set` over a document that already exists
IS an update. So the first attempt filed the order, the prompt stopped it, and
every attempt after that was refused with a permission-denied — which the panel
reported as *"This is not switched on yet"*, sending the owner to look for a
rules deploy that had happened hours before. **The step READS the order first
now** and carries on from one already filed; a read that itself fails falls
through to the write, so a genuine rules problem still surfaces as one. The
maintainer's own `requestFor` has the same shape for the same reason.

**The copy no longer names a cause it cannot know.** A permission-denied now
says to reload and try once more, and mentions the rules only as what is left
if that does not help.

Tests: the pins in `testAccountDeletion` (read-before-write on both writers,
`{ reauth: false }`, and nothing on the path re-proving the session) and the
block in `page-test.mjs` that drives the owner's exact case — an order already
filed, a session Firebase will not let delete itself — and asserts it finishes,
reads rather than writes the order, asks for no password, and says when the
sign-in goes.

### …and then a NEW account could not be deleted either

Owner, 2026-09-05, minutes after registering one: *"I registered a new user.
Then immediately after tried to delete that user profile entirely. The website
doesn't let me."* The panel said *"We could not read what this account has
posted, so we cannot take it down"* and **disabled the button**, so there was
nothing left on the page to press.

**THE CAUSE IS THE TOKEN, AND THIS FILE ALREADY KNEW THE FACT.** `isOwner()`
goes through `verified()`, which reads `email_verified` off the ID TOKEN, and
the SDK caches that token for up to an hour — the same fact gate 4 below turns
the other way round, that deleting an Auth account does not invalidate a token
already minted. So an account that confirmed its address minutes ago goes on
presenting the claims it had BEFORE it did, and every read of its own data is
refused: its postings, its alerts, its profile. `confirmVerified` states the
rule on the LIFT (*reload() updates the user object; the rules read the token*,
with `getIdToken(true)` beside it and a comment saying the second call is not
optional) and a session RESTORED on a later page load lifts nothing, so nothing
refreshed it. **`OAAccounts.survey()` re-mints it first now** (`freshClaims`),
best effort and deliberately: a refresh that fails changes nothing, and the read
behind it reports for itself.

**AND THE PANEL NO LONGER DEAD-ENDS ON A READ IT WAS REFUSED.** The survey is
how the panel NAMES what will go; it is not what does the removal. The removal
is the sweep's, with the Admin SDK, over an account it enumerates server-side
and cannot be refused. So a survey the browser could not read is a list it
cannot print, never a deletion it must refuse: **the typed word is the only gate
on the button**, the note in the list's place says the list is missing and that
everything goes regardless, and `describe()` stops saying *"your account holds
nothing you have posted"*, which this page has no way of knowing. The work order
is filed exactly as before, which is the whole of what the sweep needs.

**THE MERGE KEEPS THE OPPOSITE RULE, and what separates them is what finishes
them.** `runMerge` still refuses when the postings could not be listed, because
nothing but that browser finishes a merge: what it cannot enumerate it cannot
move, and its last step removes the only sign-in that could ever reach it again.
A deletion has a sweep behind it. One survey, two flows, opposite answers, for
that one reason.

Tests: the pins in `testAccountDeletion` (the token re-minted before the survey,
the typed word as the only gate, and `describe()` claiming no empty account it
cannot see) and the block in `page-test.mjs` that drives the owner's own case in
a real browser — every read of the account refused, through the shim's
`refuseReads`, which is its stand-in for a stale token: the note drawn, the
button offered, the deletion finished, the work order filed, and the forced
token ahead of the survey's first query.

### The four gates on deleting a submission's document

1. **The build has run SINCE the withdrawal.** `data/jobs-meta.json`'s
   `generated` must be at least `BUILD_GRACE_MS` (15 minutes) past the moment
   the postings were withdrawn. The idea is `oa-fresh.js`'s own 90-second
   grace; the number is ten times larger, deliberately — there the cost of
   being early is a stale value on one screen for a minute, here it is a
   published row whose document has gone, and waiting costs one more
   twenty-minute cycle.
2. **No served file still names the account.** Measured, never assumed:
   `owner` is a digest of the uid and is published on every row of all three
   datasets (`PUBLIC_FIELDS`, `CANDIDATE_PUBLIC_FIELDS`,
   `PLACEMENT_PUBLIC_FIELDS`), so the files answer the question directly, with
   every `ref` and id the documents carry as the belt to that braces (the
   `removalSpecs` shape). **An unreadable file is ABSENT, never empty** — the
   unreachable-source rule, and here an empty read would delete a document
   under a row that is still on the site.
3. **The Google Drive copies are gone.** A job advertisement and a candidate's
   CV are filed into Drive by the build, which writes the Drive id onto the
   document and nowhere else; the credential's `drive.file` scope cannot see
   anything it did not create, so it cannot list the folder to find an orphan.
   Delete the document first and that file — whose name carries the person's
   own name — sits in the shared Drive for ever with no route to it. So they go
   first, and a failure HOLDS the deletion rather than being swallowed.
4. **An hour has passed since the sign-in went.** Deleting an Auth account
   revokes its refresh tokens and does NOT invalidate an ID token already
   minted, and the rules read the token. The three owned documents are swept
   once more before the order is closed, in case one of those tokens put the
   tally mark or the roster row back.

Until all four hold the order stays open and **the run's log says which one it
is waiting on**, rather than leaving it to be guessed at.

### What goes, what is anonymised, and what stays

**Goes**: the postings (withdrawn, then their documents), the e-mail alerts and
everything else under `users/{uid}`, the profile, the `registeredUsers` mark,
the roster row, the message thread and its items, the identity keys in
`accountKeys` (only while they still name THIS account — a claim another
account has taken over is somebody else's), the `usageSessions` records,
`verifyMail/{uid}` (the verification mailer's own rate limit: keyed on the
account and `allow read, write: if false`, so this sweep is the only thing that
could ever reach it), the Storage landing strip, the Drive copies, and the Auth
record.

**…and the DEVICE's own memory, which signing out deliberately does not
reach.** `signOut()` clears the header hint, the picture beside it and the two
count caches, and leaves the rest, because the rest is this browser's working
state and belongs to whoever is sitting there. A deletion is the case where it
does not: `forgetThisDevice` also removes the job form's unsent DRAFT
(`oa:jobdraft:v1`, which holds the poster's own name and address, the chair's,
and the private note, and is otherwise cleared only by a successful send), the
edit echo, the pending-verification marker and the two per-uid latches. Named
keys, never a prefix sweep: a machine may be shared, and a key belonging to
another account there is somebody else's.

**The MESSAGE THREAD is deleted, and that is a departure worth naming.** The
rules keep a thread out of both parties' hands because *a thread whose history
either party can rewrite is not a record of anything*, and the MERGE
deliberately leaves one behind — because a merged account's person is still
here and the conversation is still theirs. A deletion is the case that is not:
the person it was with has asked to be gone, and it is a two-party conversation
with nobody else's stake in it. Disclosed in the Privacy Policy.

**Anonymised, not deleted**: a `directoryEdits` correction to the Universities
directory (public-read, and its `name` is printed on the card as "Last edited by
… on …", so the name goes and `oa-directory.js` falls back to "a registered
user") and a `nameFixes` suggestion (its `authEmail` goes). Deleting either
would revert a correction the community relies on — `build-jobs.mjs` rewrites
`data/name-fixes.json` from a fresh queue read and applies it to every published
and carried row, so removing a suggester's document un-renames the site. The
field is **blanked, never deleted as a key**: the rules bound these with
`str()`, and a key that has gone is a different shape from a blank one.

**The public figures follow on their own, and one of them moves BACKWARDS.**
`data/users-meta.json` counts the Auth accounts that carry a `registeredUsers`
mark, so a deletion takes one off exactly as a merge does. `data/users-growth.json`
is RECOMPUTED from the surviving accounts on every roster sync rather than
appended to, so a deletion also lowers every point at or after that person's
joining day. That is inherent in a series built from who is here now, it is the
same behaviour a merge already had, and it is worth knowing before somebody
reads the whole chart shifting as a bug.

**Stays, and the Privacy Policy says so rather than claiming otherwise**:
anything sent through the feedback form. `feedback` carries no uid at all — its
own key list has none, and a signed-out visitor can send one — so joining it to
an account by the address typed into a public form would be a guess. It is
removed on request, like everything else that has to be asked for.

### The rules, and the one place an Admin-SDK stamp is safe

`accountDeletions/{uid}` is keyed on the uid itself (the `messages/{uid}` and
`verifyMail/{uid}` shape), so a person cannot open two and the sweep finds one
with a `get()`. Three things the rules pin, each closing a hole: **`by` is
pinned to who is writing** (a person files their own as `self`, the maintainer
files anyone's as `admin`, so an ordinary account cannot file an order that
reads as the maintainer's decision); **`uid` must equal the document id**; and
**nobody updates one from a browser**. The sweep's own keys (`clearedAt`,
`doneAt`, `removed`, `note`) are deliberately outside the create list, which is
safe here and only here — the `sync-user-directory` trap is an Admin-SDK key
that makes a document its own owner can no longer write, and there is no later
owner write to freeze. `REQUEST_KEYS` and `SWEEP_KEYS` are pinned against the
rules, and against each other as disjoint sets.

**Cancelling is allowed only while it is still queued** (`allow delete: if
isAdmin() && resource.data.status == 'requested'` — `resource` is the STORED
document on a delete, which is what lets the condition read the status). Once
the sweep has started, "cancelled" would be a lie: the alerts and the sign-in
have gone.

**An unverified password account cannot file one**, because `isOwner()` goes
through `verified()` like every other user write here. It holds a profile
document and a sign-in and nothing else, and the roster is seeded from Auth
itself, so that account is deleted from the Admin area.

**A finished order is REDACTED, not kept**: a record that an account was deleted
on a day is worth keeping; a record of a deleted person that still carries their
name and their address is the thing the deletion was for. What is left is a uid,
the dates and the counts.

### Where the controls are, and what they say

`account.html` carries the section, last on the page (`#pa-delete`), drawn by
`oa-account-delete.js` and **born hidden**: it follows the auth event and never
the remembered hint, because a control that deletes an account must not be
painted for a reader the SDK then says is not there. It names each posting and
profile that is about to come off the site, asks for the word DELETE to be
typed. A survey it could not READ leaves the list empty and a note in its
place; it never withholds the button (see the section above).

`admin-area.html`'s roster gains **Delete** on every row, and **Cancel** while
one is queued. **The control is withheld where the queue could not be read** —
unknown draws nothing, the rule the account menu's badges follow — and the
maintainer types the word into a prompt rather than pressing a `confirm()`,
which is what that panel uses to delete an orphaned conversation. **The
maintainer's own account is offered no delete control anywhere**, in the roster
or in their own personal area (owner, 2026-09-05: *"yes add that guard"*). The
personal area was the way round the roster's guard, and it is offered the
REASON in place of the button rather than being left silently short of a
control everybody else has; `openSelfPanel` refuses as well as hiding, or a
hidden button is still a button on a keyboard. **It is a guard against an
accident and not an authorisation, and the file says so**: the rules still let
any owner file their own order, because `isAdmin()` is keyed on an ADDRESS
rather than on an account, so a maintainer who genuinely means it registers
again with the same address and is the maintainer again. What it removes is a
button that deletes the site's own account in two presses and a typed word.

**The
maintainer's OWN row is never offered one**: the rules would allow it, an admin
may file an order for any account including their own, and the result is a site
whose only maintainer account has deleted itself, with the Admin area and the
review queues gone with it. Their own route is the same one everybody else has,
in their personal area. A queued deletion is **not** in `pendingCounts()`: it clears itself, so it is not
something waiting on the maintainer, and a figure nobody can clear inflates the
badge for ever (the Registered-users rule).

**The module is loaded on those two pages and nowhere else.** Its markup and
its copy have no business in `oa-accounts.js`, which every page downloads; what
it takes from there is two exports, `survey()` and `deleteSignIn()`, which are
the merge's own machinery rather than a second copy of it.

Tests: `testAccountDeletion` in `_scraper/selftest.mjs` (the rules against
`REQUEST_KEYS` both ways, the `by` pin, the no-update argument and the disjoint
key sets, the cancel window, the pure halves including that a finished order
carries no name or address, the browser flow's ORDER read out of its own source,
the two surfaces, the load order, the workflow's chain and its checkout, the
copy on the Privacy Policy and the FAQ, and both stylesheets), the sweep's own
`node _scraper/purge-accounts.mjs --selftest` (the served-file test, the four
gates, the sign-in first with its reason, the blanked-not-deleted anonymisation,
and that no log line carries an address or a name), and the deletion block in
`_scraper/page-test.mjs`, which drives it in a real browser against the shim's
recorded operation log: the order written first, the posting withdrawn and never
deleted, the alerts before the sign-in, the sign-in last, the local memory
cleared, the signed-out reader offered nothing, the phone target, and the
maintainer's row queuing an order and nothing else.

## Registration is verified by e-mail

Owner, 2026-09-04: a person who registers with an e-mail address and a
password must press a link in a message before the account can be used.
Google sign-ins are already verified by Google; ORCID sign-ins carry no
e-mail claim and are not gated. The decisions, so nobody re-opens them:

    _functions/verify-email.js        the message (renderer, zero dependencies)
    _functions/index.js               sendVerificationEmail, the callable that sends it
    _firestore.rules                  verified(), on every write a signed-in user makes
    assets/oa-accounts.js             the pending session and the "Check your inbox" card
    verify-email.html + oa-verify.js  where the link lands
    _SETUP-EMAIL-VERIFICATION.md      the four secrets, the deploy, how to test

**The rules read the TOKEN, and `verified()` is the one place they read it.**
`verified()` is a sign-in whose `email_verified` claim is true OR whose
provider is anything but `password`, and `isOwner(uid)` goes through it, so
every owner write is gated with no text change at its call sites. The
top-level user writes (`jobSubmissions`, `candidateSubmissions`,
`placementSubmissions`, `accountKeys`, `directoryEdits`, `nameFixes`, the
signed-in branch of `usageSessions`) name `verified()` where they named
`signedIn()`. **The ONE exception is `profiles/{uid}`**: its owner may create
and update it on a bare sign-in, because the registration form writes the
profile in the same breath as it creates the account, before any link can
have been pressed. Read and delete there stay owner-gated. The selftest pins
that exactly one write clause in the file is granted on a bare sign-in and
that it is that one. **Because it is the one write an unverified account may
make, it is also the one that has to carry a shape**: whoever holds the
account has not proved the address is theirs, and the first name they type
is printed at the top of the message that goes TO that address from the
site's mailbox. So `profileKeys()` in the rules is exactly
`PROFILE_DOC_KEYS` in `oa-accounts.js` (pinned both ways), every text field
is bounded, and an update is judged on the keys it CHANGES
(`diff().affectedKeys()`), so a document carrying an older field is not
frozen against its own owner. The renderer guards the same line from its
end: `greetingName` uses a first name only when it is short, on one line and
carries no address or link, else the greeting is a bare "Hello,". The
Storage rules gate an upload on the same `verified()`; they still deploy by
hand (`firebase deploy --only storage --project operations-academia`).

**Every password account that already existed is gated too**, and nothing was
ever sent to it, because none of them registered through the path that
sends. So the card promises a message only on the registration path (status
`'sent'`); on a sign-in or a page load it says "if a message reached you when
you registered, press its link, otherwise press the button" and the button
reads "Send the e-mail", which is the one press those accounts need. The
setup page and the changelog say so.

**And the site writes to them once, rather than waiting for each to find the
card** (owner, 2026-09-05). `_scraper/verify-existing-users.mjs`, pressed
through `.github/workflows/oa-verify-existing.yml` (`workflow_dispatch` only,
a boolean `send` input defaulting to false, so the button is a scan until it
is ticked), lists every Auth account and selects the ones whose EVERY provider
is `password`, whose address is unverified, which are not disabled and which
have an address (`campaignTarget`, pure); a Google or ORCID sign-in is
verified by its provider and is skipped, a Google-plus-password link counts
as Google, and the summary counts each reason and says why. Each is sent the
SAME message, rendered by `renderVerifyEmail` with `existing: { since }` (the
heading "Please confirm your e-mail address" and a first paragraph naming the
day they registered replace the newcomer's thanks; the button, the printed
link and the footer are unchanged), and the link is built by `siteVerifyLink`
in `verify-email.js`, the ONE helper the callable uses too, pinned both ways
so the two senders cannot put the code on different pages. A successful send
stamps `verifyMail/{uid}.campaignAt` (the callable's own document, closed to
clients, so no rules change), a stamped account is never mailed again however
often the button is pressed, and a failed send stamps nothing. The callable
leaves the mark alone on BOTH of its paths: its slot reservation is a MERGED
write, so a member who presses Send the e-mail on the card keeps the mark
through a send that succeeds (a plain set there erased it, and the next press
of the button wrote to them again), and `releaseSlot` restores the document
whole after a send that fails; the selftest pins both. A stamp that could not
be written after a successful send is warned about by id, counted in the
summary and never stops the queue, since that account may be mailed again on
the next press. One message a second. The log carries counts, ids and
redacted addresses only; `--dry-run` mints nothing, because `_mail.mjs`
prints a dry-run message's text and the text carries the link; and without
SMTP nothing is minted, since a code minted for a message that cannot go out
expires unused. The Admin SDK handle comes from `firebaseAdmin()` in
`_mail.mjs`, the one definition of "the Admin SDK, or null", which returns
Firestore and Auth together; `firestore()` is a wrapper over it and the
roster sync reads the same function. Tests: the mailer's own `--selftest`
(the selection rule over fixture accounts, the member variant against the
newcomer's, the once-only mark and the dry-run order read from the file's own
source, no address in any log line) and `testVerifyExistingUsers` in
`selftest.mjs` (both senders through `siteVerifyLink`, the workflow
dispatch-only with its input and secrets, the setup page and this section).

**A pending session is signed out for everything but the panel.** The browser
keeps the user for the "Check your inbox" card and nothing else: `user()`
answers null, `hint()` answers `'out'`, `onChange` fires null, nothing writes
the hint, the roster row, the tally, the identity keys or the counts, and the
chip reads "Verify your e-mail". Anything less leaves a flash of unlocked
cards on the next page, painted from a remembered hint the SDK then
contradicts. **The archive can still write that hint**: `/v2/` is frozen,
shares the origin, and its accounts module writes `oaAuthHint` for any
signed-in user, pending ones included. So the pending branch writes a marker
beside it, `oaAuthPending` = the uid, and a hint naming that uid is read as
no hint at all, in `readHint()` and in every live page's `<head>` snippet;
the marker is cleared the moment that account becomes usable
(`markPending`). The usage tracker (`oa-usage.js`) makes the same
`needsVerification` test itself and files a pending account's session as an
anonymous visitor, because the `usageSessions` rule refuses one filed under
an unverified uid and the refusal is silent.

**The card opens on its own everywhere but the verify page, and opens on a
press anywhere.** `openVerifyPanel(status, who, auto)`: the auth handler
passes `auto`, and only an auto open stands down on `verify-email.html`
(which confirms the address itself); a press on the chip or the phone-sheet
link opens it there too, or the one account control in the header would do
nothing. Closing it puts focus back on that chip, and `wireModalKeys` keeps
Tab inside every card that claims `aria-modal`.

**The one-time code comes off the address bar at once.** `oa-verify.js`
reads `mode` and `oobCode` and calls `history.replaceState` before any
async work; `oa-ga4.js` reports a `page_location` without the code (it runs
first in the deferred order) and `oa-usage.js` records the path alone when
the query carries one. The page also moves focus to the heading of the card
it shows, re-decides its buttons when the session changes (`A.onChange`), and
treats `confirmVerified()` answering false after a successful
`applyActionCode` as the link having confirmed a DIFFERENT address, offering
"Use a different account" rather than a Continue into a locked account page.

**Verification does not refresh the token by itself.** `user.reload()` updates
`emailVerified` on the object; the rules read the ID token, which is cached
for up to an hour. So every lift calls `getIdToken(true)` before the first
write, or the roster row, the tally and the profile read all bounce with
permission-denied that looks exactly like undeployed rules.

**The site's own message, with Firebase's as the fallback.** The callable
generates the link with the Admin SDK, cuts the code out of it, and puts it on
the site's own page (`verify-email.html?mode=verifyEmail&oobCode=...`), so the
reader lands on operationsacademia.org rather than a firebaseapp.com handler.
It mails the address on the token only, refuses an already-verified one, and
keeps its own rate limit in `verifyMail/{uid}` (one send in 90 seconds, six in
a UTC day), because Firebase's resend limits do not apply to links the Admin
SDK mints. The slot is RESERVED in a transaction before the send, so parallel
calls cannot all pass the check and each send a message, and a failed send
gives the slot back. Neither the link nor the code is ever logged, and neither
is an SMTP error's message text, which quotes the rejected address in full.
The browser prints the function's own refusal (too soon, or enough for the
day) rather than one sentence for both, and a `functions/*` error is worded
as a send that failed, never as a sign-in failure. When the callable
cannot be reached (not deployed, down, or the SDK failed to load) the browser
falls back to `sendEmailVerification`, so nobody is stranded; that message
comes from Firebase's own address and lands on the same page with no code.

**The renderer is deploy-local.** `firebase deploy` ships only `_functions/`,
so `verify-email.js` copies the shape of `_scraper/_mail.mjs` (a 600px table,
an escaper, a plain-text alternative) and imports nothing. The palette is the
live site's from `assets/v3.css`, the button is a coloured table cell with a
VML fallback for Outlook, and the link is written out in full as text as well
as behind the button.

**The deploy count is FOURTEEN now.** Four doorbells (`revealCandidates` among
them), `recordVisit`, `sendVerificationEmail`, and the eight forum callables
(see "The forum"). Read the list back after every deploy; fewer means a stale
checkout. `npm install --prefix _functions` first, since the CLI loads
`index.js` and this function requires `nodemailer`.

**The confirmed state is a box in the middle of the screen that moves on by
itself** (owner, 2026-09-05: "just a message box in the center of the screen
which would disappear after 5sec"). For a reader whose session is usable the
page's hero and footer line go (`body.ve-focus`, rules in `v3.css`), a line
under the button counts five seconds down (`aria-live`, so it is heard), and
at zero `location.replace` moves to the account page, so Back does not
return to a spent link. Never for a reader who must sign in first, and never
in the mismatch case: there is no account to go to, and a countdown into a
locked page would be the very thing Continue is withheld for. The one-time
code is already off the address bar by then. The white page the owner saw
between the message and the site was Firebase's OWN handler, reached only
from the fallback message's link; the setup page names the console setting
(the template's action URL) that points it at `verify-email.html` instead.

**The Admin app is found by NAME, never by count.** The functions
library creates a named app of its own to verify a callable's token, so
inside every callable `getApps()` is already non-empty while the default
app, the one `getFirestore()` and `getAuth()` read, may not exist.
`if (!getApps().length) initializeApp()` therefore skipped the
initialisation exactly when a callable ran: the day this went live
(2026-09-05) every call to `sendVerificationEmail` died on "The default
Firebase app does not exist", the browser fell back to Firebase's own
message, and that message landed in spam. `recordVisit` never hit it
because an onRequest handler verifies no token, which is why the deploy
looked fine. `adminApp()` in `index.js` and `db()` in the forum's
`member.js` test for an app named `[DEFAULT]`, and the selftest reads
every functions file with its comments stripped and refuses the count test.

**Where the browser keeps it, so nobody looks in the wrong place.**
`needsVerification(u)` is the one test (unconfirmed address AND the password
provider); the auth handler sets `state.pending` from it and takes the
pending branch before anything a session does; `enterSession(u, fb)` is what
a usable session does on arrival, factored out because the lift
(`liftVerification`) has to do the same list later and two copies would
drift. The registration form no longer writes the signed-in hint for a
password account; it opens the card and calls `sendVerification` with the
user it just created, because the auth event may not have fired yet. The
Functions SDK is loaded lazily by `OAFB.readyFunctions()`, the way Storage
is, so the ~30 KB bundle costs only the page that presses the button. The
verify page marks its `<main>` with `data-oa-verify-page`, which is how the
accounts module knows not to draw the card over it. The header chip while
pending is `.oa-acct-pending`, styled in BOTH `oa-ui.css` and `v3.css` (the
live design overrides the engine's rule at a higher specificity, the Excel
button's lesson). And `_scraper/_fake-firebase.js` makes every seeded user
VERIFIED by default, so every browser check written before the gate keeps a
verified reader; an unverified password account is a seed that says so.

Tests: `testEmailVerification` in `_scraper/selftest.mjs` (the message, the
rules with the exception, the function's secrets and what it never logs, the
package and lockfile, the setup page and this section, then the browser
half's source: the exports, the callable-first send with Firebase's message
as the fallback, `user()` null while pending, the reload-then-token lift,
the verify page noindex with both tags and no preview block, the two
registries, the copy on the FAQ and the Privacy Policy, the changelog entry
at index 0, and the shim's defaults), plus the block in
`_scraper/page-test.mjs`, which drives it in a real browser: the pending
session on the jobs page (locked cards, the chip, the card, no hint and no
writes), Send again reaching the callable and falling back when it is
absent, "I have verified it" lifting the gate with a fresh token, and the
verify page's four cards for both readers, at 390px too.

## The forum

Owner, 2026-09-04 and 05: an anonymous forum for the candidates of the
season under way, and beside it an Open forum for every registered account;
tags on threads, like and dislike on posts, quote and reply; and the
maintainer admitted to both rooms as an ordinary member. The design brief is
the forum blueprint and its privacy audit (read against Ederer,
Goldsmith-Pinkham and Jensen's paper on EJMR, whose four-character usernames
were a hash of the poster's IP address and a topic id, with no secret, and
were reversed for two thirds of seven million posts from the public pages
alone). Step 1 is the server half and the page; follows and mail are step 2,
reports and moderation of reports step 3. The decisions, so nobody re-opens
them:

    assets/oa-forum-model.js     rooms, KEYS, BOUNDS, TAGS, RATE, slug(), minute()   (dual-mode)
    assets/oa-forum-guard.js     what a post may not contain, one check() for both sides
    assets/oa-forum-guide.js     the thirteen rules and three notes
    _functions/forum/identity.js the ONE HMAC, the handle draw, the season's secret version
    _functions/forum/member.js   the shared preamble: who, which room, limits, ERRORS
    _functions/forum/{join,post,edit,delete,vote,moderate}.js   the seven callables
    _scraper/build-functions-vendor.mjs   copies the four modules into _functions/ (in BUILDERS)
    _functions/test/forum-emulator.mjs    the functions and the rules against the real emulator

**The uid never sits beside a handle, anywhere, in any form.** The only link
between a handle and a person is `H = HMAC-SHA256(FORUM_SECRET, season + ':' +
uid)`, computed in `identity.js` and nowhere else (the selftest pins that
`createHmac` appears once in the forum, that no other file computes over a
uid, and that H is never truncated), used whole as the id of
`forumHandles/{H}` and of a vote, `posts/{pid}/votes/{H}`. No custom claim,
no sealed uid, no served file, no Actions log ever carries H beside a uid.
Every forum document is written by the Cloud Functions and by nothing else:
every content path in `_firestore.rules` is `allow write: if false`, the
maintainer's browser included, and the votes and `forumNames` are closed in
BOTH directions to everyone. The handle a member sees is drawn with
`crypto.randomInt` from two word lists and a number, INSIDE the transaction
that claims its slug in `forumNames` (retried on a collision), and is a
function of nothing: not H, not the uid, not the clock. `Moderator` is
reserved and never drawn; only `seedGuide` posts under it.

**Two rooms under one handle scheme.** The path is
`forumSeasons/{Y}/rooms/{room}/threads/{tid}/posts/{pid}`, `room` in
`['candidates', 'open']`, so the rules read the room off the PATH and need no
document read for it; there are no room documents. `forumReader(room)` admits
a current candidate or the maintainer to the candidates room and any
`verified()` account to the open room, compared by NAME (never a regex, the
trap the map warned about), and the selftest pins the two names against
`OAForumModel.ROOMS` both ways. A current candidate is a `candidateMarkers/
{uid}` marker (written by `forumJoin`, owner-read, owner-delete, never
client-written) naming a profile the caller owns, of THIS season, queued or
published, RE-READ on every request, so a withdrawal ends access at once. The
handle is keyed on the season and the account, never the room, so one person
has one handle in both rooms for the season, and the guide says so in one
sentence. `verified()` passes any non-password provider, so an ORCID account
(no e-mail claim) reads and posts in the open room; the site never signs
anyone in anonymously, and if it ever did that provider would pass too.
`verifiedToken` in `member.js` mirrors the rule exactly, both halves, and
`ADMIN` there is the one literal shared with `isAdmin()` in the rules (pinned).

**The maintainer may enter both rooms** (owner, 2026-09-05: "the admin should
be able to have access to all forums because I need to check how people use
it initially and for testing purposes"). `admitted()` lets `adminToken()`
into the candidates room with no profile; `forumJoin` gives them a random
handle like anyone else; `forumPost`, `forumEdit` and `forumVote` take them
in either room through the same `member()`; their posts are indistinguishable
from any member's on the page. `forumModerate` alone checks `adminToken` and
refuses everyone else. The guide, the Privacy Policy and this section say so
plainly.

**One refusal for two causes (R5).** The candidates room answers
`permission-denied {reason:'candidate'}` whether the caller is unverified or
simply holds no profile, so a caller learns nothing about the profile
database from the error; only the open room names `verified`. A refusal's
`details` object carries `reason` and NOTHING else (R6), and a rate limit
names its counter, never a count. Every reason string lives in `ERRORS` in
`member.js`, and `refuse()` is the one shape.

**The model is pinned against the WRITERS, both ways.** There is no
`hasOnly()` list in the rules to pin a client write against, because no
client writes. So every write in `_functions/forum/*.js` is a named object
inside a `/* @doc <kind> */ ... /* @end */` block; the selftest reads each
block's keys and holds them to `KEYS[kind]` in `oa-forum-model.js`, and holds
the union of every block of a kind to exactly that list, so a key nobody
writes and a write nobody declared both fail the build. An inline object
handed to `set()`/`update()` fails it too. No list carries `uid`, `email`,
`name` or `sub`, with the two named exceptions: `candidateMarkers.sub` (a
profile id, on a uid-keyed document that never sits beside a handle) and
`forumNames.key` (the one field on any forum document that holds a hash).

**Tags replace the blueprint's one category.** A thread carries 1 to 5 slugs
of `[a-z0-9-]{2,24}`; `TAGS` in the model is the curated list of about thirty
and free tags are allowed beside them, normalised through `slug()`. NO TAG IS
REFUSED: the list is only what the picker OFFERS (see "No rumours" below,
where `rumour` comes off it and stays postable). The tally
`forumTags/{Y}_{room}` is bumped in the thread transaction as a NESTED map
with `FieldValue.increment` (the `recordVisit` lesson: never a dotted path),
capped at `TAG_COUNT_CAP` (400) distinct slugs so the one hot document cannot
grow without bound (a tag past the cap is still on its thread, just not
tallied). Tags are fixed at creation: `forumEdit` touches the body only,
so the tally never drifts, and the guide says "Tags are set when the question
is asked". The guide thread is tagged `about`.

**Like and dislike.** `posts/{pid}` carries `up` and `down`; `forumVote {room,
tid, pid, v: 1 | -1 | 0}` reads the caller's vote at `votes/{H}` and moves the
two tallies by the DELTA with `FieldValue.increment`, so a retried
transaction never re-applies a stale absolute, and moves the thread head's
`score` when the post is n 1, which is the net the list card shows without
reading post 1 per card. Own post: `failed-precondition {reason:'own'}`. The
caller's own votes for a thread come back from `forumThreadVotes` in one
`getAll`. A contended transaction (Firestore's ABORTED) is mapped to
`resource-exhausted {reason:'busy'}` so the page says "try again in a moment"
rather than a raw code. Votes are 60 per handle per day.

**Quote and reply.** `forumPost` on a reply accepts `quote: {n, text}`, reads
post `n` INSIDE the transaction (one equality on one collection, no index),
refuses `invalid-argument {reason:'quote'}` unless `text` is a non-empty
substring of that post's body as it stands NOW and at most `BOUNDS.quote`
(600) characters, and stores a COPY `{n, by, text}` on the reply, so a later
edit or removal of the original never rewrites it. Never the quoted pid.

### A post is its author's to delete, at any time

Owner, 2026-09-05: *"a user can delete a post anytime they want"*. There was
no window on this and there is none now: `forumEdit`'s fifteen minutes are
about rewriting words other people may already have replied to, and taking
your own words away is a different act with a different answer.
`_functions/forum/delete.js` is the seventh callable, and it reads no
`EDIT_WINDOW_MS` at all, which the selftest pins rather than trusting.

**BUT NOT A QUESTION SOMEBODY HAS ANSWERED**, and that is the owner changing
their own instruction the same day after seeing what it produced: *"a user
cannot delete a question posted that has received at least one answer. If all
answers are deleted, then the user who posted the respective question should
be able to delete it. Right now, I delete the question but the looks of it
looks orphan forum"*.

The first build blanked such a question and left the thread standing, on the
reasoning that other people's replies must not go with it. The screenshot of
the result is the argument against it: a page headed *"Deleted by its author"*
with no question under it and one reply hanging below reads as a broken
thread, not a tidy one. **So there are two states and no third**: no live
reply and the whole thread goes; a live reply and the question cannot be
deleted at all. `DELETED_TITLE` left the model with the state it named, since
nothing writes it any more.

**"Live" is the second sentence of the instruction.** A reply its own author
or the maintainer has deleted no longer holds the question down, so a thread
whose answers have all gone can be withdrawn by the person who asked it. The
count is one query for posts that are not hidden, `limit(2)`, since the only
question is whether ANY of them is a reply and only one of them can be the
question.

**THE MAINTAINER MAY DELETE ANY POST** in either room (*"the admin should be
able to delete any questions or answers"*), and is not held by the rule above:
removing a question as moderation takes the thread with it, replies included,
which is what removing a question means.

**IT IS A TOMBSTONE, AND BOTH HALVES OF THAT ARE THE POINT.** The words really
go: `body` and `kind` are ERASED in the database, not merely flagged, or
"delete" is a lie the page tells on the maintainer's behalf. The post's SLOT
stays, because `n` is the post's name: a reply quotes by number (`#4`), the
thread's `n` is the next number to hand out, and a hole would renumber nothing
and break both. So a deleted reply is drawn as removed and the thread reads
on. `hiddenBy` says which of the two it was, `'author'` or `'admin'`, so the
page says *"deleted by its author"* or *"removed by the maintainer"* rather
than guessing.

**A QUOTE OF IT SURVIVES, deliberately.** `forumPost` stores a COPY of the
quoted words on the reply, which is already what keeps an edit from rewriting
somebody else's reply; the same rule means deleting your post does not blank
the passage a reply was written about. The guide says your words are gone; it
does not promise to reach into what other people wrote.

**The griefing worry the first build was written around is answered by the
refusal rather than by the blanking**: asking a question, collecting the
answers and deleting the thread is exactly what "not while it has an answer"
forbids.

**Refused on an ARCHIVED season and on a HIDDEN thread; allowed on a LOCKED
one.** Once a season's secret version is destroyed its handles cannot be
re-derived, so *"is this the author"* is not a question that can be answered
there; a thread moderation has already removed has nothing here to act on; and
locking stops new posts, it does not make somebody's own words un-deletable. A
second press is a SUCCESS, not an error.

**The confirmation says what is true of this one.** Everywhere else on this
site hiding is never a one-way door, and here it is: the words are gone and
there is no Restore, so the dialog says so rather than asking a bare
are-you-sure, and it words the four cases apart (your reply, your question,
and the maintainer removing either).

**A THREAD WHOSE QUESTION HAS GONE IS CLOSED, AND NOBODY MAY REPLY IN IT**
(owner, 2026-09-05, of a screenshot showing a deleted question, a deleted
reply, and a compose box under both: *"the entire thread should be deleted
too, and noone should be able to reply in such a thread"*). Deleting a
question now hides its thread, so `tv.hidden` answers this for anything
written since; the rows that need the second half are the ones written
BEFORE that rule, where a blanked question sits under a thread still
standing. So `forumPost` reads the head post inside the transaction that
guards the write, one equality on one collection, and refuses `locked` when
it is missing or hidden. In the FUNCTION rather than only on the page,
because a page can be got round; on the page too, where the reply box is
replaced by a line saying the thread is closed. And pressing Delete on a
question that is already gone FINISHES THE JOB rather than doing nothing:
it shuts the thread, which is the one press that clears a legacy thread
left headless.

**And the control says NO before it is pressed.** An answered question draws
Delete disabled with the reason in its tooltip, rather than a button that
fails when somebody presses it; the maintainer's own says *Remove* on a post
that is not theirs. `amAdmin()` asks `OAAccounts.isAdmin()`, the one
definition, so the page and the function cannot disagree about who may remove
somebody else's post.

Tests: the `forum delete` block of `testForum` (a callable of its own, no
window even read, the author check, the erase, the kept slot, the archive and
hidden refusals, the locked one NOT refused, the answered refusal counting
REPLIES, `DELETED_TITLE` gone from the model too, a question always taking its
thread, the maintainer's two exemptions, and the page's control, confirmation
and wording), the emulator test's own block against the real function
(somebody else refused, the author's reply deleted long past the edit window,
a second press a success, a quote of it surviving, an answered question
refused, the maintainer removing other people's replies with `hiddenBy:
'admin'`, the asker then able to delete the question, a reply refused on a
headless thread and one press closing it), and the browser block in
`page-test.mjs`, which posts a reply, deletes it, reads the stored document
back, finds Delete disabled on the question the reply answers, and deletes a
question of its own to watch the whole thread leave the list.

### The compose box says nothing about being anonymous

It used to carry a standing warning above every question and every reply,
reminding the writer that a handle is not a disguise and that a detail here
beside a detail there can identify somebody. The owner had it removed
(2026-09-05): *"I do not want to over-stress to users that they are
anonymous, it is OK. They are adults."* Nothing is lost from the record: the
small-population note ("This forum is small") is still the third of the
guide's three notes, and rule 4 still says not to reveal who you are; the
guide is pinned at the top of both rooms and every member ticks it before
their first post, and
the Privacy Policy paragraph held verbatim in this file says the same thing
for announce day. What went is the repetition on every screen.

`.oa-forum-warn` and its copy are DELETED from the page and the stylesheet
rather than left unrendered, which the selftest pins: this file's own rule
is that nothing merely hidden counts as withheld, and a block still in the
source is one CSS change from coming back.

### No rumours, and no box asking how you know

Owner, 2026-09-05, over a screenshot of the reply box with its three radio
buttons ringed in red: *"what are these? Add in the forum's rules that posting
rumors, unverified stories or [running colleagues down] is not allowed. Be
nice and be a good citizen/colleague... and don't let users to post a rumor.
Also I don't understand why a user should select 'plain' and 'First-hand, it
happened to me', perhaps remove these."*

**The three radio buttons were `KINDS`, and all three are gone.** A post
carried `kind`: `''` (Plain), `'first-hand'` or `'rumour'`, drawn as a chip
under the post, asked in the reply box, in the edit box and in the ask form.
Both halves of that were wrong. It asked every poster a question with no good
answer, which is what the owner saw: nothing on the page said what turned on
it, nothing read it, and the honest answer to "how do you know" is the post
itself. And its third option WAS PERMISSION: a box labelled Rumour is the site
telling a member that a rumour is a thing to post here, tidily, as long as it
is ticked. Removing the label is what makes rule 5 mean something.

**Removed from the model, not narrowed to one value.** `KINDS` is gone from
`oa-forum-model.js`, `kind` is out of `KEYS.post`, `kindField` is out of
`member.js`, the reason `kind` is out of `ERRORS` and `REASONS`, and the
radios, the chip and their CSS are out of the page. The writer scan does the
rest for free: `KEYS.post` no longer names `kind`, so a `@doc post` block that
wrote one would FAIL THE BUILD, both ways. A model that still knew the word
would be one edit from drawing the control again.

**The rules say the two things the owner asked for, in his own order.** Rule 1
is *"Be kind, and be a good colleague. Disagree with the point, never the
person, and write nothing about a school, a department or a fellow candidate
that you would not put your own name to."* Rule 5 is *"No rumours and no
unverified stories. Post what happened to you, or what you can point to; if
you have only heard it, leave it out. Running down a school, a department or a
colleague is not on either, however politely it is phrased..."* Rule 5 is
where the marker's own rule used to be, which is why the count is still
thirteen and why no rule still tells anybody to MARK a post as anything.
"Bitching" is the owner's word for what rule 1 and rule 5 forbid; the guide
words it as a colleague would.

**NOTHING IS ENFORCED, AND THAT IS THE OWNER'S OWN CORRECTION.** A body
cannot be classified: no rule this repository could write would tell a rumour
from a question about one, and a guess that refuses a legitimate post is
worse than the post it refuses (the `deadlineDay` discipline, applied to
prose). The TAG looked like the one exception, being the one part of a post
that is a machine-readable label the poster picks, so the first draft refused
`rumour` and five spellings beside it (`TAG_BANNED`, refused by `tagOk` in
the model, in the functions and in the page, with the tag box saying why).
The owner reversed it the same day, and the sentence is the whole rule:
*"don't remove the possibility users use the tag rumour on a post... what I
was saying is let's not nudge users to post rumours and gossips on the forum.
The updated rules are fine now."*

So `TAG_BANNED` is gone, `tagOk` refuses nothing a slug rule allows, and the
one thing that stays is the NUDGE: **`rumour` is off `TAGS`**, the curated
list the picker suggests from, so the site offers the word to nobody and
accepts it from anybody who types it. The distinction is worth keeping
straight, because it is the difference between a forum with house rules and
a forum with a filter: **a rule is what the guide says and moderation acts
on; a suggestion list is what the site puts in front of you.** Only the
second was the problem. The selftest pins it that way round now (the word
still tags a post, alone or beside another; the curated list carries neither
it nor `gossip`), and `page-test.mjs` measures both halves in a browser: the
CURATED half of the picker offers no rumour tag for "rumou" (what it does
draw there is the create-a-tag row for the prefix, which is how a free tag
is made at all), and a reader who types the word gets the chip.

**WHAT IS STILL A NUDGE, SAID RATHER THAN HIDDEN.** The compose picker's
suggestion pool is the curated list PLUS THE ROOM'S OWN TALLY
(`drawSugg` in `oa-forum.js`), and the "Popular tags" card is the tally
alone (`drawTags`). So the first thread anybody tags `rumour` puts the word
into both, high up, ordered by use like every other tag. That is deliberate
for now and the reading is: the curated list is the SITE recommending
something, and the tally is the ROOM describing itself, which is also what
makes the card a truthful filter. It is the owner's call, and the one-line
change if they want it is a suppression list read by `drawSugg`/`drawTags`
only, never by `tagOk`, so nothing would be refused. The browser check says
which half it measures, rather than a message that reads as covering both.

**The pinned guide thread had to be refreshable for any of this to reach a
reader**, which is the paragraph above ("A SECOND PRESS REFRESHES THE
THREAD"): the panel renders the module, the thread is a copy, and rules edited
after a seed reach only the panel until the button is pressed again.

Tests: the block in `testForum` pins the removal as an ABSENCE on every
surface it lived on, comments stripped (no `KINDS`, no `kind` on a post, no
`kindField` or `d.kind` in any callable, neither label named anywhere in the
functions, no radios or chip in the page or either stylesheet, none in the
shim's simulator), the two rewritten rules by their opening words, that no
rule still describes the marker, that no tag is refused and the curated list
suggests none of these, and the compose bar aligned to its end now that its
left-hand control is gone. `page-test.mjs` measures a rendered thread
carrying no chip and no radio group, a reply sent without a kind, and the
picker suggesting no rumour tag while a typed one still becomes a chip; the
emulator test posts a thread under a tag the curated list does not offer, and
drives the seed-then-refresh cycle against a guide whose words have been
moved on.

### The question list is laid out the way Stack Overflow lays one out

Two owner messages on 2026-09-05, and they are one change rather than two.
First, from a screenshot: *"I think these tags are too close to each other,
update them to look nicer and merge"*. Then, plainly: *"I want the forum to
look like stackoverflow"*.

The card was a two-column grid with an 88px stat column, and three things met
badly in it: the like and reply chips sat level with the badge row and the
title, the badges ran into each other because `.oa-label` is `display:
inline` site-wide (vertical padding on an inline box does not grow its line,
so chips bleed into the rows above and below), and the reply count was
printed twice, once as a chip and once in the line under the excerpt.

**The first fix stacked everything into one column, and that was the wrong
lesson.** It removed the collision by removing the layout, and the owner's
next message asked for exactly the arrangement that had just been taken out.
The column was never the fault: **the tags being ABOVE the title was**, which
is why Stack Overflow puts them under the excerpt and always has.

So the card is a **tally column on the left** (votes, then replies, the
answered ones in a green outline) beside the **title, the first lines, and a
footer** carrying the tags on one side and who asked on the other. `subtitle`
returns the handle alone; `onCard` MOVES the engine's own `.oa-badges` and
`.oa-card-sub` into that footer rather than drawing either twice, which is
what keeps every fact said once and the answer count in the tally alone. The
chips are `inline-block`, **scoped to this card** rather than fixed globally,
because every other list's badges are measured where they are. On a phone the
tally lies ABOVE the question as a row, the same move the vote column makes in
a thread (rule 13).

The thread already had the shape: crumbs, a heading, a meta bar, a vote column
per post, an answers band. What changed is the reading: square arrows rather
than pills, the score the largest thing in its column, the who-block on the
brand wash with the handle in the link colour, and a rule under the answers
heading.

**What is NOT copied is the brand.** No orange, no logo, no wordmark, no
borrowed stylesheet. `oa-forum.css` carries no raw colour at all, which the
selftest pins, so every one of these rules resolves through the site's own
tokens and works in both themes. It is the LAYOUT people recognise, and the
layout is the part that is a good idea rather than somebody's property.

`page-test.mjs` measures it as GEOMETRY rather than as a class list: the tally
sits left of the title, no two chips overlap, none reaches up into the excerpt
or across into the tally, the tags and the asker share a footer row, and the
word "reply" appears once on the card. That survives a change of markup, which
a check on class names would not.

**Timestamps are whole minutes (R7).** Every `t`, `lastAt`, `joinedAt`,
`editedAt`, `createdAt` comes from `minute()`; `serverTimestamp()` and
`Date.now()` appear in no forum function (pinned), and the emulator walk
asserts every numeric stamp `% 60000 === 0`. A minute cannot be joined
exactly to any other record of the same moment.

**The secret is VERSIONED BY SEASON (decision 15, R8).** `FORUM_SECRET` is
one Secret Manager secret with versions; `forumSeasons/{Y}.secretVersion`
names the version the season's handles are derived under, written on the
season's first join from whatever `latest` resolved to at that moment, and
`identity.js` then reads exactly that version through
`@google-cloud/secret-manager` (`.value()` cannot read a named version; the
`secrets:` binding on the callables is what grants the runtime account
access). `latest` is named in the create branch of `ensureSeason` and
nowhere else; `secretVersion` is read in `identity.js` and nowhere else; the
one season document read is the season passed in. The runbook is in
`_SETUP-INSTANT-PUBLISH.md` ("The forum secret"): set once, a rotation
renames every handle so it is the answer to a suspected leak and nothing
else, and on 1 August the previous season's version is destroyed with
`gcloud secrets versions destroy`, after which an archived season's handles
cannot be re-derived by anyone. The housekeeping that runs that and stamps
`secretDestroyedAt` is step 2; the field is in the model's comment now so the
key list gains it with its writer. The emulator has no Secret Manager, so
under `FUNCTIONS_EMULATOR === 'true'` only, versions `env` and `env2` read
`FORUM_SECRET_TEST` and `FORUM_SECRET_TEST_2`, and the emulator test proves
two versions give two handles for one uid.

**No forum source reads the request's address (R1).** No `rawRequest`, `ip`,
`x-forwarded-for`, `remoteAddress` or `headers` anywhere under
`_functions/forum/` or in the four vendored modules (pinned; `recordVisit` in
`index.js` legitimately reads headers and is outside the scan). Google's own
request logs for the functions still record the connecting address and the
minute for their standard retention; the Privacy Policy says so (R9), says
who can read them, and says the forum writes nothing of its own to them.

**Ids are Firestore auto-ids (R4).** Threads and posts are minted with
`.doc()`; the selftest pins that the only ids built from a hash are
`forumHandles/{H}` and `votes/{H}`, and the only one built from a uid is
`candidateMarkers/{uid}`.

**The guide is ONE text.** `forumModerate {op:'seedGuide', room}` takes no
body: it renders `guide.text()` itself as the first post of a pinned, locked
thread under `Moderator`, one per room per season, and stamps
`forumSeasons/{Y}.guides.{room}`. The panel on the page draws `html()` from
the same module, so the pinned thread and the panel cannot disagree. Thirteen
rules, the owner's two notices verbatim and the small-population note (the
maintainer paragraph was removed at the owner's word on 2026-09-05 and lives
in the Privacy Policy). No link in it (the guard would refuse the seed), and
it fits the body bound, both pinned.

**A SECOND PRESS REFRESHES THE THREAD**, since 2026-09-05, and that is what
keeps "one text" true rather than true on the day it was seeded. It used to
answer `already-exists`: the panel renders the module on every load while the
thread is a STORED COPY of what the module said when the button was pressed,
so the morning rules 1 and 5 were rewritten, every reader of the panel saw
the new rules and every reader of the pinned thread saw the old ones. The
refresh writes `guide.text()` and nothing else, so the op still cannot carry a
body of somebody's own; an unchanged guide writes nothing and answers
`{ updated: false }`, which the button reports rather than navigating. The
maintainer's card therefore draws a button per admitted room at all times,
reading "Post the guide" where a room has none and "Update the guide" where it
has one. **After changing anything in `oa-forum-guide.js`, press it in both
rooms.**

**The guard is one module on both sides.** `check(text)` answers `''` or
`email | orcid | phone`; `EMAIL_RX` is the literal from
`_scraper/jobs-model.mjs`, which a browser cannot import, so the selftest
reads the literal out of that source and holds the copy to it character for
character. The phone rule is nine or more digits joined by at most one
separator each, so `2026-2027`, `2026-09-04` and `$120,000-150,000` pass and
`(617) 253-1000` does not; the blueprint's fixtures are pinned. The function
runs the same `check()` on every title and body and refuses with the same
reason word the page shows.

**A WEB ADDRESS POSTS** (owner, 2026-09-05: *"I want users to be able to post
links in their posts or replies"*). It was refused at first, on the reading
that `mit.edu/~jane` names a person as surely as a card would; the owner's
call is that a forum where you cannot link the call for papers you are asking
about is the poorer trade. So `URL_RX` is GONE from the module rather than
left unread, the fixtures that used to prove the refusal are kept as the
positive control that a link now posts, and `url` left `WHY`, `ERRORS` and the
page's `REASONS` with it. What is still refused is a way to be CONTACTED off
the forum, or an identifier naming exactly one researcher.

**The page draws it as a link, and the safety is the ORDER.** `linkify` in
`oa-forum.js` runs over text `esc()` has ALREADY escaped, so `&`, `<` and `"`
are entities by the time it looks: nothing it emits can close an attribute or
open a tag, and the pattern itself admits only `http`, `https` and `www`,
never a `javascript:` href. `rel="noopener noreferrer nofollow"` with
`target="_blank"` keeps the forum's address out of the other site's referrer
and passes it no rank. Trailing sentence punctuation is not part of the
address, and a closing bracket counts as punctuation only when the address
does not open one of its own. The cost, said in rule 7 rather than hidden: a
link to your own page, paper or profile identifies you as surely as your name
would.

**Vendored copies are GENERATED, never edited.** `firebase deploy` ships only
`_functions/`, so `build-functions-vendor.mjs` (in `BUILDERS` after
`build-netmap.mjs`, offline, `writeIfChanged`) copies `oa-jobnav.js`,
`oa-forum-model.js`, `oa-forum-guard.js` and `oa-forum-guide.js` to the top
of `_functions/`, and the selftest pins each pair byte for byte. It is
deliberately NOT named in any workflow: the "every builder has a caller,
never both" guard refuses a builder both in `BUILDERS` and in a workflow, and
the byte pin already catches drift, so the `--check` mode is for a hand run.

**The deploy count is FOURTEEN.** `_functions/index.js` re-exports the eight
callables one per line (`exports.forumX = forum.forumX;`) so a deploy's
per-function lines and the selftest's count of them agree; the header, both
setup pages and the count sentences in this file moved from six together,
again from twelve when `forumDelete` arrived, and again from thirteen when
`forumAccept` did.
`npm install --prefix _functions` first, as always: `@google-cloud/secret-
manager` arrived with the forum and the CLI's own load of `index.js` dies on
a `require` it cannot resolve. Owner, by hand, once: `firebase
functions:secrets:set FORUM_SECRET --project operations-academia`, then
`git pull && npm install --prefix _functions && firebase deploy --only
functions --project operations-academia`, read fourteen back, and press the
seed for each room. The rules publish themselves behind the green check.

**The emulator test is the ground truth, and it skips honestly.**
`_functions/test/forum-emulator.mjs` runs under `firebase emulators:exec
--project demo-oa-forum --only auth,firestore,functions` (a `demo-` project
never touches operations-academia; the `functions` predeploy guard does not
run under the emulator; `firebase.json` fixes the three ports). It signs
real password users in against the Auth emulator so tokens carry
`sign_in_provider: 'password'` as a browser's would, drives every callable
and every refusal, drives the rules through `@firebase/rules-unit-testing`
for all four readers, and then WALKS every document under `forumSeasons`,
`forumTags`, `forumHandles` and `forumNames` for any test uid, e-mail
address, `candidateSubmissions` id or 64-hex string outside `forumHandles`
ids, `votes` ids and `forumNames.key` (R10), with `candidateMarkers` walked
apart for e-mail and hash. Without Java or firebase-tools it prints SKIPPED
and exits 0; under `CI` that same skip exits 1 (page-test's rule), so
`oa-checks.yml` runs it in a job of its own with `setup-java`, a bounded and
retried `npm i -g firebase-tools@14`, `npm ci --prefix _functions`, `CI:
true` and the two test secrets, keeping the first job's "No network" header
true. No workflow cron touches the forum (pinned); nothing here runs on a
schedule.

**`forum.html` loads none of GA4, `oa-usage.js` or `oa-visit.js`** (decision
12): GA4 would send `forum.html?t=<tid>` as `page_location`, usage writes a
uid-keyed document with click timings, and the visit ping sends the address
to a function. The two page walks in the selftest name it in `QUIET_PAGES`
rather than letting a missing tag on a members-only page read as the gap
those walks exist to catch. Cost, stated: forum use is unmeasured.

**The page: one page under three addresses, painted from the hint first.**
`forum.html` is the `messages.html` skeleton (charset first, `noindex`, NO
`og:*` block since nobody can share into it, `card: false` in share-check's
`PAGES` with its reason, in `NOINDEX_OK`, out of the sitemap, the exact head
snippet, the skip link) plus `assets/oa-forum.js` and `assets/oa-forum.css`,
loading `oa-firebase`, `oa-accounts`, `oa-jobnav`, the three forum modules,
`oa-list` and then itself, every script deferred. The gate is painted from
`OAAccounts.hint()` before the SDK lands (a remembered signed-in reader sees
"Joining the forum", never a flash of the sign-in card); when the session
resolves, `pendingUser()` gets the verify prompt (`#oa-forum-verify`), a
usable account calls `forumJoin` ONCE per session and caches
`{uid, season, handle, guideAt, banned, rooms}` in `sessionStorage
'oa-forum-me'`, trusted only for the same uid and season. **The tabs are
drawn from `rooms` in that answer**, never from anything the page decides: a
non-candidate sees the Open forum alone and one line saying what opens the
other room (`#oa-forum-roomnote`), a current candidate and the maintainer see
both (`#oa-forum-rooms`, `role="tablist"`, `.oa-forum-tab[data-room]`). The
list (`#oa-forum-list`) is an **`OAList` mount fed by `cfg.source`**, the one
generic addition the engine gained: a function answering the rows (a
Firestore read of `forumSeasons/{Y}/rooms/{room}/threads`, `orderBy lastAt
desc, limit 200`, hidden rows dropped, pinned first) stands in for
`load(cfg.data)`, and deliberately skips the `OAFresh` echo that path
applies, since nothing a source answers is a posting saved in this browser.
Everything else is the engine's: the `tags` pick filter over the array
field with `TAGS` as its order, the text search over title and excerpt, the
chips, the URL keys, the pager and the phone rules, so the forum INHERITS
`_MOBILE-STANDARDS.md`. A card is a way IN (`cardOpen`, the one-pager
teaser's own shape): pressing it opens the thread. The Ask button lives in
the list HEAD (`#oa-forum-askbtn`), not in the engine's action bar, because
v3 hides that bar with an empty dataset and an empty room is exactly where
the first question has to come from. The thread (`?t=`), the ask form
(`?ask=1`) and the list are one page under three addresses moved between
with `pushState` (`go()`, `popstate`, and every link the page draws to its
own address followed in place), so a post lands on its thread without a
round trip and the Back button works; `?room=` and `?season=` travel with
every address, `?tags=` is the engine's own key. **A past season is the
archive**: `.oa-archive-banner`, no Ask button, no answer box, no vote button
in the DOM at all (the functions refuse a write there anyway). Votes are
drawn from `forumThreadVotes` once per thread open and a press calls
`forumVote` with the toggled value (`aria-pressed` on `.oa-forum-v`, own
posts disabled with a title saying why); Quote takes the selection inside
that post's body or the whole body cut to `BOUNDS.quote` at a word boundary
and sends `{n, text}` only; Edit appears on the author's own post for the
window (a countdown from `t`, the function the authority). Every refusal is
worded through `REASONS`, which the selftest pins against `ERRORS` in
`member.js` both ways (plus `auth`), so a code never reaches the screen; the
guard runs on every keystroke so the refusal the function would give is
shown first. The New badge is a per-account `localStorage 'oa-forum-seen'`
mark (`{uid, since, seen:{tid:n}}`); sign-out clears both stores. **The uid,
the address and the profile id never reach the forum's markup**: the banner
prints the handle, a post its author's handle, a quote the quoted author's.
The maintainer's seed button (`#oa-forum-admin`, `[data-seed-room]`, drawn
for `OAAccounts.isAdmin()` when a room's guide is not yet posted) calls
`forumModerate {op:'seedGuide', room}`; the guide panel
(`#oa-forum-guide`) is `OAForumGuide.html()` and opens until `guideAt` is
set; the first post carries `acceptGuide` from the tick. The account menu
carries **Forum** on both menus as an ordinary row like Messages (the Open
room admits every verified account, so no profile read and no `data-held`;
the badge `data-count="forum"` is born hidden until step 3 fills it), the
home page's candidates section links it and the FAQ names both rooms, and
`oa-candidateform.js` drops the owner's own `candidateMarkers/{uid}` on a
withdrawal, best-effort and never the maintainer's. `oa-forum.css` paints
with tokens alone (no raw colour, pinned), so both themes are covered, and
rule 13 in `_MOBILE-STANDARDS.md` is what its phone block holds to: a 16px
textarea, 42px tabs, votes, actions and Post; the vote column stands beside
a post on a desktop and lies above it on a phone.

**The browser suite drives the page through a SIMULATOR, never the
functions.** `_scraper/_fake-firebase.js` gained `forumSim`, a stand-in for
the eight callables over its own fake Firestore: join writes the marker and
answers the handle and the rooms (the maintainer's address, verified, opens
both; a seeded current profile opens the candidates room; `emailVerified` or
a non-password provider opens the open room, the `verifiedToken` reading), a
question writes the thread, its first post and the tag tally, a reply
verifies its quote as a substring of the post as it stands and stores the
copy `{n, by, text}`, a vote moves `up`/`down` by the delta under a FIXED
64-hex id that never derives from the uid and carries the first post's net
onto the thread head, an edit checks the author and the window, and
`seedGuide` posts `OAForumGuide.text()` under Moderator, pinned, locked,
tagged `about`. Every refusal has the SDK's shape, `{code:'functions/…',
details:{reason}}`, with a reason `member.js` can answer with, and
`seed.refuse` makes one callable refuse for the wording checks. It proves
nothing about the functions, which the emulator test proves; what it lets
`page-test.mjs` measure is what the page does with a real answer. The
verification card's own branches (`callableFails` first, the canned receipt)
are untouched. One consequence for every shim consumer: a snapshot's `data()`
now answers a COPY, as the SDK's does, because the forum stamps `id` onto a
thread it read and a check over `__fb.docs` would otherwise see the page's own
bookkeeping as a field the simulator wrote. The forum's 390px block measures
its LIST with `MOBILE_LIST_MEASURE`, the very function the `MOBILE_PAGES`
loop runs, factored out of the loop so the standard is applied one way
(`testMobileStandards` pins that exactly the two call it), and adds rule
13's own numbers: the vote column above the post, the 16px textarea, the
42px tabs, votes, actions and Post.

### It is BUILT and NOT ANNOUNCED, and everything it would say is held together

Owner, 2026-09-05: *"do not add it on the top bar yet and don't mention it
anywhere on the website yet. I want to pre-populate it with certain topics I
will tell you."* So `forum.html` ships, is served and is reachable by typing
its address — which is how the maintainer signs in, presses the seed button
for each room and posts the first threads — and **nothing on the site points
at it**: not the home page, not the account menus, not the change log, not
the sitemap, not the privacy policy.

**One switch, and it is `FORUM_ANNOUNCED` in `assets/oa-accounts.js`.** That
file is the only one that DRAWS a link (both menus), so the flag lives beside
what it governs rather than in the model, which most pages never load — a
flag read through a module that is absent would be false everywhere and could
never be turned on. The row's markup is written behind it and not merely
hidden: this file's own rule is that **nothing merely hidden counts as
withheld**, so the link is not in the document at all.

**The static surfaces cannot read a flag, so they were REMOVED and their
words kept here.** Announcing the forum is one change that puts all of them
back and flips the switch:

1. `FORUM_ANNOUNCED = false` → `true` in `assets/oa-accounts.js`;
2. the home page's button, in the candidates section's `.v3-section-cta`,
   where a comment holds its place:

       <a class="v3-btn ghost" href="forum.html">Candidates&rsquo; forum</a>

3. the home page's FAQ answer, restored as a `.v3-faq-item` immediately
   before *Is my personal information published?*. Its question, on one line:

       Is there somewhere to talk to other candidates and to faculty?

   and its answer: *Yes. The
   site has an anonymous [forum](forum.html) in two rooms. The **Candidates'
   room** is for the accounts holding a candidate profile for the season under
   way; the **Open forum** is for every registered account with a confirmed
   e-mail address, faculty included. You post under a random handle drawn for
   the season, the same in both rooms and never your name; threads carry tags,
   replies can quote a passage of an earlier post, and a post can be liked or
   disliked. Sign in and open **Forum** from your account menu. The forum guide
   is pinned at the top of each room; read it once before your first post.*
4. the privacy policy's paragraph, restored where its comment holds the place,
   above `<h2>Security</h2>`, VERBATIM:

```html
          <p>The Site has an anonymous forum in two rooms: a Candidates&rsquo; room for the
          accounts holding a candidate profile for the season under way, and an Open forum for
          every registered account whose e-mail address is confirmed. You post there under a
          handle, and the handle is random: two words and a number drawn by chance when you
          first join in a season, the same in both rooms, and changed at the July roll. The Site
          links a handle to an account only through a keyed one-way hash computed inside its
          server functions, whose key is destroyed a month after the season ends; after that
          nobody, the maintainer included, can tell which account held which handle in that
          season. The forum does not read the address your browser connects from, stores no
          record of it and does not load the analytics and visit measurements the rest of the
          Site carries. Google&rsquo;s own request logs for the server functions record the
          connecting address and the minute of each call for their standard retention; only the
          maintainer&rsquo;s project login can read them, and the forum writes nothing of its
          own to them. Every time a post or a vote is stored is rounded down to the minute. The
          maintainer can read and post in both rooms as an ordinary member under a handle like
          anyone else&rsquo;s, and moderates them; linking a current-season handle to a person
          would take a deliberate step with the key and never happens by accident.</p>
```

5. the change log entry, restored at index 0 of `changelog.json`:

```json
{
  "id": "forum-2026-09",
  "date": "2026-09-05",
  "title": "An anonymous forum, in two rooms",
  "summary": "The site gains a forum. The Candidates' room is for accounts holding a candidate profile for the season under way; the Open forum is for every registered account with a confirmed e-mail address. You post under a random handle, the same in both rooms for the season, never under your name. Threads carry tags, posts can be liked or disliked and quoted in a reply, and your own post is yours to edit for fifteen minutes and to delete, a question once every reply has gone. The forum guide is pinned at the top of each room; read it once before your first post. Reached from your account menu.",
  "url": "/forum.html"
}
```

**R9 is deferred, never waived, and the guard is what makes that true.**
`testForum` reads the switch out of the source and demands the opposite
things on either side of it: while it is false, no served page may carry an
`href="forum.html"`, the policy must NOT describe the forum, no change log
entry may exist, and these five wordings must be here verbatim; the moment it
is true, every one of those surfaces is demanded back, the policy paragraph
included. So the disclosure cannot be the thing somebody forgets on announce
day, and meanwhile it discloses nothing because no reader can reach the
forum: the pre-population is the maintainer posting under their own handle.

**What is not solved, and is said rather than hidden.** A constant per-season
handle lets a reader connect one person's posts across threads, and a detail
here beside a detail there can identify someone in a population of a few
hundred; the guide's small-population note says so. With the current
season's secret and the Admin SDK the maintainer can link a current handle to
an account; that is a deliberate step, disclosed in the guide and the policy,
and it ends for a season when that season's version is destroyed.

Tests: `testForum` in `_scraper/selftest.mjs` (the model, the writers against
the model both ways through the `@doc` blocks, R1 to R8 as source scans, the
rules block clause by clause with the rooms pinned against the model both
ways, the guard's literal and fixtures, the guide, the fourteen exports, the
package and lockfile, the emulator test's shape and the workflow job, no
forum cron, the runbook, the policy paragraph (R9), the change log entry and
this section; then the page half: noindex and no preview block, charset
first, the head snippet, the nine scripts in order and deferred, the three
quiet scripts absent, the ids the browser suite hooks on, the app and the
gate cards born hidden with no thread markup shipped, `card: false`,
`NOINDEX_OK`, the sitemap, both `QUIET_PAGES`, the engine's `cfg.source`,
the collections in `col`, the menu row on both menus and the sign-out
clearing, `REASONS` against `ERRORS` both ways, the quote's bound and
shape, the archive drawing no write control, the withdraw marker, the CTA,
the FAQ, rule 13 and a token-only stylesheet), `_functions/test/
forum-emulator.mjs` (R7 and R10 against the real thing), and the forum
block of `_scraper/page-test.mjs` (the gate for a signed-out, an
unverified, a verified non-candidate, a seeded candidate and the
maintainer; a question with two tags posted, read back, replied to with a
quote, edited inside the window and voted up, down and withdrawn through the
shim's forum simulator, with the counts and the thread head's score
following; a hostile title and body rendered inert; the leak check over
`#main`, which is where the forum's markup is, since the header's account
chip prints the account's own name and address on every page by design, and
over the whole document for the uid and the profile id; the maintainer
seeding the guide through `forumModerate` and posting under a drawn handle;
the archive view asking for no votes; and the 390px block for the list, one
thread and the open compose). `testForum` also pins the simulator (the six
names and only those, the refusal shape, the fixed vote id, the reasons it
answers with) and the browser block (every reader driven, the leak needles,
the shared measure), so a block deleted or a reader dropped fails the
build.

### The 2026 Q&A archive, carried in as threads

Owner, 2026-09-05: *"prepopulate the OA forum with anonymous users having
posted the questions shown here and then anonymous users having posted the
answers ... tag: 2026 Q&A"*, from the tracking workbook's **2026 Q&A** tab,
which is the sheet's own anonymous forum and the thing this forum replaces.

    _scraper/forum-seed-2026-qa.json   what is posted, committed and reviewable
    _scraper/seed-forum.mjs            the plan, the guards, the write
    .github/workflows/oa-forum-seed.yml   pressed, never scheduled

**A SCRIPT, NOT AN `op` ON `forumModerate`.** A callable would be inert until
somebody ran `firebase deploy --only functions` by hand, and this file has
twice recorded what that costs: *a feature that needs a manual step to become
real looks installed and is not*. `FIREBASE_SERVICE_ACCOUNT` has been a secret
here for months, so this road is live on merge. It is also the one writer of a
forum document outside `_functions/forum/`, which is why `shapeOk` holds every
document it builds to `KEYS` in `oa-forum-model.js`: the writer-against-model
discipline the `@doc` scan applies to the callables, applied to the one writer
the scan cannot see.

**THE SEED IS COMMITTED, NOT FETCHED**, and it is under `_scraper/` rather
than `data/`. Two reasons, and they are separate. Everything under `data/` is
served by Pages to anyone who asks, and these threads belong to the room that
decides who reads them. And a one-off seed read live from a crowdsourced
workbook could not be reviewed before it was posted, nor re-run against the
same words: the file is what the button will post, in the diff, before it is
pressed.

**WHAT THE SHEET RECORDS AND WHAT IT DOES NOT.** A cell packs several people's
replies together with `<<` and `<-` (row 5's Response 3 is an eight-turn
exchange in one cell), so each segment is its own post: 14 rows became 14
threads and 52 posts, nobody's words altered and only the splits added. The
sheet names no author anywhere, so **a handle is drawn per POST** and asserts
no linkage between two posts, because the sheet records none. A seeded
handle's id is a digest of its own post id and nothing else, never a uid and
never `FORUM_SECRET`, so no seeded document can be joined to a person; each
claims its slug in `forumNames`, or `forumJoin` could later draw a name a
seeded post already speaks under.

**AN `xN` IS N UPVOTES, NOT N PEOPLE SAYING THE SAME THING** (owner,
2026-09-05: *"'Thank you! x5' means that someone wrote 'Thank you!' and then 5
users upvoted it"*). The first cut read those markers as text and published
posts that said `x20` and `x6`, which is the sheet's convention misread as
prose. A marker attaches to the post it FOLLOWS, wherever it sits: trailing
the words it applauds it becomes that post's `up` and leaves the text, and a
cell that is only `xN` is a vote count rather than a post at all, so its
count lands on the post before it and no empty post is published. Seven
markers, 41 upvotes, and three posts that were never posts.

**No `votes/{H}` document is written for them, and that is right rather than
a shortcut.** Those documents record WHO voted, so that a member can change
their own vote; the sheet records no voter, and inventing one would be the
one thing this file refuses everywhere. A seeded count behaves correctly
without them: a reader's own vote increments and decrements from it exactly
as it would from any other, and nobody can un-cast a vote that was never
theirs. The thread's `score` is its opening post's net, which is what
`forumVote` keeps there, so a seeded thread sorts and reads like a posted
one.

**THE GUARD IS RE-RUN AT WRITE TIME**, over every title and body, so a text
the site's own rule refuses cannot be smuggled in through a committed file.
One response was refused and is listed in the seed's own `skipped` block with
the reason: a Substack post id (`p-165440484`) is nine consecutive digits and
`hasPhone` cannot tell it from a telephone number. It is **reported, never
weakened away** — relaxing a privacy guard to import content is the wrong way
round, and the run log names what did not travel. A `"ddd"` somebody typed
into the sheet is listed there too.

**IDEMPOTENT BY DOCUMENT ID.** A thread is `qa2026-r<row>` and a post
`qa2026-r<row>-p<n>`, so a second press writes nothing: the run reads each
thread first and skips the ones already there, which is also what keeps the
room's tag tally from being counted twice. It never writes a **season head**:
`secretVersion` is `identity.js`'s to mint from Secret Manager on the season's
first real join, and a head written without one would be a season whose
handles no version derives.

**The season is the one under way and the run refuses a mismatch.** The tab is
named for the calendar year the market opens in and the site names a season
for the year it ends in, so "2026 Q&A" is season **2027**; the seed says so
and the seeder stops rather than filing a closed season's questions under the
one now running (`--force-season` if that is ever really meant). Each post
carries the day the sheet recorded, at 12:00 UTC plus a minute per post, so a
thread reads in order and every stamp is a whole minute (R7).

**It changes nothing about the announce switch.** `FORUM_ANNOUNCED` stays
false, no served page gains a link, and the pre-population is exactly what the
owner described: the forum is reachable by typing its address, which is how
the seed is read back and the guide seeded.

Tests: `node _scraper/seed-forum.mjs --selftest` (the digest naming no uid,
secret or clock, read from a bounded and comment-stripped slice of its own
source because the file EXPLAINS the HMAC it does not compute; the ids; the
minute-aligned clock; `KEYS` over every document it would write and the four
kinds it builds; the guard re-run over the committed seed; a duplicate handle
and `Moderator` both refused; every handle one the word lists could have
drawn; and the upvote counts stored with no marker left in the words, no
post that is only a count, the thread's score its opening post's, and no
invented vote document) and `testForumSeed` in `_scraper/selftest.mjs`, which spawns that suite
the way the roster sync's is spawned and pins the seed out of `data/`, its
room and season, the owner's tag on every thread, one handle per post, the
dispatch-only workflow with its plan-by-default input, and this section.

### …and one thread can be taken off entirely

Owner, 2026-09-05, of a thread on the Candidates' room list: *remove this
thread in red entirely*. It was one whose author had deleted the opening post
with a reply already under it — `forumDelete`'s documented middle case, where
the words go, the title becomes `DELETED_TITLE` and the thread STANDS, because
one person changing their mind must not take other people's replies down with
them. That is right for an author and it is not the maintainer's answer: what
was left was a card reading "Deleted by its author" over a reply, with no way
to be rid of it. Nothing in the forum could remove it — every content path in
`_firestore.rules` is `allow write: if false`, the maintainer's browser
included, and `forumModerate` carries `seedGuide`, `pin` and `lock` and no
removal, since moderation of reports is step 3.

    _scraper/remove-forum-thread.mjs           the plan, the guards, the deletes
    .github/workflows/oa-forum-remove-thread.yml   pressed, never scheduled

**THE SEEDER'S ROAD AGAIN, and for its reason.** An `op` on `forumModerate`
would be inert until somebody ran `firebase deploy --only functions` by hand,
which this file has recorded twice the cost of; `FIREBASE_SERVICE_ACCOUNT` has
been a secret here for months, so a script is live on merge. It joins
`seed-forum.mjs` as the second writer of a forum document outside
`_functions/forum/`, and like it, the one document it WRITES is held to the
model: the room's tag tally, whose only key `KEYS.tags` names. Everything else
it touches, it deletes.

**IT PRINTS NO WORDS, because the log is public.** A dispatched run prints into
the Actions log of a public repository and the Candidates' room decides who
reads what is in it, so a thread is named by its ID, its tags, its counts and
its days — never a title, never a body, never a handle. That is also what makes
the LIST mode usable at all: with no id the run lists the room and marks the
threads whose author has deleted the opening post `opener-deleted`, which is
how the one the owner circled is told apart without publishing anybody's words
to the world. The id itself comes off the address bar (`?t=`) or off that list.

**THE TALLY IS GIVEN BACK, BY VALUE.** `forumTags/{Y}_{room}` is an `increment`
tally and the one thing here that cannot be recomputed from what is stored, so
a removal that ignored it would leave **Popular tags** counting a thread nobody
can open. It is read and written back floored at zero rather than incremented
by −1: a tag past `TAG_COUNT_CAP` was never counted, has nothing to give back,
and `increment(-1)` would print a negative in that panel.

**WHAT IT NEVER REACHES.** `forumHandles/{H}` and `forumNames/{slug}` are the
ACCOUNT's handle for the season, shared by every thread it has posted in, so a
thread removal must not take one with it; nor `candidateMarkers`, which is the
membership marker. And the room's own **guide thread is refused outright** —
`forumSeasons/{Y}.guides.{room}` names it and the seed button is drawn only
while that field is empty, so a removed guide is a room that can never have one
again.

**The order is recoverable, and it is permanent.** The posts and their votes go
first and the thread document LAST, so a run interrupted half way leaves the
thread standing and a second press finishes it; the other order would strand
posts under a thread nothing can reach. There is no Restore, and the plan is
what stands in for one: elsewhere on this site hiding is never a one-way door
because those are controls a READER presses, this is the maintainer's own tool,
and nothing happens until `--write`.

Tests: `node _scraper/remove-forum-thread.mjs --selftest` (the tally floored at
zero and never incremented, the guide refused, a printed line carrying no
title, handle or body while still saying `opener-deleted`, the arguments, and
the source scans over a slice bounded at BOTH ends and its length asserted —
the file explains the things it must not do, so a scan over the whole of it
would be satisfied by deleting the explanation) and `testForumThreadRemoval` in
`_scraper/selftest.mjs`, which spawns that suite the way the seeder's is
spawned and pins the one document it writes against `KEYS.tags`, the
collections it may never reach, the dispatch-only workflow with its
plan-by-default input and its list-to-find-the-id line, and this section.

### A question, its answers, and the tick that says which one worked

Owner, 2026-09-05, over four screenshots of a Stack Exchange question: *"a
user who posts may tick an answer that they think answers their question.
Other users can post answers but comments as shown in red should not be
posted"*, and then *"improve the looks of the posts, e.g. add more space to
look nicer. See how stackoverflow does it"*. Three decisions come out of it
and none of them should be re-opened lightly.

**THERE ARE NO COMMENTS, AND THERE IS NO PLAN FOR ANY.** The thing circled in
red is the comment thread under a Stack Exchange answer, and the forum has
never had one: a thread is a QUESTION and the ANSWERS to it, post 1 and the
rest. What changed is that the page now says so — the band under the question
is "N Answers", the box below it is "Your answer", a post is "answered" rather
than "replied", and the per-post Reply button (which only ever moved the
keyboard to the box below) is drawn on the question alone as *Answer this
question*; Quote is how an answer is answered. The selftest reads
`assets/oa-forum.js` with its own comments stripped and refuses the word
`comment` in anything the page draws, and `KEYS` names no such document, so a
comment layer cannot arrive by accident. (The scan has to strip the file's
comments, because the paragraph explaining this decision is itself full of the
word — the trap this file records for the analytics page's "no iframes"
check.)

**`forumAccept` IS THE EIGHTH CALLABLE, and the tick is ONE FIELD ON THE
THREAD.** `accepted` names the post; the post carries no flag of its own.
That is what lets the card in the list mark an answered question from the row
it already reads — no post read per card — and it is why the two can never
disagree: there is nothing to keep in step. `forumAccept({room, tid, pid})`
takes an empty `pid` to untick, moves the tick when another answer is named,
and writes nothing when asked for the one already ticked (the shape
`forumVote` already had).

* **The member who ASKED, and nobody else.** The handle on the thread head is
  the one that may tick, and the refusal is its own word, `asker`. Not the
  maintainer: they are an ordinary member in both rooms, and reading somebody
  else's question is not moderation.
* **Only an answer, and only while its words are there.** Post 1 is the
  question and a deleted post is a tombstone; both answer `answer`.
* **Refused on an ARCHIVE, allowed on a LOCKED thread.** An archived season
  cannot answer "did this member ask it" once its secret version is destroyed;
  locking stops new posts, and saying which of the answers already written
  worked is not a new post. That is `forumDelete`'s own reading, applied here.
* **Deleting the ticked answer takes the tick with it**, in the same
  transaction (`delete.js`), or the thread goes on telling every reader that a
  question with no answer left in it has been answered. That is the same
  transaction the rule above it lives in: a question with a live answer cannot
  be deleted at all, so the tick and the question can never go together.
* **No rate limit, deliberately.** It writes one field on the caller's own
  thread and creates nothing; the day counters exist to bound what a handle
  can ADD to a room.

**The band is ordered, and the numbering is not.** Answers read accepted
first, then best liked, then oldest, with "Sorted by" beside the heading
offering the strictly chronological reading instead. What never moves is `n`:
it is a post's name, a quote points at it, and the permalink under each answer
is that number. The band is repainted on its own when the tick moves, so the
box below it keeps whatever was half written in it.

**The looks, and the one rule behind all of them.** A post is given 28px of
air and a 64px vote column; the question card's tally column is 104px with the
number over its word (which is what stops "0" and "votes" being squeezed into
one cramped line — the column the owner circled); the answered count is boxed
in the room's green and FILLED with a tick once an answer is accepted; the
accepted answer carries that green as a rail and a wash where the words are;
"Open the thread" stays (it is the only text on the card that says what a
press does, and the engine's comment explains why it must reach a screen
reader) but is small, muted and tucked to the right. And the heading a thread
focuses on arrival is no longer RINGED: `tabindex="-1"` means nothing can tab
to it, so every focus it takes is the script's, and Chrome matches
`:focus-visible` on a programmatic focus, so both have to say `outline: none`.

**A tag chip's hover is a STEP, not a flip** (owner, 2026-09-05, of the
near-black chip: *"see what happens when a user hovers over a tag on
stackoverflow. Improve the colour and behavior"*). Filling a chip with
`--brand` inverts it to near-black in light theme and near-white in dark,
which reads as a pressed state on something that is only being pointed at and
throws the tag's own colour away at the moment a reader is looking at it. The
ground goes one step firmer (`--line-soft`), the ink stays the tag's, a
hairline appears, and the chip carries a TITLE naming what pressing it does
and how many questions carry it this season — the useful half of the popover
there. Both places a chip is drawn move the same way, and the selftest pins
that neither goes back to the flip.

### Saved questions and watched tags live in THIS BROWSER

Owner, 2026-09-05: *"allow users to bookmark a question or answer within the
forum. Also, similar to stackoverflow allow them to watch tags and get
notified if new posts get posted with the same tags."*

**Neither writes a document, and that is the decision rather than the
shortcut.** A `users/{uid}/...` bookmark would be perfectly easy to write —
the blanket owner rule already allows it — and it would put in the database
exactly what this page refuses to let the site keep: a uid beside the threads
a member reads and the tags they follow. `forum.html` loads no GA4, no
`oa-usage.js` and no visit ping for that same reason, and the argument does
not change because the record would be the reader's own. So both marks sit in
`localStorage` under **`oa-forum-saved`**, keyed to the account like the
seen-marks beside them, cleared by `signOut()` with the rest (a shared machine
must not hand the next person the last one's list), and the cards SAY so
rather than letting a reader take them for a subscription the site is keeping.
The cost is stated where it is offered: they follow the reader on this device
and no other.

* **The bookmark is on every post**, question and answer alike, under the vote
  arrows where the site the owner named puts it; saving an answer and saving
  its question are two marks, so the key carries the post id. The side card
  lists the newest eight for the room on screen, each with a way to remove it,
  and it is hidden while there are none.
* **A tag is watched from its own chip**, in Popular tags and in the card of
  the tags you watch; the bell says which state it is in and the card explains
  itself while the list is empty, since that is where the feature is
  discovered.
* **"Notified" is IN-APP, and the e-mail half is deferred rather than
  forgotten.** Over the list, when questions carrying a watched tag have
  arrived since this reader last read the room, a line says how many and
  offers to show them — computed from the rows the list has already read and
  the seen-marks it already keeps, so watching a tag costs no read, no
  document and nothing anyone could later be asked to hand over. A digest
  cannot ship yet for a reason that has nothing to do with the plumbing: the
  forum is deliberately NOT ANNOUNCED (`FORUM_ANNOUNCED`), and an e-mail
  naming a thread in the Candidates' room would announce it to whoever opens
  the message. When the switch is flipped, the honest shape is a fifth topic
  on the existing alerts (`assets/oa-alert-match.js` + `alerts-mailer.mjs`)
  with the room checked per subscriber at send time.

Tests: the accept and marks blocks of `testForum` (a callable of its own with
the asker check, the question and the tombstone refused, the archive refused
and the locked thread not, the idempotent write, the tick pinned as a thread
key and never a post one, the deletion that clears it, the band's order, the
"Answers" wording with `oa-forum-replies-h` gone from both files, no `comment`
in anything the page draws, the local store with no collection behind it, the
five new ids born hidden, the tag hover pinned both ways, the post's own
padding and the un-ringed heading), the `forumAccept` block of
`_functions/test/forum-emulator.mjs` against the real function (somebody else
refused, the tick moved and cleared, the archive refused, and the deletion
clearing it), and the forum block of `_scraper/page-test.mjs`, which drives
the whole of it in a browser: no tick offered on somebody else's question, the
asker ticking their own thread with the answer moving to the top and the
thread's row following, the untick, the bookmark with its side card, the bell
writing to localStorage and NOTHING to the database, the archive offering the
bookmark but no tick, and rule 13's 42px targets for both new controls.

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
  site, a different producer. It READ as dead code while the functions were
  undeployed — they are live since 2026-08-27, so it is the live instant path
  now — and the selftest pin stays for the same reason it was written: nothing
  in this repository can see whether the functions are up, so the trigger is
  kept whether or not they are.
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

### …and a "Closing this week" digest, whose mark is a WINDOW END

Owner, 2026-09-04: an alert may also remind its subscriber of the postings
matching their filters whose **final apply-by date** (`applyByDate`) or
**suggested apply-by date** (`reviewDate`) falls within the next seven days.
It is a fourth topic, `deadlines`, on the existing alert system rather than a
mailer of its own: the tick box sits beside the other three on `alerts.html`,
the same `criteria` filters choose the postings (no filter means every
posting), the same `isDue` honours the alert's frequency, and a digest may
carry jobs, candidates, updates and deadlines together — the section is
headed **Closing this week** and lists institution, department, which date it
is and the date, each posting linked through `livePostingUrl`, the same
`OAJobNav.hrefFor` rule the poster's own e-mail already uses (so a posting
whose season has rolled opens on Previous markets). A digest that carried
only deadlines is subjected "N postings close this week".

**One pure function decides it, on both sides.** `closingSoonFor(rows,
criteria, {from, until, coveredUntil})` in `assets/oa-alert-match.js` — the
alerts page's preview and the mailer both call it, over the same served
file, so the sample a subscriber sees is the e-mail they get. Dates are
`yyyy-mm-dd` strings compared as strings (a stamp is cut to its day, prose is
never a date), today is the UTC day like the rest of the pipeline, and both
window edges are inclusive: a search closes at the end of the day named, and
"within seven days" includes the seventh. Where both dates fall due in one
window the FINAL one is named, since it is the date that closes the search;
where only the suggested one is in the window it is named as suggested, and
the final date gets its own turn. The window's length is ONE constant,
`DEADLINE_WINDOW_DAYS`, read by both consumers, so the page cannot promise a
week the mailer does not send.

**The mark is `lastDeadlineUntil`: the END of the window the alert was last
checked against**, written when a digest was delivered and on the idle
branch, and never a wall clock — the shape `lastJobAt`, `lastUpdateDate` and
`lastCandidateAt` have, for the reason the section above records. The next
window announces only dates AFTER it, which is what makes a closing date
named exactly once: a daily alert sees each posting on the day its date
enters the window, a weekly one sees the week's worth, and a run that could
not send (no mark written) re-checks the same days rather than losing them.
A checked-and-EMPTY window is covered too — a delivered digest with no
closing rows, or an idle run, still writes the window end — because what the
mark records is what was looked at, not what was found. **And it is written
ONLY when `data/jobs.json` was actually read** (`jobsOk` in the mailer): the
read falls back to `[]` on failure, which is the safe direction for the jobs
and candidates marks (they move only behind a delivery) and the WRONG one for
this mark, the one that moves on the idle branch — an unread file reads
exactly like an empty window, and every closing date in the week would have
been stamped covered without being looked at. Unread, the mark stays where it
was and the next run re-checks the same days; the run says so.

**A MONTHLY alert sees one week in four**, and the page says so rather than
promising every closing date. `isDue` makes a monthly digest due 28 days after
the last one, and the window is always the seven days from the run, so a
closing date in days 8 to 27 after a monthly digest is in no window it is
ever checked against. The tick box says "the seven days after each digest
(choose daily or weekly to see every closing date)", the FAQ says the same,
and `syncFormState` draws a hint under the frequency select (`#a-freq-note`)
while deadlines is ticked and the frequency is monthly — where the choice is
being made. Widening a monthly alert's window to 28 days was not done: the
reminder is a "closing this week" list, and a month of deadlines under that
heading would be a different message.

**The cost, stated rather than hidden**: a posting that ENTERS the window late
— added, or given a date, after the window was covered — is not announced by
this topic. The jobs topic is what announces a new posting, and a subscriber
who wants both ticks both; a per-posting ledger would keep "never twice"
without that gap and was not worth a document that grows for ever.

**The matcher is handed the market rule, and says no without it.** A posting
from a closed season is not on the jobs page and is not reminded of, however
its dates read, so `closingSoonFor` asks `OAJobNav.inCurrentMarket` — the ONE
definition — through a third factory argument. `alerts.html` therefore loads
`oa-jobnav.js` BEFORE `oa-alert-match.js`, and with the module absent the
function returns nothing rather than a private guess at the season (the
`oa-sponsors.js` lesson, pinned by evaluating the file with a bare root).
The dependency changes nothing for the jobs, updates and candidates topics.

**No rules change**: alerts live under the blanket `users/{uid}/**` owner
rule with no key ceiling, so the Admin-SDK stamp freezes nothing (pinned).
`ALERT_FIELDS` carries the mark in both copies of `oa-accounts.js`, or a
merged alert would re-announce the week it was already told about.

Tests: `testClosingSoonDigest` in `_scraper/selftest.mjs` (the window edges,
the covered-until exclusion, suggested versus final, the market filter,
string dates, the module without its dependency, and the wiring on the page,
the mailer, both accounts copies, the rules, the changelog and the FAQ),
`alerts-mailer.mjs --selftest` (the section rendered with the permalink, the
subject, and — from the file's own source — that the mark is the window end
on the idle branch and behind a delivery, and never `now`), and the alerts
block in `_scraper/page-test.mjs` (the tick box, the preview section over a
routed file, and a deadlines-only alert saved through the fake Firebase shim
with exactly that topic).

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
--project operations-academia`, from the repository root — done, since
2026-08-27; `recordVisit` since 2026-08-30), and a doorbell that is not
deployed looks exactly like a site that is simply slow — there is no error
anywhere, everything still publishes, just on the schedule. That is worth
checking first whenever "it takes ages to appear" comes up:
`firebase functions:log` should show `build dispatched` / `sheet read
dispatched`, and the `oa-jobreview-decided` runs in the Actions history are
the proof only the function can produce — filter by
`event:repository_dispatch` and read the ACTOR: the function carries a PAT
and shows as a person, where the verify workflows' own curls carry
`GITHUB_TOKEN` and show as `github-actions[bot]`. The setup page's paths were
stale after the promotion (it said `cd v2`, where there are no functions any
more); they are fixed. **And a deploy from a STALE CHECKOUT is the same trap
one layer up**: the 2026-08-29 deploy printed "Deploy complete!" while
shipping nothing — the checkout predated the newest function, so the three
existing ones skipped as unchanged and `recordVisit` was not in the upload at
all; the 2026-08-30 deploy that followed a pull created it. Pull before
deploying, and read the per-function lines, not the last one.

**The Node.js 20 deadline is CLOSED — answered in the repository and carried
live by the owner's 2026-08-30 deploy.** Google decommissioned Node 20
deploys on **2026-10-30**; `_functions/package.json` names **Node 22** and
current SDKs (`firebase-functions` ^7.3.2, the package the deploy warning
itself named; `firebase-admin` ^14.3.0 — a major that REMOVES the namespaced
`admin.*` surface whole, which is why `recordVisit` was rewritten to the
modular `firebase-admin/app` / `firebase-admin/firestore` API in the same
change; the breaking change was caught by LOADING the module, not by reading
release notes), and `firebase functions:list --project operations-academia`
reads **nodejs22** on all four — the runtime column there is the ground
truth for any future deploy, never the deploy's own "complete". Getting it
live surfaced two misleading CLI failures — a discovery timeout on code that
loads in under a second (a blocked localhost socket, not slow code), and a
wrong "Skipped (No changes detected)" on a changed runtime (the skip hash
does not include the runtime; bypassed by naming the functions in `--only`)
— both recorded with their fixes in `_SETUP-INSTANT-PUBLISH.md`. `npm install --prefix _functions`
before deploying, as always: the CLI loads the local `index.js`, and stale
modules are how a load dies.

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

### …and it says WHO edited, or the crawler reads as eight people

Owner, 2026-09-02, of an "[OA] Job postings changed: 8 edited": *"for each edit
(1) the name and email of user who edited"*. Every one of those eight was the
tracking-sheet crawler, and the message gave the maintainer no way to know it —
eight "Edited" headings, a before/after each, and nobody named. A message whose
whole subject is that something changed has to answer who changed it, or every
pipeline hiccup reads as users editing postings.

**It is `postedBy`, the shared rule** (`jobs-model.mjs`) — the same one the
review and submission mailers print, so the three cannot disagree about what a
crawled posting is. `renderChangesHtml` takes a `whoFor(row)` and draws
*"Posted by:"* under each section: a person by name with their address as a
`mailto`, a crawled row as *"auto-crawler from the OM Job Market tracking sheet
(Google Sheets)"*. **A caller that cannot answer says nothing** rather than
guessing, which is what keeps the renderer usable from a test with no database.

**The join is `ref` and only `ref`.** It is issued by the FORM and by nothing
else, so it is the one key that finds the POSTER's own document rather than a
place and a day — the `matchServed` lesson, which cost a poster somebody else's
posting in their inbox. A row without one is the workbook's or the legacy
import's, and `postedBy` names the source.

**Only the admin receives this message, and always did**: one `to:`,
`ADMIN_NOTIFY` or `kstouras@gmail.com`, no list and no other recipient — the
same address the review and staleness mail goes to. No user has ever been sent
one, so nothing had to be stopped. What was missing was the line saying so.

### A tab read without its header must not UN-SAY what the header said

Those eight edits were not merely unattributed — they were **wrong**, and they
reverted themselves. The workbook is crowdsourced and edited live; the
2026-09-01 02:01 read caught "2026 Jobs" mid-edit with its header row
momentarily unrecognisable, so `resolveColumns` fell through to whole-tab
inference. **Inference reads the institution, the date, the link, the country,
the area and the rank out of the DATA, and can never find the DEADLINE CELL or
the NOTES column** — a column is not named after either of the things it
detects. So the tab published every deadline as "Until filled." and every
comment as empty: eight served postings lost their closing dates for one run,
the maintainer was mailed a before/after for each, and the 17:26 read — which
saw the header again — put all eight back.

**The rule is the sync's own, one column at a time: a column the read could not
find changes nothing.** `carryUnreadColumns` (`jobmarket-sheet.mjs`, pure) is
the same shape as *"a workbook that cannot be read writes nothing"* and *"an
unreachable queue changes nothing"*, narrowed from the file to the field. For a
row from an **inferred** tab only, a field whose column the inference did not
claim keeps what the site already knows — the committed `data/jobmarket.json`,
or the review queue's own copy for a posting still pending, which is the same
"already known" set `stampAddedAt` reads.

Four things make it safe, and each is pinned:

* **An inferred tab only.** A recognised or repaired header is the tab's own
  word: a column such a header does not name genuinely is not on the tab, so a
  deadline the maintainer really did clear in the workbook still clears.
* **Fill-empty and by value**, the `healCountry`/`healPlace` shape — a row with
  nothing to carry is the same object, and a second pass carries nothing more.
* **The dates move together** (`applyBy`, `applyByDate`, `reviewDate`), because
  one cell settles all three, and only onto a row the degraded read left
  open-ended — so it can never overwrite a date.
* **`year` and `id` stay derived.** The tab-cycle floor is what holds them
  steady through a dateless read (it did, for all eight), and an id rewritten
  here would desync from everything joined on it.

**And a degraded read is now LOUD.** The run warns which tab was read without
its header and how many postings kept their deadline because of it. The last
one said only `"2026 Jobs": 129 posting(s) (columns inferred — no header row
was recognised)` — true, buried, and indistinguishable in the log from the
tabs that legitimately have no header.

Tests: `testJobMarketSheetCarry` in `selftest.mjs` drives the defect itself —
one fixture read with its header and without, the degraded read asserted to
un-say the deadline, the carry putting it back with its span re-read, the
idempotence, the by-value identity, and the three cases that must carry
nothing (a header that was read, a posting the site does not know, no inferred
tab at all) — plus the wiring in `testJobMarketSheetWiring`, including that
everything downstream consumes the CARRIED rows, since a carry nothing reads
is a fix that is not applied.

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

### …and two pickers take several values, one of them ALL-OF

Owner, 2026-09-04: Entry level and Characteristics on `jobs.html` were
single-select (`type: 'one'`, drawn as radios), one answer forced on two
questions that have several. Both are multi now, and they combine their values
DIFFERENTLY, because the questions differ. **Entry level is ANY-OF**, the
engine's default and the text search's own reading: a candidate who could take
an assistant professorship or a post-doc wants to see both, and AND would be
empty for everybody not advertised at two ranks at once. **Characteristics is
ALL-OF** (`match: 'all'` on the filter): a candidate ticking "PhD" and
"Research seminars" wants a department that has BOTH, and a widening search
would show them departments with neither of the things they asked for
together.

`match: 'all'` is a GENERIC engine option (`matches()` in `oa-list.js`), so the
decision stays on the page that knows its dataset. Three things follow, each
pinned in `testMultiSelectFilters` and driven in `page-test.mjs`:

* **The counts change meaning under AND.** A cross-filtered count is "rows
  carrying this value, given every OTHER filter", and the moment one value is
  ticked that overstates every other option: "MBA 82" beside a ticked "PhD",
  where a tick would show the postings that have both. An all-of count is
  therefore WHAT TICKING THIS AS WELL WOULD LEAVE, counted over the rows
  already carrying every ticked value — a ticked value's own count is the
  current result, and every value the other filters allow stays listed, at an
  honest 0 where nothing has it beside what is ticked. Because those numbers
  move with the menu's own ticks, an all-of tick refreshes them IN PLACE
  (`recount`) rather than redrawing the rows, which would throw away the
  checkbox just pressed and the keyboard focus with it.
* **The rule is said where the reader is choosing** — a line inside the menu
  (`.oa-pick-hint`, styled in BOTH stylesheets) and the button's title — never
  under the control, where it would move the bar about on a phone. The page
  words it for its dataset (`hint:`); the engine has a fallback.
* **The Excel download's About sheet writes "and" between an all-of filter's
  values** (`activeFilters()` now says how each filter combines, `match:
  'all' | 'any'`), because "or" would describe a search the reader was not
  shown.

The URL needed nothing: a multi filter already carries one parameter per value
(`?chars=PhD&chars=Research+seminars`), and a single-value link from the radio
days still selects. `type: 'one'` stays in use — the archive's Entry level on
`previous-markets.html` and the directory's Show and Last edited — and the
engine keeps drawing it as radios that take the last value a link names. On a
phone the chips under a picker hang below its control, so a row whose partner
has none is not on one line while values are chosen; that was already true of
Location and is not what rule 12 in `_MOBILE-STANDARDS.md` measures (nothing
chosen).

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

### …and a search can be saved as an e-mail alert

Owner, 2026-09-04: a signed-in reader who has narrowed the jobs list can
press **Save as e-mail alert**, beside the Excel download, and land on
`alerts.html` with a new alert filled in from the filters they had set.

    assets/oa-alertsave.js   what is carried, what is reported as left out,
                             the URL, the note, the button (dual-mode)

**One module on both ends**, like `oa-alert-match.js`: the jobs page WRITES
the hand-over and the alerts page READS it through the same file, so the two
cannot disagree about its shape, and `selftest.mjs` drives the pure half.

**The university search carries its FIRST term only.** The matcher searches
ONE substring across the institution and the department, where the jobs page
ORs several terms; "utah princeton" as one needle matches nothing, so joining
them would hand the reader an alert that never sends. The others are reported
as `terms`. Type, entry levels and locations carry whole (through
`OACountries.canon`, so a legacy `?country=USA` lands as the name the form
offers). **Characteristics, the two deadline buckets, the date-posted window
and the `?job=` focus are not carried** and cannot be: nothing in an alert
holds them. Their keys travel as `dropped` and the alerts page says, in one
line over the form, what it left out, pointing a dropped deadline bucket at
the "Postings closing within 7 days" topic. A jobs-page filter added without
a wording in `DROPPED` is still reported, as "the <key> filter", never dropped
silently, and the selftest pins that every filter key has one.

**The transport is the URL and the stash is sessionStorage.**
`alerts.html?prefill=1&text=…&level=…&level=…&country=…&dropped=chars`, one
key per value as the jobs page's own links are. The alerts page stashes it
the moment it loads and strips the keys from the address with
`history.replaceState` (keeping `?unsubscribe=` and `?topic=`, which are
somebody else's), so a reload after the form was filled does not fill it
again; the stash is consumed ONCE, when the form can be drawn, which for a
reader who arrived signed out is after they sign in. It opens as a NEW alert
on the jobs topic with a suggested name ("Assistant Professor in United
States"), because the name is the e-mail's subject and a blank one is the
first thing the form refuses.

**Gated exactly like the download**: `whenSignedIn`, never the hint, and it
says no without the gate module. **Disabled with nothing filtered**, and the
tooltip says why: an alert for every new posting already exists as the "New
job postings" topic with the filters left blank, so an empty form would be
the wrong answer. The `.oa-action` rules in both stylesheets cover it with no
addition; measured at 1280px the three buttons share one line and the bar
stays two rows deep, and at 390px they stack full-width.

Tests: `testSaveSearchAsAlert` in `_scraper/selftest.mjs` (the mapping,
the round trip, what is kept off the address, the name, the note, the
no-em-dash rule over every word the module shows, the gate, and the wiring
on both pages, the lock card, the FAQ and the change log) and the
save-search block in `_scraper/page-test.mjs` (signed out it opens the
sign-in box and goes nowhere; signed in it lands on the alerts page with the
boxes ticked and the note naming the characteristics; a reload does not
re-fill; a signed-out arrival on the alerts page keeps the prefill across the
sign-in; the row at 1280px and the stack at 390px).

## Two calendar files: the deadlines a reader chooses, and the candidates' INFORMS talks

Owner, 2026-09-06: *"users can select jobs and then download a calendar
invitation with their respective deadlines (if any). Jobs with deadline
'until filled' won't be added on that calendar"*, and *"a calendar with all
candidates talks times, dates and locations at INFORMS conference. That
should help anyone who wants to attend their talk."*

    assets/oa-ics.js          the iCalendar writer (RFC 5545: CRLF, TEXT escaping, 75-octet
                              folding, VTIMEZONE), dual-mode like oa-xlsx.js
    _scraper/_ics-read.mjs    reads one back, for the two checks (the _xlsx-read.mjs shape)
    assets/oa-jobcal.js       the deadlines: which dates a posting can give, the tick box on
                              its card, the strip above the list, the file
    assets/oa-informs.js      WHEN and WHERE each season's INFORMS meeting is, keyed by market year
    assets/oa-talkcal.js      the talks: one entry per presenting day, timed where the profile
                              gives a time, the button in the candidates list's bar

**What a deadline entry is.** A posting carries up to two dates, the final
apply-by and the suggested apply-by (see "Two deadlines per posting"), and
each becomes an ALL-DAY, TRANSPARENT entry named for what it is, because the
suggested date matters most to exactly the searches that have no final one.
A posting with neither is the "until filled" case the owner named: it puts
nothing on a calendar, so its card is offered NO TICK BOX at all, and a date
that has already passed adds nothing either (a calendar of expired deadlines
is noise). The entry says both dates, the deadline as listed, the entry
levels, the advertisement and the posting's own permalink through
`OAJobNav.hrefFor`, the one rule for which page carries a posting today.
The Contact details are not in `data/jobs.json` and so cannot be here;
the selftest sweeps the built file for anything shaped like an address, the
way it sweeps the Excel workbook, and pins that every field the module reads
is in `PUBLIC_FIELDS`.

**The selection is page memory and nothing else.** Which postings a reader
ticked is kept in a variable in `oa-jobcal.js`: a reload forgets it, a
sign-out clears it (a selection made in one session must not be handed to
whoever signs in next on the same machine), and nothing about it is stored
or sent anywhere. The ticks survive a repaint because `onCard` redraws each
box from that memory, and "Tick all listed" ticks every dated posting in the
filtered set across every page, not the page on screen.

**A strip above the list, not a fourth button in the bar, and that was
measured.** The filter bar's actions cell holds Clear, the Excel download and
Save as e-mail alert on one line at 1280px with about 570px to spend; a
fourth button wraps, and the browser check that the last button holds the
bar's right edge goes red. More to the point the calendar is about the
SELECTION the reader makes on the cards, not about the filters, so it sits
between the bar and the result bar: a sentence saying what to do and how many
listed postings carry a date still to come, Tick all listed, the download,
and Untick all while anything is ticked. The engine gained ONE generic hook
for it, `cfg.onRender(snapshot)`, called after every repaint with what an
action is handed, so the strip's numbers follow the filters without the page
guessing when to recount. Drawn for a signed-in reader only, through the
gate's one definition, and the sign-in card names it as a reason to
register; the download goes through `whenSignedIn`, the Excel download's own
gate. The tick strip under a card's head and the strip's buttons are 42px
targets on a phone (rule 14 in `_MOBILE-STANDARDS.md`).

**The talk details live on the profile, keyed by the day.** A candidate's
profile has always said WHICH DAYS they present (`informsDays`, Sunday to
Wednesday); for each ticked day it may now say WHEN and WHERE: `talks` is a
map keyed by the day name, each day a map of at most `at` (HH:MM, the
meeting's local time), `session`, `room` and `title`, bounded by
`TALK_MAXLEN` in `candidates-model.mjs` and pinned against the rules'
`talkOk` both ways, key by key and bound by bound. Keying on the day is what
ties a talk to a day the candidate actually ticked, and the DATE is never
stored: it is the meeting's Sunday plus the day's index. The form draws one
block per day under the tick boxes, shown while the day is ticked, and reads
only the ticked days' blocks, so unticking a day drops its details at the
next save without four boxes being cleared; `talks` is sent on every save,
empty or not, because an edit is an `update()` and a key left out would leave
last time's details on the document. The card gains one "Talk on Monday
2 November 2026" row per day with details, through `oa-candcard.js`, so the
list, the account page's preview and the form's live preview say the same
thing; the twin fixture table carries the talk cases. The create-key
ceiling went from 34 to 35, and the candidate-stats guard against a
`keys().hasOnly()` on the document was narrowed to the DOCUMENT's own keys,
since a nested map's key list is not the trap it guards against.

**`oa-informs.js` is the one record of the meeting**, keyed by market year
(the meeting held in the autumn of 2026 belongs to 2026-2027, key 2027):
the opening Sunday, the city, the venue, the programme's address, the zone
and how long a session runs. 2026-2027 is San Francisco, Moscone Center,
Sunday 1 to Wednesday 4 November 2026, checked against informs.org on
2026-09-06. The selftest pins that every `opens` is a Sunday and that `DAYS`
is the profile's own vocabulary. A season with no record still publishes its
day names and offers neither dates nor a talks calendar, which is honest
rather than a guess; when a season's meeting is announced, add its record
there and nothing else.

**A talk is a TIMED entry in the meeting's own zone, with the VTIMEZONE
written into the file.** A floating time would be wrong in the one place
the file is used: a phone imports 10:45 in Boston, flies to San Francisco,
and shows the talk three hours late. The RFC requires the zone's definition
beside its TZID, and an app that meets a bare TZID it does not know reads the
time as the reader's own; the 2026 meeting opens on the very Sunday US clocks
go back, so the rule is written out with its transitions rather than assumed
from one day's offset. The entry runs the length of a session (90 minutes)
from the start given, so whoever attends is there whichever slot the talk
takes. A day whose time is not on the profile yet is an ALL-DAY entry saying
so, so a committee still has the day blocked and the profile to come back
to. The location is the room, the venue (once, even where the room already
names it) and the city. The candidate's e-mail address is never in the
file, even where they opted to publish it on the card: the file is where and
when the talk is, and the way to reach the person stays on the site, behind
the sign-in the card is behind; the entry links the profile instead, through
the candidates list narrowed by the engine's own `c_name` key, and the CV.
The button writes what the list is SHOWING, so a committee can narrow by
research area first, and is gated like the Excel download.

Tests: `testCalendars` and `testCalendarsWiring` in `_scraper/selftest.mjs`
(the writer's escaping, folding on octets with no split surrogate, CRLF, the
all-day and timed shapes, a zone the file does not define left floating, a
junk date or a bad link refused, the VTIMEZONE's two halves; the meeting
record; the deadlines over a fixture and over the whole served file, one
entry per upcoming date, no address, every field read a published one; the
talk map's sanitising against its twin, the rules' keys, bounds and days
both ways, the ceiling; the talks over a fixture, the dedupe, the address
never read; the wiring on every page, the engine hook, both stylesheets, the
form, the FAQ, the change log, this section, and the frozen archives loading
none of it) and the calendar block of `_scraper/page-test.mjs` (signed out
no tick box and no strip; signed in a box on exactly the dated postings,
ticks surviving a repaint, a real .ics read back with exactly the ticked
postings' dates, Untick all and Tick all listed, the phone targets; the
talks calendar over a seeded candidates file, the card's talk row, the file
with its zone and TZID, narrowing by name narrowing the file, signed out the
sign-in box; and the form's block appearing with the day, feeding the
preview, and the document carrying the map).

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

### The pending card is CLAIMED, not handed out

`pending` — the id of the card whose lock was pressed, so signing in lands the
reader on the posting they pressed — is one variable in one module, and the
one-pager mounts TWO gated lists that both watch the same auth state. Consumed
unconditionally it went to whichever list `OAAccounts.onChange` notified
FIRST: press a candidate card signed out, sign in, and **the profile you
pressed stayed shut** while the jobs teaser above quietly marked a row it does
not have. On `jobs.html`, which has one gated list, the same code worked
perfectly — which is why it shipped.

So `list.open(id)` **answers whether it opened**, and only for a row this list
carries; `watch` spends the id only when a list claims it. Ownership is
membership in that list's own `rows`, not its current view — a row filtered
out is still this list's, and opening it means it is open when the filter is
cleared. A sign-OUT drops the id: one pressed in one session must not open a
card for whoever signs in next on the same machine.

Pinned twice, because the failure is an ORDERING between two listeners and a
single-list page cannot show it: a unit check in `selftest.mjs` drives two
mock lists through a fresh module instance (with a `window` in place, since
the module captures its global at load and Node has none), and
`page-test.mjs` reproduces the reader — signed out on the one-pager, press a
candidate card, sign in, the card opens.

### Nothing merely HIDDEN counts as withheld

The gate's own rule — *the values are absent, not blurred* — turned up a
second place that broke it, older than the gate: **`alerts.html` built its
example e-mail for a signed-out reader.** The whole app is `hidden` when
nobody is signed in, but `applyNewsDecisions` re-renders the preview whenever
the change-log decisions land, which is every page load — so a university, its
department, the entry level, the country and both apply-by dates sat in the
document of a reader who could not see them. Hidden is not absent, and it is
the same picture-of-a-lock the cards refuse to draw.

`renderPreview` now returns empty while `OAGate.locked()`, asked of the one
definition so the page and the cards cannot disagree about who is reading.
Nothing is lost by waiting: signing in runs `resetForm()` → `syncFormState()`
→ `renderPreview()`, and the preview is byte-for-byte what it was.

**The check that states the whole promise** is in `page-test.mjs`: for every
locked card it takes what that posting actually SAYS, from the served file,
and asserts none of it is anywhere in the card's markup. What is ALLOWED is
measured from the head itself — anything the head already displays is not a
leak — rather than from a list of field names, which would rot: `school` and
`unit` are the halves the subtitle is joined from, and `type` ("Business
School") is a substring of that subtitle by coincidence at CUHK and would not
be at the next university. It is the check a refactor could not slip past: a
hidden body, an `aria-label`, a `data-` attribute or a `title` carrying the
comments all pass every structural check and fail this one.

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

## A candidate sees how often their OWN profile was opened, and nobody else does

Owner, 2026-09-04: each candidate may see how many times their profile card
was opened on the site and how many times its CV link was clicked, this season
and in the last 7 days, computed from the usage record the site already keeps
and shown to that candidate alone.

    assets/oa-usage.js                    a click inside a card now says WHICH card (c) and whether it OPENED it (o)
    _scraper/build-candidate-stats.mjs    tally the season per profile, stamp it onto the document (pure core + Admin SDK)
    .github/workflows/oa-analytics.yml    runs it daily as a second step, after the analytics build
    assets/oa-candidateform.js            the "Your profile on the site" panel, in edit mode only
    account.html / assets/oa-submissions.js   the season totals on the personal-area card and the maintainer's inbox card

**The attribution rule is in the record, not guessed afterwards.** The list
engine gives every card the element id `job-<row id>` (candidates included),
so `oa-usage.js` carries that id on any click that lands inside a card as `c`,
and sets `o: 1` when the click OPENED the card: the head button, on a card the
reader may read (never the blurred locked one, whose press only offers the
sign-in box), and not already expanded (the same button closes it). It reads
that state in the capture phase, before the engine's own handler flips it. A
CV click is an `a` whose href IS the profile's `cvUrl`, or a link inside the
card whose label reads CV. Both ride inside the `clicks` list the rules already
bound at 400 small maps, so **no rules change was needed for the record** and
no new top-level field joined the session document.

**Which card is theirs is decided the way the site decided it.**
`cardsFor()` derives every live document's id through the model,
`rowFromCandidateSubmission` and `assignCandidateIds` keyed on the document id,
exactly as `build-candidates.mjs` does, so two people sharing a name in one
season take the same `-2` here as on the page. And the SERVED file is asked
first, by `ref`, the key that identifies a submission rather than a name and a
year (the `matchServed` lesson). A card the served file does not carry was
never on the site, so nothing is counted for it; a derived id the served file
holds under ANOTHER submission's ref is "not sure", which means count nothing.
That is also what makes the reveal gate honest: before the reveal day the
served file is empty, nothing is counted, and the owner's panel says the
profile is not public yet rather than showing a zero that reads as "nobody is
interested".

**Whose clicks do not count.** Sessions filed under the profile's own account
(its `uid`, and the `mergedFrom` uid) and the maintainer's, by the admin
address a signed-in session carries (`ADMIN_EMAILS`, pinned to `isAdmin()` in
the rules). Anonymous sessions count: a reader who has not signed in still
opened the card. The window is the season, from `marketStart(now)`, capped at
the analytics build's own 50,000-document read and reported when hit; the
per-day map keeps the newest 120 days (`DAY_CAP`), the totals are not capped.

**Why it lives on the candidate's own document.** The owner can already read
that one document and nobody else can, so a bounded `stats` map there
(`{opens, cvClicks, days: {YYYY-MM-DD: [opens, cv]}, updatedAt}`) needs no new
collection, no new read rule and no served file: nothing under `data/`, which
Pages hands to anyone who asks, and these figures are one person's. The rules
let an owner CARRY the map and never write it: `statsUntouched()` requires the
merged document's `stats` to equal the stored one on the owner's
correct-and-withdraw update, and a new profile may not arrive with one. That
is the sync-user-directory trap answered rather than avoided: an Admin-SDK
key on a document whose owner update sends the merged document back must be
allowed through unchanged, or the first count would freeze the profile against
its own owner. `candidateSubmissions` still has no `keys().hasOnly()`, which
the selftest pins beside the new function.

**A stamp lands only on a document the build has marked `published`.**
`publishOnCandidateChange` rings the build on the client-left states (queued,
withdrawn, hidden) and ignores that one, so a daily bookkeeping write rings
nothing; a profile mid-edit is counted on the next run. The step is
`continue-on-error` in `oa-analytics.yml`, so a failure here never holds the
analytics figures back from their commit. It is NOT in `build-all.mjs`'s
`BUILDERS`, because it writes no `data/` file; the "every builder has a
caller" guard is satisfied by the workflow naming it.

Disclosed in the Privacy Policy's usage paragraph and announced in
`changelog.json`.

Tests: `testCandidateStats` in `_scraper/selftest.mjs` (the builder's own
offline suite driven in-process, the id through the model with the collision
the site resolves, the owner and maintainer exclusions, what the usage record
carries and that no new top-level field joined it, the rules both ways, the
workflow step and its `continue-on-error`, that the builder writes no file,
the surfaces, the disclosure and the announcement) and the candidate block in
`_scraper/page-test.mjs` (the panel before the reveal naming the day, after it
with the season and 7-day figures, a hostile value rendered as 0 and never as
markup, and the personal-area card's totals), plus
`node _scraper/build-candidate-stats.mjs --selftest`.

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

**IT WAS INERT UNTIL `recordVisit` WAS DEPLOYED — done on 2026-08-30, so the
measurement is LIVE.** The three instant-publish doorbells went live on
2026-08-27 (see "An approved posting is on the maintainer's jobs page at
once"); this function did not ride along, and until its own deploy the ping
failed silently, the collection stayed empty, the builder logged
`visits: universityVisits is empty`, and the page drew no figure rather than
an empty one — the undeployed-doorbell trap wearing the chart's clothes. What
ended it was the owner's `firebase deploy --only functions --project
operations-academia` from a PULLED checkout:
`functions[recordVisit(us-central1)] Successful create operation.`, FOUR
functions in the list, at the exact URL `assets/oa-visit.js` pings (a
later deploy may print the service's own `run.app` address instead —
same function, and the classic `cloudfunctions.net` form stays valid). The
collection fills from real traffic from that moment, and the daily build
publishes the figure once it holds a day.

**AND A DEPLOY FROM A STALE CHECKOUT LOOKS EXACTLY LIKE A SUCCESSFUL ONE**
(owner, 2026-08-30). The first attempt ran `firebase deploy --only functions`
from a working copy that predated the merge, and printed **`Deploy complete!`**
over a list of THREE functions — the three doorbells, each "Skipped (No changes
detected)". `recordVisit` was not deployed, not skipped, and not mentioned: the
CLI discovers functions by LOADING the local `index.js`, so a checkout without
the code has nothing to find and nothing to say about it. **The count is the
only signal there is — four functions, or something is wrong.**

`npm install --prefix _functions` is part of the ritual for the same reason and
is not optional: `firebase-admin` arrived WITH `recordVisit`, and the CLI's own
load of `index.js` throws on a `require` it cannot resolve. So the sequence is
`git pull` → `npm install --prefix _functions` → deploy, and the deploy is read
rather than glanced at.

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

### How the community has grown, and what the dashed line is

Owner, 2026-09-05: a chart of registered users over time, with the growth one
would expect from the recent trend. The figure, **How the community has
grown**, sits under the daily visitors chart and is drawn from
`data/users-growth.json`, the roster sync's second served file (one cumulative
point per UTC day, counts and dates only, the same read that writes the front
page's count). It is DRAWN ONLY WHEN THE FILE HOLDS SOMETHING, the page's rule
for every figure: the committed seed carries no days, and its absence is
silent. It is fetched separately with `cache: 'no-cache'`, so a failure costs
the one figure and nothing else, and the page draws again if the file lands
after `analytics.json` did.

**The dashed yellow line is ONE pure function, `growthProjection(days,
{window, ahead, today})` in `assets/oa-analytics-model.js`**, so the caption,
the chart and the selftest cannot disagree about what "expected growth" means:
a least-squares straight line fitted over the last 90 actual points (the whole
record when shorter), whose SLOPE is kept and whose intercept is not, carried
**seven days** forward THROUGH THE LAST ACTUAL POINT so the two lines meet.
**A week and no further** (owner, 2026-09-05: "do not expand that yellow line
beyond a week from where we are now"): the first version carried it 180 days,
and a six-month straight line over a record three weeks old read as a forecast
of a thousand members, a claim the page cannot make. The model's own default
is the same week, and the selftest pins both. Fitting
the intercept too would start the dashed line above or below the real count on
the day it takes over, a disagreement about a number both sides know. The
count never falls, so a negative slope is clamped and no projected value is
below the last actual one; it refuses fewer than two points; it reads no
clock, `today` being the anchor of the horizon and nothing else (a reader with
a stale copy still gets the week from today); and it is pinned on a synthetic
straight line, on a plateau and on a falling series. The two constants live
in `oa-analytics.js` as `GROWTH_WINDOW`/`GROWTH_AHEAD` and the caption is BUILT
from the window constant and from the RESULT, so the words under the chart
cannot promise a window the model did not use or a horizon it did not draw. The
caption says exactly what the line is ("a straight-line trend fitted over the
last 90 days and carried N days forward; an expectation from past growth,
not a target") and gives the count on the last day and the count the trend
reaches.
N is the days between the last real point and the horizon, read off the
projection: 7 on the fresh copy the daily sync writes, and more on a stale
one, because the model carries the line to seven days after TODAY and a fixed
"7" would then understate the line drawn above it (the page-test fixture,
whose last day is fixed, is exactly that stale copy, and it asserts the number
against today). **The wash under the count ends where the count ends.**
`line()` closes an area series at its last REAL point rather than the last
index of its values; the growth chart is the first caller whose area series
carries trailing nulls (every projected day), and before that the brand wash
ran on under the dashed projection to the horizon in the colour that means
measured data. `page-test.mjs` reads the three paths back and pins that the
wash's furthest x is the count's last x.

**The line is the chart accent, dashed, and never `--gold` directly.**
`--oa-chart-accent` is the token re-stepped in the dark theme so two overlaid
lines stay tellable apart (the daily chart's own reason), and `page-test.mjs`
measures the two strokes from what the browser paints in BOTH themes. The
legend is the existing click-to-hide control, and the numbers table lists one
row per month (the last real count in it and the last expected one) through a
new generic `opts.table` override on `line()` in `oa-charts.js`, because a
record that grows by a day for ever would print a thousand rows under itself.
The growth figure is deliberately NOT a `DIMENSIONS` entry: it is not a
`breakdowns` record of `analytics.json`, and the pin that reads that table
against `BREAKDOWN_IDS` both ways must stay exact. The current count and the
count reached go in the CAPTION, never a sixth tile (the strip caps at five).

### Two figures that are each OPTIONAL cannot promise each other

Both of these shipped in the merge that brought the universities figure back
beside PR #109's five GA4 ones, both survived a green suite, and both live in
exactly one combination of the data — which is the whole lesson: a page
assembled from independently-gated figures has a state space, and a fixture
carrying half the data cannot reach most of it.

**A caption that names another figure is a promise the page may break.**
"Where readers are" is drawn when GA4 answers; "Which universities visited" is
drawn when the site's own resolver has data. On THIS installation today the
first is configured and the second is not deployed — so the countries caption
said "the coarser companion to *Which universities visited* below" directly
above the page's own note listing that figure under **Not on this page yet**
(that note has since been removed — see below — but the rule it exposed stands:
a caption may not name a figure the page might not draw).
Neither caption names the other now. Each describes itself, which is the only
formulation true under all four combinations.

**And the tile strip caps at FIVE.** #109 measured that a sixth orphans onto a
row of its own and folded the length and the depth of a visit into one tile to
stay at five; the merge then left "Universities seen" in, which is the sixth
the moment both are present — measured 6 tiles over 2 rows with **one alone on
the second** at 1400px, 1180px and 1024px. The count moved into the
universities figure's own caption, where a fact about ONE figure belongs.

**The guards for both had to be re-read with comments stripped**, because each
block now EXPLAINS the defect it no longer has — the trap this file already
records for the analytics page's "no iframes" check, walked into twice on the
very checks that removed these. And the browser half drives the two states no
other fixture reaches: **every source answering at once** (three widths, the
strip asserted never to end with a lone tile — geometry, not a count, so it
holds whatever the tiles become) and **one figure present with the other
absent** (a drawn figure never points at one the same page lists as missing).

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

**A FIGURE NO SOURCE HAS ANSWERED FOR IS NOT DRAWN, and its absence is
SILENT.** It appears on its own once the figures exist. A heading over an
empty axis is precisely the shape of the defect this whole page is a rebuild
of. The missing figures used to be NAMED at the foot, in a "Where these
figures come from" note that also described the sources, the cookieless
trade-off and the admin-area exclusion — the owner had that whole section
removed (2026-08-30: "we shouldn't tell that private information to the
users"), and the page's own comment records the removal so the guard against
it cannot be satisfied by deleting the explanation. What the note carried for
READERS is not lost: the per-figure "Measured by … · span" lines stay, being
about the numbers rather than the plumbing, and `_SETUP-ANALYTICS.md` holds
the plumbing.

(The reader-facing half — the cookieless posture and what it costs — was
already in the Privacy Policy, which is its proper home and where the selftest
pins it.)

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

### The charts fit the screen they are read on, and the numbers were audited

Owner, 2026-08-30: *"check the numbers of any figures and make sure they are
optimized for mobiles and small screens. they appear somewhat stretched right
now."* Both halves were real.

**The stretch was one attribute.** Every SVG chart drew into a fixed
`viewBox="0 0 900 H"` with `preserveAspectRatio: 'none'`, so the drawing was
scaled NON-UNIFORMLY into whatever box it landed in — measured scaleX 0.28 at
a 320px viewport, 0.36 at 390px, 1.13 at 1180px, against scaleY always 1.
Every glyph, marker circle, corner radius and vertical stroke was distorted by
that ratio at every width; no width was ever right. The fix is to **draw at
the size the chart is shown at** (`plotWidth`/`plotHeight` in oa-charts.js:
one user unit = one CSS pixel, height following the width down on a phone),
with ONE debounced resize listener in oa-analytics.js redrawing through the
same `draw()` everything else uses — no observer per chart to leak, and a
resize that changed only the height (a phone's URL bar, on every scroll)
redraws nothing. What a narrow plot gives up it gives up honestly: axis
labels THIN to every Nth (the 24-hour clock reads 00 03 06 … at 390px) while
every bucket keeps its bar, tooltip, focus stop and table row; and a tap is
the phone's hover — pointerdown shows the same tooltip everywhere, without
preventDefault so a swipe still scrolls.

**The numbers audit found twelve defects; every one reproduced and every one
is fixed.** The worth-remembering ones: `compact()` printed "1000.0K" for
999,999 and "10.0K" for 9,990; both axes drew gridlines at exact fractions of
the top and rounded only the LABEL, so a top of 2.5 read 0 1 2 3 over lines
at 0.83 and 1.67 (`tickVal` now settles each tick's VALUE first and draws the
line AT it); the weekday/season bars carry one-decimal means but printed
integers, so two visibly different bars could carry the same number; `bars()`
invented a share denominator by summing the rows it displayed, so the
most-visited-pages leader was a "share of the whole" measured against 25 rows
(a share now needs a stated whole — `pagesWindow.views`, the window's entire
pageview count, from the builder); a share bar's unlisted tail was an
unexplained blank (now a muted, named "Everything else" part); a 1.5%
bar-length floor drew small rows up to 15x their true length (a 2px CSS
min-width now); the ranges sliced the last N ROWS rather than N calendar
days, and the daily line ran index-spaced straight through any gap (nulls now
break the line, and `rollingMean` refuses a window with a hole in it).

**Three were about what a label CLAIMED.** The daily chart offered a "Visits"
metric that, for every day the first-party record owns, is the Pageviews
series under a wrong name — the record files one document per page opened, so
its session count IS its pageview count; the metric is gone (the file keeps
all three day fields — the format is not the interface). The "Typical visit"
tile claimed pages-per-visit from the same record, where it is identically 1
by construction — it reads "Time on a page" for the usage source, and only a
source that can measure a visit (GA4) gets the visit framing. And the
headline Visitors tile now says "counted per day": the file has no cross-day
identity, so the total is per-day uniques summed, and a reader returning on
ten days counts ten times.

Tests: the axis/scale/format pins in `testAnalytics`, and in `page-test.mjs`
the scales measured at 1180 AND 390 (|scale−1| < 0.02 on both axes), zero
overlapping axis labels on a phone, the legend switches at 42px, a viewport
change redrawn at the new width, the "Everything else" part drawn, named and
filling its bar, and the retitled tile.

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
the same reasoning that kept `repository_dispatch: [oa-jobs-changed]` in
place through the months the functions were undeployed — and that trigger is
the live instant path now that they are.

## The 2026-09-04 review sweep — what ten reviewers found, and what changed

Ten independent reviews of the live site (home/nav, jobs page, forms, accounts,
archives, admin area, pipeline, mailers/workflows, candidates, security) were
run against this tree on 2026-09-04 and the confirmed defects fixed in one
change. The load-bearing decisions, so the next reader does not undo them:

* **`str()` in `_firestore.rules` accepts NULL.** The builds clear a filed
  upload's landing-strip fields (`adUploadPath`, `cvUploadPath`, …) by writing
  `null`, and on an update `request.resource.data` is the MERGED document, so
  `null is string` refused every later OWNER write: a poster who had uploaded
  an advert could never edit or take down that posting again (verified in the
  emulator). Null now reads as "cleared". Beside it, `directoryEdits` lets any
  signed-in account carry an UNCHANGED `hidden` — a row the maintainer had
  restored kept `hidden: false` on the document, and every later merge from an
  ordinary account then failed the admin-only test.
* **A review decision REPLACES `edits`** (`writeDecision` in
  `oa-jobreview.js`, `mergeFields`): `set(…, {merge:true})` deep-merges a map,
  so a field changed and then typed BACK to the sheet's value — which
  `readEdits` therefore omits — survived in Firestore and was re-applied at
  publish while the card said "Saved." `_fake-firebase.js` now deep-merges the
  way the SDK does, or the browser check could not see it. **Approve-all acts
  on `state.crawled`, never on the arrays captured at render**: a card decided
  singly since the render was still in them, and a REJECTED posting was
  flipped to approved.
* **The approved-queue read in `build-jobs.mjs` is bounded by the last sheet
  read.** An approved document whose row `data/jobmarket.json` does not carry
  is published from its snapshot only while the approval is NEWER than that
  file's `generated` (15-minute margin for a read that began first); older, the
  workbook has dropped the row and "what the workbook keeps is existence"
  applies (UCL and ESSEC were served for a week after their rows had gone).
  And **an unreadable `jobmarket.json` is ABSENT, not empty** — present but
  unparsable used to take every workbook posting off the site in one build.
  `publishedId` is stamped from the FINAL rows, since `uniqueIds` renames a
  same-day collision by returning a new object. `transferUploads` (both
  builds) RETURNS what it wrote so the same build publishes the link.
* **The alerts mailer freezes `lastJobAt` at `since`** on every patch that can
  advance `lastSentAt` without carrying a posting: `since` fell back to
  `lastSentAt`, which an update-only digest advanced past a posting approved
  minutes earlier — the same loss `lastJobAt` was written to end.
  **`_mail.mjs` prints a REDACTED `To:`** and the submissions/feedback dry
  runs print ids and subjects, never bodies: with SMTP unset the alerts mailer
  IS a dry run, hourly, into a public Actions log.
* **The analytics pages list belongs to ONE source** — the one whose window it
  prints. Every source used to add rows: GA4's ninety days landed a dozen old-
  site click events (`/logoHeader.html`, a 404) and redirect stubs under the
  usage fortnight's heading, shares summing past 100%. `normPath` also drops a
  backslash whole (`/\evil.com` resolves off-site, and the list links its
  rows). The hours chart says "Page opens" for the usage source, whose sessions
  are pages.
* **The header, keyboard and nav.** `.v3-sheet` is `visibility: hidden` while
  closed and `display: none` above the burger's breakpoint — a transform alone
  left eleven off-screen links in every page's tab order; the burger moves
  focus in and back and the sheet is a `dialog`; in-page links (the skip link
  included) FOCUS their target; every page carries a skip link and
  `aria-current`; the account chip's NAME hides up to 1180px, where the fixed
  header was wider than the viewport and hid the chip. `Jobs` in the nav points
  at `jobs.html` on every page (nine form/account pages sent it to the home
  teaser). `oa-list.js`'s `rerender()` is a no-op until the data has landed —
  the gate and the edit layer re-render on the auth event, which fires
  synchronously on a warm session, and painted "No job postings are listed"
  over the loading state; and `todayISO()` is UTC, the pipeline's clock.
* **Copy that promised what the site does not do**: "one-click unsubscribe"
  (there is no endpoint; every message carries an unsubscribe LINK), "My
  postings" listing profiles and placements (it lists job postings), a
  candidate profile "on the candidates page within an hour" while the reveal
  gate holds it, "within an hour" for a job posting (minutes), a FAQ example
  season hard-coded to 2026. The three sign-in-only shells left the sitemap.
* `MEX` joined the country aliases (ISO-3 codes, with the served rows healed
  once by hand — the usual alias discipline). The placement form no longer
  offers a season that has not started.

**Reported, deliberately NOT changed here — the owner's calls:** e-mail alerts
can be pointed at any address and the `feedback` receipt goes to an unverified
one (a working relay from the site's SMTP identity; pinning the recipient to
the account's own address, or App Check, is a product decision); the
`deadlineDay` day/month swap manufactures a future date for a closed search
entered after the fact; the account-merge hand-over lets a poster assign a
submission to any uid; `usageSessions` is unauthenticated and unbounded; the
merge re-authentication asks for the password in a `window.prompt`;
"University of Leeds, UK" is served as an institution with an empty country
(an alias moves its id, which is the join key to the queue); the archive lists
the same San Diego advertisement under two seasons; JobPosting structured data
is only viable if the gated fields are shown to crawlers.

**Running the browser suite locally**: `node_modules` may be a SYMLINK to a
global install that holds `playwright` (`ln -s /opt/node22/lib/node_modules
node_modules`) — `.gitignore` names the bare form for exactly this reason.

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

**Both name fields are MANDATORY on a new posting, and a school that repeats
the university is no school** (owner, 2026-09-02). The form used to accept a
posting with either a school or a department; it asks for both now, on a NEW
posting only. An edit keeps the older either-or rule, the same exemption every
other new-posting-only field on the form carries (`EDIT_ID` in `collect()`, the
`oa-req-new` marks lifted by `enterEditMode()`), because a posting that
predates the rule must stay correctable. A place with no separate school,
INSEAD or IE Business School, answers by repeating the institution's name in
the School box, and that name must not publish twice ("INSEAD, INSEAD,
Decision Sciences"). `schoolRepeatsInstitution` in `assets/oa-schools.js` is
the ONE rule: a LITERAL repeat with case, accents, punctuation, a leading "The"
and a trailing acronym folded, never the alias-aware `institutionKey`, which
reads "ESSEC Business School" as ESSEC itself and would fold away a real
school. `assemble()` applies it as the LAST word of every canon path
(`canonColumns` and `canonPlace` alike), after the curated `UNIT_HOME` fill
that can put a university's own name back as its school (ETH Zurich's seed
row), so a second pass changes nothing. That is what makes it one rule: the
form's own preview, the review card's `settlePlace`, `rowFromSubmission`,
`healPlace`, the sheet ingest and the directory build all fold it the same way,
and the picker's settle-on-blur keeps the typed repeat in the box, or the
mandatory check would refuse a moment later what the hint had just asked for.
Measured over the served data it reached three seed rows and one archived
posting (Indian School of Business, healed with `--heal-names`;
`directory.json` and `vocab.json` rebuilt) and moved no posting's id, which is
built from the institution alone. Pinned in `testMandatoryPostingFields`; the
browser half, the refusal with an error on each of the six, the preview naming
the fold, the box keeping the repeat on blur, and the stored `school` empty
with the line said once, is in `page-test.mjs`.

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
real cost. Three rules keep it cheap, and `testAccountCounts` pins all four
(the fourth is below):

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

### …and a row is drawn only for what the account holds

Owner, 2026-09-04: *"my job postings should appear in the account menu of a
user who has posted, otherwise it shouldn't show it there"*, and a **My
candidate profile** row *"only for those users who posted a candidate
profile"*. So the fourth rule: **"My postings" is listed only for an account
that has made a job posting, "My candidate profile" only for one that has
filed a profile, and an account holding neither sees neither row.** E-mail
alerts, Messages, My personal area and the maintainer's Admin area are
untouched; the phone sheet follows the same rule.

* **The count decides the row, under the badge's own rule.** A third cached
  count, `cands`, joins `postings` and `alerts` in the same once-per-session
  `count()` refresh — `candidateSubmissions where uid == me`, the query the
  candidate form's one-profile check and `account.html` already issue and the
  rules already allow the owner. **Nothing is excluded by status**: a
  withdrawn profile still exists and is its owner's to restore, so it earns
  the row. The rows carry `data-held` and are BORN HIDDEN in the markup;
  `paintCounts` — the one function that knows the numbers — reveals a row
  exactly when it would show its badge (known, and more than zero). One
  function on purpose: a row and its badge cannot disagree about whether
  there is anything there, and every path that already repainted badges
  (the deferred repaint after `paint()`, `setCount`, the refresh) now reveals
  the rows too, so a row appears the moment its count becomes known.
* **A count NOT KNOWN draws neither row.** Never a row that may be wrong: the
  refresh lands within a second on the first page of a session, and every
  later page paints the final form from the cache before that. The browser
  check reproduces the state (no cache, session latch set) and asserts the
  poster's own "My postings" is withheld.
* **The candidate form is the third exact-where-loaded source.** Its
  one-profile query returns every profile the account holds, so it calls
  `OAAccounts.setCount('cands', snap.size)`; a successful CREATE adds one, so
  the row appears from that moment rather than the next session; an edit or
  a take-down changes nothing, because the profile still exists.
  `account.html` holds all three lists and corrects all three counts.
* **The row links `post-a-candidate.html`**, which sends an owner straight to
  their own profile (`redirectToOwnProfile`) — a `count()` aggregate could not
  hand the menu a document id anyway. The personal area's card, which DOES
  read the documents, links straight to `?edit=<newest profile>` and reads
  "Your candidate profile"; newest overall is the current season's where one
  exists, because `createdAt` is set once and a new profile takes the season
  under way. **A profile from a PAST season is not redirected to** — one
  profile per market year means the form is the right page for this season —
  **but it is named**: the count has no year filter, so an account whose only
  profile is last spring's sees "My candidate profile 1", and a blank create
  form that mentioned no profile would read as the row lying (every candidate
  who filed in spring 2026 was in that state on 2026-09-05). So when no
  current-season profile is found and the snapshot holds older ones, the
  newest of them is named above the form with a link to open it, and the form
  below stays the way to file for the season under way. `say()` takes a DOM
  node for it — the message carries a link, and `textContent` is what keeps
  every other message inert.

Tests: the rule-4 block of `testAccountCounts` in `_scraper/selftest.mjs`
(both menus carry both rows born hidden, the painter reveals them under the
badge's own rule, the refresh counts by uid with no status filter, the form
and the personal area correct the cache) and the "held rows" block in
`_scraper/page-test.mjs` (three seeded accounts through the shim: neither row,
My postings with its count, My candidate profile for a WITHDRAWN profile with
its count, the phone sheet mirroring each, the not-known state withholding the
poster's own row, a last-season profile named above the create form with a
link rather than redirected to or passed over, and the personal area's card linking straight to the
profile).

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

**…and the menu button, with the sheet it opens, sits on the LEFT** (owner,
2026-08-31: "this button and list of links it opens should appear on the left
of the screen (whereas currently is shown on the right)"). The burger is the
FIRST child of `.v3-header-inner` on every live page — on a phone the row
reads burger · lockup · actions, and on desktop it is `display: none`, so its
place in the DOM costs nothing there — and `.v3-sheet` is anchored `left: 0`,
sliding in from the left (`translateX(-102%)`, with `border-right` taking the
border that faced the page). The `/v1/` and `/v2/` archives are untouched —
each keeps its own frozen navigation, by the rule the three trees are held
to. **Becoming a direct flex child cost the burger its size**, the one thing
the position pins cannot see: with default `flex-shrink` the row's tightness
shaved the 42px touch target to 32px at a 320px viewport, so `.v3-burger` is
`flex: none` — the logo's `min-width: 0` stays the thing that gives — and the
phone-header block pins the WIDTH beside the position. It pins the rest of
the new geometry too: the burger LEFT of the lockup at the screen's left
edge, the opened sheet measured at left = 0 with the right of the screen
left to the page — and the clash check rewritten as an
order-independent horizontal OVERLAP, because the old "the words end before
the burger begins" encoded which SIDE the button sat on and would have to be
rewritten again the next time the row moved; the geometry it protects
(nothing runs into anything) does not.

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
    node _scraper/sync-user-directory.mjs --selftest   # the roster row, the two
                                    # served files, and that its scan prints
                                    # ids and redacted addresses only (also
                                    # spawned by selftest.mjs, so a PR check
                                    # sees it, not only the daily writer)
    node _scraper/verify-existing-users.mjs --selftest # the campaign mailer: who
                                    # is written to, the member variant, the
                                    # once-only mark (also spawned by selftest.mjs)
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
