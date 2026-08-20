/*
 * Standalone (home-screen PWA) launch marker. Marks the launch on <html>
 * before first paint so CSS can scroll-lock the shell (see index.css).
 *
 * External rather than inline because index.html carries a strict
 * Content-Security-Policy whose `script-src` permits no inline script. Loaded
 * from <head> in document order, like theme.js.
 */
(function () {
  "use strict";

  if (
    window.matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches ||
    window.navigator.standalone === true
  ) {
    document.documentElement.classList.add("standalone");
  }
})();
