/* Navigation menu for the v2 site.

   A copy of /assets/js/navigationMenu.js with three differences:

     1. every href is RELATIVE to the directory the page sits in. The original's
        hrefs are relative too, but extension-less (`href="jobs"`), which only
        resolves because GitHub Pages retries with `.html`; a static server, and
        the browser test that drives one, does not. Writing the extension makes
        the menu work everywhere the pages do.

     2. every page it names now EXISTS under /v2/, so the menu no longer leaks
        back out to the live site half-way through. `v2/_scraper/port-pages.mjs`
        carried the remaining pages across.

     3. the job-market season in the label is DERIVED, not typed. The live
        menu says "2025-2026 job market" while the jobs page it links to is
        headed "Job postings (2026-2027)" — the market rolled on 1 July 2026 and
        the hand-typed label did not. Same rule as jobs.html and
        jobs-model.mjs: a market year runs 1 July of the previous year to
        30 June of its own and is numbered by the year it ends, so the roll
        month is July and getUTCMonth() (0-based) is 6.

   At cutover this file replaces /assets/js/navigationMenu.js (the pages move up
   one directory; the hrefs are relative, so they still resolve) and the Feedback
   entry keeps pointing at the site's own feedback page. */
(function () {
  'use strict';

  var nav = document.getElementById('nav');
  if (!nav) return;

  /* keep in step with jobs.html and _scraper/jobs-model.mjs */
  function marketLabel() {
    var d = new Date();
    var y = d.getUTCFullYear() + (d.getUTCMonth() >= 6 ? 1 : 0);
    return (y - 1) + '-' + y;
  }

  function item(href, label) {
    return '<li><a href="' + href + '">' + label + '</a>';
  }

  nav.innerHTML =
    '<ul>' +
      item('survey.html', 'Annual job market survey') +
        '<ul>' + item('survey-faqs.html', 'Survey FAQs') + '</li></ul>' +
      '</li>' +
      item('jobs.html', marketLabel() + ' job market') +
        '<ul>' +
          item('candidates.html', 'Candidates') + '</li>' +
          item('jobs.html', 'Job postings') + '</li>' +
          item('placements.html', 'Confirmed placements') + '</li>' +
        '</ul>' +
      '</li>' +
      item('resources-for-candidates.html', 'Resources') +
        '<ul>' +
          item('resources-for-candidates.html', 'For job candidates') + '</li>' +
          item('universities.html', 'Universities') + '</li>' +
          item('previous-markets.html', 'Previous job markets') + '</li>' +
          item('recent-faculty.html', 'Recent junior faculty') + '</li>' +
        '</ul>' +
      '</li>' +
      item('faqs.html', 'About') +
        '<ul>' +
          item('directors-and-contributors.html', 'Directors and contributors') + '</li>' +
          item('faqs.html', 'FAQs') + '</li>' +
          item('http://a.co/ev61V45', 'Donate (in books)') + '</li>' +
          item('analytics.html', 'Analytics') + '</li>' +
          item('feedback.html', 'Feedback') + '</li>' +
          item('contact.html', 'Contact') + '</li>' +
        '</ul>' +
      '</li>' +
    '</ul>';
})();
