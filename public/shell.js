(function () {
  const $ = (sel) => document.querySelector(sel);

  fetch('/api/me', { cache: 'no-store' }).then((r) => {
    if (!r.ok) { location.href = '/login'; return null; }
    return r.json();
  }).then((me) => {
    if (!me) return;
    $('#logged-in-name').textContent = me.name;
    startDashboardApp();
  }).catch(() => { location.href = '/login'; });

  $('#logout-btn').addEventListener('click', () => { location.href = '/logout'; });

  const menuBtn = $('#menu-btn');
  const menuPanel = $('#menu-panel');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menuPanel.hidden = !menuPanel.hidden;
    menuBtn.setAttribute('aria-expanded', String(!menuPanel.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!menuPanel.hidden && !menuPanel.contains(e.target)) { menuPanel.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }
  });

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
      $('#visitors-list').innerHTML = !visits.length
        ? '<div class="visitors-empty">No visits recorded yet.</div>'
        : visits.map((v) => (
            '<div class="visitors-row"><strong>' + v.name.replace(/[<>&]/g, '') + '</strong>' +
            '<span>' + visitTimestamp(v.at) + '</span></div>'
          )).join('');
    }).catch(() => {
      $('#visitors-list').innerHTML = '<div class="visitors-empty">Couldn\'t load visits.</div>';
    });
  });
  $('#visitors-close').addEventListener('click', () => { $('#visitors-panel').hidden = true; });
})();
