/* Public cohort totals only. This module never downloads candidate profiles. */
(function () {
  'use strict';
  function mount(opts) {
    var pending = false;
    var count = document.getElementById('oa-cohort-count');
    var label = document.getElementById('oa-cohort-count-label');
    var research = document.getElementById('oa-cohort-research');
    var areas = document.getElementById('oa-cohort-research-areas');
    var status = document.getElementById('oa-cohort-status');
    var signin = document.getElementById('oa-cohort-signin');
    signin.querySelector('button').addEventListener('click', function () {
      if (window.OAAccounts) OAAccounts.openAuth();
    });
    if (window.OAAccounts) OAAccounts.onChange(function (user) { signin.hidden = !!user; });
    function refresh() {
      if (pending || document.hidden) return Promise.resolve();
      pending = true;
      return fetch('/data/candidates-meta.json', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (res) { if (!res.ok) throw new Error('metadata-unavailable'); return res.json(); })
        .then(function (meta) {
          var revealed = OAReveal.isRevealed(meta.revealAt);
          var total = Number(revealed ? meta.count : meta.heldCount);
          if (!Number.isInteger(total) || total < 0) throw new Error('invalid-count');
          count.textContent = total.toLocaleString('en-US');
          label.textContent = 'candidate profile' + (total === 1 ? '' : 's') + (revealed ? '' : ' submitted');
          var summary = revealed && Array.isArray(meta.researchSummary) ? meta.researchSummary : [];
          areas.textContent = '';
          summary.forEach(function (area) {
            if (!area || typeof area.label !== 'string' || !Number.isInteger(area.count) || area.count < 1 || area.count > total) return;
            var item = document.createElement('li');
            item.textContent = area.label + ' · ' + area.count.toLocaleString('en-US');
            areas.appendChild(item);
          });
          research.hidden = !areas.children.length;
          status.hidden = true;
          if (opts && opts.onMeta) opts.onMeta(meta);
        }).catch(function () {
          status.textContent = count.textContent === '—'
            ? 'Candidate statistics are temporarily unavailable.'
            : 'Statistics could not be refreshed. Showing the last available totals.';
          status.hidden = false;
        }).then(function () { pending = false; });
    }
    refresh();
    setInterval(refresh, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    return { refresh: refresh };
  }
  window.OACandidateSummary = { mount: mount };
}());
