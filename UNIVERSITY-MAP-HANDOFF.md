# University map research and publication handoff

Snapshot: 31 October 2026. Generated from the current data/directory.json. The snapshot contains **65 unresolved location rows** and **3 missing faculty rosters** (down from 110 and 3 at the start of the day). These are directory rows, not necessarily distinct universities or buildings. Recalculate after synchronizing the repository.

## Objective and authorization

Continue researching missing building locations and faculty rosters for https://www.operationsacademia.org/universities. Add only verified information, publish updates, and check the live map. The owner has explicitly authorized repository edits, publication, live verification, and Chrome research agents. Do not repeatedly ask permission for already authorized work. Follow any environment permission mechanism when needed.

## Repository and completed work

Local checkout: C:/Users/LENOVO/Documents/Codex/2026-10-30/uni/work/operations-academia

Remote: https://github.com/konstantinosStouras/OperationsAcademia.github.io.git

Branch: master. GitHub Pages serves the repository root. Other tasks publish concurrently: inspect status, fetch the latest remote before work, and check again before pushing. Never overwrite others' work or force-push.

Latest completed map update: e77eb0dcd0375a35dc7fb75adfea3e825da6ae52 (batches A to E of 31 October 2026, published together). Forty-one new location records resolved forty-five directory rows: UT Austin ORIE (Engineering Teaching Center II); Louisville Industrial Engineering (James B. Speed Building); FIU ISBA (Ryder Business Building, two rows); Miami Herbert (George W. Jenkins Building, school-building scope, two rows plus one school reference); Cornell Johnson (Sage Hall); WashU Olin SCOT AI cluster seat (Knight Hall); Fudan School of Management (Li Dasan Building, school scope); MEF University engineering (single campus building); Mannheim operations chairs (Schloss Schneckenhof Ost, three rows); IIT Bombay IEOR Building; Universidad de Chile Industrial Engineering (Beauchef 851 east tower); PUC Chile Industrial and Systems Engineering (Edificio Raúl Devés) and School of Management (Edificio Fundación); Erasmus Econometric Institute (E Building); UCLouvain CORE (Voie du Roman Pays 34); CUHK SEEM (William M. W. Mong Engineering Building); HKUST IEDA (Academic Building); SMU SCIS 1 (80 Stamford Road); KAIST College of Business (SUPEX Building, two rows); TBS Education IOMS (Sébastopol Building); Sabancı FENS Building; TOBB ETÜ main building (campus scope); Sydney Faculty of Engineering dean's office (faculty-level); Koç CASE Building; UCL GBSH Marshgate; NCCU School of Business building at 829 E. Lawson Street; UM-Dearborn Fairlane Center South; UC Merced Science and Engineering Building 2; UTDT Edificio Alcorta; SUSTech Business School Building; IE Business School María de Molina 12 (three rows, two records); and institution-level campus references for Nova SBE, Ewha School of Business, HEC Paris (Jouy-en-Josas, Bâtiment S), SUTD, Skoltech and TED University. All four local map checks and the full offline selftest passed; no faculty links were lost. Do not add these again. The earlier update 8fe2e3db57c3aa123d9305d852b416995ca15d6b (Dayton, Portland, RPI, Rutgers–Camden, Loyola Chicago, Seton Hall, Alberta, UCSD, Oxford) stands.

Read _MAP-MAINTENANCE.md and applicable AGENTS.md instructions. CLAUDE.md is very large; read relevant sections rather than dumping it. Full official school/department names and checked dates are required. Do not edit archived v1 or v2.

Git has needed the per-command option:

    git -c safe.directory=C:/Users/LENOVO/Documents/Codex/2026-10-30/uni/work/operations-academia ...

GitHub CLI authentication previously worked.

## Agent coordination

Use a primary coordinator and up to three Chrome research agents. Assign disjoint batches of exact row IDs, typically three to six schools each. Location agent A can handle North America; location agent B Europe/Asia/other regions; a third agent can check difficult evidence or faculty roster leads. Prior agent names were /root/locations_a, /root/locations_b, and /root/faculty; a new session may need new agents.

Agents should find current official university department/contact/faculty/building evidence, establish the correct building, then corroborate its named point with an official campus map, Google Maps, or OpenStreetMap. They should write separate proposal JSON arrays outside the repository, not edit shared source files or commit. The coordinator reviews proposals and merges them sequentially. Continue batches while useful verified candidates remain.

Prior research proposals are in C:/Users/LENOVO/Documents/Codex/2026-10-30/uni/work. The latest files locations-oct31-h.json, locations-oct31-i.json, locations-oct31-j.json, and locations-oct31-k.json have already been merged and published. Earlier files exist too; check record IDs before reuse. Files outside the repository may not accompany a new clone, so the committed evidence files are authoritative.

## Research standards and known difficult cases

Prefer official university sources for the department/school-to-building relationship. Coordinates must be for the corroborated named building, not a university centre, road, or map camera position. Google Maps place coordinates and named OSM building footprints are acceptable corroboration. An official building page with coordinates is especially useful. Mailing addresses may be campus-wide; record this limitation in notes. Do not rely solely on AI summaries, snippets, or a dead cached page. Preserve school, department, and campus boundaries.

Generic institution-only rows must not be arbitrarily assigned to a business school. Historical department titles may use a verified school-building reference, but do not imply a specific current department office was verified. Exact routing means a reviewed association, not surveyed coordinates. Leave ambiguity unresolved.

NCCU: the current business-school address is 829 E. Lawson Street; some map results still point to former Willis building. Do not use the old footprint for the new address.

Michigan–Dearborn: official information places business in Fairlane Center South; a reliable building point was not established. A planned move in 2027 is not its current location.

RPI: Lally School is in Pittsburgh Building, not the similarly named Lally Hall; already fixed.

Faculty rosters: never substitute a department homepage or borrow another department's roster merely because it shares a university. AASU SCM/Logistics has a verified program but no appropriate public roster found. Columbia's data-driven decision-making/optimization text is a hiring topic, not a confirmed department; the source encountered a login barrier. INSEAD HRG is a historical hidden row and its team is a cross-institution network, not a local departmental faculty roster. These three have been revisited repeatedly; prioritize new leads instead of repeating dead ends.

## Merge sources and rebuild

Authoritative building evidence: data/school-map-locations.json. Reviewed department/faculty links: data/map-department-links.json. Both use a wrapper with version and records; proposals have been plain arrays. Use the existing schema, including unique id, institution, exact rowIds, school, department, building, address, lat/lng, addressSource, coordinateSource, supportingSources, checked, and notes. Parse JSON before merging.

Faculty override matching uses actual institution/school/department identity; do not rely on rowIds for those overrides. directoryFilter provides a displayed roster scope hint; facultyLabel alone does not.

Before changes save a baseline data/directory.json outside the repository. Rebuild with:

    node _scraper/build-directory.mjs
    node _scraper/build-map-data.mjs

Generated outputs are data/directory.json and data/university-map.json; do not hand-edit them. Adding a location can alter identity resolution and remove inherited faculty links. Compare every pre-existing facultyUrl/mapDepartmentLinks against the baseline; fix or withhold any proposal causing loss. Inspect generated directory-meta.json and university-names.json changes instead of blindly committing unrelated side effects.

## Cache references

Last published map version: 20261031-directory-updates-5. Last directory version: 20261031-rosters5. Choose new unique values for the next publication. Update all six references consistently:

- universities.html map-data preload
- assets/oa-uni-map.js map-data fetch
- universities.html oa-uni-map.js script URL
- assets/oa-directory.js directory-data fetch default
- universities.html directory-data preload
- universities.html oa-directory.js script URL

Previous updates showed stale information when only data URLs changed while scripts stayed cached.

## Validation and publication

Run these checks:

    node _scraper/map-routing-test.cjs
    node _scraper/map-new-posting-test.cjs
    node _scraper/map-department-links-test.cjs
    node _scraper/map-physical-card-test.cjs

Confirm no faculty links disappeared, row associations and country/coordinates are correct, unrelated schools did not acquire the building, and unresolved counts are accurate. The broader _scraper/university-map-test.mjs previously could not run because Playwright was unavailable; do not claim it passed. Use Chrome for user-flow checks.

Check the latest remote again, incorporate concurrent changes, stage only intended source/generated/cache files, commit, and push master. Publication is authorized. Check the pages-build-deployment workflow with gh and wait for success. Do not claim the update is live before deployment and live checks.

Fetch the published /data/university-map.json with the new version and verify each new record under its verified array, including coordinates. Check directory associations too. Open representative deep links in Chrome, e.g. https://www.operationsacademia.org/universities?university=University+of+Portland . A department query parameter is also supported. Verify the address link/coordinate target, faculty link, and checked date; reload if initial HTML is cached.

Chrome screenshots were unreliable in the previous session, producing oversized black areas or failures. Accessibility snapshots did show updated cards. Do not present broken screenshots as proof. If capture works, save a useful card view.

Report what was added, how many rows were resolved, remaining counts, checks passed, and what was verified live. Do not claim all schools were researched unless they were. Record unsuccessful searches to prevent repeated dead ends.

## Research log: dead ends and near-misses (31 October 2026)

Recorded so later agents do not repeat them. The agents' full logs with every URL tried are not in the repository; the summary is:

- **NYU Shanghai, Business Area, Statistics/Operations Management**: reuse of the South Hall records needs the official faculty directory re-read (Chen Chen S810, Shukai Li S726). shanghai.nyu.edu could not be reached from the research environment (TLS failure, upstream 503); coordinates to reuse once re-verified: 31.15037, 121.4772 (OSM way 1164785875).
- **SUFE School of Information Management and Engineering**: the school has its OWN building (信息管理与工程学院) on the Wudong Road campus, shown on the official campus map image at sufe.edu.cn/dt/list.htm, south-east of the College of Business building; it is NOT the College of Business record. Neither OSM nor Google carries a point for it; a georeferenced estimate (31.30459, 121.49389, about 20 m uncertainty) was withheld. Needs a named map point (Amap or Baidu, or a new OSM footprint).
- **Fudan Management Science**: the department office is Siyuan Building Room 522 (思源楼) per the official contact directory; the record carries the school building (Li Dasan Building) because Siyuan has no map point.
- **Miami Herbert Management department**: faculty office addresses on people.miami.edu sit behind a login; the Jenkins Building record is school scope, and the department may be in the adjacent Epstein/Kosar Faculty Building. The BA: FinTech, AI, Healthcare row is a cross-department hiring topic and now resolves as a school reference only.
- **Bellarmine, Information Systems and Artificial Intelligence**: no official bellarmine.edu page names such a unit (Rubel School pages, catalog, 576-row staff directory, checked twice). The only source is a third-party Chronicle advertisement that itself calls the unit Business Technology and Artificial Intelligence, already covered by record bellarmine-rubel-mcgowan. Folding the row into that unit is a directory identity decision for the owner, not a map record.
- **Woxsen School of Business**: official pages give only the campus address; OSM has no named academic building, only a campus polygon and an Admin Area footprint.
- **SRM University, Operation and Supply Chain Management**: srmist.edu.in refused access; SRM has several campuses and no official page ties the unit to one, so the row stays unresolved.
- **UM-Dearborn**: umdearborn.edu answered 403 to every fetch; the College of Business to Fairlane Center South link rests on the owner's earlier official research plus search excerpts of the official contact page, and the point is the OSM named relation 4245890. The 2027 move is not represented.
- **KAIST**: reading office numbers S406, S410 and S206 as SUPEX rooms is an inference stated in both records; the college's own directions page names SUPEX as its main building.
- **UTDT**: the Edificio Alcorta point is an unnamed OSM footprint matched to the official campus plan; stated in the notes.
- **Generic institution-only rows** (for example Harvard, Cambridge, CMU, Columbia, HKU, NUS, NTU, Penn State, Ohio State, Minnesota, Utah, Virginia, Wisconsin, Berkeley, Georgia Tech, UCL, University of London, Imperial, Tilburg, Mannheim, IESE with Barcelona and Madrid campuses, TBS Education with four campuses, Institut Mines-Télécom, Universidad de los Andes): left unresolved on purpose. Each has several schools or campuses and the row names none, so a building cannot be assigned responsibly. Single-campus, single-school institutions were resolved today at institution level (see above).
- **Roster gaps** (AASU SCM/Logistics, Columbia hiring topic, INSEAD HRG): no new lead was found; not re-researched today.

## Full unresolved location inventory

The following list is the complete snapshot. Empty school or department values are shown as —. Retain row IDs exactly when assigning research or matching proposals.

| # | Row ID | Institution | School | Department |
|---|---|---|---|---|
| 1 | alfaisal-university | Alfaisal University (AU) | — | — |
| 2 | american-university-of-beirut | American University of Beirut | — | — |
| 3 | arizona-state-university | Arizona State University | — | — |
| 4 | auburn-university | Auburn University | — | — |
| 5 | bellarmine-university____information-systems-and-artificial-intelligence | Bellarmine University | — | Information Systems and Artificial Intelligence |
| 6 | carnegie-mellon-university | Carnegie Mellon University | — | — |
| 7 | city-university-of-hong-kong | City University of Hong Kong | — | — |
| 8 | city-university-of-new-york | City University of New York (CUNY) | — | — |
| 9 | columbia-university | Columbia University | — | — |
| 10 | columbia-university____data-driven-decision-making-optimization-under-uncertainty | Columbia University | — | data-driven decision-making, optimization under uncertainty |
| 11 | depauw-university | DePauw University | — | — |
| 12 | georgetown-university | Georgetown University | — | — |
| 13 | georgia-institute-of-technology | Georgia Institute of Technology | — | — |
| 14 | georgia-state-university | Georgia State University | — | — |
| 15 | harvard-university | Harvard University | — | — |
| 16 | ie-university____business | IE University | — | Business |
| 17 | iese | IESE | — | — |
| 18 | iese-business-school | IESE Business School | — | — |
| 19 | imperial-college-london | Imperial College London | — | — |
| 20 | indian-school-of-business | Indian School of Business | — | — |
| 21 | insead____humanitarian-research-group-hrg-social-innovation-center | INSEAD | — | Humanitarian Research Group (HRG), Social Innovation Center |
| 22 | institut-mines-telecom | Institut Mines-Télécom | — | — |
| 23 | kaist | KAIST | — | — |
| 24 | lehigh-university | Lehigh University | — | — |
| 25 | mcmaster-university | McMaster University | — | — |
| 26 | michigan-state-university | Michigan State University | — | — |
| 27 | nanyang-technological-university | Nanyang Technological University | — | — |
| 28 | national-university-of-singapore | National University of Singapore | — | — |
| 29 | new-york-university-shanghai____business-area-statistics-operations-management | New York University Shanghai | — | Business Area, Statistics/Operations Management |
| 30 | ozyegin-university | Özyeğin University | — | — |
| 31 | shanghai-university-of-finance-and-economics | Shanghai University of Finance and Economics | — | — |
| 32 | shanghai-university-of-finance-and-economics__school-of-information-management-and-engineering-sime__management-science-information-systems-financial-information | Shanghai University of Finance and Economics (SUFE) | School of Information Management and Engineering (SIME) | Management Science, Information Systems, Financial Information, and Computer Science |
| 33 | srm-university____operation-and-supply-chain-management | SRM University | — | Operation and Supply Chain Management |
| 34 | tbs-education | TBS Education | — | — |
| 35 | temple-university | Temple University | — | — |
| 36 | chinese-university-of-hong-kong-shenzhen | The Chinese University of Hong Kong, Shenzhen | — | — |
| 37 | hong-kong-polytechnic-university | The Hong Kong Polytechnic University | — | — |
| 38 | ohio-state-university | The Ohio State University | — | — |
| 39 | pennsylvania-state-university | The Pennsylvania State University | — | — |
| 40 | university-of-hong-kong | The University of Hong Kong | — | — |
| 41 | tilburg-university | Tilburg University | — | — |
| 42 | tulane-university | Tulane University | — | — |
| 43 | united-states-naval-academy | United States Naval Academy | — | — |
| 44 | universidad-de-los-andes | Universidad de los Andes | — | — |
| 45 | university-college-london | University College London | — | — |
| 46 | university-of-california-berkeley | University of California, Berkeley | — | — |
| 47 | university-of-cambridge | University of Cambridge | — | — |
| 48 | university-of-cyprus | University of Cyprus | — | — |
| 49 | university-of-houston | University of Houston | — | — |
| 50 | university-of-illinois-at-urbana-champaign | University of Illinois at Urbana-Champaign | — | — |
| 51 | university-of-london | University of London | — | — |
| 52 | university-of-mannheim | University of Mannheim | — | — |
| 53 | university-of-miami | University of Miami | — | — |
| 54 | university-of-minnesota | University of Minnesota | — | — |
| 55 | university-of-notre-dame | University of Notre Dame | — | — |
| 56 | university-of-san-diego | University of San Diego | — | — |
| 57 | university-of-south-carolina | University of South Carolina | — | — |
| 58 | university-of-texas-at-dallas | University of Texas at Dallas | — | — |
| 59 | university-of-utah | University of Utah | — | — |
| 60 | university-of-virginia | University of Virginia | — | — |
| 61 | university-of-west-florida | University of West Florida | — | — |
| 62 | university-of-wisconsin-madison | University of Wisconsin-Madison | — | — |
| 63 | unsw-sydney | UNSW Sydney | — | — |
| 64 | villanova-university | Villanova University | — | — |
| 65 | woxsen-university__school-of-business__business-analytics | Woxsen University | School of Business | Business Analytics |

## Full missing faculty roster inventory

| # | Row ID | Institution | School | Department | Hidden |
|---|---|---|---|---|---|
| 1 | abdullah-al-salem-university____scm-logistics | Abdullah Al Salem University (AASU) | — | SCM/Logistics | no |
| 2 | columbia-university____data-driven-decision-making-optimization-under-uncertainty | Columbia University | — | data-driven decision-making, optimization under uncertainty | no |
| 3 | insead____humanitarian-research-group-hrg-social-innovation-center | INSEAD | — | Humanitarian Research Group (HRG), Social Innovation Center | no |

## Machine-readable snapshot

See UNIVERSITY-MAP-UNRESOLVED.json beside this file. It contains the same full location and roster rows, including current fallback fields and existing links. Regenerate from data/directory.json after future publications; do not treat this snapshot as a permanent source of truth.
