/* ---------------------------------------------------------------------------
   Operations Academia — one spelling per country.

   ONE definition, loaded by BOTH sides, exactly like oa-alert-match.js:

     the browser   <script src="assets/oa-countries.js">  -> window.OACountries
     the build     createRequire(...)('.../oa-countries.js') -> module.exports

   WHY THIS EXISTS. The country is free text on the posting form and was free
   text in the spreadsheets the archive was imported from, so one country
   arrived under several names: 142 postings said "USA", 12 said "UK" and 4
   "United Kingdom", and there were "Hong Kong SAR", "The Netherlands",
   "Republic of Korea", "Russian Federation", "China (Shanghai)" and
   "Shenzhen, China". Every one of those is a SEPARATE entry in the jobs
   page's Location filter and in the alerts form's country list — so a reader
   filtering on United Kingdom saw a third of the British postings, and the
   rest were filed under a name they never thought to tick.

   THE CANONICAL NAME IS THE FULL ONE (owner, 2026-08-17): "United States",
   not "USA"; "United Kingdom", not "UK". That makes the list internally
   consistent — every other entry was already a full name — at the cost of a
   one-off rewrite of the committed data, which is done and pinned by the
   selftest.

   canon() NEVER INVENTS. A value it does not recognise comes back cleaned but
   otherwise untouched, so a campus in a place this list has never heard of is
   still postable and still published under the name its poster gave it.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OACountries = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Every country, alphabetical — what the posting form offers and what
     canon() resolves to. It is a HINT on a free-text field, never a closed
     list. */
  var LIST = [
    'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua and Barbuda',
    'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan', 'Bahamas',
    'Bahrain', 'Bangladesh', 'Barbados', 'Belarus', 'Belgium', 'Belize', 'Benin',
    'Bermuda', 'Bhutan', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil',
    'Brunei', 'Bulgaria', 'Burkina Faso', 'Burundi', 'Cambodia', 'Cameroon', 'Canada',
    'Cape Verde', 'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia',
    'Comoros', 'Costa Rica', 'Croatia', 'Cuba', 'Curacao', 'Cyprus', 'Czech Republic',
    'Democratic Republic of the Congo', 'Denmark', 'Djibouti', 'Dominica',
    'Dominican Republic', 'East Timor', 'Ecuador', 'Egypt', 'El Salvador',
    'Equatorial Guinea', 'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia',
    'Faroe Islands', 'Fiji', 'Finland', 'France', 'Gabon', 'Gambia', 'Georgia',
    'Germany', 'Ghana', 'Gibraltar', 'Greece', 'Greenland', 'Grenada', 'Guatemala',
    'Guinea', 'Guinea-Bissau', 'Guyana', 'Haiti', 'Honduras', 'Hong Kong', 'Hungary',
    'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy',
    'Ivory Coast', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati',
    'Kosovo', 'Kuwait', 'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon', 'Lesotho',
    'Liberia', 'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Macau',
    'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta',
    'Marshall Islands', 'Mauritania', 'Mauritius', 'Mexico', 'Micronesia', 'Moldova',
    'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia',
    'Nauru', 'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua', 'Niger', 'Nigeria',
    'North Korea', 'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Palau',
    'Palestine', 'Panama', 'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines',
    'Poland', 'Portugal', 'Puerto Rico', 'Qatar', 'Republic of the Congo', 'Romania',
    'Russia', 'Rwanda', 'Saint Kitts and Nevis', 'Saint Lucia',
    'Saint Vincent and the Grenadines', 'Samoa', 'San Marino',
    'Sao Tome and Principe', 'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles',
    'Sierra Leone', 'Singapore', 'Slovakia', 'Slovenia', 'Solomon Islands', 'Somalia',
    'South Africa', 'South Korea', 'South Sudan', 'Spain', 'Sri Lanka', 'Sudan',
    'Suriname', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan', 'Tanzania',
    'Thailand', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tunisia', 'Turkey',
    'Turkmenistan', 'Tuvalu', 'Uganda', 'Ukraine', 'United Arab Emirates',
    'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan', 'Vanuatu',
    'Vatican City', 'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe'
  ];

  /* What the site has actually been given, and what each one means. Written in
     ordinary spellings; they are folded (below) when the table is built, so
     "U.S.A." and "usa" both find their way here without separate entries.

     Add to this table rather than editing the data when a new variant turns
     up — the data is rebuilt from Firestore every day, so a hand-patched row
     would come back the next morning, while an entry here fixes it for ever
     and for every past row at the same time. */
  var ALIASES = {
    'USA': 'United States',
    'U.S.A.': 'United States',
    'U.S.': 'United States',
    'US': 'United States',
    'United States of America': 'United States',
    'America': 'United States',
    'UK': 'United Kingdom',
    'U.K.': 'United Kingdom',
    'Great Britain': 'United Kingdom',
    'England': 'United Kingdom',
    'Scotland': 'United Kingdom',
    'Wales': 'United Kingdom',
    'Northern Ireland': 'United Kingdom',
    'The Netherlands': 'Netherlands',
    'Holland': 'Netherlands',
    'Hong Kong SAR': 'Hong Kong',
    'Hong Kong S.A.R.': 'Hong Kong',
    'Macao': 'Macau',
    'Macau SAR': 'Macau',
    'Republic of Korea': 'South Korea',
    'Korea': 'South Korea',
    'Korea, Republic of': 'South Korea',
    'South Korea (Republic of Korea)': 'South Korea',
    'Democratic People\'s Republic of Korea': 'North Korea',
    'Russian Federation': 'Russia',
    "People's Republic of China": 'China',
    'PR China': 'China',
    'P.R. China': 'China',
    'PRC': 'China',
    'Mainland China': 'China',
    'Taiwan, ROC': 'Taiwan',
    'Republic of China (Taiwan)': 'Taiwan',
    'UAE': 'United Arab Emirates',
    'Czechia': 'Czech Republic',
    'Turkiye': 'Turkey',
    'Viet Nam': 'Vietnam',
    'Burma': 'Myanmar',
    'Swaziland': 'Eswatini',
    'Cabo Verde': 'Cape Verde',
    'Timor-Leste': 'East Timor',
    "Cote d'Ivoire": 'Ivory Coast',
    'Macedonia': 'North Macedonia',
    'Republic of Ireland': 'Ireland',
    'Eire': 'Ireland',
    'Deutschland': 'Germany',
    'Espana': 'Spain',
    'Brasil': 'Brazil',
    'Singapore (Republic of Singapore)': 'Singapore'
  };

  /** Lower case, no diacritics, punctuation flattened to single spaces, so
      "U.S.A.", "usa" and "U S A" are one key and "Guinea-Bissau" matches
      "Guinea Bissau". */
  function fold(s) {
    s = String(s == null ? '' : s).toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return s.replace(/[^a-z0-9]+/g, ' ').replace(/^ | $/g, '');
  }

  /* fold(name) -> canonical name, for the canonical list AND every alias. */
  var BY_FOLD = {};
  var i;
  for (i = 0; i < LIST.length; i++) BY_FOLD[fold(LIST[i])] = LIST[i];
  for (var alias in ALIASES) {
    if (Object.prototype.hasOwnProperty.call(ALIASES, alias)) {
      BY_FOLD[fold(alias)] = ALIASES[alias];
    }
  }

  /** Whitespace tidied and any stray trailing separator removed — what a value
      becomes even when we do not recognise it. */
  function clean(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ')
      .replace(/^[\s,;:.]+|[\s,;:.]+$/g, '');
  }

  /**
   * The one name this country is published under.
   *
   * Beyond the table, two shapes the spreadsheets actually contained are
   * understood, because enumerating every city is hopeless:
   *
   *   "China (Shanghai)"  a parenthetical qualifier -> try without it
   *   "Shenzhen, China"   a comma list -> try each part, last one first
   *
   * Anything still unrecognised is returned CLEANED BUT UNCHANGED. This
   * function must never guess a country it was not given.
   */

  /* ------------------------------------------------- the United States, by state

     WHY A STATE TABLE LIVES IN A COUNTRY FILE. canon() reads a comma-separated
     value from the outside — a sheet cell, a posting form, a postal address —
     and scans its parts from the RIGHT, because the last part of an address is
     the most administrative one. That is right, and it had one hole: a part
     that is a US CITY sharing a country's name won before the state beside it
     was ever considered. St. John's University is in Jamaica, New York, and
     the site published it under the country JAMAICA.

     So a US state settles the country, which is the same "most administrative
     part wins" rule the reverse scan already expresses — a state is simply the
     administrative part below a country and above a town.

     GEORGIA IS THE ONE THAT NEEDS CARE. It is the only US state that is also a
     country, so its NAME cannot settle anything — "Athens, Georgia" falls
     through to the country, exactly as it did before, because guessing is
     worse than leaving it. Its ABBREVIATION is not ambiguous at all, and
     dropping "GA" with the name is a bug in its own right: it left Emory's
     "1300 Clifton Rd, Atlanta, GA 30322" unreadable. So the name is listed in
     AMBIGUOUS_STATE_NAMES and skipped; the abbreviation is registered like
     every other. */
  var US_STATES = [
    ['Alabama', 'AL'], ['Alaska', 'AK'], ['Arizona', 'AZ'], ['Arkansas', 'AR'],
    ['California', 'CA'], ['Colorado', 'CO'], ['Connecticut', 'CT'], ['Delaware', 'DE'],
    ['District of Columbia', 'DC'], ['Florida', 'FL'], ['Georgia', 'GA'],
    ['Hawaii', 'HI'], ['Idaho', 'ID'],
    ['Illinois', 'IL'], ['Indiana', 'IN'], ['Iowa', 'IA'], ['Kansas', 'KS'],
    ['Kentucky', 'KY'], ['Louisiana', 'LA'], ['Maine', 'ME'], ['Maryland', 'MD'],
    ['Massachusetts', 'MA'], ['Michigan', 'MI'], ['Minnesota', 'MN'], ['Mississippi', 'MS'],
    ['Missouri', 'MO'], ['Montana', 'MT'], ['Nebraska', 'NE'], ['Nevada', 'NV'],
    ['New Hampshire', 'NH'], ['New Jersey', 'NJ'], ['New Mexico', 'NM'], ['New York', 'NY'],
    ['North Carolina', 'NC'], ['North Dakota', 'ND'], ['Ohio', 'OH'], ['Oklahoma', 'OK'],
    ['Oregon', 'OR'], ['Pennsylvania', 'PA'], ['Rhode Island', 'RI'], ['South Carolina', 'SC'],
    ['South Dakota', 'SD'], ['Tennessee', 'TN'], ['Texas', 'TX'], ['Utah', 'UT'],
    ['Vermont', 'VT'], ['Virginia', 'VA'], ['Washington', 'WA'], ['West Virginia', 'WV'],
    ['Wisconsin', 'WI'], ['Wyoming', 'WY']
  ];

  /** A state whose NAME is also a country's, so the name alone settles
      nothing. The abbreviation still does. */
  var AMBIGUOUS_STATE_NAMES = ['Georgia'];

  var US_BY_FOLD = {};
  (function () {
    var skip = {};
    for (var a = 0; a < AMBIGUOUS_STATE_NAMES.length; a++) {
      skip[fold(AMBIGUOUS_STATE_NAMES[a])] = true;
    }
    for (var i = 0; i < US_STATES.length; i++) {
      if (!skip[fold(US_STATES[i][0])]) US_BY_FOLD[fold(US_STATES[i][0])] = true;
      US_BY_FOLD[fold(US_STATES[i][1])] = true;
    }
  }());

  /** Is this address part a US state, written either way? "MA 02142" counts:
      a five-digit ZIP after a state is the most decisive form there is. */
  function usStatePart(part) {
    var s = clean(part);
    if (!s) return false;
    if (US_BY_FOLD[fold(s)]) return true;
    var m = s.match(/^(.+?)\s+\d{5}(?:-\d{4})?$/);       // "<state> <ZIP>"
    return !!(m && US_BY_FOLD[fold(m[1])]);
  }

  /**
   * The country a POSTAL ADDRESS is in, or '' when it cannot be read.
   *
   * The Universities directory (data/universities.json) carries one address
   * per school, and that address is the site's own answer to "where is this
   * university" — which is what makes it the authority a posting's country can
   * be audited against (see _scraper/country-audit.mjs).
   *
   * It reads from the RIGHT for the same reason canon() does, and it NEVER
   * INVENTS: an address whose tail is a map-URL fragment, a bare postcode or a
   * campus building returns '' rather than a guess, and the audit then has
   * nothing to say about that university.
   */
  function countryFromAddress(address) {
    var s = clean(address);
    if (!s) return '';
    var parts = s.split(',').map(clean).filter(Boolean).reverse();
    for (var i = 0; i < parts.length; i++) {
      var hit = BY_FOLD[fold(parts[i])];
      if (hit) return hit;
      if (usStatePart(parts[i])) return 'United States';
      /* the city-states write their postcode where a country would go */
      var m = parts[i].match(/^(.+?)\s+\d{4,6}$/);
      if (m) {
        hit = BY_FOLD[fold(m[1])];
        if (hit) return hit;
      }
      /* ...and an address can END in its country with no comma before it —
         "Yangpu Qu, Shanghai Shi China". Only the LAST part is read this way,
         and only as a whole trailing word-run, so a street called after a
         country cannot be mistaken for one. */
      if (i === 0) {
        var words = parts[i].split(/\s+/);
        for (var w = Math.max(0, words.length - 4); w < words.length; w++) {
          hit = BY_FOLD[fold(words.slice(w).join(' '))];
          if (hit) return hit;
        }
      }
    }
    return '';
  }

  function canon(v) {
    var s = clean(v);
    if (!s) return '';

    var hit = BY_FOLD[fold(s)];
    if (hit) return hit;

    var bare = clean(s.replace(/\([^)]*\)/g, ''));
    if (bare && bare !== s) {
      hit = BY_FOLD[fold(bare)];
      if (hit) return hit;
    }

    if (s.indexOf(',') !== -1) {
      var parts = s.split(',').map(clean).filter(Boolean).reverse();
      for (var j = 0; j < parts.length; j++) {
        hit = BY_FOLD[fold(parts[j])];
        if (hit) return hit;
        /* ...and a US STATE settles it, before any part further left can win.
           Without this the reverse scan walked past "NY" and matched the town
           "Jamaica" as a country — see US_STATES above. */
        if (usStatePart(parts[j])) return 'United States';
      }
    }

    return s;
  }

  /** True when `v` is already the name we publish. */
  function isCanonical(v) {
    return !!v && canon(v) === v;
  }

  return {
    LIST: LIST,
    ALIASES: ALIASES,
    US_STATES: US_STATES,
    fold: fold,
    canon: canon,
    isCanonical: isCanonical,
    countryFromAddress: countryFromAddress
  };
}));
