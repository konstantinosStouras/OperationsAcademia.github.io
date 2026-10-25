# University map maintenance

The directory build assigns every posting a location route using
`assets/oa-map-routing.js`. Exact reviewed rows and department aliases take
precedence. A new department at a known school reuses that school's physical
card and keeps its own department name. This is a school location reference,
not a claim that its department office was separately verified. Unknown or
ambiguous schools retain their existing fallback; they do not borrow another
school's office. Multiple eligible campuses remain selectable.

`data/school-map-locations.json` retains the full official address evidence.
`data/map-card-groups.json` contains reviewed school aliases and grouping rules.
Departments sharing a physical school card keep their own search aliases,
source rows, links and location evidence. Separate schools do not merge solely
because their coordinates are close. Manual directory corrections take
precedence over inferred routing.

`data/map-department-links.json` holds reviewed department and faculty links.
The directory builder also fills missing links from an unambiguous equivalent
department. It never borrows another department's links merely because they
share a school card. Add official corrections here instead of editing the
generated directory.

After source changes, run `node _scraper/build-directory.mjs` and
`node _scraper/build-map-data.mjs`. Both posting and affiliation publication
paths rebuild the map. The map payload omits research notes and secondary
citations, which remain in the full evidence file. Its preload and fetch URLs
must match, including their version query, to avoid duplicate downloads.

The regression checks include `map-routing-test.cjs`,
`map-new-posting-test.cjs`, `map-department-links-test.cjs`,
`map-physical-card-test.cjs`, and `university-map-test.mjs` under `_scraper/`.
The browser test checks school-specific links, mobile layout, cluster counts,
shared cards, location provenance, country filters, and address links.
