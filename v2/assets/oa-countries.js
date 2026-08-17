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
    fold: fold,
    canon: canon,
    isCanonical: isCanonical
  };
}));
