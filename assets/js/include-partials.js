(function () {
  var nodes = document.querySelectorAll('[data-include]');
  if (!nodes.length) return;
  nodes.forEach(function (el) {
    var url = el.getAttribute('data-include');
    fetch(url, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
        return res.text();
      })
      .then(function (html) {
        el.outerHTML = html;
      })
      .catch(function (err) {
        console.error('Include failed for', url, err);
      });
  });
})();
