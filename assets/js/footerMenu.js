document.getElementById( "nav" ).innerHTML = '<ul>' + '<li>' +
	'<a href="Survey.html">Annual Job Market Survey</a><ul>' +
	'<li><a href="#">Survey FAQs</a></li>' + '</ul>' + '</li>' + '<li>' +
	'<a href="#">2017-2018 Job Market</a>' + '<ul>' +
	'<li><a href="#">Candidates (2017-2018)</a></li>' +
	'<li><a href="#">Job Postings (2017-2018)</a></li>' +
	'<li><a href="#">Confirmed Placements (2017-2018)</a></li>' + '</ul>' +
	'</li>' + '<li>' + '<a href="#">Resources</a>' + '<ul>' +
	'<li><a href="#">Previous Job Markets</a></li>' +
	'<li><a href="#">For Job Candidates</a></li>' +
	'<li><a href="#">Recent Junior Faculty</a></li>' + '</ul>' + '</li>' + '<li>' +
	'<a href="#">About</a>' + '<ul>' + '<li><a href="#">Analytics</a></li>' +
	'<li><a href="#">FAQs</a></li>' + '<li><a href="#">Contact</a></li>' + '</ul>' +
	'</li>' + '</ul>';

document.getElementById( "footerCol1" ).innerHTML =
  '<a href="job_postings.html">Job postings</a>' +
  '<a href="candidates.html">Candidates</a>' +
  '<a class="box-no-padding" href="confirmed_placements.html">Confirmed placements</a>' +
  '<a class="box-no-padding" href="job_market_survey.html">Annual job market survey</a>' +
  '<a class="box-no-padding" href="resources.html">Resources</a>' +
  '<a class="box-no-padding" href="faqs.html">FAQs</a>' +
  '<a class="box-no-padding" href="contact.html">Contact</a>';
document.getElementById( "footerCol2" ).innerHTML =
  '<a class="box-no-padding" href="about.html">About</a>' +
  '<a class="box-no-padding" href="blog.html">Blog</a>' +
  '<a class="box-no-padding" href="donate.html">Donate</a>' +
  '<a class="box-no-padding" href="analytics.html">Analytics</a>' +
  '<a class="box-no-padding" href="terms_and_conditions.html">Terms and Conditions</a>' +
  '<a class="box-no-padding" href="privacy_policy.html">Privacy Policy  </a>';
today = new Date();
currentYear = today.getFullYear();
document.getElementById( "copyright" ).innerHTML = '&copy' + '2014-' +
  currentYear + ". Made  with " + '<i class="fa fa-coffee"></i>' + " by " +
  '<a href="http://www.stouras.com/">Konstantinos I. Stouras</a>';