// PBKDF2 sobre PIN: guarda {pin_salt, pin_hash, pin_iters} en lugar de texto plano.
// Costo elegido bajo (100k) para que el login se sienta instantáneo incluso en máquinas lentas.

const enc = new TextEncoder();
const ITERS = 100_000;

export function randomSalt(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bufferToHex(arr);
}

export async function hashPin(pin, salt, iterations = ITERS) {
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(String(pin)), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBuffer(salt), iterations, hash: 'SHA-256' },
    keyMat,
    256,
  );
  return bufferToHex(new Uint8Array(bits));
}

export async function verifyPin(pin, salt, expectedHash, iterations = ITERS) {
  const h = await hashPin(pin, salt, iterations);
  return h === expectedHash;
}

// Deriva {pin_salt, pin_hash, pin_iters} nuevos desde un PIN en texto plano.
export async function derivePin(pin) {
  const salt = randomSalt();
  const hash = await hashPin(pin, salt, ITERS);
  return { pin_salt: salt, pin_hash: hash, pin_iters: ITERS };
}

function bufferToHex(buf) {
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}
function hexToBuffer(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}
