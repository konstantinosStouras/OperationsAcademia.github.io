/*
    Use this tool to clean the CSS code: https://www.10bestdesign.com/dirtymarkup/css/
*/

document.getElementById( "nav" ).innerHTML = '<ul>' + '<li>' +
	'<a href="survey.html">Annual job market survey</a><ul>' +
	'<li><a href="survey-faqs.html">Survey FAQs</a></li>' + '</ul>' + '</li>' + '<li>' +
	'<a href="jobs.html">2017-2018 job market</a>' + '<ul>' +
	'<li><a href="candidates.html">Candidates</a></li>' +
	'<li><a href="jobs.html">Job postings</a></li>' +
	'<li><a href="placements.html">Confirmed placements</a></li>' + '</ul>' +
	'</li>' + '<li>' + '<a href="resources-for-candidates.html">Resources</a>' + '<ul>'+
	'<li><a href="resources-for-candidates.html">For job candidates</a></li>' +
	'<li><a href="universities.html">Universities</a></li>'  +
	'<li><a href="previous-markets.html">Previous job markets</a></li>' +
	'<li><a href="recent-faculty.html">Recent junior faculty</a></li>' + '</ul>' + '</li>' + '<li>' +
	'<a href="faqs.html">About</a>' + '<ul>' + '<li><a href="faqs.html">FAQs</a></li>' +
	'<li><a href="https://operationsacademia.wordpress.com">Blog</a></li>' +
	'<li><a href="http://a.co/ev61V45">Donate (in books)</a></li>' + 
	'<li><a href="analytics.html">Analytics</a></li>' + '<li><a href="contact.html">Contact</a></li>' + '</ul>' +
	'</li>' + '</ul>';

today = new Date();
currentYear = today.getFullYear();
document.getElementById( "copyright" ).innerHTML =
	'&copy' + '2014-' + currentYear + ". " +
	'<a href="http://www.stouras.com/">Konstantinos I. Stouras</a>';
/* 	'&copy' + '2014-' + currentYear + ". Made  with " +
	'<i class="fa fa-coffee"></i>' + " by " +
	'<a href="http://www.stouras.com/">Konstantinos I. Stouras</a>'; */
