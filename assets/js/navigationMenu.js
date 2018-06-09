/*
    Use this tool to clean the CSS code: https://www.10bestdesign.com/dirtymarkup/css/
*/

document.getElementById( "nav" ).innerHTML = '<ul>' + '<li>' +
  '<a href="survey.html" onClick="ga('
send ', '
pageview ', '
surveyMenuHeader ');">Annual job market survey</a><ul>' +
  '<li><a href="survey-faqs.html" onClick="ga('
send ', '
pageview ', '
survey - faqsMenuHeader ');">Survey FAQs</a></li>' + '</ul>' + '</li>' + '<li>' +
  '<a href="jobs.html" onClick="ga('
send ', '
pageview ', '
jobsMenuHeader ');">2017-2018 job market</a>' + '<ul>' +
  '<li><a href="candidates.html" onClick="ga('
send ', '
pageview ', '
candidatesMenuHeader ');">Candidates</a></li>' +
  '<li><a href="jobs.html" onClick="ga('
send ', '
pageview ', '
jobsMenuHeader ');">Job postings</a></li>' +
  '<li><a href="placements.html" onClick="ga('
send ', '
pageview ', '
placementsMenuHeader ');">Confirmed placements</a></li>' + '</ul>' +
  '</li>' + '<li>' + '<a href="resources-for-candidates.html" onClick="ga('
send ', '
pageview ', '
resources -
  for -candidatesMenuHeader ');">Resources</a>' + '<ul>' +
  '<li><a href="resources-for-candidates.html" onClick="ga('
send ', '
pageview ', '
resources -
  for -candidatesMenuHeader ');">For job candidates</a></li>' +
  '<li><a href="universities.html" onClick="ga('
send ', '
pageview ', '
universitiesMenuHeader ');">Universities</a></li>' +
  '<li><a href="previous-markets.html" onClick="ga('
send ', '
pageview ', '
previous - marketsMenuHeader ');">Previous job markets</a></li>' +
  '<li><a href="recent-faculty.html" onClick="ga('
send ', '
pageview ', '
recent - facultyMenuHeader ');">Recent junior faculty</a></li>' + '</ul>' +
  '</li>' + '<li>' +
  '<a href="faqs.html" onClick="ga('
send ', '
pageview ', '
faqsMenuHeader ');">About</a>' + '<ul>' +
  '<li><a href="faqs.html">FAQs</a></li>' +
  '<li><a href="https://operationsacademia.wordpress.com" onClick="ga('
send ', '
pageview ', '
blogMenuHeader ');">Blog</a></li>' +
  '<li><a href="http://a.co/ev61V45" onClick="ga('
send ', '
pageview ', '
donateMenuHeader ');">Donate (in books)</a></li>' +
  '<li><a href="analytics.html" onClick="ga('
send ', '
pageview ', '
analyticsMenuHeader ');">Analytics</a></li>' +
  '<li><a href="contact.html" onClick="ga('
send ', '
pageview ', '
contactUsMenuHeader ');">Contact</a></li>' + '</ul>' +
  '</li>' + '</ul>';

today = new Date();
currentYear = today.getFullYear();
document.getElementById( "copyright" ).innerHTML =
  '&copy' + '2014-' + currentYear + ". " +
  '<a href="http://www.stouras.com/">Konstantinos I. Stouras</a>';
/* 	'&copy' + '2014-' + currentYear + ". Made  with " +
	'<i class="fa fa-coffee"></i>' + " by " +
	'<a href="http://www.stouras.com/">Konstantinos I. Stouras</a>'; */
