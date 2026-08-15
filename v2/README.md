# Operations Academia v2 — preview

A rebuild of operationsacademia.org that removes the paid **Awesome Tables**
vendor, the Google Forms and the Google Sheets from the path, and replaces them
with the site's own form, its own data files in this repository, and its own
renderer — the architecture used by [stouras.com/lit](https://www.stouras.com/lit/).

Everything here is served under `/v2/` and is marked `noindex`. **Nothing in the
live site is changed.** The cutover is described in `_PLAN.md`.

| | |
|---|---|
| `jobs.html` | the job postings page — replaces the Awesome Table view `-O_tq18fckswU28d7JCQ` |
| `post-a-job.html` | the submission form — replaces the Google Form |
| `data/jobs.json` | the postings, committed to this repo |
| `assets/oa-list.*` | the filter + card renderer (dataset-generic) |
| `assets/oa-firebase.js` | one place for the Firebase config; **inert until filled in** |
| `_scraper/` | the scripts a GitHub Action runs to keep `data/` up to date |
| `_PLAN.md` | what is done, what is left, and how to cut over |

Run it locally with any static server from the repository root:

    python3 -m http.server 8899
    # then open http://127.0.0.1:8899/v2/jobs.html
