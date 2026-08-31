(function () {
  const PINS = {
    'Jay Pro': '1991',
    'Brandon': '1987',
    'Nichole': '2003',
    'Alexander': '1994',
    'Christian': '2005',
    'Zeke': '2006',
    'Rouise': '2007',
    'Dominic': '2008',
    'Jim': '2009',
    'Rommel': '2010',
    'Mark': '2002',
  };
  const STORAGE_KEY = 'loudr_dashboard_login';

  const $ = (sel) => document.querySelector(sel);
  const nameGrid = $('#login-name-grid');
  const digits = [...document.querySelectorAll('.login-pin-digit')];
  const errorEl = $('#login-error');
  const overlay = $('#login-overlay');
  const appContent = $('#app-content');
  let selectedName = '';

  const BIG_NAMES = ['Jay Pro', 'Brandon'];
  Object.keys(PINS).forEach((name, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'login-name-btn' + (BIG_NAMES.includes(name) ? ' login-name-btn--big' : '');
    btn.textContent = (i + 1) + '. ' + name;
    btn.dataset.name = name;
    btn.addEventListener('click', () => {
      selectedName = name;
      nameGrid.querySelectorAll('.login-name-btn').forEach((b) => b.classList.toggle('is-selected', b === btn));
      errorEl.hidden = true;
      digits[0].focus();
    });
    nameGrid.appendChild(btn);
  });

  function showApp(name) {
    overlay.hidden = true;
    overlay.classList.add('is-hidden');
    appContent.hidden = false;
    $('#logged-in-name').textContent = name;
    startDashboardApp();
  }

  // Only an actual PIN entry counts as a visit — restoring an already-logged-in session on
  // page load/reload is not a new visit, so this is called from attemptLogin only, never from
  // the "already logged in" restore path below.
  function recordVisit(name) {
    fetch('/api/visit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    }).catch(() => {});
  }

  function attemptLogin() {
    const name = selectedName;
    const pin = digits.map((d) => d.value).join('');
    if (!name || pin.length < 4) return;
    if (PINS[name] === pin) {
      localStorage.setItem(STORAGE_KEY, name);
      recordVisit(name);
      showApp(name);
    } else {
      errorEl.hidden = false;
      digits.forEach((d) => { d.value = ''; });
      digits[0].focus();
    }
  }

  digits.forEach((d, i) => {
    d.addEventListener('input', () => {
      d.value = d.value.replace(/\D/g, '').slice(0, 1);
      errorEl.hidden = true;
      if (d.value && i < digits.length - 1) digits[i + 1].focus();
      if (digits.every((x) => x.value)) attemptLogin();
    });
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !d.value && i > 0) digits[i - 1].focus();
    });
  });

  $('#login-submit').addEventListener('click', attemptLogin);

  $('#logout-btn').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });

  // Full date + time in Pacific (the timezone the underlying campaign data itself uses),
  // not a relative "X ago" that stops being meaningful once you close and reopen the panel.
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

  // Already logged in on a previous visit — skip straight to the app.
  const savedName = localStorage.getItem(STORAGE_KEY);
  if (savedName && PINS[savedName]) {
    selectedName = savedName;
    showApp(savedName);
  }
})();
