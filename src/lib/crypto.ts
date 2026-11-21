const encoder = new TextEncoder();
export const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export const createIdentity = () => crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
export const publicKey = async (pair: CryptoKeyPair) => encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
export async function deriveSession(pair: CryptoKeyPair, remote: string, room: string) {
  const key = await crypto.subtle.importKey('raw', decode(remote), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: key }, pair.privateKey, 256);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', shared));
  // 256 unique emoji code points retain all 32 bits of the four-byte SAS.
  const sas = Array.from(digest.slice(0, 4), b => String.fromCodePoint(0x1f300 + b)).join(' ');
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const aes = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(room), info: encoder.encode('bridge-v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  new Uint8Array(shared).fill(0);
  return { aes, sas };
}
export async function encrypt(key: CryptoKey, value: unknown, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, encoder.encode(JSON.stringify(value)));
  return JSON.stringify({ iv: encode(iv), data: encode(new Uint8Array(ciphertext)) });
}
export async function decrypt(key: CryptoKey, payload: string, context: string): Promise<unknown> {
  const { iv, data } = JSON.parse(payload);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: encoder.encode(context) }, key, decode(data));
  return JSON.parse(new TextDecoder().decode(plain));
}
