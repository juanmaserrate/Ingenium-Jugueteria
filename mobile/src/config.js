import Constants from 'expo-constants';

// URL del backend de Ingenium (producción Railway). Se puede sobrescribir en app.json → extra.apiBase.
export const API_BASE =
  Constants.expoConfig?.extra?.apiBase ||
  'https://ingenium-jugueteria-production-0632.up.railway.app';

// Colores (paleta Ingenium).
export const COLORS = {
  red: '#d82f1e',
  dark: '#241a0d',
  muted: '#7d6c5c',
  card: '#ffffff',
  bg: '#fff8f0',
  line: '#fff1e6',
  green: '#157f3b',
};
