// Same "jump to top" button as the leaderboard/creative dashboard, built here instead of copied
// into every client page's own markup/app.js so all of them stay in sync from one place.
(function () {
  const btn = document.createElement('button');
  btn.id = 'back-to-top';
  btn.className = 'back-to-top';
  btn.hidden = true;
  btn.setAttribute('aria-label', 'Back to top');
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
  document.body.appendChild(btn);

  window.addEventListener('scroll', () => { btn.hidden = window.scrollY < 400; });
  btn.addEventListener('click', () => { window.scrollTo({ top: 0, behavior: 'smooth' }); });
})();
