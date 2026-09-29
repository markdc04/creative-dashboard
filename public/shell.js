(function () {
  const $ = (sel) => document.querySelector(sel);

  fetch('/api/me', { cache: 'no-store' }).then((r) => {
    if (!r.ok) { location.href = '/login'; return null; }
    return r.json();
  }).then((me) => {
    if (!me) return;
    $('#logged-in-name').textContent = me.name;
    // The visitor/login history is Mark's own view only — nobody else's session even shows the button.
    if (me.name === 'Mark') $('#visitors-btn').hidden = false;
    startDashboardApp();
  }).catch(() => { location.href = '/login'; });

  $('#logout-btn').addEventListener('click', () => { location.href = '/logout'; });

  // Full date + time in Pacific (the timezone the underlying campaign data itself uses).
  function visitTimestamp(ms) {
    return new Date(ms).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }) + ' PDT';
  }

  $('#visitors-btn').addEventListener('click', () => {
    const panel = $('#visitors-panel');
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    $('#visitors-list').innerHTML = '<div class="visitors-empty">Loading&hellip;</div>';
    fetch('/api/visits').then((r) => r.json()).then((d) => {
      const visits = d.visits || [];
      // `page` is what every visit now carries (one row per page load, not just per login).
      // A couple of old entries from before this may still have the earlier role/scope shape
      // on disk — fall back to that so they don't render blank.
      const dashboardLabel = (v) => v.page || (v.role === 'client' ? (v.scope === 'leaderboard' ? 'Creative Team' : v.scope ? v.scope[0].toUpperCase() + v.scope.slice(1) : 'Client') : 'Admin');
      $('#visitors-list').innerHTML = !visits.length
        ? '<div class="visitors-empty">No visits recorded yet.</div>'
        : visits.map((v) => (
            '<div class="visitors-row"><strong>' + v.name.replace(/[<>&]/g, '') + '</strong>' +
            '<span class="visitors-dash">' + dashboardLabel(v) + '</span>' +
            '<span>' + visitTimestamp(v.at) + '</span></div>'
          )).join('');
    }).catch(() => {
      $('#visitors-list').innerHTML = '<div class="visitors-empty">Couldn\'t load visits.</div>';
    });
  });
  $('#visitors-close').addEventListener('click', () => { $('#visitors-panel').hidden = true; });
})();
