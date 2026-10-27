(() => {
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
    updateButton();
  }
  function isDark() { return root.dataset.theme ? root.dataset.theme === 'dark' : system.matches; }
  function updateButton() {
    const button = document.getElementById('share-theme-toggle');
    if (!button) return;
    const dark = isDark();
    button.setAttribute('aria-label', dark ? '切换到白天模式' : '切换到黑夜模式');
    button.title = button.getAttribute('aria-label');
    const icon = dark
      ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>'
      : '<path d="M20.5 13.3A8.5 8.5 0 0 1 10.7 3.5a8.5 8.5 0 1 0 9.8 9.8Z"/>';
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
  }
  let saved;
  try { saved = localStorage.getItem('theme'); } catch {}
  // Run in the head before painting to avoid flashing the system theme.
  applyTheme(saved);
  document.addEventListener('DOMContentLoaded', () => {
    updateButton();
    document.getElementById('share-theme-toggle').addEventListener('click', () => {
      const next = isDark() ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem('theme', next); } catch {}
    });
  });
  system.addEventListener('change', updateButton);
  window.addEventListener('storage', event => {
    if (event.key === 'theme' || event.key === null) applyTheme(event.newValue);
  });
})();
