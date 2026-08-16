# /v3 — the single-page redesign preview

A TESTING copy of operationsacademia.org with a very different design, built
2026-08-16 on the owner's brief. Nothing here touches the live site; every
page carries `noindex,nofollow` until the owner promotes it.

## What it is

- **One scrolling page** (`index.html`), stouras.com-style: hero → Jobs →
  Candidates → Placements → Survey → Resources → FAQ → About → Contact.
  The top panel holds ONLY keywords — no dropdowns, no sub-menus.
- **Eased in-page travel**: clicking a nav keyword accelerates, then slows as
  the target nears, then settles (`v3.js`, `scrollToEl`) — with the target
  position re-read every frame, because the lists lazy-load and grow the page
  mid-flight.
- **A redesigned FAQ** (accordion, rewritten answers).
- **A redesigned sign-in / registration / personal area** (`oa-accounts.js`
  here + `account.html`): "Sign in" pill → brand card with sign-in ⇄ create
  account (confirm password + Terms consent), a "Your personal area" chip
  and menu, and a personal-area page a fresh registration lands on.
- **Light and dark mode**, chosen by the visitor, remembered
  (`localStorage oaV3Theme`), defaulting to the system preference.
- The six action pages (post-a-job, post-a-candidate, post-a-placement,
  my-postings, alerts, feedback) ported into the same shell.
- **Jobs are a teaser + a dedicated page** (owner, 2026-08-16, second round):
  the one-pager's Jobs section shows a compact launcher card (search + three
  selects that always SHOW their value — "All types", "All locations") and
  the TEN most recent postings; "Explore all postings" leads to `jobs.html`,
  where the full filterable list lives and **the filters unlock on sign-in**
  (the list itself stays public — the lock is a nudge, not security).

## What it reads and writes

- **Data is the LIVE site's**: the engines fetch `/data/*.json` and
  `/changelog.json` from the repository root — v3 duplicates no data, so it
  always shows exactly what the real site shows.
- **Firebase is the LIVE project**: sign-in, postings, alerts and feedback
  made here are real. That is deliberate — the preview must be testable end
  to end.

## Keep-in-sync notes

- `assets/oa-*.js|css` are VENDORED copies of `/assets/oa-*` with only these
  deliberate differences (keep the rest in sync with root):
  - `oa-list.js`: adds `urlPrefix` (several engines share one page's query
    string) and `strings` (per-dataset wording) options;
  - `oa-accounts.js`: the redesigned presentation (see its header comment);
  - `oa-jobform.js` / `oa-placementform.js` / `oa-alerts.js`: fetch
    `/data/…` and `/changelog.json` ABSOLUTE, since the pages sit in /v3/;
  - `oa-placementedit.js`: the placements Edit/Take-down hook, extracted
    verbatim from the inline block in `/placements.html`.
- The market-year rule (1 July roll, numbered by the year it ends) is inlined
  in `index.html` — keep in step with `_scraper/jobs-model.mjs`, like the
  root pages do.
- The six ported action pages were generated from their root counterparts;
  if a root form page changes materially, re-port it (the transform lives in
  the PR that created /v3).

## Promoting it later

The layout mirrors the root: promotion is the same "move up one directory"
cutover the site has done twice before (see `_PLAN.md` §5) — plus removing
the `noindex` tags and re-pointing the vendored absolute `/data/` fetches
back to relative ones if desired.
