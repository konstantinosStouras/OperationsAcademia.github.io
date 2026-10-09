(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./oa-ics.js'), require('./oa-informs.js'));
  } else root.OACandidateCalendar = factory(root.OAIcs, root.OAInforms);
}(typeof self !== 'undefined' ? self : this, function (Ics, Informs) {
  'use strict';
  var TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  function text(v) { return String(v == null ? '' : v).trim(); }
  function esc(v) { return text(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function minutes(v) { var p = v.split(':'); return Number(p[0]) * 60 + Number(p[1]); }
  function presentationUrl(v) {
    try {
      var u = new URL(v);
      return u.protocol === 'https:' && u.hostname === 'submissions.mirasmart.com' &&
        /^\/InformsAnnual2026\/Itinerary\/PresentationDetail\.aspx$/i.test(u.pathname) &&
        /^[1-9][0-9]*$/.test(u.searchParams.get('evdid') || '') ? u.href : '';
    } catch (e) { return ''; }
  }
  function event(row) {
    if (!row || !row.id || !row.name || !(row.informsDays || []).length) return null;
    var t = row.jobTalk || {}, meeting = Informs.meetingFor(row.year);
    var url = presentationUrl(row.informsUrl);
    if (!meeting || !url || !Ics.isoDayOk(t.date) || !TIME.test(t.at || '') ||
        !TIME.test(t.end || '') || minutes(t.end) <= minutes(t.at) || !text(t.location)) return null;
    var day = (row.informsDays || []).filter(function (d) { return Informs.dateOf(meeting, d) === t.date; });
    if (!day.length) return null;
    var profile = 'https://www.operationsacademia.org/?c_name=' + encodeURIComponent(row.name) + '#candidates';
    var details = [row.name, [row.position, row.affiliation].filter(Boolean).join(' — ')];
    if (t.title) details.push('Job talk: ' + t.title);
    details.push('INFORMS presentation: ' + url);
    details.push('When: ' + t.date + ', ' + t.at + '–' + t.end + ' (' + meeting.tz.id + ')');
    details.push('Location: ' + t.location);
    if ((row.researchAreas || []).length) details.push('Research areas: ' + row.researchAreas.join(', '));
    if (Ics.safeUrl(row.cvUrl)) details.push('CV: ' + row.cvUrl);
    if (Ics.safeUrl(row.webUrl)) details.push('Website: ' + row.webUrl);
    details.push('Candidate profile: ' + profile);
    return { uid: 'oa-job-talk-' + row.id, summary: 'INFORMS job talk: ' + row.name + (t.title ? ' — ' + t.title : ''),
      description: details.join('\n'), location: text(t.location), url: url,
      start: t.date + 'T' + t.at, minutes: minutes(t.end) - minutes(t.at), tzid: meeting.tz.id };
  }
  function utcStamp(date, time, zone) {
    var wall = Date.parse(date + 'T' + time + ':00Z'), instant = wall;
    var fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    for (var i = 0; i < 3; i++) {
      var p = {};
      fmt.formatToParts(new Date(instant)).forEach(function (part) { p[part.type] = part.value; });
      var shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
      instant += wall - shown;
    }
    return new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }
  function calendar(row, now) {
    var ev = event(row);
    if (!ev) return '';
    return Ics.build([ev], { name: 'INFORMS job talk: ' + row.name,
      now: now || new Date(), timezones: [Informs.meetingFor(row.year).tz] });
  }
  function googleUrl(row) {
    var ev = event(row);
    if (!ev) return '';
    var t = row.jobTalk;
    var params = { action: 'TEMPLATE', text: ev.summary,
      dates: utcStamp(t.date, t.at, ev.tzid) + '/' + utcStamp(t.date, t.end, ev.tzid),
      ctz: ev.tzid, location: ev.location, details: ev.description };
    return 'https://calendar.google.com/calendar/render?' + Object.keys(params).map(function (k) {
      return k + '=' + encodeURIComponent(params[k]);
    }).join('&');
  }
  function links(row) {
    var ics = calendar(row);
    if (!ics) return null;
    return '<a href="' + esc(googleUrl(row)) + '" target="_blank" rel="noopener">Google</a> · ' +
      '<a href="data:text/calendar;charset=utf-8,' + encodeURIComponent(ics) + '" download="' +
      esc('informs-job-talk-' + row.id + '.ics') + '">Outlook/Apple</a>';
  }
  return { event: event, calendar: calendar, googleUrl: googleUrl, links: links, presentationUrl: presentationUrl, utcStamp: utcStamp };
}));
