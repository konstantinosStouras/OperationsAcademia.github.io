/* ---------------------------------------------------------------------------
   Operations Academia — the analytics page.

   Fetches ONE served file, data/analytics.json, and draws six figures from it
   through assets/oa-charts.js. Every number on screen is derived here, in the
   browser, from the same day rows — so the tiles, the charts and the tables
   cannot disagree with each other, and a range change moves all of them at
   once rather than each fetching its own answer.

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
     - the universities    -> labelled FROZEN, with its own date range. UA's
                              networkDomain is the only thing that ever
                              produced those numbers and no analytics product
                              offers a replacement, so they are an archive and
                              must never be read as current.
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

  var state = { data: null, range: '90' };

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

  function rowsInRange() {
    var all = A.series(state.data.days);
    var r = RANGES.filter(function (x) { return x.id === state.range; })[0] || RANGES[1];
    if (!r.days || all.length <= r.days) return all;
    return all.slice(-r.days);
  }

  function renderRange(host) {
    host.innerHTML = '';
    var bar = document.createElement('div');
    bar.className = 'oa-range';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'How much of the record to show');
    RANGES.forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = r.label;
      b.setAttribute('aria-pressed', state.range === r.id ? 'true' : 'false');
      b.addEventListener('click', function () {
        state.range = r.id;
        draw();
      });
      bar.appendChild(b);
    });
    host.appendChild(bar);
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
        'currently empty, because none of its three sources is switched on.</p>' +
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
    renderRange(ranges);

    /* 1 — daily visitors, with the trailing 7-day mean over it */
    var f1 = figure('Visitors, day by day',
      'One point per day. The gold line is the trailing seven-day average, which is ' +
      'what the shape of the traffic looks like once the weekend is taken out of it.');
    root.appendChild(f1.section);
    var visitors = rows.map(function (r) { return r.visitors; });
    C.line(f1.body, {
      title: 'Visitors per day',
      points: rows.map(function (r) {
        return { label: pretty(r.day).replace(/ \d{4}$/, ''), label2: pretty(r.day) };
      }),
      series: [
        { name: 'Visitors', values: visitors, kind: 'brand', area: true },
        { name: '7-day average', values: A.rollingMean(visitors, 7), kind: 'accent', dashed: true },
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

    /* 3 — the season. The reason this one is on the page: an academic hiring
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
    var span = allRows.length
      ? pretty(allRows[0].day) + ' to ' + pretty(allRows[allRows.length - 1].day)
      : '';
    var f3 = figure('The hiring season',
      'Average visitors in each calendar month, over the whole record' +
      (span ? ' (' + span + ')' : '') + ' — not the range above, because a ' +
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

    /* 4 — the pages */
    if (data.pages && data.pages.length) {
      var f4 = figure('The most visited pages',
        'Pageviews, and how long a reader spends on each.');
      root.appendChild(f4.section);
      C.bars(f4.body, {
        unit: 'views',
        limit: 12,
        items: data.pages.map(function (p) {
          return {
            label: p.title || p.path,
            href: p.path && p.path.charAt(0) === '/' ? p.path : null,
            value: p.views,
            sub: p.avgSec ? Math.round(p.avgSec) + ' seconds on average' : '',
          };
        }),
      });
    }

    renderUniversities();
  }

  /** The frozen archive. Drawn last and labelled, because these numbers can
      never be brought up to date: they came from Universal Analytics'
      networkDomain — the visitor's reverse-DNS — and no analytics product
      sells that dimension any more. */
  function renderUniversities() {
    var u = (state.data && state.data.universities) || {};
    if (!u.all || !u.all.length) return;
    var span = u.from && u.to ? pretty(u.from) + ' to ' + pretty(u.to) : '';
    var f = figure('Which universities visited',
      'Visits by university, counted from the visitor\'s own network. ' +
      (span ? 'Covers ' + span + '. ' : '') +
      'This one cannot be brought up to date: it was measured from a dimension ' +
      'Universal Analytics offered and no analytics product has replaced.',
      { frozen: 'Archive — 2014 to 2023' });
    root.appendChild(f.section);
    C.bars(f.body, { unit: 'visits', limit: 25, items: u.all.map(function (x) {
      return { label: x.name, value: x.visits };
    }) });
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
