try {
      const theme = localStorage.getItem('theme');
      if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    } catch {}

try {
  const collapsed = localStorage.getItem('sidebar-collapsed');
  if (collapsed === 'true' || collapsed === 'false') document.documentElement.dataset.sidebarCollapsed = collapsed;
} catch {}
