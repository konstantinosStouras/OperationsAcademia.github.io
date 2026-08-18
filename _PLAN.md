# Rebuilding Operations Academia

> **WHERE THINGS ARE NOW (after the 2026-08-17 swap).** The **single-page
> redesign serves the ROOT**. The vendor-free rebuild this document plans —
> which was the root for one day, from the 2026-08-16 cutover — is **archived,
> working, at `/v2/`**; the 2014-2026 Awesome-Tables site stays at `/v1/`;
> `/v3/`, where the redesign was previewed, holds redirect stubs.
>
> So `v2/…` paths below mean two different things depending on when they were
> written, and both are now correct again by coincidence: they were the
> pre-cutover preview layout, and they are the archive layout. What they are
> NOT is the live site. The architecture this document describes — own forms,
> own data files, own renderer, Firestore as the submission queue, the
> workflows that write `data/` — is unchanged by either move: **the redesign
> swapped the presentation, not the pipeline.** Every engine, every workflow
> and every data file described below is still exactly what runs.
>
> The swap itself is recorded in §5 (Cutover) below.

**What this is:** the plan for replacing the paid *Awesome Tables* vendor, the
Google Forms and the Google Sheets behind operationsacademia.org with the site's
own form, its own data files, and its own renderer — the architecture used by
[stouras.com/lit](https://www.stouras.com/lit/).

It records what has been **built**, what is **left**, and how to **cut over**.
Everything built so far lives under `/v2/` and changes nothing on the live site.

---

## 0. The shape of the change, in one picture

**Today**

```
   poster ──▶ Google Form ──▶ Google Sheet ──▶ Awesome Tables ──▶ jobs.html
              (5 forms)       (6 sheets,        (paid, per-view
                               formula-driven    licence, renders
                               display tabs)     in an iframe)
```

Three parties sit between a poster and a reader, two of them commercial. If
Awesome Tables changes its pricing, its embed code, or simply stops, the pages
go blank; the data survives in the Sheet, but the site does not.

**After**

```
   poster ──▶ post-a-job.html ──▶ Firestore ──▶ GitHub Action ──▶ data/jobs.json
              (own form,          (queue,        (every 20 min,     (committed to
               sign-in)            bounded        re-validates,      this repo)
                                   rules)         idempotent)             │
                                                                          ▼
                                                            jobs.html renders it
                                                            (own JS, no vendor)
```

The only remaining third party is Firebase, and only for things that genuinely
need a server: identity, a submission queue, and a place for feedback. **The
reading path — the part every visitor uses — has no third party in it at all**
and no longer depends on anything staying online except GitHub Pages.

### Why this shape rather than a database-backed site

Because the site is, and should stay, static. A JSON file in the repository is
free to serve, free to back up, diffable in a pull request, and survives every
vendor. The cost is that a new posting appears at the next scheduled build
rather than instantly — up to 20 minutes. For a job board where deadlines are
measured in weeks, that is not a cost worth paying anything to avoid.

---

## 1. What the old stack actually was

Documented here because it is not written down anywhere else, and the migration
depends on it.

### The six Google Sheets

| Page | Sheet | ID | Rows shown | Raw responses |
|---|---|---|---|---|
| `/jobs` | **Job Postings** | `1YgTajXa5W1r4Ekm2zkFGQoQFNiE3C82l4_54aMYizok` | **80** | **129** |
| `/previous-markets` | Past job postings | `1d0_XxHBYKFEvYDQWEJzIipFmvAo5w9t4jd1hEHTgDzs` | 93 | 51 |
| `/candidates` | Candidates | `1-hpvbSnA5DDY1RhdqlBRHC1wFfLMGKtw9egzBa4NZ7A` | 104 | 104 |
| `/placements` | Confirmed Placements (Responses) | `14x2Fu_A3L_RXdMRnEbgBdSYbebaVrVdXVHMJ2EytrwQ` | 173 | 173 |
| `/recent-faculty` | Recent Faculty in Operations (Responses) | `16j0bQulL7jWIpajmVRzlJZmz6rf8k_r7z_4enfXBAuk` | 212 | 190 |
| `/universities` | List of Universities | `1aW8z50zk98vmsrt6llJySvPH2ID0s0GtT_4Xh-J0rMw` | 144 | — (map) |

> **The jobs row counts above are from the original recovery and are too low.**
> They were read through Google Drive's text rendering of the sheet, which
> **truncates large files without saying so**. An earlier draft of this plan
> concluded from them that the display tab stopped at row 80 and that *rows
> 81–129 (13 Aug → 21 Oct 2025) had never been published*. **That finding is
> withdrawn.** The scheduled sync, reading the real CSV endpoint from CI,
> returns postings the rendering never showed — including rows dated well after
> 21 Oct 2025 — so there is no evidence of a publication gap. Treat the CSV
> endpoint as the only authority on what the sheet contains; anything derived
> from the Drive rendering is a lower bound at best. The other five sheets'
> counts come from the same source and carry the same caveat.

*The live page reads "1 – 10 / 92".* That reconciles: the sync returns 102 rows
at or after market 2026, of which 7 are for later seasons the vendor page
filters out and 8 were repeat submissions of postings already in the list
(§3.3). What is left is 87, against a vendor count read at a different moment
while the sheet kept receiving. **The new list is not missing postings; it
carries slightly more.**

### How one sheet worked

"Job Postings" has three tabs:

1. **`jobsData`** — the Awesome Table *display* view. 28 columns. Row 2 is a
   **control row** of vendor keywords (`StringFilter`, `CategoryFilter -
   Hidden`, `csvFilter - Hidden`, `CardsContent`, `Hidden`) that told the vendor
   which column drives which filter. Every cell is a **formula** reading the raw
   tab.
2. An untitled tab holding the **card template** and CSS — `{{University/Institution}}`
   placeholders, the `.tg` table, `.label-primary` at `#426394` for the Featured
   badge, `#81C0F2` for the filter highlight, Roboto 400/500/700.
3. **`rawData`** — the raw Google Form responses. 19 columns, including the
   submitter's e-mail, the department chair's e-mail, and the **exact apply-by
   date** that the display tab only keeps as prose.

Three things about this are worth carrying forward as warnings:

- **The `Deadline` and `Date posted` columns were formulas**, so their values
  froze at whatever the last sheet edit computed. Every row in the current
  export reads `Older posts`, regardless of age. The rebuild derives both from
  the real dates at render time, so they are always right.
- **The display tab and the raw tab disagree** about roughly a third of the
  link fields: the display cell says `NA` where the raw response has a URL. The
  importer prefers the display tab and falls back to the raw one.
- **The raw tab carries personal data.** Any migration that copies it wholesale
  into this repository publishes ~130 people's e-mail addresses. See §6.

---

## 2. What has been built

All of it under `/v2/`, all of it working, none of it touching the live site.

### The reading path — **done**

| File | What it is |
|---|---|
| `v2/jobs.html` | the replacement for the Awesome Table view `-O_tq18fckswU28d7JCQ` |
| `v2/assets/oa-list.js` | the filter + card engine, **dataset-generic** |
| `v2/assets/oa-list.css` | the card look, matched to the vendor's own stylesheet |
| `v2/data/jobs.json` | 80 real postings |
| `v2/data/jobs-meta.json` | counts and filter vocabularies |

The renderer is deliberately generic: a page describes its dataset with a config
object (`filters`, `card.title`, `card.rows`) and the engine does the rest. That
is what makes Candidates and Placements cheap to add later — they are config,
not new code.

**It matches the old page**: the same seven filters in the same order, the same
expanding cards with the same six rows, the same Featured badge. Three
deliberate improvements:

- **Filter state is in the address bar**, so a filtered view can be bookmarked
  and shared. The vendor's tables could not do this. The legacy `?filterA=`
  links that the footer and the `Further info` column still emit are honoured.
- **Option counts cross-filter** — each value shows how many results it would
  yield given the *other* active filters, so a count is never a dead end.
- **Empty rows are dropped from a card** rather than rendered as `NA`.

### The writing path — **done, inert until Firebase is configured**

| File | What it is |
|---|---|
| `v2/post-a-job.html`, `assets/oa-jobform.js` | the replacement for the Google Form |
| `v2/_scraper/jobs-model.mjs` | **one** definition of a published row |
| `v2/_scraper/build-jobs.mjs` | Firestore → `data/jobs.json` |
| `v2/_scraper/import-sheet.mjs` | the migration: Sheet CSV → `data/jobs.json` |
| `v2/_firestore.rules` | the security rules |
| `.github/workflows/oa-jobs-build.yml` | every 20 minutes |

Two design decisions worth restating:

- **`jobs-model.mjs` is shared by the live path and the migration.** If they
  each had their own mapping, postings would render differently depending on
  when they were submitted, and nothing would fail loudly.
- **`build-jobs.mjs` writes the dataset before stamping Firestore.** A crash in
  between re-publishes the same rows next run (the merge replaces by reference,
  so it is idempotent) rather than losing a posting.

### Accounts, alerts, feedback — **done, inert until Firebase is configured**

| File | What it is |
|---|---|
| `v2/assets/oa-firebase.js` | the config, in one place; the inert-until-set gate |
| `v2/assets/oa-accounts.js` | sign in / register / account menu |
| `v2/alerts.html`, `assets/oa-alerts.js` | subscribe to postings and site changes |
| `v2/assets/oa-alert-match.js` | the matcher, **loaded by both the page and the mailer** |
| `v2/feedback.html`, `assets/oa-feedback.js` | feedback + the maintainer's inbox |
| `v2/changelog.json` | the single source for "what's new" |
| `v2/_scraper/alerts-mailer.mjs` | sends what is due |
| `v2/_scraper/feedback-mailer.mjs` | forwards feedback, applies resolutions |
| `v2/_feedback-resolutions/` | close a ticket by adding a file here |

`oa-alert-match.js` is a **dual-mode file** — a browser global and a Node
module. `/lit/` vendors a copy of its matcher into its mailer and notes "keep in
sync"; that drift would make the preview a subscriber sees disagree with the
e-mails they receive, silently. One file removes the possibility.

### Tests — **done**

| Command | Checks |
|---|---|
| `node v2/_scraper/selftest.mjs` | 1188 — the data model, the row merge, the served file, and the security rules the account merge depends on |
| `node v2/_scraper/page-test.mjs` | 70 — the page in a real browser, plus the account merge's own decisions |
| `node v2/_scraper/alerts-mailer.mjs --selftest` | 21 |
| `node v2/_scraper/feedback-mailer.mjs --selftest` | 20 |
| `node v2/_scraper/import-sheet.mjs --selftest` | 18 |

`.github/workflows/oa-checks.yml` runs all of them on every push, plus two
guards that matter for a public repository: **no e-mail address in `v2/data/`**
and **no private key anywhere under `v2/`**.

### Landmines found in the site itself

These are not v2 problems — they are properties of the existing site that will
bite anything added to it. Each is handled in v2; each is worth knowing before
you touch another page.

**The script chain is load-bearing, and Awesome Tables is the only optional
part of it.** Every page loads, in this order: `ypo-parakolouthisi.js` →
`navigationMenu.js` → jQuery → dropotron → skel → *AwesomeTableInclude* →
`util.js` → `main.js`. Nothing in the site's own CSS or JS refers to Awesome
Tables, so removing that one tag is free. Removing any of the others is not:

- **Below 840px there is no navigation without `main.js`.** `main.css` hides
  `#header-wrapper` outright at that width, and the menu exists *only* as the
  off-canvas panel `main.js` builds at runtime from `#logo` and `#nav`. I
  originally shipped the v2 pages without the chain and they had no menu at all
  on a phone. `page-test.mjs` now asserts the panel is built.
- **The shared footer calls `ga(...)` inline.** `ypo-parakolouthisi.js` defines
  that global. Without it, every footer link throws on click. The analytics
  property itself (`UA-47739718-1`) has been dead since Universal Analytics was
  retired in July 2023, but roughly 40 inline handlers still depend on the
  function existing. **Replacing it with GA4, or removing the handlers, is a
  separate decision worth making deliberately.**

**Never recompile `assets/sass/`.** It is stale template source that was never
rebuilt: `libs/_vars.scss` has empty `$palette` and `$font` maps, and
`main.scss` still says `body { color: #656b74 }` where the shipped CSS says
`#222222`. Every site-specific style — the sponsor bar, `.button.blue`, the
link colours, the footer — exists only in the compiled `assets/css/main.css`.
Recompiling would delete all of it. v2 ships a second `<link>` beside it
instead.

**`#page-wrapper` is left unclosed** on `jobs.html`, `candidates.html`,
`contact.html` and `survey.html` (19 `<div>` against 18 `</div>`), which puts
the footer inside the off-canvas transform on those pages. v2 closes it; the
live pages are still worth fixing.

### Two landmines found in the site's own CSS

Both were fixed centrally in `v2/assets/oa-ui.css`, and both will bite anything
else added to this site:

- **`main.css:1568`** applies `-webkit-appearance: none` to every `form input`,
  which collapses a checkbox to 0×0 — invisible and unclickable. The new forms
  draw their own checkboxes.
- **The CSS reset declares `section { display: block }`**, and an author rule
  beats the user agent's `[hidden] { display: none }`. A hidden `<section>`
  therefore stays visible — this was showing the maintainer's feedback inbox to
  every visitor. `[hidden] { display: none !important }` is now set once.

---

## 3. What is left

Roughly in the order I would do it.

### 3.1 Switch on Firebase — **half a day**

Follow `_SETUP-FIREBASE.md`. Nothing else can be tested until this is done.
The gate is step 4: **deploy the rules before telling anyone the site exists.**

### 3.2 Switch on e-mail — **half a day, plus DNS**

Follow `_SETUP-EMAIL.md`. The part people skip is SPF/DKIM/DMARC, and skipping
it means alert digests go to spam for most academic mail systems without anyone
being told.

### 3.3 The postings are imported on a schedule — **done**

`oa-jobs-sheet-sync.yml` reads both tabs straight from the published sheet and
merges what is missing, so the file no longer depends on a hand export.

**A correction to an earlier draft of this plan.** It said the display tab held
80 rows and that *49 submissions were never published*. Both numbers came from
reading the sheet through Google Drive's text rendering, which **truncates large
files without saying so**. The scheduled sync, reading the real CSV endpoint,
returns postings the rendering never showed. There is no evidence of a
publication gap, and the finding is withdrawn.

#### The job market year, defined once and typed nowhere

**A market year runs 1 July of the previous year to 30 June of its own, and is
numbered by the year it ends** — market 2027 is 1 Jul 2026 – 30 Jun 2027 —
matching the sheet's own *Job Market Year* column. `marketYear()` in
`jobs-model.mjs` owns it, and `MARKET_ROLL_MONTH` is the whole rule: July,
0-based 6. Everything derives from it —

| Consumer | How |
|---|---|
| scope of the sync | `marketFloor()`, no `--min-year` in the workflow |
| the page heading | the same two lines inline in `jobs.html` (no build step, so it cannot import; the selftest pins the copy to the model) |
| a submission with no year | `rowFromSubmission` |

This is the one thing that had already gone wrong: the heading was typed, the
workflow was pinned to `--min-year 2026` to agree with it, and by August 2026
both were a season behind the market that had started on 1 July.

**`MARKET_WINDOW = 2`** — the page carries the current season and the one
before. One season is what the title implies, and it was measured on
2026-08-15: it would have cut the list from 102 postings to **7**, and 38 of the
95 dropped were still live (2 open by their own deadline, 36 *until filled*).
Postings also keep ARRIVING under the previous season — the newest market-2026
row was filed 2026-07-28, six weeks after the roll — because the poster picks
that field by hand. Set it to `1` if you would rather the list match its title
exactly; it is one constant in `jobs-model.mjs`, mirrored in `jobs.html`.

Because the heading then names a season the list exceeds, the page prints a note
under it saying so.

#### Repeat submissions collapse

The Google Form has no edit step, so a poster who wanted to change something
submitted again — hence four Tulane rows for 2026-04-07 and three Hong Kong
PolyU rows for 2025-06-05, all rendered by the vendor page. `collapseSameDay()`
keeps one per (market year, institution, department, posting date). A posting
made on the site wins over an anonymous sheet row for the same job, whatever
each contains, because its author can still correct or withdraw it.

Deliberately narrow: only the SAME DAY collapses. The same school advertising
again weeks later, or in the next season, is a different posting, and telling a
re-advertisement from a correction is a judgement this cannot make. So the
spread-apart repeats — UCL across September–November 2025, Virginia across two
seasons — are left alone. Revisit if they become a nuisance.

### 3.4 Decide about the PDF uploads — **a decision, then a day if yes**

The old form uploaded a PDF to Drive; the new one asks for a link. 49 of the 80
imported postings have a PDF link and all 80 have an advertisement URL, so
nothing is lost for those — but a school with only a PDF and no public URL now
has to host it somewhere. Options, in increasing cost: leave as is; accept
Firebase Storage uploads; or accept an e-mailed PDF and upload it yourself.

### 3.5 The remaining five tables — **DONE 2026-08-16**

> **All five are now on the site's own stack, and no page loads Awesome
> Table any more.** Candidates and Placements shipped with their forms
> (above); the last three shipped together:
>
> - **Recent faculty** — `data/recent-faculty.json` (+`-meta`), rebuilt on
>   OAList with the vendor page's own four filters plus a year picker;
>   alphabetical by last name as before. The page now points reporters at
>   `post-a-placement.html` — placements is the live pipeline, this page is
>   the archive of earlier years.
> - **Past postings** — `data/past-postings.json` (+`-meta`), the jobs.json
>   row shape via the same `rowsFromSheets` the sheet sync used, so the two
>   files cannot drift. The committed archive holds every market ≤ 2025
>   (`ARCHIVE_MAX_YEAR`) from BOTH legacy sheets — the "Past job postings"
>   sheet (market 2015; the vendor page's whole content) and the "Job
>   Postings" sheet's older markets. On top of it, `previous-markets.html`
>   folds in whatever `data/jobs.json` rows have fallen out of the jobs
>   page's market window at read time, so each July the newly-past season
>   appears there by itself with nothing to re-import. (This is the "merge
>   into /jobs" decision of §4 resolved the other way round: one archive
>   page, fed by the live file.)
> - **Universities** — `data/universities.json`, and the one non-card
>   renderer: a Leaflet + OpenStreetMap map (vendored at `assets/leaflet/`,
>   engine `assets/oa-uni-map.js`), with the vendor view's search box,
>   clustered pins and per-school popup linking into the site's own pages.
>   The tile server is the only third party left in the reading path.
>
> The importer is `_scraper/import-legacy-tables.mjs` (CSV files in, or
> `--fetch` straight from the published sheets — tab discovery by header
> signature, e-mail redaction, and it refuses to write if an address slips
> through). `.github/workflows/oa-legacy-import.yml` re-runs it on demand;
> these are frozen archives, so there is no schedule. The legacy
> `?filterA=`/`?filterD=`/`?filterE=`/`?filterF=` deep links — the vendor's
> spreadsheet-column names, which the sheets and jobs.json's "Further info"
> column emit everywhere — keep selecting what they always selected, pinned
> by the selftest.
>
> One honest caveat: Google Drive's text rendering truncates large sheets
> (§1's warning), and the build sandbox cannot reach the CSV endpoints, so
> the first committed archive was cut from partial renderings. The import
> workflow re-reads every tab from the real endpoints on the runners and
> commits any rows the renderings hid — run it once after merging (it also
> fires itself when the importer changes).

The original estimate, kept for the record:

The engine is generic, so each is mostly configuration plus a form:

| Page | Extra work beyond config |
|---|---|
| **Placements** | almost none — few columns, low volume. Do this one first to prove the pattern generalises. |
| **Recent faculty** | almost none. |
| **Past postings** | none at all: it is the same row shape as jobs, filtered by year. Consider merging it into `/jobs` behind a "Job market year" filter rather than keeping a second page. |
| **Candidates** | the hard one. CV and research-statement **uploads**, plus the reveal-on-a-date behaviour (profiles held back until four weeks before INFORMS). Needs Storage, and needs a `publishAt` field the build honours. |
| **Universities** | the only one needing a non-card renderer — it is a map. Leaflet + OpenStreetMap, or keep it on the vendor until last. |

### 3.6 Cutover — **an hour** (§5)

### 3.7 Cancel the Awesome Tables subscription — **the point of all this**

Only after §5 is done and has run for a week.

---

### 3.6 The job market tracking sheet — **DONE 2026-08-17**

The postings the owner keeps by hand in a Google workbook — one per market
cycle, a tab per kind of position ("2026 Jobs", "2026 NTT/PD") — are now read
into the site daily: `_scraper/sync-jobmarket-sheet.mjs` +
`.github/workflows/oa-jobmarket-sheet.yml` → `data/jobmarket.json`, which
`build-jobs.mjs` merges beside the Firestore postings. Behaviour and setup:
`_SETUP-JOBMARKET-SHEET.md`.

**Why this is not the sync that was retired in §3.x.** `oa-jobs-sheet-sync.yml`
read the old FORM's response sheet, and it had to go because those postings had
become documents people edit — re-reading the sheet reverted their edits. This
workbook has the OPPOSITE ownership: it is where these rows are curated, nobody
edits them on the site, and following it cannot undo anyone's work. The
consequence is carried through deliberately rather than left implicit: sheet
rows are never migrated into Firestore (`migratable()`), and a row deleted from
the workbook comes off the site — otherwise the only way to unlist one would be
a hand-maintained suppression list, which rots.

Three decisions worth recording, because each could have gone the other way:

- **The market year is derived from each posting's own date**, not from the
  tab's name. A tab called "2026 Jobs" holds postings from July 2026, which
  this site files under market year 2027; deriving it means the tab naming and
  the site's roll rule can never disagree.
- **Nothing is guessed to fill a field the sheet does not have.** The type of
  institution is read off the names where they say it ("Rutgers Business
  School", "Clarkson University") and left EMPTY otherwise, rather than
  defaulted — a made-up value sits behind a filter a visitor trusts. Columns
  are matched by header alias, and a header it does not recognise is reported
  in the log rather than interpreted.
- **Going quiet is a failure mode, not a state.** A sheet that stops being
  updated is invisible from the site — it looks like a quiet August — so the
  sync e-mails the maintainer when the workbook gains nothing for three weeks,
  cannot be read, or reads as empty. A failed read writes NOTHING; nothing
  already published is ever removed by one.

Rolling on to next year's workbook is automatic: the intro tab's link is read
out of the sheet's HTML view (the CSV export cannot see a hyperlink), the new
workbook is recorded in `data/jobmarket-sheets.json`, and it becomes current on
EVIDENCE — once it holds a posting newer than anything in the one it replaces —
never on a date, so a workbook opened in advance and left empty cannot take the
site with it.

---

### 3.8 The posting form's three name fields cascade — **DONE 2026-08-18**

The form asks for the university, the school and the department separately
(§3.5), and each field offered a flat list of everything the site had ever
published. Two consequences, both reported from the form itself: choosing
Tulane offered *both* "A.B. Freeman School of Business" and "Freeman School of
Business" — one school, posted twice, spelled twice — and the department box
offered every department on the site rather than that school's.

The first half is `assets/oa-schools.js` (the same day, in parallel): one
spelling per place, canonicalised at every ingest. **This is the second half:
the three fields now CASCADE.** `data/vocab.json` gained a third level,
`byUniversity[uni].bySchool[school]`, and a top-level `bySchool` for the
university-not-yet-known case; `assets/oa-combo.js` gained `setScope()`, which
offers a scope under a heading ("Schools at Tulane University") while typing
still searches the whole site under a second one ("Elsewhere on the site").
The scope is a HINT: a school opening a department tomorrow must stay
postable, so nothing is ever removed from reach.

Four decisions worth recording:

1. **The vocabulary reads the Universities directory too.**
   `data/universities.json` — imported from the owner's own universities sheet
   — carries 254 curated (institution, school, department) rows, which is what
   lets the cascade work for a university that has never posted here. Directory
   rows carry NO posting count, so "4 postings" stays a count of postings, and
   they are put through `canonPlace()` inside `buildVocab` because a directory
   row has never been through an ingest. `data/past-postings.json` is
   deliberately NOT a source: its legacy rows never separated the institution
   from the school and the department, so feeding it in would put the very mess
   this ends into the university picker.
2. **The form shows what it will submit.** `oa-jobform.js` already
   canonicalised the three names into the submission; it now writes them back
   into the fields as the poster leaves them, so the preview, the posting and
   everybody else's postings agree. The one exception is a lone institution
   with no school or department yet — `canonPlace()` reads that as one of the
   archive's fused one-column values and takes it apart, which is right at
   ingest and wrong under a poster who has simply not reached the next field.
3. **A rename can move a name a saved e-mail alert was watching for.** An
   alert holds free text, not a name, so nothing can canonicalise it the way
   `canonCountry` does. The fix is on the other side: the site's own text
   search and the alert matcher now fold punctuation and read "&" as "and"
   (one rule, pinned in both files), which is strictly more forgiving and
   keeps "what I see on the site" and "what I am e-mailed" the same question.
   A fold alone rescued only the "&"-versus-"and" renames, and thirteen
   free-text alerts measured silent against the canonicalised postings — "SCM",
   "IEOR", "DADS", "Penn State", "Management Sciences Area" — so the matcher
   also tries the needle's own canonical form ("SCM" → "Supply Chain
   Management") and reads an ALL-CAPS needle as an acronym to be matched
   against the initials of the words in the field ("IEOR" finds "Industrial
   Engineering and Operations Research", whose acronym the canon dropped).
   Twelve of the thirteen are rescued. The thirteenth is "IT Management", now
   published as "Information Technology Management": no fold, canon or acronym
   reaches it, and it is recorded here rather than papered over.
4. **Grouping a university is not naming it.** The directory lists one
   university under several names ("City University of Hong Kong (CityU)"
   beside "City University of Hong Kong"), and the picker offered each as its
   own university with its own schools — so half a university's schools were
   invisible from the other half. `institutionKey()` folds a trailing acronym
   and a leading "The" for GROUPING only, and deliberately does not touch what
   is published: a posting's id and permalink are built from its institution,
   and an earlier attempt to canonicalise those renamed KAIST and Baruch and
   would have rewritten ids across the whole archive.
5. **A directory row's three names are already in three columns**, so they are
   canonicalised one by one and never through `canonPlace()`, whose job is
   taking apart a value that names more than one thing. Run over columns that
   are already separate it invents: Rutgers' campus and Clemson's college
   became departments called "Camden, Operations Management" and "Computing
   and Applied Sciences, Industrial Engineering", both of them offered by the
   form.
6. **`canonUnit()` had to become idempotent.** A department ending in its own
   acronym — "Engineering Management, Information, and Systems Department
   (EMIS)", from the directory — lost the acronym but kept the wrapper word,
   because the wrapper was only stripped while it was last. It now strips to a
   fixed point. Nothing in the postings hit it; the directory did, the first
   time anything canonicalised it.

---

## 4. Things to decide

| Question | My recommendation |
|---|---|
| Keep the Google Form running in parallel during the transition? | **Yes, for one job market year.** Two intake paths is a nuisance but a broken intake in September is worse. The v2 form links to the Google form while Firebase is unconfigured, so this is already the behaviour. |
| Auto-publish, or review? | You chose **auto-publish for signed-in users**. Worth revisiting after a term: it removes your bottleneck, but the old `OK` column was doing real work — several rows in the raw tab never made it to the display tab. |
| Keep `/previous-markets` as a separate page? | **No.** It is the same data. A "Job market year" filter on `/jobs` does the job and halves the maintenance. |
| Split the candidate form's "Current affiliation" the way the job form's three fields are split? | **Worth doing while it is free.** It is one free-text box ("Wharton, University of Pennsylvania") and `data/candidates.json` is empty today, so nothing has to be migrated; every profile posted from now on makes it more expensive, and until then a candidate's university cannot be matched to a posting's. |
| A "Featured" posting — how does one become featured? | Currently only you can set it (the rules forbid a poster from doing so). If it is ever to be sold or granted, that needs a deliberate mechanism. |
| The 49 job submissions that were never published (§1)? | **Look at them before cutover.** Some schools may believe their posting has been live for months. |
| Replace the dead Universal Analytics with GA4, or drop analytics? | **Decide deliberately.** It has measured nothing since July 2023, but ~40 inline handlers depend on the `ga` global existing, so it cannot simply be deleted without touching every page. |
| Where do the old Drive-hosted PDFs live long term? | They are Drive links inside the imported rows. They work today. If that account ever changes, ~49 links break silently. Worth a link-checker workflow. |

---

## 5. The cutover

`/v2/` mirrors the live structure one directory down, so the swap is a move.
Do it on a branch, in this order.

1. **Re-import the data** (§3.3) and confirm the count matches the live page.
2. **Move the pages up:**
   ```
   v2/jobs.html          ->  jobs.html          (replacing the Awesome Table one)
   v2/post-a-job.html    ->  post-a-job.html
   v2/alerts.html        ->  alerts.html
   v2/feedback.html      ->  feedback.html
   v2/data/              ->  data/
   v2/assets/oa-*        ->  assets/oa-*
   v2/_scraper/          ->  _scraper/
   v2/_firestore.rules   ->  _firestore.rules
   v2/changelog.json     ->  changelog.json
   v2/_feedback-resolutions/ -> _feedback-resolutions/
   ```
3. **Fix the paths.** Each moved page loses one directory level:
   - `assets/oa-*` stays relative and keeps working;
   - the workflow paths `v2/_scraper/…` and `v2/data` lose their `v2/` prefix;
   - `DATA` in `build-jobs.mjs` and `JOBS` in `page-test.mjs` lose one `..`.
4. **Delete `v2/assets/oa-nav.js`** and add the account control plus the new
   Feedback link to the real `assets/js/navigationMenu.js`.
5. **Remove `<meta name="robots" content="noindex,nofollow">`** from the four
   moved pages. This is the step that is easiest to forget and the one that
   decides whether Google ever sees the new pages.
6. **Delete the Awesome Tables script tag** from every page that no longer needs
   it. It is currently in *fifteen* pages, most of which have no table at all:
   `index.html`, `faqs.html`, `contact.html`, `directors-and-contributors.html`,
   `resources-for-candidates.html`, `terms-and-conditions.html`,
   `privacy-policy.html`, `survey.html`, `survey-faqs.html`,
   `informed_consent_statement.html`, `analytics.html`. Removing it there is
   free and speeds those pages up immediately — **do this first, independently
   of everything else.**
7. **Add the new pages to `sitemap.xml`** and check `robots.txt`.
8. **Watch for a week.** Keep the Google Form and the Sheet untouched. If
   anything is wrong, `git revert` puts the vendor page straight back.
9. **Then** cancel the Awesome Tables subscription.

### 5b. The second swap — the redesign takes the root (2026-08-17)

Done the day after the first, and worth writing down because it is the shape
every future promotion will take. The list above is a **move**; this one taught
that a move is only half of it.

1. **The archive first.** The root pages went to `/v2/` with `git mv`, so the
   history follows them. `/v2/` was holding redirect stubs from the preview
   era; they made way for the pages themselves. `_scraper/archive-v2.mjs`
   then applied the four archive rules — `noindex`, a banner with the way back,
   absolute paths to the shared substrate, and no page still claiming through
   its canonical/og:url to be the home page. It has a `--check` mode, so the
   rules are testable rather than remembered.
2. **The archive keeps its own chrome.** `v2/assets/oa-*.js|css` are copies,
   frozen at what that design shipped with, so the root is free to move on.
   `/assets/css|js|fonts|leaflet` stay at the root — `/v1/` loads them too.
3. **The promotion, choosing per file.** Four of the vendored copies under
   `v3/assets/` had drifted from the root originals, so the promotion took the
   better of each rather than the newer directory wholesale — the redesign's
   own `oa-accounts.js`/`oa-list.*`/`oa-ui.css`, but the ROOT's
   `oa-alert-match.js`, whose v3 copy predated "one spelling per country" and
   would have reinstated a bug where an alert saved under "USA" quietly stops
   matching. **Never promote an asset directory without diffing it.**
4. **Then the sweep, which is the real work.** The redesign had been *borrowing*
   ten pages from the design it replaced — Universities, Recent faculty,
   Previous job markets, the survey, the survey FAQ, analytics, the update log
   and both legal texts. After a bare move, a reader clicks a card on the new
   front page and lands in the old design. Nothing 404s, so nothing looks
   broken. All ten were rebuilt in the new design; six more pages the one-pager
   had absorbed as sections kept their decade-old addresses as redirects.
5. **`_scraper/link-check.mjs` exists because of step 4.** It resolves every
   internal link in all three trees and fails when one version navigates into
   another. It is the guard that makes a future promotion checkable instead of
   careful.
6. **The tests followed their pages.** `page-test.mjs` gained a `V2` prefix:
   the checks asserting on the old chrome now drive `/v2/`, and the ones that
   were driving `/v3/` drive the root. Nothing was dropped — the same suite,
   re-aimed. It caught a real regression on the way: the posting forms renamed
   `.title-heading h2` on entering edit mode, a selector only the old design
   has, so on the live site the page went on saying "Post a job" while the form
   held someone's existing posting.
7. **`/v3/` became stubs**, exactly as `/v2/` had been, for the links shared
   during the preview.

### Lifting `/v2/` into its own repository instead

If you would rather have a standalone repo than a subfolder:

1. Create it, and copy the contents of `v2/` to its root.
2. Delete `assets/oa-nav.js` and copy in the real `assets/`, `images/`,
   `partials/` from this repo — the v2 pages reference them at absolute paths.
3. Change the four `<link href="/assets/css/main.css">` and `/images/…`
   references if the new repo serves from a subpath.
4. Move the four workflows across and re-add the secrets — they are per
   repository.
5. Point the `CNAME` at it when you are ready.

---

## 6. Risks, and what was done about each

| Risk | Status |
|---|---|
| **Publishing personal data.** The raw form tab holds ~130 submitter and department-chair e-mail addresses; this repository is public. | Handled. `PUBLIC_FIELDS` in `jobs-model.mjs` is an allowlist, the importer refuses to write if an address slips through, and `oa-checks.yml` fails the build if one ever appears in `v2/data/`. Verified on the current 80 rows. |
| **Someone injects markup through the form.** A posting's fields are rendered into a page and into e-mails. | Handled. Links are validated to `http(s)` on write *and* on render; every e-mail escapes the values it interpolates; the type and level vocabularies are allowlists, so a forged value is dropped rather than shown. |
| **A poster promotes their own posting to Featured.** | Handled in the rules: `featured` may not appear in a created document at all. |
| **The build loses a posting.** | Handled: dataset written before Firestore is stamped, and the merge is idempotent. |
| **An SMTP failure swallows a day of alerts for everyone.** | Handled: per-alert high-water marks, advanced only on that alert's own success. |
| **The preview a subscriber sees disagrees with the e-mail they get.** | Handled: one matcher file, loaded by both. |
| **Alert e-mail goes to spam.** | **Open.** Needs SPF/DKIM/DMARC — `_SETUP-EMAIL.md` §3. This is the most likely thing to quietly not work. |
| **An unsubscribe link that does not unsubscribe.** | Handled, with a stated limit. The link carries the alert id and, when opened, pauses that alert — verified. But a subscription is private to its account, so the reader must be **signed in**; the page says so rather than pretending. `List-Unsubscribe-Post: One-Click` is deliberately **not** declared: a GitHub Pages site cannot accept the POST it promises, and declaring it would show a button in Gmail that silently does nothing. A signed-token endpoint (a Cloud Function) would remove the sign-in step. |
| **A change-log entry announced the same day as a digest reaches nobody.** | Handled. The update window is keyed on the date of the last entry sent, not on the send timestamp — comparing a calendar date against an instant silently drops same-day entries. |
| **Gmail's ~500/day send limit.** | **Open.** Fine now, not fine at scale. Move to a transactional provider before the alert list reaches a few hundred. |
| **A Drive-hosted job ad PDF disappears.** | **Open.** ~49 imported postings link to Drive. Worth a scheduled link-checker. |
| **Firestore free-tier limits.** | Low. Reads are dominated by the maintainer's inbox; the public page reads a static file and costs nothing. |
| **The 20-minute delay confuses a poster.** | Handled in copy: the confirmation says "normally within an hour". |

---

## 7. Where to look when something breaks

| Symptom | Look at |
|---|---|
| The jobs page is empty | `v2/data/jobs.json` — is it valid JSON? `node v2/_scraper/selftest.mjs` |
| A posting was submitted but never appeared | Actions → *OA jobs* run log. `node v2/_scraper/build-jobs.mjs --scan` lists what is queued |
| A posting in the tracking SHEET never appeared | Actions → *OA jobs — read the job market tracking sheet*. The log names every tab it read, every column it did not recognise and every row it stepped over. `_SETUP-JOBMARKET-SHEET.md` |
| The form says "not accepting postings yet" | the rules were not deployed — `_SETUP-FIREBASE.md` §4 |
| Sign-in does nothing | the config still has `PASTE_` in it, or the domain is not in Firebase's authorized list |
| No alert e-mails | `--scan` first: are any actually *due*? Then `--dry-run`. Then check spam. |
| Feedback arrives but no receipt | the submitter left no address, or their address bounced — the maintainer copy is sent independently and on purpose |
| The maintainer inbox is not showing | `isAdmin()` in the rules requires a **verified** e-mail address |

---

## 8. What this replaces, and what it costs

**Removed:** the Awesome Tables subscription; a Google Form and a formula-driven
Google Sheet per dataset; a third-party iframe on fifteen pages.

**Added:** a Firebase project (free tier), an SMTP mailbox (free or a few
dollars a month), and four GitHub Actions (free on a public repository).

**Kept:** everything a reader sees.
