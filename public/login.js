(function () {
  const PINS = {
    'Jay Pro': '2001',
    'Brandon': '2002',
    'Nichole': '2003',
    'Alexander': '2004',
    'Christian': '2005',
    'Zeke': '2006',
    'Mark': '2007',
    'Rouise': '2008',
    'Dominic': '2009',
    'Jim': '2010',
    'Rommel': '2011',
  };
  const STORAGE_KEY = 'loudr_dashboard_login';

  const $ = (sel) => document.querySelector(sel);
  const nameGrid = $('#login-name-grid');
  const digits = [...document.querySelectorAll('.login-pin-digit')];
  const errorEl = $('#login-error');
  const overlay = $('#login-overlay');
  const appContent = $('#app-content');
  let selectedName = '';

  for (const name of Object.keys(PINS)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'login-name-btn';
    btn.textContent = name;
    btn.dataset.name = name;
    btn.addEventListener('click', () => {
      selectedName = name;
      nameGrid.querySelectorAll('.login-name-btn').forEach((b) => b.classList.toggle('is-selected', b === btn));
      errorEl.hidden = true;
      digits[0].focus();
    });
    nameGrid.appendChild(btn);
  }

  function showApp(name) {
    overlay.hidden = true;
    overlay.classList.add('is-hidden');
    appContent.hidden = false;
    $('#logged-in-name').textContent = name;
    startDashboardApp();
  }

  function attemptLogin() {
    const name = selectedName;
    const pin = digits.map((d) => d.value).join('');
    if (!name || pin.length < 4) return;
    if (PINS[name] === pin) {
      localStorage.setItem(STORAGE_KEY, name);
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

  // Already logged in on a previous visit — skip straight to the app.
  const savedName = localStorage.getItem(STORAGE_KEY);
  if (savedName && PINS[savedName]) {
    selectedName = savedName;
    showApp(savedName);
  }
})();
