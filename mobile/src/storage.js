import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'ingenium_session';

// Guarda/lee la sesión (token + usuario) para no re-loguear en cada apertura.
export async function saveSession(session) {
  try { await AsyncStorage.setItem(KEY, JSON.stringify(session)); } catch { /* ignore */ }
}
export async function loadSession() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
export async function clearSession() {
  try { await AsyncStorage.removeItem(KEY); } catch { /* ignore */ }
}
