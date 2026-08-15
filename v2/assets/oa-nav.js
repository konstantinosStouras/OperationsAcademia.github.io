/* Navigation menu for the v2 preview.

   A copy of /assets/js/navigationMenu.js with two differences:
     1. every href is ABSOLUTE, because v2 pages live one directory down and the
        original's relative hrefs would resolve to /v2/candidates etc.;
     2. the pages v2 has rebuilt point INTO /v2/ — everything else still points
        at the live site, so the preview is fully navigable.

   At cutover this file is deleted and /assets/js/navigationMenu.js takes over
   again (the rebuilt pages will then sit at the paths it already points to). */
(function () {
  'use strict';

  // pages rebuilt in v2 -> their v2 path; anything else -> the live page
  var V2 = {
    jobs: '/v2/jobs.html',
    feedback: '/v2/feedback.html'
  };

  function href(slug) {
    return V2[slug] || '/' + slug;
  }

  var nav = document.getElementById('nav');
  if (!nav) return;

  nav.innerHTML =
    '<ul>' +
      '<li><a href="' + href('survey') + '">Annual job market survey</a>' +
        '<ul><li><a href="' + href('survey-faqs') + '">Survey FAQs</a></li></ul>' +
      '</li>' +
      '<li><a href="' + href('jobs') + '">2025-2026 job market</a>' +
        '<ul>' +
          '<li><a href="' + href('candidates') + '">Candidates</a></li>' +
          '<li><a href="' + href('jobs') + '">Job postings</a></li>' +
          '<li><a href="' + href('placements') + '">Confirmed placements</a></li>' +
        '</ul>' +
      '</li>' +
      '<li><a href="' + href('resources-for-candidates') + '">Resources</a>' +
        '<ul>' +
          '<li><a href="' + href('resources-for-candidates') + '">For job candidates</a></li>' +
          '<li><a href="' + href('universities') + '">Universities</a></li>' +
          '<li><a href="' + href('previous-markets') + '">Previous job markets</a></li>' +
          '<li><a href="' + href('recent-faculty') + '">Recent junior faculty</a></li>' +
        '</ul>' +
      '</li>' +
      '<li><a href="' + href('faqs') + '">About</a>' +
        '<ul>' +
          '<li><a href="' + href('directors-and-contributors') + '">Directors and contributors</a></li>' +
          '<li><a href="' + href('faqs') + '">FAQs</a></li>' +
          '<li><a href="http://a.co/ev61V45">Donate (in books)</a></li>' +
          '<li><a href="' + href('analytics') + '">Analytics</a></li>' +
          '<li><a href="' + href('feedback') + '">Feedback</a></li>' +
          '<li><a href="' + href('contact') + '">Contact</a></li>' +
        '</ul>' +
      '</li>' +
    '</ul>';
})();
