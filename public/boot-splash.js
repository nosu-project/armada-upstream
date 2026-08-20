/*
 * Boot-splash reveal.
 *
 * Show the mark only when this launch ISN'T headed for /welcome, which draws
 * its own crest on arrival — starting the draw here as well meant a signed-out
 * load animated, got cut off on mount, and jumped to a second draw. A
 * signed-out load goes to /welcome (see HomeRedirect), and on the web the
 * session is a localStorage entry we can read before the bundle parses. Native
 * keeps it in the OS keystore, unreadable here, so `window.Capacitor`
 * (injected by the bridge before our scripts) means "assume signed in" — its
 * cold start is the case the inline splash exists for.
 *
 * External rather than inline because index.html carries a strict
 * Content-Security-Policy whose `script-src` permits no inline script. This
 * must stay where the inline block was, AFTER the splash markup: it reads
 * #boot-mark, and a classic script runs at its position in the document.
 */
(function () {
  "use strict";

  var mark = document.getElementById("boot-mark");
  var signedIn = true;
  try {
    if (!window.Capacitor) {
      var login = localStorage.getItem("armada:login");
      signedIn = !!login && login !== "[]";
    }
  } catch (e) { /* storage blocked — treat as signed in, i.e. show it */ }
  if (mark && signedIn && location.pathname !== "/welcome") mark.style.display = "";
})();
