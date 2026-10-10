      document.addEventListener('DOMContentLoaded', function () {
        var started = false, checking = false;
        function checkReveal() {
          if (started || checking) return;
          checking = true;
          fetch('/data/candidates-reveal.json', {cache:'no-cache'}).then(function(r){if(!r.ok)throw new Error(r.status);return r.json();}).then(function(meta){
            var note = document.getElementById('oa-reveal-note');
            if (!OAReveal.isRevealed(meta.revealAt)) {
              if (meta.revealAt) note.textContent='The candidate list opens on ' + OAReveal.formatDay(meta.revealAt) + ' at 14:00 UTC. Until then, candidate profiles remain private. You can create or update your profile now.';
              return;
            }
            started = true;
            note.hidden = true;
            document.getElementById('oa-candidates-content').hidden = false;
            document.getElementById('oa-candidates-intro').hidden = false;
            mountCandidates();
          }).catch(function(){}).then(function(){checking=false;});
        }
        checkReveal();
        setInterval(checkReveal, 60000);
        document.addEventListener('visibilitychange', function(){if(!document.hidden)checkReveal();});
        function mountCandidates() {
        function inCurrentMarket(row) { return OAJobNav.inCurrentMarket(row); }
        var candidateCard = OACandCard.cardConfig();
        candidateCard.title = function (r) { return OAGate.signedIn() ? r.name : OACandCard.universityName(r.affiliation); };
        candidateCard.subtitle = function (r) { return OAGate.signedIn() ? [r.affiliation, r.position].filter(Boolean).join(' — ') : ''; };
        var heading = document.getElementById('oa-candidates-heading');
        heading.textContent = 'Job market candidates (' + (OAJobNav.marketYear()-1) + '-' + OAJobNav.marketYear() + ')';
        var cands = OAList.mount({
          mount: '#oa-candidates',
          bottomPager: true,
          data: '/data/candidates.json',
          perPage: 10,
          urlPrefix: 'c_',
          strings: {
            loading: 'Loading candidate profiles…',
            emptyData: 'No candidate profiles are public yet.',
            emptyDataHint: 'Before the reveal, profiles are held privately and appear here together at 14:00 UTC on the reveal date (this list can take a few minutes to catch up with that moment); after it, new ones appear as candidates post them.',
            emptyFiltered: 'No candidate profiles match these filters.',
            emptyFilteredHint: 'Try removing a filter, or clear them all to see every profile.',
            loadError: 'The candidate profiles could not be loaded.',
            loadErrorHint: 'Please reload the page, or let us know if it keeps happening.',
            unit: 'profiles'
          },
          prepare: function (rows) { return rows.filter(inCurrentMarket); },
          sort: function (a, b) {
            var surname = (a.last || (a.name || '').trim().split(/\s+/).pop()).localeCompare(b.last || (b.name || '').trim().split(/\s+/).pop(), 'en', { sensitivity: 'base' });
            if (surname) return surname;
            return (a.first || a.name || '').localeCompare(b.first || b.name || '', 'en', { sensitivity: 'base' });
          },
          filters: [
            { key: 'name',        label: 'Name',             type: 'text',
              fields: ['name'], placeholder: 'Search by name…' },
            { key: 'affiliation', label: 'Affiliation',      type: 'text',
              fields: ['affiliation'], placeholder: 'Search by affiliation…',
              legacyParam: 'filterE' },
            { key: 'position',    label: 'Current position', field: 'position',
              placeholder: 'All positions' },
            { key: 'area',        label: 'Research area',    field: 'researchAreas',
              placeholder: 'All areas' },
            { key: 'day',         label: 'INFORMS day',      field: 'informsDays',
              placeholder: 'All days' },
            { key: 'posted',      label: 'Date posted',      derive: 'datePosted',
              placeholder: 'Any date' }
          ],
          cardOpen: OAGate.cardOpen({ note: 'Create a free account to view this profile', authMode: 'register' }),

          /* THE TALKS CALENDAR (owner, 2026-09-06): every listed candidate's
             INFORMS talk, with its time, date and room where the profile
             gives them, as an .ics. Declared on the mount because the engine
             owns the bar (the Excel download's reasoning on jobs.html);
             writes what the list is SHOWING, so a committee can narrow by
             research area first. Registered readers only, the module's own
             gate (assets/oa-talkcal.js). */

          /* the "Profile updated on" line first (inside the body, so a locked
             card never gets one), then the owner's Edit / Take down bar */
          onCard: function (li, r) {
            OACandCard.decorate(li, r);
            if (window.OACandidateEdit) OACandidateEdit.onCard(li, r);
          },
          /* THE CARD IS DRAWN BY assets/oa-candcard.js, the one renderer the
             account page's own-card preview and the posting form's live
             preview share (owner, 2026-09-04): title, subtitle and the seven
             labelled rows in their order. This page's own three link helpers
             are passed in, so the list's output is exactly what it was. */
          card: candidateCard
        });
        window.OACandidateList = cands;
        if (window.OACandidateEdit) OACandidateEdit.attach(cands);
        OAGate.watch(cands);
        var host = document.getElementById('oa-candidates');
        var lock = document.getElementById('v3-lock-card');
        function updateLock() {
          var locked = !OAGate.signedIn();
          host.classList.toggle('oa-candidates-locked', locked);
          lock.hidden = !locked;
        }
        updateLock();
        OAAccounts.onChange(updateLock);
        document.getElementById('v3-lock-signin').addEventListener('click', function () { OAAccounts.openAuth(); });
        document.getElementById('v3-lock-register').addEventListener('click', function () { OAAccounts.openAuth('register'); });
        /* A page opened before the reveal must not keep its cached empty list
           forever. Read only public snapshots after the announced instant. */
        var refreshingCandidates = false;
        function refreshRevealedCandidates() {
          var host = document.getElementById('oa-candidates');
          if (document.hidden || refreshingCandidates || host.contains(document.activeElement)) return;
          refreshingCandidates = true;
          fetch('/data/candidates-meta.json?v=' + Date.now(), { cache: 'no-store' })
            .then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); })
            .then(function (meta) {
              if (!OAReveal.isRevealed(meta.revealAt)) return;
              return cands.refresh().then(function () {
                if (cands.rows().length) {
                  var waiting = document.getElementById('oa-reveal-note');
                  if (waiting) waiting.hidden = true;
                }
              });
            }).catch(function () {})
            .then(function () { refreshingCandidates = false; });
        }
        setInterval(refreshRevealedCandidates, 60000);
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) refreshRevealedCandidates();
        });
        }
      });
