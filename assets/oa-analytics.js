/* ---------------------------------------------------------------------------
   Operations Academia — the analytics page.

   Fetches ONE served file, data/analytics.json, and draws every figure from it
   through assets/oa-charts.js. Every number on screen is derived here, in the
   browser, from the same day rows and the same dimension records — so the
   tiles, the charts and the tables cannot disagree with each other, and a
   range change moves all of them at once rather than each fetching its own
   answer.

   THE PAGE IS HONEST WHEN THERE IS NOTHING TO PLOT, which is the whole reason
   it exists in this shape. The four <iframe>s it replaces had been dead since
   2023 and rendered as four empty boxes — a page that has stopped measuring
   and a site nobody is visiting look identical from outside, and that is
   precisely how three years went by. So:

     - nothing configured  -> a note naming exactly what is missing, with the
                              setup file to read. Not an empty chart.
     - configured but old  -> a warning naming the last day it has, because a
                              pipeline that quietly stopped is the failure this
                              page is now built to make impossible to miss.
     - a figure with no
       source yet          -> NOT DRAWN, and named in the provenance note at
                              the foot instead. An empty axis is the shape of
                              the defect this page was rebuilt to remove.
     - the universities    -> labelled FROZEN, with its own date range. UA's
                              networkDomain is the only thing that ever
                              produced those numbers and no analytics product
                              offers a replacement, so they are an archive and
                              must never be read as current.

   EVERY FIGURE STATES WHERE IT COMES FROM AND WHAT SPAN IT COVERS. The day
   rows go back as far as the record does; the dimension tallies are recomputed
   over a trailing window on every build (see BREAKDOWN_DAYS in the model), so
   a chart drawn from one beside a tile drawn from the other would otherwise
   invite a reader to compare two different spans without knowing it.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var A = window.OAAnalytics;
  var C = window.OACharts;
  var root = document.getElementById('oa-analytics');
  if (!root || !A || !C) return;

  /* The ranges the reader can ask for. `days: 0` means everything there is —
     the "since the site was created" chart the old page had, kept. */
  var RANGES = [
    { id: '30', label: 'Last 30 days', days: 30 },
    { id: '90', label: 'Last 90 days', days: 90 },
    { id: '365', label: 'Last 12 months', days: 365 },
    { id: 'all', label: 'Everything', days: 0 },
  ];

  /* WHICH NUMBER THE DAILY CHART PLOTS, and the reason it is a control rather
     than three charts stacked. The three answer different questions — how many
     PEOPLE, how many VISITS, how many PAGES — and a reader almost always wants
     one of them; drawing all three at once needs two more colours and makes
     the one they came for harder to see. */
  var METRICS = [
    { id: 'visitors', label: 'Visitors', unit: 'visitors',
      note: 'distinct browsers, as the site’s own record counts them' },
    { id: 'sessions', label: 'Visits', unit: 'visits',
      note: 'a visit is one browsing session' },
    { id: 'pageviews', label: 'Pageviews', unit: 'pageviews',
      note: 'every page opened' },
  ];

  /* Each dimension the file may carry: its heading, the sentence under it, and
     the shape it is drawn as. Kept in ONE table because the provenance note at
     the foot has to name the same figures the page draws, and two lists would
     drift apart the first time one was added to. */
  var DIMENSIONS = [
    {
      id: 'hours', kind: 'columns',
      title: 'When in the day people read it',
      sub: 'Visits by hour of the day, in UTC — the site’s own record stamps the ' +
        'instant each session begins, so this is exact rather than bucketed by a ' +
        'reporting time zone. Readers here are spread across the Americas, Europe ' +
        'and Asia, so the flat hours are the ones nobody anywhere is awake for.',
      xTitle: 'Hour of the day (UTC)', unit: 'Visits',
    },
    {
      id: 'countries', kind: 'bars',
      title: 'Where readers are',
      sub: 'Visits by country. This is the nearest thing left to the old “which ' +
        'universities visited” charts: those were measured from the visitor’s ' +
        'reverse-DNS, which no analytics product still offers, and a country is ' +
        'what can honestly be measured instead.',
      unit: 'visits', limit: 12,
    },
    {
      id: 'channels', kind: 'share',
      title: 'How readers arrive',
      sub: 'Which channel brought each visit — a search engine, a link on another ' +
        'site, an e-mail, or the address typed or opened from a bookmark.',
      unit: 'visits', limit: 6,
    },
    {
      id: 'referrers', kind: 'bars',
      title: 'Which sites send readers',
      sub: 'The source of each visit as Google Analytics records it. A search engine ' +
        'appears under its own name; a reader who typed the address or opened a ' +
        'bookmark has no referring site and is counted as such.',
      unit: 'visits', limit: 10,
    },
    {
      id: 'devices', kind: 'share',
      title: 'What they read it on',
      sub: 'Desktop, phone or tablet. Worth knowing on a site whose longest pages are ' +
        'lists of job postings: the phone share is the constraint every layout here ' +
        'is measured against.',
      unit: 'visits', limit: 6,
    },
  ];

  var state = { data: null, range: '90', metric: 'visitors' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g,
      function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function pretty(day) {
    if (!day) return '';
    var p = day.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return d.toLocaleDateString('en-GB',
      { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  /** The span a dimension record covers, as a sentence. Every figure drawn
      from one carries it: the tallies are recomputed over a trailing window on
      every build while the tiles above describe the whole record, and two
      spans on one screen with only one of them named is how a reader comes to
      compare them without knowing they are different. */
  function span(rec) {
    if (!rec || !rec.from) return '';
    return rec.from === rec.to
      ? pretty(rec.from)
      : pretty(rec.from) + ' to ' + pretty(rec.to);
  }

  var SOURCE_NAMES = {
    usage: 'the site’s own record',
    ga4: 'Google Analytics',
    history: 'the 2014–2023 archive',
  };
  function sourceName(id) { return SOURCE_NAMES[id] || id || 'an unnamed source'; }

  function note(html, warn) {
    var box = document.createElement('div');
    box.className = 'oa-an-note' + (warn ? ' warn' : '');
    box.innerHTML = html;
    return box;
  }

  /* ------------------------------------------------------------------ tiles */

  function tile(label, value, sub) {
    return '<div class="oa-tile">' +
      '<span class="oa-tile-label">' + esc(label) + '</span>' +
      '<span class="oa-tile-value">' + esc(value) + '</span>' +
      (sub ? '<span class="oa-tile-note">' + esc(sub) + '</span>' : '') +
      '</div>';
  }

  function renderTiles(host, rows, data) {
    var s = A.summarise(rows);
    var html = '<div class="oa-tiles">';
    html += tile('Visitors', C.full(s.visitors), s.days ? 'over ' + C.full(s.days) + ' days' : '');
    html += tile('Pageviews', C.full(s.pageviews), s.days ? C.full(Math.round(s.pageviews / s.days)) + ' a day' : '');
    html += tile('Busiest day', s.busiest ? C.full(s.busiest.visitors) : '—',
      s.busiest ? pretty(s.busiest.day) : '');
    html += tile('Typical day', s.days ? C.full(Math.round(s.mean)) : '—', 'visitors, on average');

    /* HOW LONG A VISIT LASTS, said in minutes rather than in seconds (owner,
       2026-08-29). It comes from the dimension window, not from the range
       control above, so it says which — a tile that silently means a different
       span from the tile beside it is worse than no tile.

       The length and the depth share ONE tile rather than taking two. They are
       two halves of the same fact, measured by the same source over the same
       window; and a sixth tile orphans onto a row of its own at every width the
       page is read at, because the reading column caps at 1064px and five is
       what fits. */
    var eng = data.engagement;
    if (eng && eng.avgSessionSec) {
      html += tile('Typical visit', C.duration(eng.avgSessionSec),
        (eng.viewsPerSession ? eng.viewsPerSession + ' pages · ' : '') +
        (span(eng) || 'on average'));
    }
    if (data.totals && data.totals.universities) {
      html += tile('Universities seen', C.full(data.totals.universities),
        'in the 2014–2023 archive');
    }
    html += '</div>';
    host.innerHTML = html;
  }

  /* ---------------------------------------------------------------- figures */

  function figure(title, sub, opts) {
    var sec = document.createElement('section');
    sec.className = 'oa-figure';
    var h = document.createElement('h2');
    h.textContent = title;
    sec.appendChild(h);
    if (opts && opts.frozen) {
      var chip = document.createElement('span');
      chip.className = 'oa-figure-frozen';
      chip.textContent = opts.frozen;
      sec.appendChild(chip);
    }
    if (sub) {
      var p = document.createElement('p');
      p.className = 'oa-figure-sub';
      p.textContent = sub;
      sec.appendChild(p);
    }
    var body = document.createElement('div');
    sec.appendChild(body);
    return { section: sec, body: body };
  }

  /** The line under a figure naming its source and its span. */
  function provenance(sec, rec) {
    if (!rec) return;
    var p = document.createElement('p');
    p.className = 'oa-figure-src';
    p.textContent = 'Measured by ' + sourceName(rec.source) +
      (span(rec) ? ' · ' + span(rec) : '');
    sec.appendChild(p);
  }

  function rowsInRange() {
    var all = A.series(state.data.days);
    var r = RANGES.filter(function (x) { return x.id === state.range; })[0] || RANGES[1];
    if (!r.days || all.length <= r.days) return all;
    return all.slice(-r.days);
  }

  /** A row of mutually-exclusive buttons. Used for the range and for the
      daily chart's metric — one control shape, so the two read as the same
      kind of thing and neither needs explaining twice. */
  function chooser(host, opts) {
    var bar = document.createElement('div');
    bar.className = 'oa-range' + (opts.className ? ' ' + opts.className : '');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', opts.label);
    opts.options.forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.label;
      b.setAttribute('aria-pressed', opts.value === o.id ? 'true' : 'false');
      b.addEventListener('click', function () { opts.onPick(o.id); });
      bar.appendChild(b);
    });
    host.appendChild(bar);
    return bar;
  }

  /* ------------------------------------------------------------------- draw */

  function draw() {
    var data = state.data;
    var rows = rowsInRange();

    root.textContent = '';

    var stale = A.staleness(data, Date.now());
    if (stale) {
      root.appendChild(note(
        '<h2>These figures have stopped moving</h2>' +
        '<p>The most recent day on record is <b>' + esc(pretty(stale.last)) + '</b>, ' +
        esc(String(stale.age)) + ' days ago. That is long enough to mean the ' +
        'collection has stopped rather than that the site is quiet — the page ' +
        'says so here rather than leaving the charts to look merely flat.</p>', true));
    }

    if (!rows.length) {
      root.appendChild(note(
        '<h2>Nothing is being measured yet</h2>' +
        '<p>This page draws its charts from <code>data/analytics.json</code>, which is ' +
        'built once a day by <code>_scraper/build-analytics.mjs</code>. That file is ' +
        'currently empty, because neither of its two live sources is switched ' +
        'on yet.</p>' +
        '<p>The charts that used to be here were Google Sheets embeds fed by the ' +
        'Google&nbsp;Analytics Spreadsheet Add-on, which spoke only the Universal ' +
        'Analytics API — retired in July&nbsp;2023, with the properties themselves ' +
        'deleted a year later. They have shown nothing since. See ' +
        '<code>_SETUP-ANALYTICS.md</code> for what each source needs.</p>'));
      /* the frozen archive may still have something worth showing even with no
         day rows at all, so it is drawn below rather than skipped */
      renderUniversities();
      return;
    }

    var tiles = document.createElement('div');
    root.appendChild(tiles);
    renderTiles(tiles, rows, data);

    var ranges = document.createElement('div');
    root.appendChild(ranges);
    chooser(ranges, {
      label: 'How much of the record to show',
      options: RANGES,
      value: state.range,
      onPick: function (id) { state.range = id; draw(); },
    });

    /* 1 — the daily series, in whichever of the three numbers the reader
       asked for, with its trailing 7-day mean over it */
    var metric = METRICS.filter(function (m) { return m.id === state.metric; })[0] || METRICS[0];
    var f1 = figure(metric.label + ', day by day',
      'One point per day — ' + metric.note + '. The gold line is the trailing ' +
      'seven-day average, which is what the shape of the traffic looks like once the ' +
      'weekend is taken out of it. Press a key in the legend to put either line away; ' +
      'the chart takes the keyboard, so the arrow keys walk it day by day.');
    root.appendChild(f1.section);
    chooser(f1.body, {
      label: 'Which number to plot',
      className: 'oa-switch',
      options: METRICS,
      value: state.metric,
      onPick: function (id) { state.metric = id; draw(); },
    });
    var plot1 = document.createElement('div');
    f1.body.appendChild(plot1);
    var values = rows.map(function (r) { return r[metric.id]; });
    C.line(plot1, {
      title: metric.label + ' per day',
      points: rows.map(function (r) {
        return { label: pretty(r.day).replace(/ \d{4}$/, ''), label2: pretty(r.day) };
      }),
      series: [
        { name: metric.label, values: values, kind: 'brand', area: true },
        { name: '7-day average', values: A.rollingMean(values, 7), kind: 'accent', dashed: true },
      ],
      xTitle: 'Day',
      height: 280,
    });

    /* 2 — the weekly rhythm */
    var wk = A.byWeekday(rows);
    var f2 = figure('The weekly rhythm',
      'Average visitors on each day of the week, over the range above.');
    root.appendChild(f2.section);
    C.columns(f2.body, {
      title: 'Average visitors by day of the week',
      unit: 'Average visitors',
      xTitle: 'Day of the week',
      items: wk.map(function (b) {
        return {
          label: b.name,
          short: b.name.slice(0, 3),
          value: Math.round(b.mean * 10) / 10,
          empty: !b.days,
          note: b.days
            ? b.days + ' ' + b.name + (b.days === 1 ? '' : 's') + ' in this range'
            : 'no ' + b.name + ' in this range',
        };
      }),
    });

    /* 3 — the hours, when the record carries them (see DIMENSIONS) */
    drawDimension('hours');

    /* 4 — the season. The reason this one is on the page: an academic hiring
       site ought to be loudest in the autumn, and that is a claim the data can
       either support or not.

       IT DELIBERATELY IGNORES THE RANGE ABOVE, and that is not an oversight.
       A seasonality question cannot be answered by a window shorter than a
       year: over the default 90 days, eight of the twelve months hold no days
       at all and were drawn as zero-height bars — so the chart said "nobody
       visits in September", which for a job-market site is not merely missing
       but backwards. It reads the WHOLE record and says so. */
    var allRows = A.series(data.days);
    var mo = A.byMonth(allRows);
    var monthSpan = allRows.length
      ? pretty(allRows[0].day) + ' to ' + pretty(allRows[allRows.length - 1].day)
      : '';
    var f3 = figure('The hiring season',
      'Average visitors in each calendar month, over the whole record' +
      (monthSpan ? ' (' + monthSpan + ')' : '') + ' — not the range above, because a ' +
      'window shorter than a year cannot answer a question about the year. The ' +
      'Operations job market runs on an annual cycle; this is the chart that ' +
      'shows whether the site does too.');
    root.appendChild(f3.section);
    C.columns(f3.body, {
      title: 'Average visitors by month of the year',
      unit: 'Average visitors',
      xTitle: 'Month',
      items: mo.map(function (b) {
        return {
          label: b.name,
          short: b.name.slice(0, 3),
          value: Math.round(b.mean * 10) / 10,
          /* a month the record has never covered is EMPTY, not zero — see
             `columns` in oa-charts.js: it draws no bar and says so */
          empty: !b.days,
          note: b.days
            ? b.days + ' day' + (b.days === 1 ? '' : 's') + ' of ' + b.name + ' on record'
            : 'no ' + b.name + ' on record yet',
        };
      }),
    });

    /* 5-8 — who the readers are, where they came from and what they read on.
       Each is drawn only where a source has actually answered for it; the ones
       that have not are named in the provenance note at the foot instead of
       being drawn as an empty axis. */
    ['countries', 'channels', 'referrers', 'devices'].forEach(drawDimension);

    /* 9 — the pages.

       FILTERED BEFORE THE FIGURE IS DECIDED ON, not inside it: with a cached
       file whose only rows were admin paths, testing `data.pages.length` first
       would draw the heading and an empty chart under it. What decides whether
       there is a figure is whether there is anything the public may see.

       This is a SECOND LINE, not the defence itself. The builder is what keeps
       an admin or archived path out of data/analytics.json, because that file
       is world-readable and a render-time filter would leave the path sitting
       in it. This catches only what the builder cannot: a reader whose browser
       still holds a copy fetched before that shipped. */
    var publicPages = (data.pages || []).filter(function (p) {
      return A.isPublicPath(p && p.path);
    });
    if (publicPages.length) {
      var win = data.pagesWindow || {};
      var f4 = figure('The most visited pages',
        'Pageviews, and how long a reader spends on each' +
        (span(win) ? ', over ' + span(win) : '') + '. Hover or tab through a row for ' +
        'its share of the whole.');
      root.appendChild(f4.section);
      C.bars(f4.body, {
        unit: 'views',
        limit: 12,
        xTitle: 'Page',
        subTitle: 'Average time on the page',
        items: publicPages.map(function (p) {
          return {
            label: p.title || p.path,
            href: p.path && p.path.charAt(0) === '/' ? p.path : null,
            value: p.views,
            /* SAID IN MINUTES, NOT IN SECONDS (owner, 2026-08-29). This line
               used to read "1,952 seconds on average", which is a number a
               reader has to divide by sixty before it means anything. */
            sub: p.avgSec ? C.duration(p.avgSec) + ' on the page, on average' : '',
          };
        }),
      });
      if (win.source) provenance(f4.section, win);
    }

    renderUniversities();
    renderProvenance();
  }

  /** One dimension figure, or nothing at all.

      DRAWN ONLY WHERE A SOURCE HAS ANSWERED. A heading over an empty axis is
      exactly the shape of the defect this page was rebuilt to remove — four
      boxes reporting nothing to anybody — so a dimension with no record is
      named in the provenance note at the foot and drawn nowhere. */
  function drawDimension(id) {
    var def = DIMENSIONS.filter(function (d) { return d.id === id; })[0];
    var rec = ((state.data.breakdowns || {})[id]) || null;
    if (!def || !rec || !rec.items || !rec.items.length) return;

    var f = figure(def.title, def.sub);
    root.appendChild(f.section);

    if (def.kind === 'columns') {
      C.columns(f.body, {
        title: def.title,
        unit: def.unit,
        xTitle: def.xTitle || '',
        items: rec.items.map(function (it) {
          return { label: it.name + ':00', short: it.name, value: it.value };
        }),
      });
    } else if (def.kind === 'share') {
      C.share(f.body, {
        title: def.title,
        unit: def.unit,
        total: rec.total,
        limit: def.limit,
        xTitle: def.title,
        items: rec.items.map(function (it) {
          return { label: it.name, value: it.value };
        }),
      });
    } else {
      C.bars(f.body, {
        unit: def.unit,
        limit: def.limit,
        total: rec.total,
        xTitle: def.title,
        items: rec.items.map(function (it) {
          return { label: it.name, value: it.value };
        }),
      });
    }
    provenance(f.section, rec);
  }

  /** The frozen archive. Drawn last and labelled, because these numbers can
      never be brought up to date: they came from Universal Analytics'
      networkDomain — the visitor's reverse-DNS — and no analytics product
      sells that dimension any more. */
  function renderUniversities() {
    var u = (state.data && state.data.universities) || {};
    if (!u.all || !u.all.length) return;
    var range = u.from && u.to ? pretty(u.from) + ' to ' + pretty(u.to) : '';
    var f = figure('Which universities visited',
      'Visits by university, counted from the visitor\'s own network. ' +
      (range ? 'Covers ' + range + '. ' : '') +
      'This one cannot be brought up to date: it was measured from a dimension ' +
      'Universal Analytics offered and no analytics product has replaced.',
      { frozen: 'Archive — 2014 to 2023' });
    root.appendChild(f.section);
    C.bars(f.body, { unit: 'visits', limit: 25, xTitle: 'University',
      items: u.all.map(function (x) {
        return { label: x.name, value: x.visits };
      }) });
  }

  /** WHERE EVERY FIGURE ON THIS PAGE COMES FROM, and which ones are not here
      yet. A dashboard that shows only what it happens to have, with nothing
      saying what it does not, is the failure this whole page is a rebuild of:
      four dead embeds looked exactly like four figures nobody had got round
      to. So the absences are printed as plainly as the presences. */
  function renderProvenance() {
    var data = state.data;
    var have = [];
    var missing = [];
    DIMENSIONS.forEach(function (d) {
      var rec = (data.breakdowns || {})[d.id];
      if (rec && rec.items && rec.items.length) {
        have.push('<li><b>' + esc(d.title) + '</b> — ' + esc(sourceName(rec.source)) +
          (span(rec) ? ', ' + esc(span(rec)) : '') + '</li>');
      } else {
        missing.push('<li>' + esc(d.title) + '</li>');
      }
    });

    var html = '<h2>Where these figures come from</h2>' +
      '<p>The day-by-day counts, the weekly rhythm and the hiring season are drawn ' +
      'from the site’s own record of its own pages — no cookies, no third ' +
      'party, nothing that leaves this project. The audience figures come from ' +
      'Google Analytics, which runs here <b>cookieless</b>: it stores nothing at all ' +
      'on your device, which is why you were not asked to accept anything on the way ' +
      'in. That has a cost we would rather state than hide — with no identifier ' +
      'it cannot tell a returning reader from a new one, so everything it reports is ' +
      'counted in <b>visits</b> rather than in people.</p>';

    if (have.length) html += '<ul class="oa-an-list">' + have.join('') + '</ul>';
    if (missing.length) {
      html += '<p>Not on this page yet, because no source has answered for ' +
        (missing.length === 1 ? 'it' : 'them') + ' — they will appear on their own ' +
        'once the figures exist:</p><ul class="oa-an-list oa-an-missing">' +
        missing.join('') + '</ul>';
    }
    html += '<p>The counts describe <b>public pages only</b>: a visit to the ' +
      'maintainer’s own area of the site is left out of every figure here, and ' +
      'never written into the file this page reads. ' +
      (data.generated ? 'Rebuilt ' + esc(pretty(data.generated.slice(0, 10))) + '. ' : '') +
      'The file itself is <code>data/analytics.json</code>, which you are welcome to ' +
      'read directly.</p>';

    root.appendChild(note(html));
  }

  /* ------------------------------------------------------------------- load */

  /* `no-cache` REVALIDATES rather than re-downloads — Pages serves data/ with
     ten minutes of freshness, so without it a reader who was here recently is
     shown what they already had. The rule every fetch of data/ on this site
     follows. */
  fetch('data/analytics.json', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (d) {
      state.data = d && d.days ? d : A.emptyDataset();
      draw();
    })
    .catch(function () {
      root.textContent = '';
      root.appendChild(note(
        '<h2>The figures could not be loaded</h2>' +
        '<p>The page asks for <code>data/analytics.json</code> and that request ' +
        'did not come back. It is a plain served file, so this is usually a ' +
        'network problem rather than a broken page — reloading is worth a try.</p>'));
    });
}());
