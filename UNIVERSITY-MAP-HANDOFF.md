# University map research and publication handoff

Snapshot: 31 October 2026. Generated from the current data/directory.json. The snapshot contains **110 unresolved location rows** and **3 missing faculty rosters**. These are directory rows, not necessarily distinct universities or buildings. Recalculate after synchronizing the repository.

## Objective and authorization

Continue researching missing building locations and faculty rosters for https://www.operationsacademia.org/universities. Add only verified information, publish updates, and check the live map. The owner has explicitly authorized repository edits, publication, live verification, and Chrome research agents. Do not repeatedly ask permission for already authorized work. Follow any environment permission mechanism when needed.

## Repository and completed work

Local checkout: C:/Users/LENOVO/Documents/Codex/2026-10-30/uni/work/operations-academia

Remote: https://github.com/konstantinosStouras/OperationsAcademia.github.io.git

Branch: master. GitHub Pages serves the repository root. Other tasks publish concurrently: inspect status, fetch the latest remote before work, and check again before pushing. Never overwrite others' work or force-push.

Latest completed map update: 8fe2e3db57c3aa123d9305d852b416995ca15d6b. GitHub Pages deployment 41156678407 succeeded. Nine buildings resolved eleven gaps: Dayton Miriam Hall; Portland Franz Hall; RPI Pittsburgh Building; Rutgers–Camden Business and Science Building; Loyola Chicago Schreiber Center; Seton Hall Jubilee Hall; Alberta Business Building; UCSD Otterson Hall; Oxford Saïd Park End Street. All nine records were verified in the published map data and Portland's updated card was checked in Chrome. All four local map checks passed and no faculty links were lost. Do not add these again.

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

Last published map version: 20261031-directory-updates-4. Last directory version: 20261031-rosters4. Choose new unique values for the next publication. Update all six references consistently:

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
| 11 | cornell-university-cornell-tech__samuel-curtis-johnson-graduate-school-of-management | Cornell University/ Cornell Tech | Samuel Curtis Johnson Graduate School of Management | — |
| 12 | depauw-university | DePauw University | — | — |
| 13 | erasmus-university-rotterdam__econometric-institute__operations-and-supply-chain-management | Erasmus University Rotterdam | Econometric Institute | Operations and Supply Chain Management |
| 14 | ewha-school-of-business | Ewha School of Business | — | — |
| 15 | florida-international-university____is | Florida International University | — | IS |
| 16 | florida-international-university__college-of-business-administration__decision-sciences-and-information-systems | Florida International University | College of Business Administration | Decision Sciences and Information Systems |
| 17 | fudan-university__school-of-management__management-science | Fudan University | School of Management | Management Science |
| 18 | georgetown-university | Georgetown University | — | — |
| 19 | georgia-institute-of-technology | Georgia Institute of Technology | — | — |
| 20 | georgia-state-university | Georgia State University | — | — |
| 21 | harvard-university | Harvard University | — | — |
| 22 | hec-paris | HEC Paris | — | — |
| 23 | ie-business-school____ds | IE Business School | — | DS |
| 24 | ie-business-school____om | IE Business School | — | OM |
| 25 | ie-business-school____operations-and-technology | IE Business School | — | Operations and Technology |
| 26 | ie-university____business | IE University | — | Business |
| 27 | iese | IESE | — | — |
| 28 | iese-business-school | IESE Business School | — | — |
| 29 | imperial-college-london | Imperial College London | — | — |
| 30 | indian-institute-of-technology-iit-bombay____industrial-engineering-and-operations-research | Indian Institute of Technology (IIT) Bombay | — | Industrial Engineering and Operations Research |
| 31 | indian-school-of-business | Indian School of Business | — | — |
| 32 | insead____humanitarian-research-group-hrg-social-innovation-center | INSEAD | — | Humanitarian Research Group (HRG), Social Innovation Center |
| 33 | institut-mines-telecom | Institut Mines-Télécom | — | — |
| 34 | kaist | KAIST | — | — |
| 35 | kaist____organization-man-sci | KAIST | — | Organization/Man. Sci |
| 36 | kaist__college-of-business__operations-strategy-and-management-science | KAIST | College of Business | Operations Strategy and Management Science |
| 37 | koc-university__college-of-administrative-sciences-and-economics-case | Koç University | College of Administrative Sciences and Economics (CASE) | — |
| 38 | lehigh-university | Lehigh University | — | — |
| 39 | mcmaster-university | McMaster University | — | — |
| 40 | mef-university__faculty-of-engineering__industrial-engineering | MEF University | Faculty of Engineering | Industrial Engineering |
| 41 | michigan-state-university | Michigan State University | — | — |
| 42 | nanyang-technological-university | Nanyang Technological University | — | — |
| 43 | national-university-of-singapore | National University of Singapore | — | — |
| 44 | new-york-university-shanghai____business-area-statistics-operations-management | New York University Shanghai | — | Business Area, Statistics/Operations Management |
| 45 | north-carolina-central-university__school-of-business__decision-sciences | North Carolina Central University | School of Business | Decision Sciences |
| 46 | nova-school-of-business-and-economics | Nova School of Business and Economics | — | — |
| 47 | ozyegin-university | Özyeğin University | — | — |
| 48 | pontificia-universidad-catolica-de-chile__school-of-engineering__industrial-and-systems-engineering-and-electrical-engineerin | Pontificia Universidad Catolica de Chile (PUC) | School of Engineering | Industrial and Systems Engineering and Electrical Engineering |
| 49 | pontificia-universidad-catolica-de-chile__school-of-management__management-science | Pontificia Universidad Catolica de Chile (PUC) | School of Management | Management Science |
| 50 | sabanci-university__faculty-of-engineering-and-natural-sciences-fens | Sabanci University | Faculty of Engineering and Natural Sciences (FENS) | — |
| 51 | shanghai-university-of-finance-and-economics | Shanghai University of Finance and Economics | — | — |
| 52 | shanghai-university-of-finance-and-economics__school-of-information-management-and-engineering-sime__management-science-information-systems-financial-information | Shanghai University of Finance and Economics (SUFE) | School of Information Management and Engineering (SIME) | Management Science, Information Systems, Financial Information, and Computer Science |
| 53 | singapore-management-university__school-of-information-systems | Singapore Management University (SMU) | School of Information Systems | — |
| 54 | singapore-university-of-technology-and-design | Singapore University of Technology and Design (SUTD) | — | — |
| 55 | skolkovo-institute-of-science-and-technology-skoltech | Skolkovo Institute of Science and Technology (Skoltech) | — | — |
| 56 | southern-university-of-science-and-technology-sustech__school-of-business-analytics__information-and-operations-management | Southern University of Science and Technology (SUSTech) | School of Business, Analytics | Information, and Operations Management |
| 57 | srm-university____operation-and-supply-chain-management | SRM University | — | Operation and Supply Chain Management |
| 58 | tbs-education | TBS Education | — | — |
| 59 | ted-university | TED University | — | — |
| 60 | temple-university | Temple University | — | — |
| 61 | chinese-university-of-hong-kong__faculty-of-engineering__systems-engineering-and-engineering-management | The Chinese University of Hong Kong (CUHK) | Faculty of Engineering | Systems Engineering and Engineering Management |
| 62 | chinese-university-of-hong-kong-shenzhen | The Chinese University of Hong Kong, Shenzhen | — | — |
| 63 | hong-kong-polytechnic-university | The Hong Kong Polytechnic University | — | — |
| 64 | hong-kong-university-of-science-and-technology____industrial-engineering-and-logistics-management | The Hong Kong University of Science and Technology (HKUST) | — | Industrial Engineering and Logistics Management |
| 65 | ohio-state-university | The Ohio State University | — | — |
| 66 | pennsylvania-state-university | The Pennsylvania State University | — | — |
| 67 | university-of-hong-kong | The University of Hong Kong | — | — |
| 68 | university-of-texas-at-austin__cockrell-school-of-engineering__operations-research-and-industrial-engineering | The University of Texas at Austin | Cockrell School of Engineering | Operations Research and Industrial Engineering |
| 69 | tilburg-university | Tilburg University | — | — |
| 70 | tobb-university-of-economics-and-technology____business-administration | TOBB University of Economics and Technology | — | Business Administration |
| 71 | tulane-university | Tulane University | — | — |
| 72 | united-states-naval-academy | United States Naval Academy | — | — |
| 73 | universidad-de-chile____industrial-engineering | Universidad de Chile | — | Industrial Engineering |
| 74 | universidad-de-los-andes | Universidad de los Andes | — | — |
| 75 | universidad-torcuato-di-tella__school-of-business | Universidad Torcuato di Tella | School of Business | — |
| 76 | universite-catholique-de-louvain__louvain-school-of-management__center-for-operations-research-and-econometrics | Université catholique de Louvain | Louvain School of Management | Center for Operations Research and Econometrics |
| 77 | university-college-london | University College London | — | — |
| 78 | university-college-london__ucl-global-business-school-for-health__sustainable-supply-chain-management | University College London | UCL Global Business School for Health | Sustainable Supply Chain Management |
| 79 | university-of-california-berkeley | University of California, Berkeley | — | — |
| 80 | university-of-california-merced__school-of-engineering | University of California, Merced | School of Engineering | — |
| 81 | university-of-cambridge | University of Cambridge | — | — |
| 82 | university-of-cyprus | University of Cyprus | — | — |
| 83 | university-of-houston | University of Houston | — | — |
| 84 | university-of-illinois-at-urbana-champaign | University of Illinois at Urbana-Champaign | — | — |
| 85 | university-of-london | University of London | — | — |
| 86 | university-of-louisville__j-b-speed-school-of-engineering__industrial-engineering | University of Louisville | J. B. Speed School of Engineering | Industrial Engineering |
| 87 | university-of-mannheim | University of Mannheim | — | — |
| 88 | university-of-mannheim__business-school__chair-of-production-management | University of Mannheim | Business School | Chair of Production Management |
| 89 | university-of-mannheim__business-school__operations-management | University of Mannheim | Business School | Operations Management |
| 90 | university-of-mannheim__business-school__supply-chain-management | University of Mannheim | Business School | Supply Chain Management |
| 91 | university-of-miami | University of Miami | — | — |
| 92 | university-of-miami__miami-herbert-business-school__ba-fintech-ai-healthcare | University of Miami | Miami Herbert Business School | BA: FinTech, AI, Healthcare |
| 93 | university-of-miami__miami-herbert-business-school__management-area | University of Miami | Miami Herbert Business School | Management Area |
| 94 | university-of-miami__miami-herbert-business-school__operations-management | University of Miami | Miami Herbert Business School | Operations Management |
| 95 | university-of-michigan-dearborn__college-of-business__decision-sciences-operations-management | University of Michigan-Dearborn | College of Business | Decision Sciences/Operations Management |
| 96 | university-of-minnesota | University of Minnesota | — | — |
| 97 | university-of-notre-dame | University of Notre Dame | — | — |
| 98 | university-of-san-diego | University of San Diego | — | — |
| 99 | university-of-south-carolina | University of South Carolina | — | — |
| 100 | university-of-sydney__faculty-of-engineering__engineering-and-ai | University of Sydney | Faculty of Engineering | Engineering and AI |
| 101 | university-of-texas-at-dallas | University of Texas at Dallas | — | — |
| 102 | university-of-toulouse__toulouse-business-school__information-operations-and-management-sciences | University of Toulouse | Toulouse Business School | Information, Operations and Management Sciences |
| 103 | university-of-utah | University of Utah | — | — |
| 104 | university-of-virginia | University of Virginia | — | — |
| 105 | university-of-west-florida | University of West Florida | — | — |
| 106 | university-of-wisconsin-madison | University of Wisconsin-Madison | — | — |
| 107 | unsw-sydney | UNSW Sydney | — | — |
| 108 | villanova-university | Villanova University | — | — |
| 109 | washington-university-in-st-louis____supply-chain-operations-and-technology-ai-cluster-hire | Washington University in St. Louis | — | Supply Chain, Operations, and Technology (AI Cluster hire) |
| 110 | woxsen-university__school-of-business__business-analytics | Woxsen University | School of Business | Business Analytics |

## Full missing faculty roster inventory

| # | Row ID | Institution | School | Department | Hidden |
|---|---|---|---|---|---|
| 1 | abdullah-al-salem-university____scm-logistics | Abdullah Al Salem University (AASU) | — | SCM/Logistics | no |
| 2 | columbia-university____data-driven-decision-making-optimization-under-uncertainty | Columbia University | — | data-driven decision-making, optimization under uncertainty | no |
| 3 | insead____humanitarian-research-group-hrg-social-innovation-center | INSEAD | — | Humanitarian Research Group (HRG), Social Innovation Center | yes |

## Machine-readable snapshot

See UNIVERSITY-MAP-UNRESOLVED.json beside this file. It contains the same full location and roster rows, including current fallback fields and existing links. Regenerate from data/directory.json after future publications; do not treat this snapshot as a permanent source of truth.
