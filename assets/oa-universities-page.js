/* Initialize the searchable map before optional account and analytics scripts. */
(function () {
      'use strict';

      /* ------------------------------------------------- the card directory

         data/directory.json (built by _scraper/build-directory.mjs from the
         curated archive + the oa-institutions seed + every posting) grouped
         one card per university, with the community's `directoryEdits`
         overlaid at read time — assets/oa-directory.js owns all of it. */
      var directorySnapshot = { view: [], rows: [] };
      var resolveDirectory;
      var directoryReady=new Promise(function(resolve){resolveDirectory=resolve;});
      OADirectory.mount({ mount: '#oa-dir', mapOnly: true, deferAccounts: true, onRender: function (snapshot) {
        directorySnapshot = snapshot;
        resolveDirectory();
        if (uniMap && uniMap.update) uniMap.update(snapshot);
      } });

      /* the hero's own count, from the meta file the build writes beside the
         table — the fallback words in the markup stand until it arrives */
      OAList.load('/data/directory-meta.json').then(function (m) {
        if (!m || !m.universities) return;
        document.getElementById('oa-dir-count').textContent =
          m.universities + ' universities and ' + m.departments +
          ' departments so far, built from every posting made here and the ' +
          'site’s curated records';
      })['catch'](function () { /* the fallback words are already right */ });

      // All university links open the searchable map, retaining shared filters.
      var uniMap = OAUniMap.mount({ mount: '#oa-uni', snapshot: directorySnapshot });

      function loadExtras() {
        var sources=JSON.parse(document.getElementById('oa-map-afterload').textContent);
        sources.forEach(function(src){
          var script=document.createElement('script');script.async=false;script.src=src;
          if(src==='assets/oa-accounts.js')script.onload=function(){OADirectory.connect();};
          document.head.appendChild(script);
        });
      }
      Promise.all([directoryReady,uniMap.whenReady]).then(function(){
        requestAnimationFrame(function(){requestAnimationFrame(loadExtras);});
      },loadExtras);
})();
