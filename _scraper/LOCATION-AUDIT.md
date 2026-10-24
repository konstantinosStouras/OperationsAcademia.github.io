# School and department location verification

Status on 2026-10-24: **audit in progress; verified corrections are being published incrementally at the owner's request.**

The frozen baseline contains 714 university-fallback locations across 509
institutions. Source-discovery searches have been recorded for all 714 entries.
Search results and coordinate strings are candidates, not verification.

Examples of verified department locations:

- Columbia University: Decision, Risk, and Operations Division in Henry R. Kravis Hall.
- Korea Advanced Institute of Science and Technology: Department of Industrial and Systems Engineering in the Industrial and Management Building.
- Ohio State University: Department of Integrated Systems Engineering in Baker Systems Engineering Building.
- University of Houston-Downtown: two business departments in the Marilyn Davies College of Business building. The supply-chain posting label is linked to its host department.
- North Carolina State University: industrial engineering in Fitts-Woolard Hall and information technology, analytics and operations in Nelson Hall. The operations and supply-chain label is linked to its host department.
- Université Laval: operations and decision systems in Pavillon Palasis-Prince.
- University of British Columbia: operations and supply-chain faculty in the Engineering, Management and Education Building in Kelowna, correcting a Vancouver fallback pin.
- European School of Management and Technology: management science in the Schlossplatz 1 building.
- École des hautes études commerciales de Montréal: management in the Lise-et-Giuseppe-Racanelli building.
- University of Alabama: information systems, statistics and management science administration in Alston Hall.
- The University of Texas at San Antonio: operations and analytics in the Business Building.
- University of Nebraska at Omaha: nonprofit management's host, the School of Public Administration, in the College of Public Affairs and Community Service Building.

An additional existing pin, outside the baseline, is corrected for Vienna
University of Economics and Business: the official campus map locates the
department front office in D2.2.108. The previous coordinates put it in North America.

See `location-audit.json` → `summary` for current verified and remaining counts. Do not describe the source-discovery
pass as a completed location audit, or replace these entries with coordinates
found in a generic university footer.

## Evidence and continuation

- `location-audit.json` retains every baseline entry, original posting links,
  candidate source links, fetch outcomes, review notes and completion status.
- `../data/school-map-locations.json` contains only manually verified records:
  exact directory row identities, official names, building/address, coordinates,
  official address and coordinate sources, and the date checked.
- Raw discovery results and fetched candidate pages are saved locally in
  `C:/Users/LENOVO/.codex/visualizations/2026/10/23/01a167c7-010f-72a2-b7a4-9b26b843dd03/`.
  They are research material and are not published with the site.

For each remaining entry, establish the actual host department and campus from
the original posting and official department pages. Verify the named building
against a campus map or a place pin linked by the university. A map viewport
centre, parking pin, postal address or dean's office does not by itself verify a
department location. Review multi-campus and historical labels individually.

After adding evidence, run `build-directory.mjs`, `build-map-data.mjs`,
`update-location-audit.mjs`, `school-location-test.mjs` and
`university-map-test.mjs`, then the repository checks. The map tests check each
verified record's legacy link and pin as well as cluster counts and mobile views.
The owner requested real-time updates on 2026-10-24. Publish validated corrections
incrementally, check the live site after each deployment, and continue until the
full audit is complete. Pending records must retain their unverified status.
