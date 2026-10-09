// Applies the saved (or system) colour theme before first paint. External file so the CSP needs no 'unsafe-inline'.
try {
  var t = localStorage.getItem('af-theme');
  if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
} catch (e) {}
