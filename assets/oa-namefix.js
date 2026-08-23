/* ---------------------------------------------------------------------------
   Operations Academia — suggest a correction to a published place name.

   WHY THIS EXISTS. The site publishes every university, school and department
   under ONE spelling (assets/oa-schools.js), but the spelling it settled on
   can simply be WRONG — a legacy import's abbreviation, a poster's typo that
   arrived first — and until now only the maintainer could fix it, by adding
   an alias to oa-schools.js. A poster from the school itself knows its name
   better than anyone, so the posting form lets a signed-in poster say so.

   NOTHING RENAMES ITSELF. A suggestion is a Firestore `nameFixes` document
   with `status` pinned to 'pending' by the rules — the same "the browser is
   never trusted with what gets published" bar as a posting. The maintainer
   approves or rejects it on admin-area.html; the data build then writes the
   approved corrections into data/name-fixes.json and applies them (through
   oa-schools.js's fixPlace) to every posting and to the form's vocabulary, so
   one approved fix renames the old spelling everywhere at once and the
   pickers stop offering it.

   DUAL-MODE, like oa-news.js: the browser gets the form wiring, and Node gets
   the constants — DOC_KEYS / ADMIN_EDIT_KEYS are pinned BOTH WAYS against the
   hasOnly() lists in _firestore.rules by the selftest, so a field added here
   without a rule fails the build rather than the poster's save.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  var mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.OANameFix = mod;
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var COLLECTION = 'nameFixes';
  var KINDS = ['institution', 'school', 'unit'];
  var PENDING = 'pending';
  var APPROVED = 'approved';
  var REJECTED = 'rejected';

  /** Every key the form below may write — pinned against the create rule. */
  var DOC_KEYS = ['kind', 'from', 'to', 'institution', 'note',
    'uid', 'authEmail', 'status', 'createdAt'];

  /** Every key the admin panel may change — pinned against the update rule's
      affectedKeys(). `kind`, `from` and the suggester's identity are part of
      what was SUGGESTED and stay as filed. */
  var ADMIN_EDIT_KEYS = ['status', 'to', 'institution', 'note', 'reviewedAt'];

  var MAXLEN = { from: 200, to: 200, institution: 200, note: 1000 };

  var api = {
    COLLECTION: COLLECTION,
    KINDS: KINDS,
    PENDING: PENDING,
    APPROVED: APPROVED,
    REJECTED: REJECTED,
    DOC_KEYS: DOC_KEYS,
    ADMIN_EDIT_KEYS: ADMIN_EDIT_KEYS,
    MAXLEN: MAXLEN,
  };

  /* ---------------------------------------------------- the browser wiring */

  if (typeof document === 'undefined') return api;

  function $(id) { return document.getElementById(id); }
  function val(id) { var el = $(id); return el ? String(el.value || '').trim() : ''; }
  function show(el, on) { if (el) el.hidden = !on; }

  function say(text, cls) {
    var m = $('nf-msg');
    if (!m) return;
    m.textContent = text || '';
    m.className = 'oa-form-msg' + (cls ? ' ' + cls : '');
  }

  /** The field on the posting form a kind reads its prefill from. */
  var SOURCE_FIELD = { institution: 'f-institution', school: 'f-school', unit: 'f-unit' };

  function fold(s) {
    var S = root.OASchools;
    return S && S.fold ? S.fold(s) : String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /** The names the site currently offers for a kind — what `from` must be:
      a correction starts from a name the site actually publishes. Resolves
      null when the vocabulary cannot be read, and then the check stands down
      (the maintainer still reviews every suggestion). */
  function knownNames(kind) {
    if (!root.OAPlacePicker) return Promise.resolve(null);
    return root.OAPlacePicker.vocabulary().then(function (v) {
      if (!v) return null;
      var out = Object.create(null);
      var add = function (name) { var k = fold(name); if (k) out[k] = true; };
      if (kind === 'institution') {
        (v.universities || []).forEach(function (o) { add(o && o.v ? o.v : o); });
        Object.keys(v.byUniversity || {}).forEach(add);
      } else if (kind === 'school') {
        (v.schools || []).forEach(function (o) { add(o && o.v ? o.v : o); });
      } else {
        (v.units || []).forEach(function (o) { add(o && o.v ? o.v : o); });
      }
      return out;
    });
  }

  function prefill() {
    var kind = val('nf-kind') || 'unit';
    var from = $('nf-from');
    if (from) from.value = val(SOURCE_FIELD[kind] || 'f-unit');
    var inst = $('nf-inst');
    if (inst) inst.value = kind === 'institution' ? '' : val('f-institution');
    // the scope question makes no sense when the name IS the university
    show($('nf-inst-field'), kind !== 'institution');
  }

  function send() {
    var kind = val('nf-kind');
    if (KINDS.indexOf(kind) === -1) kind = 'unit';
    var from = val('nf-from').slice(0, MAXLEN.from);
    var to = val('nf-to').slice(0, MAXLEN.to);
    var institution = kind === 'institution' ? '' : val('nf-inst').slice(0, MAXLEN.institution);
    var note = val('nf-note').slice(0, MAXLEN.note);

    if (from.length < 2) { say('Please give the name as the site publishes it now.', 'is-err'); return; }
    if (to.length < 2) { say('Please give the name it should be.', 'is-err'); return; }
    if (fold(from) === fold(to)) {
      say('Those two read as the same name — please give the corrected spelling.', 'is-err');
      return;
    }

    var btn = $('nf-send');
    if (btn) btn.disabled = true;
    say('Checking…');

    knownNames(kind).then(function (known) {
      if (known && !known[fold(from)]) {
        say('The site does not publish that name, so there is nothing to rename — '
          + 'corrections start from a name the pickers above actually offer. '
          + '(A NEW place is simply typed into the posting itself.)', 'is-err');
        if (btn) btn.disabled = false;
        return;
      }

      return root.OAFB.ready().then(function (fb) {
        var user = fb.auth().currentUser;
        if (!user) {
          say('Please sign in first.', 'is-err');
          if (btn) btn.disabled = false;
          return;
        }
        return fb.firestore().collection(COLLECTION).add({
          kind: kind,
          from: from,
          to: to,
          institution: institution,
          note: note,
          uid: user.uid,
          authEmail: user.email || '',
          status: PENDING,
          createdAt: fb.firestore.FieldValue.serverTimestamp(),
        }).then(function () {
          var form = $('nf-form') || $('oa-namefix-form');
          if (form) {
            form.innerHTML = '<h3>Thank you &mdash; the correction is queued.</h3>' +
              '<p class="oa-hint">The maintainer reviews every suggestion. Once approved, ' +
              'every posting that carries the old spelling is renamed and the pickers stop ' +
              'offering it &mdash; usually within the hour.</p>';
          }
        });
      });
    })['catch'](function (err) {
      say('Could not send that (' + ((err && (err.code || err.message)) || 'error') +
        '). Please try again in a moment.', 'is-err');
      if (btn) btn.disabled = false;
    });
  }

  function boot() {
    var box = $('oa-namefix');
    if (!box || !root.OAFB || !root.OAAccounts) return;

    // the same bar as posting itself: a signed-in visitor
    root.OAAccounts.onChange(function (u) { show(box, !!u); });

    var open = $('oa-namefix-open');
    if (open) {
      open.addEventListener('click', function () {
        var form = $('oa-namefix-form');
        var opening = form && form.hidden;
        show(form, opening);
        if (opening) { prefill(); say(''); }
      });
    }
    var kind = $('nf-kind');
    if (kind) kind.addEventListener('change', prefill);
    var cancel = $('nf-cancel');
    if (cancel) cancel.addEventListener('click', function () {
      show($('oa-namefix-form'), false);
    });
    var sendBtn = $('nf-send');
    if (sendBtn) sendBtn.addEventListener('click', send);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return api;
}));
