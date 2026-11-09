'use strict';

// Mirrors the Google Analytics configuration used by vidarandersen.com.
(function loadGoogleAnalytics(windowObject, documentObject, tagName, source, name, script, firstScript) {
  windowObject.GoogleAnalyticsObject = name;
  windowObject[name] = windowObject[name] || function queueAnalyticsCommand() {
    (windowObject[name].q = windowObject[name].q || []).push(arguments);
  };
  windowObject[name].l = 1 * new Date();
  script = documentObject.createElement(tagName);
  firstScript = documentObject.getElementsByTagName(tagName)[0];
  script.async = true;
  script.src = source;
  firstScript.parentNode.insertBefore(script, firstScript);
}(window, document, 'script', 'https://www.google-analytics.com/analytics.js', 'ga'));

window.ga('create', 'UA-81145426-1', 'auto');
window.ga('send', 'pageview');
