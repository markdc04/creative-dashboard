(function () {
  const active = document.currentScript.dataset.active;
  let collapsed = false;
  try { collapsed = localStorage.getItem('loudr_sidebar_collapsed') === '1'; } catch (err) { /* private mode */ }

  const icons = {
    board: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
    dash: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
    scale: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7 2 13a3 3 0 0 0 6 0L5 7Z"/><path d="M19 7l-3 6a3 3 0 0 0 6 0l-3-6Z"/><path d="M8 21h8"/></svg>',
    brief: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
    lock: '<svg class="side-lock" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    collapse: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/></svg>',
  };

  const nav = document.createElement('aside');
  nav.className = 'side-nav';
  nav.setAttribute('aria-label', 'Main navigation');
  nav.innerHTML =
    '<img class="side-logo" src="/shared/logo-loudr.png" alt="Loudr Media">' +
    '<div class="side-divider"></div>' +
    '<div class="side-label">Workspace</div>' +
    '<a class="side-item' + (active === 'leaderboard' ? ' is-active' : '') + '" href="/" title="Creative Leaderboard">' + icons.board + '<span class="side-text">Creative Leaderboard</span></a>' +
    '<a class="side-item' + (active === 'dashboard' ? ' is-active' : '') + '" href="/dashboard/" title="Creative Dashboard">' + icons.dash + '<span class="side-text">Creative Dashboard</span><span class="side-lock-slot">' + icons.lock + '</span></a>' +
    '<a class="side-item' + (active === 'sasooness' ? ' is-active' : '') + '" href="/sasooness/" title="Sasooness Law Group, APC">' + icons.scale + '<span class="side-text">Sasooness Law Group, APC</span><span class="side-lock-slot">' + icons.lock + '</span></a>' +
    '<a class="side-item' + (active === 'km' ? ' is-active' : '') + '" href="/km/" title="KM Law Firm PLLC">' + icons.brief + '<span class="side-text">KM Law Firm PLLC</span><span class="side-lock-slot">' + icons.lock + '</span></a>' +
    '<div class="side-spacer"></div>' +
    '<div class="side-user" id="side-user" hidden><strong id="side-user-name"></strong><a href="/logout">Log out</a></div>' +
    '<button class="side-collapse" id="side-collapse" type="button" title="Collapse">' + icons.collapse + '<span>Collapse</span></button>';

  document.body.prepend(nav);
  document.body.classList.add('has-sidebar');
  if (collapsed) document.body.classList.add('side-collapsed');

  document.getElementById('side-collapse').addEventListener('click', () => {
    const now = document.body.classList.toggle('side-collapsed');
    try { localStorage.setItem('loudr_sidebar_collapsed', now ? '1' : '0'); } catch (err) { /* ignore */ }
  });

  // Logged in -> show who you are (and drop the lock); logged out -> the Dashboard item shows a lock.
  fetch('/api/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((me) => {
    if (!me) return;
    document.querySelectorAll('.side-lock-slot').forEach((el) => { el.hidden = true; });
    document.getElementById('side-user-name').textContent = me.name;
    document.getElementById('side-user').hidden = false;
  }).catch(() => {});
})();
