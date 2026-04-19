// Tailwind config compartido entre index.html y app.html.
// DEBE cargarse DESPUÉS del CDN de Tailwind (usa el global `tailwind`).

// U-11: aplicar preferencia de tema antes del primer pintado para evitar flash.
try {
  const saved = localStorage.getItem('ingenium_theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.classList.remove('light', 'dark');
  document.documentElement.classList.add(theme);
} catch {}

tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: '#d82f1e',
        'primary-container': '#b41005',
        'on-primary': '#ffffff',
        secondary: '#241a0d',
        surface: '#ffffff',
        background: '#fff8f4',
        'surface-container-lowest': '#ffffff',
        'surface-container-low': '#fff1e6',
        'surface-container': '#f5dfca',
        'surface-container-high': '#e3ceba',
        'surface-container-highest': '#d4bca6',
        outline: '#7d6c5c',
        'outline-variant': '#c9b6a4',
      },
      borderRadius: {
        DEFAULT: '0.5rem',
        lg: '1.5rem',
        xl: '2rem',
        full: '9999px',
      },
      fontFamily: {
        headline: ['Plus Jakarta Sans'],
        body: ['Plus Jakarta Sans'],
        label: ['Plus Jakarta Sans'],
      },
    },
  },
};
