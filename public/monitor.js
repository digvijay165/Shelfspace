// First-party error tracking and page-view counting. Nothing is sent to third parties, no cookies
// are set, and page views carry only the path (never query strings, which can hold reset tokens).
(function () {
  const sent = new Set();
  const optedOut = navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;

  function post(url, payload) {
    const body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
    } catch {}
    fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true }).catch(() => {});
  }

  function report(message, stack, location) {
    const key = `${message}|${location}`;
    // Each distinct error is reported once per page load, and at most ten in total.
    if (sent.has(key) || sent.size >= 10) return;
    sent.add(key);
    post('/api/client-errors', { message: String(message).slice(0, 500), stack: String(stack || '').slice(0, 2000), location, path: window.location.pathname });
  }

  window.addEventListener('error', event => {
    if (!event.message) return;
    report(event.message, event.error && event.error.stack, `${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}`);
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason || {};
    report(reason.message || String(reason), reason.stack, 'unhandled promise');
  });

  window.ShelfMonitor = {
    pageView(path) {
      if (optedOut) return;
      post('/api/analytics', { path });
    },
    report
  };
})();
