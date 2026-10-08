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
       source yet          -> NOT DRAWN AT ALL. An empty axis is the shape of
                              the defect this page was rebuilt to remove, and
                              each figure appears on its own once its source
                              has data. (The page used to list the missing
                              ones in a "Where these figures come from" note
                              at the foot; the owner had it removed,
                              2026-08-30 — how the site is measured is not
                              the readers' business.)
     - the universities    -> drawn with the SHARE OF VISITS it could place,
                              never as a bare ranking. It is measured from the
                              visitor's own network (see oa-netorg.js) and
                              reverse DNS answers for perhaps a third of
                              visits, so a chart without its denominator would
                              read as "hardly any universities" instead of as
                              the sample it is. It takes the page's RANGE too
                              (owner, 2026-09-08): the builder tallies the
                              counters once per period, the figure carries
                              the four periods as a row of its own under its
                              heading, and the caption says what the chosen
                              one covers. An ARCHIVED copy of the figure,
                              were one ever to exist, is labelled frozen with
                              its own date range and never mixed with the live
                              one — two rules, one ranking, no meaning.

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
     the "since the site was created" chart the old page had, kept. ONE
     definition, in the model: the builder tallies the university counters
     under these same ids, so a period this control offers is always one the
     served file carries (see visitWindows). */
  var RANGES = A.RANGES;

  /* WHICH NUMBER THE DAILY CHART PLOTS, and the reason it is a control rather
     than charts stacked: the two answer different questions — how many PEOPLE
     and how many PAGES — and a reader almost always wants one of them.

     "VISITS" IS DELIBERATELY NOT OFFERED. The site's own record files one
     document per PAGE OPENED, so for every day it owns the session count IS
     the pageview count — a "Visits" button would plot a line identical to
     Pageviews and describe a pageview as "one browsing session", which is a
     wrong number wearing a right label. The day rows keep carrying all three
     fields (the file format is not the interface), so the button returns the
     day a source that can really count sessions owns the record. */
  /* THE NOTE DESCRIBES THE NUMBER, NEVER THE SOURCE. "as the site’s own record
     counts them" attributed every plotted day to the first-party record, and
     most of them are not its: a day belongs to ONE source (mergeDays), and on
     this installation GA4 owns the great majority of them — where a "visitor"
     is a cookieless `totalUsers`, nearer a session than a person. Which
     sources are actually in view is said under the chart, from the file's own
     `sources` block, rather than guessed at here. */
  var METRICS = [
    { id: 'visitors', label: 'Visitors', unit: 'visitors',
      note: 'distinct browsers, counted per day' },
    { id: 'pageviews', label: 'Pageviews', unit: 'pageviews',
      note: 'every page opened' },
  ];

  /* Each dimension the file may carry: its heading, the sentence under it, and
     the shape it is drawn as. Kept in ONE table so the page and the model
     cannot disagree about which figures exist — the selftest pins this list
     against BREAKDOWN_IDS both ways, and two lists would drift apart the first
     time one was added to. */
  var DIMENSIONS = [
    {
      id: 'hours', kind: 'columns',
      title: 'When in the day people read it',
      sub: 'Visits by hour of the day, in UTC. The site’s own record stamps the ' +
        'instant each session begins, so this is exact rather than bucketed by a ' +
        'reporting time zone. Readers here are spread across the Americas, Europe ' +
        'and Asia, so the flat hours are the ones nobody anywhere is awake for.',
      xTitle: 'Hour of the day (UTC)', unit: 'Visits', unitBySource: { usage: 'Page opens' },
    },
    {
      id: 'countries', kind: 'bars',
      title: 'Where readers are',
      /* IT DESCRIBES ITSELF AND NAMES NO OTHER FIGURE. This caption used to
         call itself the coarser companion to “Which universities visited”
         below — and the two are drawn on INDEPENDENT conditions (this one on
         a GA4 breakdown, that one on the site's own resolver having data), so
         with GA4 configured and the resolver not yet deployed the page said
         “see the figure below” about a figure it was not drawing at all.
         Measured, not theorised. A cross-reference between two optional
         figures is a promise the page cannot keep, so neither makes one. */
      sub: 'Visits by country, as Google Analytics reports them. Every visit ' +
        'it can place is counted, whether the reader was on a campus, in an ' +
        'office or on a phone.',
      unit: 'visits', limit: 12,
    },
    {
      id: 'channels', kind: 'share',
      title: 'How readers arrive',
      sub: 'Which channel brought each visit: a search engine, a link on another ' +
        'site, an e-mail, or the address typed in or opened from a bookmark.',
      unit: 'visits', limit: 6,
    },
    {
      id: 'referrers', kind: 'bars',
      title: 'Which sites send readers',
      sub: 'The source of each visit as Google Analytics records it. Awesome Table, Firebase and GitHub are excluded. A search engine ' +
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

  var state = { data: null, growth: null, members: null, range: '90', metric: 'visitors' };

  /* THE GROWTH CHART'S TWO NUMBERS, in one place: the fit window and how far
     the dashed line is carried. The caption is BUILT from them, so the words
     under the chart cannot promise a window the model did not use. */
  var GROWTH_WINDOW = 90;
  /* A WEEK, not a season (owner, 2026-09-05: "do not expand that yellow line
     beyond a week from where we are now"): the first version carried the
     trend 180 days out, and a straight line six months long over a record
     three weeks old read as a forecast of a thousand members, which is not
     a claim this page can make. Seven days after today is as far as a
     straight-line reading of the last weeks can honestly go. */
  var GROWTH_AHEAD = 7;

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
    'usage+ga4': 'the site’s own record and Google Analytics',
    history: 'the 2014–2023 archive',
  };
  function sourceName(id) { return SOURCE_NAMES[id] || id || 'an unnamed source'; }

  /** A page's ADDRESS, as the site writes it. The file keeps the `.html`
      form (normPath's storage form, the one a file on disk has) and the site
      has shown and linked the extensionless address since 2026-09-08, so the
      list reads "/jobs" and links "/jobs" rather than printing a spelling the
      address bar never shows. */
  function addressOf(path) {
    var p = String(path || '');
    if (p === '/' || p.charAt(0) !== '/') return p;
    return p.replace(/\.html?$/i, '');
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
    /* "counted per day" is load-bearing: the served file has no cross-day
       identity, so the headline is per-day distinct visitors SUMMED — a
       reader who comes back on ten days counts ten times, and a tile that
       said a bare "Visitors over 90 days" would claim a distinct count
       nothing here can compute. */
    html += tile('Visitors', C.full(s.visitors),
      s.days ? 'counted per day, over ' + C.full(s.days) + ' days' : '');
    html += tile('Pageviews', C.full(s.pageviews), s.days ? C.full(Math.round(s.pageviews / s.days)) + ' a day' : '');
    html += tile('Busiest day', s.busiest ? C.full(s.busiest.visitors) : '—',
      s.busiest ? pretty(s.busiest.day) : '');
    html += tile('Typical day', s.days ? C.full(Math.round(s.mean)) : '—', 'visitors, on average');

    /* HOW LONG, said in minutes rather than in seconds (owner, 2026-08-29).
       It comes from the dimension window, not from the range control above,
       so it says which — a tile that silently means a different span from the
       tile beside it is worse than no tile.

       WHAT the length is a length OF depends on the source, and the tile says
       which. The site's own record files one document per page, so its
       average is time on a PAGE — its "session" count equals its pageview
       count by construction, its pages-per-visit is identically 1, and a
       "Typical visit · 1 pages" tile was two wrong claims in nine
       characters. Only a source that can really measure a visit (GA4) gets
       the visit framing and the depth. */
    var eng = data.engagement;
    if (eng && eng.avgSessionSec) {
      var perPage = eng.source === 'usage';
      html += tile(perPage ? 'Time on a page' : 'Typical visit',
        C.duration(eng.avgSessionSec),
        (!perPage && eng.viewsPerSession > 1
          ? eng.viewsPerSession + ' pages a visit · ' : '') +
        (span(eng) || 'on average'));
    }
    /* THERE IS DELIBERATELY NO SIXTH TILE. "Universities seen" was one until
       the engagement tile arrived beside it, and six tiles measure as two rows
       with ONE tile alone on the second at 1400px, 1180px and 1024px — the
       orphan the comment above says the length and the depth were folded
       together to avoid. The count is not lost: it is the first thing the
       universities figure's own caption says, which is where a fact about one
       figure belongs. */
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

  /** A calendar day, moved. Pure arithmetic in UTC, like every date on this
      page — a local read shifts the day for readers west of Greenwich. */
  function dayShift(day, n) {
    var q = day.split('-');
    return new Date(Date.UTC(+q[0], +q[1] - 1, +q[2] + n)).toISOString().slice(0, 10);
  }

  function rowsInRange() {
    var all = A.series(state.data.days);
    var r = RANGES.filter(function (x) { return x.id === state.range; })[0] || RANGES[1];
    if (!r.days || !all.length) return all;
    /* clipped by DATE, not by row count: a day with no measurement is not in
       the file at all, so "the last 90 rows" could quietly reach back further
       than 90 days across a gap and call it "Last 90 days" */
    var cutoff = dayShift(all[all.length - 1].day, -(r.days - 1));
    return all.filter(function (x) { return x.day >= cutoff; });
  }

  /** The rows made CALENDAR-CONTINUOUS for the daily chart: a day the record
      does not cover becomes a null row, which line() draws as a BREAK and the
      rolling mean refuses to average across. An index-spaced line used to run
      straight through a collection outage as if it were one ordinary day —
      and a chart that cannot show a gap is a chart that hides one. Bounded,
      because it is driven by the range control and "Everything" grows a row a
      day for ever. */
  function withGaps(rows) {
    if (rows.length < 2) return rows;
    var have = {};
    rows.forEach(function (r) { have[r.day] = r; });
    var out = [];
    var day = rows[0].day;
    var last = rows[rows.length - 1].day;
    while (day <= last) {
      out.push(have[day] ||
        { day: day, visitors: null, sessions: null, pageviews: null });
      day = dayShift(day, 1);
    }
    return out;
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
      b.setAttribute('data-id', o.id);
      b.setAttribute('aria-pressed', opts.value === o.id ? 'true' : 'false');
      b.addEventListener('click', function () { opts.onPick(o.id); });
      bar.appendChild(b);
    });
    host.appendChild(bar);
    return bar;
  }

  /** Draw the page again after a control was pressed, WITHOUT moving the
      reader. draw() empties the page and rebuilds it, and the first chart
      forces a layout while the page is still short, at which point the
      browser clamps the scroll offset: a control near the top never showed
      it, the period row on the universities figure at the FOOT of the page
      did (the press landed the reader back on the tiles). The page is
      rebuilt to the same height, so the offset it had is the offset it
      keeps; and the button the reader pressed, rebuilt with the rest, gets
      the keyboard back, found by the class its row carries and the id it
      was pressed for. */
  function redraw(cls, id) {
    var y = window.pageYOffset || 0;
    draw();
    window.scrollTo(0, y);
    var b = root.querySelector('.' + cls + ' button[data-id="' + id + '"]');
    if (b) {
      try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); }
    }
  }

  /* ------------------------------------------------------------------- draw */

  function draw() {
    var data = state.data;
    var rows = rowsInRange();

    drawnAt = root.clientWidth || 0;
    root.textContent = '';
    if (data.generated) {
      var fresh = document.createElement('p');
      fresh.className = 'oa-figure-src';
      fresh.textContent = 'Traffic snapshot: ' + new Date(data.generated).toLocaleString('en-GB') +
        '. Figures refresh throughout the day; today is still incomplete.';
      root.appendChild(fresh);
    }

    var stale = A.staleness(data, Date.now());
    if (stale) {
      root.appendChild(note(
        '<h2>These figures have stopped moving</h2>' +
        '<p>The most recent day on record is <b>' + esc(pretty(stale.last)) + '</b>, ' +
        esc(String(stale.age)) + ' days ago. That is long enough to mean the ' +
        'collection has stopped rather than that the site is quiet, so the page ' +
        'says so here rather than leaving the charts to look merely flat.</p>', true));
    }

    if (!rows.length) {
      root.appendChild(note(
        '<h2>Nothing is being measured yet</h2>' +
        '<p>This page draws its charts from <code>data/analytics.json</code>, which is ' +
        'refreshed throughout the day by <code>_scraper/build-analytics.mjs</code>. That file is ' +
        'currently empty, because neither of its two live sources is switched ' +
        'on yet.</p>' +
        '<p>The charts that used to be here were Google Sheets embeds fed by the ' +
        'Google&nbsp;Analytics Spreadsheet Add-on, which spoke only the Universal ' +
        'Analytics API, retired in July&nbsp;2023, with the properties themselves ' +
        'deleted a year later. They have shown nothing since. See ' +
        '<code>_SETUP-ANALYTICS.md</code> for what each source needs.</p>'));
      /* the frozen archive may still have something worth showing even with no
         day rows at all, so it is drawn below rather than skipped; the
         community's growth has a file of its own and is drawn on the same
         terms */
      drawGrowth();
      drawMembers();
      renderUniversities();
      return;
    }

    var tiles = document.createElement('div');
    root.appendChild(tiles);
    var tileData = Object.assign({}, data, { engagement: (data.engagementWindows || {})[state.range] || data.engagement });
    renderTiles(tiles, rows, tileData);

    var ranges = document.createElement('div');
    root.appendChild(ranges);
    chooser(ranges, {
      label: 'How much of the record to show',
      className: 'oa-pagerange',
      options: RANGES,
      value: state.range,
      onPick: function (id) { state.range = id; redraw('oa-pagerange', id); },
    });

    /* 1 — the daily series, in whichever of the three numbers the reader
       asked for, with its trailing 7-day mean over it */
    var metric = METRICS.filter(function (m) { return m.id === state.metric; })[0] || METRICS[0];
    var f1 = figure(metric.label + ', day by day',
      'One point per day: ' + metric.note + '. The dashed gold line is the trailing ' +
      'seven-day average, which is what the shape of the traffic looks like once the ' +
      'weekend is taken out of it. Press a name in the legend to put either line away. ' +
      'The chart also takes the keyboard, so the arrow keys walk it day by day.');
    root.appendChild(f1.section);
    /* WHICH SOURCE MEASURED WHAT, said where the days are drawn. A day
       belongs to exactly ONE source and the file records how many each gave,
       so the reader is told rather than left to assume the caption's subject.
       The dimension figures have carried this line all along; the chart the
       page opens on did not. */
    var srcs = (data.sources || []).filter(function (r) { return r && r.days > 0; });
    if (srcs.length) {
      var sp = document.createElement('p');
      sp.className = 'oa-figure-src';   // the same line the dimension figures carry
      sp.textContent = 'Measured by ' + srcs.map(function (r) {
        return sourceName(r.source) + ' (' + r.days +
          (r.days === 1 ? ' day' : ' days') + ')';
      }).join(' and ') + '.';
      f1.body.appendChild(sp);
    }
    chooser(f1.body, {
      label: 'Which number to plot',
      className: 'oa-switch oa-metric',
      options: METRICS,
      value: state.metric,
      onPick: function (id) { state.metric = id; redraw('oa-metric', id); },
    });
    var plot1 = document.createElement('div');
    f1.body.appendChild(plot1);
    var chartRows = withGaps(rows);
    var values = chartRows.map(function (r) { return r[metric.id]; });
    C.line(plot1, {
      title: metric.label + ' per day',
      points: chartRows.map(function (r) {
        return { label: pretty(r.day).replace(/ \d{4}$/, ''), label2: pretty(r.day) };
      }),
      series: [
        { name: metric.label, values: values, kind: 'brand', area: true },
        { name: '7-day average', values: A.rollingMean(values, 7), kind: 'accent', dashed: true },
      ],
      xTitle: 'Day',
      height: 280,
    });

    /* 1b. how the community has grown, under the visitors chart and before
       everything the reader has to scroll for. Drawn from its own served file
       and only when that file holds something (see drawGrowth). */
    drawGrowth();

    /* 1c. where those members work and where their universities are,
       anonymously (see drawMembers), beside the chart of how many there are */
    drawMembers();

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
      (monthSpan ? ' (' + monthSpan + ')' : '') + '. It ignores the range above, ' +
      'because a window shorter than a year cannot answer a question about the year. ' +
      'The Operations job market runs on an annual cycle, and this is the chart that ' +
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
       that have not are simply absent, rather than drawn as an empty axis. */
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
    /* THE PERIODS (owner, 2026-09-29: the row the universities figure
       carries, on this figure too). The builder tallies the list once per
       period under the range control's own ids; the chosen one is drawn,
       and a file carrying none (from before the periods existed, or a list
       another source owns) draws `data.pages` over its own window with no
       row, exactly as it always did. */
    var pw = data.pagesWindows || {};
    var hasPageWindows = RANGES.some(function (r) {
      return pw[r.id] && Array.isArray(pw[r.id].pages);
    });
    var pagePick = RANGES.filter(function (x) { return x.id === state.range; })[0] || RANGES[1];
    var pageWin = null;
    var pagePeriod = null;
    if (hasPageWindows) {
      if (pw[pagePick.id] && Array.isArray(pw[pagePick.id].pages)) {
        pageWin = pw[pagePick.id];
        pagePeriod = pagePick;
      } else if (pw.all && Array.isArray(pw.all.pages)) {
        pageWin = pw.all;
        pagePeriod = RANGES[RANGES.length - 1];
      }
    }
    var publicPages = ((pageWin ? pageWin.pages : data.pages) || []).filter(function (p) {
      return A.isPublicPath(p && p.path);
    });
    if (publicPages.length || hasPageWindows) {
      var win = pageWin
        ? { source: pageWin.source || (data.pagesWindow || {}).source || '', from: pageWin.from, to: pageWin.to, views: pageWin.views }
        : (data.pagesWindow || {});
      /* THE SHARE NEEDS A WHOLE. `views` is the window's entire pageview
         count, stated by the builder; the rows here are only the top of the
         list, so a share computed over them would be a share of the rows that
         fitted — the claim this figure briefly made. Without the stated
         whole, no share is offered and the subtitle does not promise one. */
      var pagesTotal = Math.max(0, Math.round(Number(win.views) || 0));
      var pageProse = pagePeriod && pagePeriod.prose ? pagePeriod.prose : '';
      var recordFrom = pw.all && pw.all.from ? pw.all.from : '';
      var pageSub;
      if (pageWin && !pageWin.from) {
        pageSub = 'Nothing was recorded in ' + pageProse + '. ' +
          'Choose a longer period to see what the record holds.';
      } else {
        pageSub = 'Pageviews, and how long a reader spends on each' +
          (pageProse ? ' in ' + pageProse : '') +
          (span(win) ? (pageProse ? ', ' : ', over ') + span(win) : '') +
          /* a period the record does not fill says so through its dates, the
             universities figure's own rule, for the same reason */
          (pageProse && recordFrom && win.from === recordFrom ? ', which is as far back as the record goes' : '') +
          '.' +
          (pagesTotal ? ' Hover or tab through a row for its share of all ' +
            C.full(pagesTotal) + ' pageviews in that ' + (pageProse ? 'period' : 'window') + '.' : '');
      }
      var f4 = figure('The most visited pages', pageSub);
      root.appendChild(f4.section);
      if (hasPageWindows) {
        /* the page's own range, as a row under the heading: pressing it is
           pressing the control at the top, and the whole page follows */
        var pbar = chooser(f4.section, {
          label: 'How much of the record to show for the pages',
          className: 'oa-switch oa-pagesrange',
          options: RANGES,
          value: pagePeriod ? pagePeriod.id : pagePick.id,
          onPick: function (id) { state.range = id; redraw('oa-pagesrange', id); },
        });
        f4.section.insertBefore(pbar, f4.section.querySelector('.oa-figure-sub'));
      }
      if (publicPages.length) {
        C.bars(f4.body, { showAll: true,
          unit: 'views',
          limit: 12,
          total: pagesTotal,
          xTitle: 'Page',
          items: publicPages.map(function (p) {
            var address = addressOf(p.path);
            return {
              label: p.title || address,
              href: address && address.charAt(0) === '/' ? address : null,
              value: p.views,
              /* SAID IN MINUTES, NOT IN SECONDS (owner, 2026-08-29). This line
                 used to read "1,952 seconds on average", which is a number a
                 reader has to divide by sixty before it means anything. AND
                 NAMED FOR WHAT IT IS (owner, 2026-09-08): "Average time on the
                 page" was the heading of a column in the numbers table under
                 this list, and when the table went (a bar list is its own
                 numbers; see bars() in oa-charts.js) the heading moved onto the
                 row, so the figure still says what the duration measures. */
              sub: p.avgSec ? 'Average time on the page: ' + C.duration(p.avgSec) : '',
            };
          }),
        });
      }
      if (win.source) provenance(f4.section, win);
    }

    renderUniversities();
  }

  /** One dimension figure, or nothing at all.

      DRAWN ONLY WHERE A SOURCE HAS ANSWERED. A heading over an empty axis is
      exactly the shape of the defect this page was rebuilt to remove — four
      boxes reporting nothing to anybody — so a dimension with no record is
      drawn nowhere. THIS EARLY RETURN IS THE WHOLE PROMISE: the note at the
      foot that also named the absences was removed by the owner (2026-08-30),
      and the selftest pins this line for that reason. */
  function drawDimension(id) {
    var def = DIMENSIONS.filter(function (d) { return d.id === id; })[0];
    var period = (state.data.breakdownWindows || {})[state.range];
    var rec = (period ? period[id] : (state.data.breakdowns || {})[id]) || null;
    if (id === 'referrers') rec = A.referralRecord(rec);
    if (!def || !rec || !rec.items || !rec.items.length) return;

    var f = figure(def.title, def.sub);
    root.appendChild(f.section);

    if (def.kind === 'columns') {
      C.columns(f.body, {
        title: def.title,
        /* the site's own record files one session per PAGE, so its "visits"
           are page opens — the same honesty the daily chart's retired Visits
           metric and the engagement tile already keep */
        unit: (def.unitBySource && def.unitBySource[rec.source]) || def.unit,
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
      C.bars(f.body, { showAll: true,
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

  /** How the community has grown: the registered accounts, day by day, and
   *  where the last few months' growth would take the count if it simply
   *  continued.
   *
   *  DRAWN ONLY WHEN data/users-growth.json HOLDS SOMETHING, the page's rule
   *  for every figure: the committed seed carries no days, and a seed drawn as
   *  a chart would be the empty axis this page was rebuilt to remove. The
   *  file is written by the roster sync (counts and dates, nothing else) and
   *  is the same source the front page's registered-users tile reads.
   *
   *  THE DASHED LINE IS SAID EXACTLY. It is `growthProjection` in the model,
   *  a straight-line trend fitted over the last GROWTH_WINDOW days and carried
   *  through the last real point to GROWTH_AHEAD days after TODAY, and the
   *  caption names the window from its constant and the days carried from the
   *  RESULT (horizon minus last real day): GROWTH_AHEAD (a week) on the fresh
   *  copy the daily sync writes, more on a stale one, since the model anchors
   *  the horizon on the reader's day and a fixed "7" would then understate
   *  the line drawn above it. It calls the line an expectation from past growth rather than
   *  a target, and gives the count it reaches. It is
   *  drawn in the chart accent (the site's yellow, re-stepped in the dark
   *  theme so it stays tellable from the brand line) and dashed, so the pair
   *  never relies on colour alone. The legend is the same click-to-hide
   *  control the daily chart has. (It used to hand line() a numbers table of
   *  one row per month; no chart draws one since 2026-09-08.) */
  function monthLabel(day) {
    if (!day) return '';
    var p = day.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).toLocaleDateString('en-GB',
      { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  function drawGrowth() {
    var g = state.growth;
    var actual = g && Array.isArray(g.days) ? g.days.filter(function (p) {
      return Array.isArray(p) && A.isDay(p[0]) && Number.isFinite(Number(p[1]));
    }) : [];
    if (actual.length < 2) return;
    var today = new Date().toISOString().slice(0, 10);
    var proj = A.growthProjection(actual, { window: GROWTH_WINDOW, ahead: GROWTH_AHEAD, today: today });
    if (!proj) return;

    var days = actual.map(function (p) { return p[0]; });
    var have = actual.map(function (p) { return Number(p[1]); });
    var expect = actual.map(function () { return null; });
    /* the two lines MEET: the projection's first point is the last actual day */
    expect[expect.length - 1] = proj.points[0][1];
    proj.points.slice(1).forEach(function (p) {
      days.push(p[0]);
      have.push(null);
      expect.push(p[1]);
    });

    /* the days the line is really carried, read off the result rather than
       the constant: a stale copy of the file is projected past today */
    var carried = Math.round((Date.parse(proj.horizon) - Date.parse(proj.lastDay)) / 86400000);
    var f = figure('How the community has grown',
      'Registered accounts on the site, day by day, since the first one. The yellow ' +
      'dashed line is a straight-line trend fitted over the last ' + GROWTH_WINDOW +
      ' days and carried ' + carried + ' days forward; an expectation from past ' +
      'growth, not a target. ' + C.full(proj.lastValue) + ' registered users on ' +
      pretty(proj.lastDay) + '; the trend reaches ' + C.full(proj.reached) + ' by ' +
      pretty(proj.horizon) + '. Press a name in the legend to put either line away.');
    root.appendChild(f.section);

    C.line(f.body, {
      title: 'Registered users over time',
      points: days.map(function (d) { return { label: monthLabel(d), label2: pretty(d) }; }),
      series: [
        { name: 'Registered users', values: have, kind: 'brand', area: true },
        { name: 'Expected growth', values: expect, kind: 'accent', dashed: true },
      ],
      xTitle: 'Day',
      height: 260,
    });
  }

  /** Who the registered members are: data/users-insights.json, written by
   *  the roster sync on its daily run (_scraper/members-insights.mjs).
   *
   *  ONLY WHAT MEMBERS TOLD THE SITE, NOTHING GUESSED (owner, 2026-10-01:
   *  "don't make guesses, it's risky. use only information actually provided
   *  from the users themselves"). Both figures count what a member stated on
   *  their profile: the affiliation they typed, matched to a university only
   *  by name, and the country of that university, or one they wrote. There is
   *  no gender figure because the site has never asked for gender.
   *
   *  TWO FIGURES AND NO MORE (owner, the same day: "update it to include
   *  only: where they work, with a table of the universities that at least
   *  three members name; the countries those universities are in. the rest
   *  are not very interesting and do not show them"). The strip of tiles,
   *  how members sign in, ORCID iDs and the two roles were built and then
   *  removed; the served file no longer carries any of them.
   *
   *  ANONYMOUS BY CONSTRUCTION, and the first caption says how. The file
   *  holds counts and nothing else; no university or country is named for
   *  fewer than `k` (three) members; and no figure crosses one fact with
   *  another. The page draws nothing at all from the committed seed
   *  (members: 0), the rule every figure here follows. */

  /* a part with nobody in it would draw a zero-width block and a "0%" key */
  function nonZero(items) {
    return items.filter(function (it) { return it.value > 0; });
  }

  function drawMembers() {
    var m = state.members;
    if (!m || !(m.members > 0) || !m.affiliation) return;
    var n = m.members;
    var when = m.generated ? pretty(String(m.generated).slice(0, 10)) : '';
    var k = m.k || 3;
    var aff = m.affiliation;
    var u = m.universities || {};
    var c = m.countries || null;

    /* where they work: how many named a university the site lists, then
       those universities by name */
    var shown = Array.isArray(u.shown) ? u.shown : [];
    var fa = figure('Where members work',
      'The affiliation each of the ' + C.full(n) + ' registered members' + (when ? ' on ' + when : '') +
      ' gave on their profile, refreshed throughout the day from what they told the site and nothing else: ' +
      'nothing is guessed about anybody. An affiliation is matched to a university this site lists ' +
      'only where it names one: by the university\'s name, one of its schools, or a short form the ' +
      'site knows. ' + C.full(aff.listed || 0) + ' members name ' + C.full(u.count || 0) +
      (u.count === 1 ? ' university' : ' universities') + '; the table names every one with at ' +
      'least ' + k + ' members' + (u.rest ? ', and the ' + C.full(u.rest) + ' members at the others ' +
      'are counted together rather than named' : '') + '. An affiliation that names no listed ' +
      'university is counted as another affiliation, never sorted or placed. ' +
      'Anonymous by construction: only counts are published, ' +
      'no university or country is named for fewer than ' + k + ' members, ' +
      'and no figure crosses one fact with another.');
    fa.section.classList.add('oa-members');
    root.appendChild(fa.section);
    C.share(fa.body, {
      title: 'Members by affiliation',
      unit: 'members',
      total: n,
      restLabel: 'Not given',
      items: nonZero([
        { label: 'A university this site lists', value: aff.listed || 0 },
        { label: 'Another affiliation', value: aff.other || 0 },
      ]),
    });
    if (shown.length) {
      var list = document.createElement('div');
      list.className = 'oa-members-unis';
      fa.body.appendChild(list);
      C.bars(list, {
        unit: 'members',
        limit: shown.length,
        total: n,
        xTitle: 'University',
        items: shown.map(function (r) {
          return { label: r.name, value: r.members, sub: r.country || '' };
        }),
      });
    }

    /* the countries of those universities */
    if (c && Array.isArray(c.shown) && c.shown.length) {
      var fc = figure('Where their universities are',
        'The country of the university a member named, as this site\'s own directory records it, ' +
        'or a country they wrote at the end of their affiliation. ' + C.full(c.count) +
        (c.count === 1 ? ' country' : ' countries') + ' in all; those with at least ' + k +
        ' members are named' + (c.rest ? ', the ' + C.full(c.rest) + ' members elsewhere are counted ' +
        'together' : '') + (c.unknown ? ', and ' + C.full(c.unknown) + ' members are not placed in ' +
        'any country: they gave no affiliation, or the site does not know where the university ' +
        'they named is' : '') + '.');
      root.appendChild(fc.section);
      C.bars(fc.body, {
        unit: 'members',
        limit: c.shown.length,
        total: n,
        xTitle: 'Country',
        items: c.shown.map(function (r) { return { label: r.name, value: r.members }; }),
      });
    }
  }

  /** Which universities read the site.
   *
   *  IT IS A SAMPLE AND IT SAYS SO. The university is worked out from the
   *  visitor's own network, which is only knowable when their address
   *  reverse-resolves to a name — true of a campus office, false of a phone
   *  on mobile data or a campus behind a commercial CDN. So the caption
   *  always carries the SHARE of visits it could place. A ranking printed
   *  without that share reads as "these are the universities that visit",
   *  which is a claim this measurement cannot make, and the reason the rest
   *  of this page exists is that a figure nobody can check goes wrong quietly.
   *
   *  IT TAKES THE PAGE'S RANGE (owner, 2026-09-08: the last 30 days, the
   *  last 90, the last 12 months or everything). The served block carries
   *  the counters tallied once per period under the range control's own
   *  ids (`windows`, see visitWindows in the model), so the figure reads the
   *  chosen period's ranking AND its coverage counts — the share it prints
   *  is the share of that period, never the whole record's over a month's
   *  bars. The four periods are drawn as a row of the figure's own, under
   *  the heading and above the caption the choice rewrites: it is the SAME
   *  range as the control at the top of the page, one notion of "how much of
   *  the record" for the whole page, placed where the reader is looking. A
   *  period the record is shorter than says so through its own dates ("as
   *  far back as the record goes"); a period with nothing placed in it says
   *  that and points at a longer one, rather than drawing an empty axis. A
   *  served block from before the periods existed carries none, and the
   *  figure is then drawn from the whole record with no row to press.
   *
   *  A frozen ARCHIVE — a closed, differently-measured period — is drawn the
   *  same way but labelled, carries no periods (a closed decade has no "last
   *  30 days"), and the builder never merges the two. */
  function renderUniversities() {
    var u = (state.data && state.data.universities) || {};
    if (!u.all || !u.all.length) return;

    var hasWindows = !u.frozen && !!u.windows && RANGES.some(function (r) {
      return u.windows[r.id] && Array.isArray(u.windows[r.id].all);
    });
    var pick = RANGES.filter(function (x) { return x.id === state.range; })[0] || RANGES[1];
    /* the chosen period; a served file predating a range the page has since
       gained falls back to everything on record rather than to a guess */
    var win = null;
    var period = null;
    if (hasWindows) {
      if (u.windows[pick.id] && Array.isArray(u.windows[pick.id].all)) {
        win = u.windows[pick.id];
        period = pick;
      } else if (u.windows.all && Array.isArray(u.windows.all.all)) {
        win = u.windows.all;
        period = RANGES[RANGES.length - 1];
      }
    }
    var w = win || u;

    /* `range`, never `span`: this file now has a span() FUNCTION for the
       dimension records, and a local of that name would shadow it. */
    var range = w.from && w.to ? pretty(w.from) + ' to ' + pretty(w.to) : '';
    var sub;
    var opts = null;

    if (u.frozen) {
      sub = 'Visits by university, counted from the visitor\'s own network. ' +
        (range ? 'Covers ' + range + '. ' : '') +
        'An archive: it was measured differently from the figures above and ' +
        'is not being added to.';
      opts = { frozen: 'Archive' + (u.from ? ': ' + u.from.slice(0, 4) + ' to ' + u.to.slice(0, 4) : '') };
    } else {
      /* THE DENOMINATOR IS WHAT THE SENTENCE CLAIMS. `resolved` counts every
         address reverse DNS answered for, an internet provider included, so
         dividing by it would print "29% came from a university" over a figure
         that counts BT Broadband. What is placed AT a university is the sum of
         the bars themselves — one visit increments exactly one of them. */
      var seen = Number(w.seen) || 0;
      /* the builder publishes the true total; summing the ROWS is the
         fallback, and would be a little low whenever the list is longer than
         the cut the served file makes */
      var placed = Number(w.placed) ||
        w.all.reduce(function (n, x) { return n + (Number(x.visits) || 0); }, 0);
      var acad = Number(w.academic) || 0;
      var share = seen ? Math.round((placed / seen) * 100) : 0;
      var prose = period && period.prose ? period.prose : '';
      sub = 'Visits by university, worked out from the visitor\'s own network. ' +
        'Nobody is identified and no address is kept. ';
      if (win && !w.from) {
        /* the record has no day inside this period at all: the resolver has
           stopped, or the period is shorter than the gap since it did */
        sub += 'Nothing was recorded in ' + prose + '. ' +
          'Choose a longer period to see what the record holds.';
      } else if (win && !w.all.length) {
        sub += 'Of ' + C.full(seen) + (seen === 1 ? ' visit' : ' visits') +
          ' in ' + prose + ', none was placed at a university listed here' +
          (acad ? ', though ' + C.full(acad) + ' came from a university this site has ' +
            'no department page for' : '') +
          '. Choose a longer period to see more of the record.';
      } else {
        /* THE COUNT LIVES HERE, not in a tile. It is a fact about this one
           figure rather than a headline about the corpus, and the tiles cap at
           five: a sixth orphans onto a row of its own at every width the page
           is read at (measured 1400/1180/1024px), which is why the length and
           the depth of a visit share one tile. */
        sub += C.full(w.all.length) + (w.all.length === 1 ? ' university' : ' universities') +
          (prose ? ' in ' + prose : '') +
          (range ? ', ' + range : '') +
          /* a period the record does not fill says so through its dates: a
             reader who pressed "Last 12 months" over a record ten days old
             would otherwise take the dates for the control being broken */
          (prose && u.from && w.from === u.from ? ', which is as far back as the record goes' : '') +
          '. ';
        if (seen) {
          sub += 'It is a sample rather than a count: of ' + C.full(seen) + ' visits, ' +
            C.full(placed) + ' (' + share + '%) were placed at a university listed here' +
            (acad ? ', and ' + C.full(acad) + ' more came from a university this site ' +
              'has no department page for' : '') +
            '. The rest were on commercial or home connections, which are not ' +
            'recorded at all. Read the shape rather than the totals.';
        }
      }
    }

    var f = figure('Which universities visited', sub, opts);
    root.appendChild(f.section);
    if (hasWindows) {
      /* the page's own range, as a row under the heading: pressing it is
         pressing the control at the top, and the whole page follows */
      var bar = chooser(f.section, {
        label: 'How much of the record to show for the universities',
        className: 'oa-switch oa-unirange',
        options: RANGES,
        value: pick.id,
        onPick: function (id) { state.range = id; redraw('oa-unirange', id); },
      });
      f.section.insertBefore(bar, f.section.querySelector('.oa-figure-sub'));
    }
    if (!w.all.length) return;
    C.bars(f.body, { showAll: true, unit: 'visits', limit: 25, xTitle: 'University',
      /* the live figure's shares are of PLACED visits — the builder's true
         total for the chosen period, the same number the sentence above
         quotes — never of the 25 rows that fitted (bars() offers no share
         without a stated whole). The frozen archive states no whole, so its
         rows carry no share rather than a made-up one. */
      total: (!u.frozen && Number(w.placed)) || 0,
      items: w.all.map(function (x) {
        return { label: x.name, value: x.visits };
      }) });
  }

  /* There is DELIBERATELY no "Where these figures come from" section. The
     page carried one — sources, spans, the cookieless trade-off, the figures
     not yet drawn — and the owner had it removed (2026-08-30): how the site
     is measured is not the readers' business. What that section also did is
     NOT lost: a figure with no source is still simply not drawn (see
     drawDimension), and the per-figure provenance lines still name each
     chart's own span, which is a property of the numbers rather than of the
     plumbing. */

  /* ------------------------------------------------------------------- load */

  /* `no-cache` REVALIDATES rather than re-downloads — Pages serves data/ with
     ten minutes of freshness, so without it a reader who was here recently is
     shown what they already had. The rule every fetch of data/ on this site
     follows. */
  /* THE CHARTS ARE DRAWN AT THE WIDTH THEY ARE SHOWN AT (see plotWidth in
     oa-charts.js), so a width that changes needs a redraw — a rotated phone,
     a resized window, a developer dock. One debounced listener for the whole
     page: draw() rebuilds every figure in a few milliseconds, each chart owns
     no observer of its own (an observer per chart would leak one per redraw),
     and a resize that did not change the width — a phone's URL bar collapsing
     changes only the HEIGHT, on every scroll — redraws nothing. */
  var drawnAt = 0;
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      if (!state.data) return;
      var w = root.clientWidth || 0;
      if (Math.abs(w - drawnAt) > 1) draw();
    }, 150);
  });

  /* THE GROWTH FILE IS A SECOND, INDEPENDENT READ. A failure here costs the
     one figure and nothing else: the page draws whatever it has, and draws
     again if the file lands after the analytics data did. */
  fetch('/data/users-growth.json', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (g) {
      state.growth = g && Array.isArray(g.days) ? g : null;
      if (state.data && state.growth && state.growth.days.length) draw();
    })
    .catch(function () { state.growth = null; });

  /* THE MEMBERS FILE IS A THIRD, INDEPENDENT READ, on the growth file's
     terms: a failure costs those figures and nothing else. */
  fetch('/data/users-insights.json', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (d) {
      state.members = d && d.members > 0 ? d : null;
      if (state.data && state.members) draw();
    })
    .catch(function () { state.members = null; });

  fetch('/data/analytics.json', { cache: 'no-cache' })   // the shared substrate is absolute
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
        'network problem rather than a broken page. Reloading is worth a try.</p>'));
    });
  /* Poll the three independent snapshots while visible. Failed reads retain
     the last good charts; no member details or database access are exposed.
     Do not rebuild a chart while a reader is using its keyboard controls. */
  var refreshing = false;
  var pendingRedraw = false;
  function refreshSnapshots() {
    if (document.hidden || refreshing || root.contains(document.activeElement)) return;
    if (pendingRedraw && state.data) { draw(); pendingRedraw = false; }
    refreshing = true;
    var stamp = Date.now();
    var specs = [
      { key: 'data', file: 'analytics', valid: function (d) { return d && d.days && typeof d.days === 'object'; } },
      { key: 'growth', file: 'users-growth', valid: function (d) { return d && Array.isArray(d.days); } },
      { key: 'members', file: 'users-insights', valid: function (d) { return d && d.members > 0 && d.affiliation; } },
    ];
    var changed = false;
    Promise.all(specs.map(function (spec) {
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 10000);
      return fetch('/data/' + spec.file + '.json?v=' + stamp,
        { cache: 'no-store', signal: controller.signal })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (d) {
          if (spec.valid(d) && JSON.stringify(d) !== JSON.stringify(state[spec.key])) {
            state[spec.key] = d;
            changed = true;
          }
        }).catch(function () {})
        .then(function () { clearTimeout(timeout); });
    })).then(function () {
      refreshing = false;
      pendingRedraw = pendingRedraw || changed;
      if (pendingRedraw && state.data && !root.contains(document.activeElement)) {
        draw(); pendingRedraw = false;
      }
    });
  }
  setInterval(refreshSnapshots, 60000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshSnapshots();
  });
}());
