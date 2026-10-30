(function () {
  'use strict';
  var root = document.getElementById('profile-analytics'), generation = 0, request = 0;
  function el(tag, text, cls) {
    var n = document.createElement(tag); n.textContent = text == null ? '' : text;
    if (cls) n.className = cls; return n;
  }
  function number(n) { return Number(n || 0).toLocaleString(); }
  function duration(n) { n = Math.round(n || 0); return n < 60 ? n + ' sec' : n < 3600 ? Math.floor(n / 60) + ' min ' + n % 60 + ' sec' : Math.floor(n / 3600) + ' hr ' + Math.floor(n % 3600 / 60) + ' min'; }
  function title(item) {
    var d = item.data;
    return d.name || [d.first, d.last].filter(Boolean).join(' ') || d.institution || d.ref || item.type;
  }
  function drawReport(parent, data, period, type) {
    parent.replaceChildren();
    var r = data[period];
    if (!r) { parent.appendChild(el('p', 'This reporting period is not available yet.')); return; }
    var metrics = el('div', '', 'pa-metrics');
    [[type === 'candidate' ? 'Profile views' : 'Posting views', number(r.views), 'Visible, expanded views'],
      ['Unique viewers', number(r.viewers), 'Approximate accounts and browsers'],
      ['Link clicks', number(r.clicks), 'Links within this listing'],
      ['Listing clicks', typeof r.interactions === 'number' ? number(r.interactions) : '—', 'Detail and control clicks since 13 Oct 2026'],
      ['Total reading time', duration(r.seconds), 'Active time across all measured views'],
      ['Average reading time', r.views ? duration(r.seconds / r.views) : '—', 'Active time per view']].forEach(function (v) {
      var box = el('div', '', 'pa-metric'); box.append(el('p', v[0]), el('strong', v[1]), el('span', v[2])); metrics.appendChild(box);
    }); parent.appendChild(metrics);
    var clicksPanel = el('section', '', 'pa-panel pa-clicks');
    clicksPanel.append(el('h3', 'Clicks and reading time by detail'), el('p', 'See which parts of your ' + (type === 'candidate' ? 'profile' : 'job posting') + ' people interact with and how long each detail is visible while they read. Clicks include links, controls and text.', 'v3-mut'));
    if (!Array.isArray(r.parts)) {
      clicksPanel.appendChild(el('p', 'The click breakdown will appear after the next report refresh. Earlier reports did not include these details.'));
    } else if (!r.parts.length) {
      clicksPanel.appendChild(el('p', 'No detail activity was measured in this period yet.'));
    } else {
      var table = el('table', '', 'pa-click-table'), theadClicks = el('thead'), headings = el('tr');
      ['Listing detail', 'Clicks', 'Link clicks', 'Reading time', 'Average per view'].forEach(function (label) { var th = el('th', label); th.scope = 'col'; headings.appendChild(th); });
      theadClicks.appendChild(headings); table.appendChild(theadClicks);
      var rows = el('tbody'), most = Math.max.apply(null, r.parts.map(function (p) { return p.clicks; }).concat([1]));
      r.parts.forEach(function (p) {
        var tr = el('tr'), name = el('th', p.name); name.scope = 'row';
        var count = el('td'), meter = el('span', '', 'pa-click-meter');
        meter.style.setProperty('--share', Math.max(0, Math.min(100, 100 * p.clicks / most)) + '%'); meter.setAttribute('aria-hidden', 'true');
        count.append(el('strong', number(p.clicks)), meter); tr.append(name, count, el('td', number(p.linkClicks)),
          el('td', typeof p.seconds === 'number' ? duration(p.seconds) : '—'),
          el('td', p.averageSeconds == null ? '—' : duration(p.averageSeconds)));
        ['Clicks', 'Link clicks', 'Reading time', 'Average per view'].forEach(function (label, i) { tr.children[i + 1].setAttribute('data-label', label); });
        rows.appendChild(tr);
      });
      table.appendChild(rows); var clickScroll = el('div', '', 'pa-table-scroll'); clickScroll.appendChild(table); clicksPanel.appendChild(clickScroll);
    }
    clicksPanel.appendChild(el('p', 'Detailed clicks have been collected since 13 October 2026. Link clicks are included in each row’s click count. Opening and closing the listing also count as clicks. Reading time estimates active time with each detail on screen. Average per view is per viewing episode of that detail. Details visible together accrue overlapping time, so their times should not be added together. External CVs and websites cannot be timed.', 'pa-footnote'));
    clicksPanel.appendChild(el('p', data.partTimeTrackingSince ? 'Detail reading time has been collected since 13 October 2026.' : 'Detail reading time will appear after the next report refresh.', 'pa-footnote'));
    parent.appendChild(clicksPanel);
    var columns = el('div', '', 'pa-columns'), trend = el('section', '', 'pa-panel');
    trend.append(el('h3', 'Views over time'), el('p', 'The last 30 calendar days (UTC)', 'v3-mut'));
    var days = [], end = new Date(data.updatedAt); end.setUTCHours(0, 0, 0, 0);
    for (var i = 29; i >= 0; i--) {
      var day = new Date(+end - i * 86400000).toISOString().slice(0, 10);
      days.push({ day: day, count: (data.all.days || {})[day] || 0 });
    }
    var max = Math.max.apply(null, days.map(function (d) { return d.count; }).concat([1]));
    var chart = el('div', '', 'pa-chart'); chart.setAttribute('aria-label', 'Daily views over the last 30 days');
    days.forEach(function (d) {
      var bar = el('div', '', 'pa-bar'); bar.style.setProperty('--height', Math.max(1, 100 * d.count / max) + '%');
      bar.setAttribute('aria-label', d.day + ': ' + d.count + ' views'); bar.title = d.day + ': ' + d.count + ' views'; chart.appendChild(bar);
    });
    trend.appendChild(chart);
    var labels = el('div', '', 'pa-chart-labels'); labels.append(el('span', days[0].day), el('span', days[29].day)); trend.appendChild(labels);
    if (!days.some(function (d) { return d.count; })) trend.appendChild(el('p', 'No measured views in the last 30 days.'));
    var details = el('details', '', 'pa-daily'); details.appendChild(el('summary', 'View daily figures'));
    var daily = el('table', '', 'oa-kv'); days.slice().reverse().forEach(function (d) { var tr = el('tr'); tr.append(el('th', d.day), el('td', number(d.count))); daily.appendChild(tr); }); details.appendChild(daily); trend.appendChild(details);
    columns.appendChild(trend);
    var countries = el('section', '', 'pa-panel'); countries.append(el('h3', 'Audience by country'), el('p', 'Views measured by Google Analytics', 'v3-mut'));
    if (!data.countriesReady) countries.appendChild(el('p', 'Country data is not available yet. It will appear after Google Analytics processes the first measured views.'));
    else {
      var list = el('ol', '', 'pa-countries'), total = (r.countries || []).reduce(function (n, c) { return n + c.views; }, 0);
      (r.countries || []).forEach(function (c) {
        var li = el('li'), row = el('div', '', 'pa-country-label'); row.append(el('span', c.name), el('strong', number(c.views)));
        var meter = el('div', '', 'pa-country-meter'), fill = el('span'); fill.style.width = (total ? 100 * c.views / total : 0) + '%'; meter.appendChild(fill); li.append(row, meter); list.appendChild(li);
      }); countries.appendChild(list);
      if (!(r.countries || []).length) countries.appendChild(el('p', 'No country views were measured for this period.'));
      countries.appendChild(el('p', 'Coverage differs from the totals above and may include your own visits. Countries are approximate.', 'pa-footnote'));
      countries.appendChild(el('p', 'Country data updated ' + new Date(data.countriesUpdatedAt).toLocaleString(), 'pa-footnote'));
    }
    columns.appendChild(countries); parent.appendChild(columns);
    var universityPanel = el('section', '', 'pa-panel pa-universities');
    universityPanel.append(el('h3', 'Universities viewing your listing'), el('p', 'Based on the university currently listed in signed-in visitors’ OA accounts. Anonymous and unmatched visits appear as Unknown.', 'v3-mut'));
    var universityTable = el('table', '', 'oa-kv');
    var head = el('tr'); ['University', 'Views', 'Link clicks', 'Average reading time'].forEach(function (label) { var th = el('th', label); th.scope = 'col'; head.appendChild(th); });
    var thead = el('thead'); thead.appendChild(head); universityTable.appendChild(thead);
    var tbody = el('tbody');
    (r.universities || []).forEach(function (uni) { var row = el('tr'); row.append(el('th', uni.name), el('td', number(uni.views)), el('td', number(uni.clicks)), el('td', uni.averageSeconds == null ? '—' : duration(uni.averageSeconds))); row.firstChild.scope = 'row'; tbody.appendChild(row); });
    universityTable.appendChild(tbody); var scroll = el('div', '', 'pa-table-scroll'); scroll.appendChild(universityTable); universityPanel.appendChild(scroll);
    if (!(r.universities || []).length) universityPanel.appendChild(el('p', 'No university visits have been measured for this period yet.'));
    universityPanel.appendChild(el('p', 'Average reading time = total active reading time from that university ÷ measured views. These are visitors’ stated affiliations, not proof that a university is recruiting you. Individual visitors are never identified.', 'pa-footnote'));
    parent.appendChild(universityPanel);
    var detail = el('details', '', 'pa-definition'); detail.appendChild(el('summary', 'How these figures are measured'));
    detail.appendChild(el('p', 'Views count expanded cards visible in a focused tab. Returning to a card starts a new viewing episode. Reading time pauses in hidden tabs and after 60 seconds without interaction. Unique viewers are approximate browser/account counts. First-party totals exclude your own visits and admin visits. Browser privacy settings and interrupted connections can prevent measurement. Time on external CVs or websites cannot be measured.'));
    detail.appendChild(el('p', 'Total active reading time: ' + duration(r.seconds) + '. Listing-open clicks: ' + number(r.opens) + '.'));
    parent.appendChild(detail);
    parent.appendChild(el('p', 'Updated ' + new Date(data.updatedAt).toLocaleString() + ' · Refreshes approximately every 15 minutes.', 'pa-footnote'));
  }
  if (!window.OAFB || !OAFB.enabled) { root.textContent = 'Analytics is not available yet.'; return; }
  OAAccounts.onChange(async function (user) {
    if (window.OAFeatureBadges) OAFeatureBadges.refresh();
    var turn = ++generation; request++; root.replaceChildren();
    if (!user) {
      root.appendChild(el('p', 'Sign in to see your private Job & Profile Analytics.'));
      var signIn = el('a', 'Sign in', 'v3-btn primary'); signIn.href = 'account'; root.appendChild(signIn); return;
    }
    root.appendChild(el('p', 'Loading your listings…'));
    try {
      var fb = await OAFB.ready(), db = fb.firestore(), admin = OAAccounts.isAdmin();
      var groups = await Promise.all(['candidateSubmissions', 'jobSubmissions'].map(async function (col) {
        var query = db.collection(col); if (!admin) query = query.where('uid', '==', user.uid);
        var snap = await query.get();
        return snap.docs.map(function (doc) { return { type: col === 'candidateSubmissions' ? 'candidate' : 'job', data: doc.data(), ref: doc.ref }; });
      }));
      if (turn !== generation) return;
      root.replaceChildren(); var listings = groups.flat();
      if (!listings.length) {
        root.appendChild(el('h2', 'Your reach starts here'));
        root.appendChild(el('p', 'Once you post a candidate profile or job, its private report will appear here.'));
        var jobs = el('a', 'Post a job', 'v3-btn primary'); jobs.href = 'post-a-job';
        var candidate = el('a', 'Post your candidacy', 'v3-btn ghost'); candidate.href = 'post-a-candidate'; root.append(jobs, candidate); return;
      }
      var controls = el('div', '', 'pa-controls'), chooserLabel = el('label', admin ? 'All users’ listings · Admin view' : 'Your profiles and job postings'), chooser = el('select');
      chooser.setAttribute('aria-label', 'Choose a listing');
      listings.forEach(function (item, i) {
        var option = el('option', (item.type === 'candidate' ? 'Candidate · ' : 'Job · ') + title(item) + (item.data.ref ? ' · ' + item.data.ref : ''));
        option.value = String(i); chooser.appendChild(option);
      }); chooserLabel.appendChild(chooser);
      var periodLabel = el('label', 'Period'), period = el('select'); period.setAttribute('aria-label', 'Reporting period');
      [['last30', 'Last 30 days'], ['all', 'Since tracking began']].forEach(function (v) { var option = el('option', v[1]); option.value = v[0]; period.appendChild(option); }); periodLabel.appendChild(period); controls.append(admin || listings.length > 1 ? chooserLabel : el('p', 'Private to you and the site administrator', 'pa-private-note'), periodLabel); root.appendChild(controls);
      var heading = el('div', '', 'pa-listing-heading'), content = el('div'); content.setAttribute('aria-live', 'polite'); root.append(heading, content);
      var cached = new Map();
      async function show() {
        var ticket = ++request, item = listings[Number(chooser.value)]; heading.replaceChildren();
        heading.append(el('p', item.type === 'candidate' ? 'Candidate Profile Analytics' : 'Job Posting Analytics', 'v3-kicker'), el('h2', title(item)));
        content.replaceChildren(el('p', 'Loading report…'));
        try {
          var key = item.ref.path;
          if (!cached.has(key)) {
            var stats = await item.ref.collection('analytics').doc('current').get(); cached.set(key, stats.exists ? stats.data() : null);
          }
          if (turn !== generation || ticket !== request) return;
          var data = cached.get(key);
          if (data) drawReport(content, data, period.value, item.type);
          else content.replaceChildren(el('h3', 'Your report is on its way'), el('p', 'Reports begin once your listing is public and the first analytics refresh completes. Your figures will appear here automatically on your next visit.'));
        } catch (e) { if (turn === generation && ticket === request) content.replaceChildren(el('p', 'This report could not be loaded. Refresh the page to try again.')); }
      }
      chooser.addEventListener('change', show); period.addEventListener('change', show); show();
    } catch (e) { if (turn === generation) root.textContent = 'Your listings could not be loaded. Please refresh and try again.'; }
  });
}());
