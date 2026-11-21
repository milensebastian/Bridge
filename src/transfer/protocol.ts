import { crc32 } from './crc32';

export const chunkSize = 32768;
export const windowBytes = 1024 * 1024;
export const threshold = 262144;
export type Item = { fileId: number; name: string; relativePath: string; size: number; mimeType: string };
export type Manifest = { type: 'transfer-manifest'; transferId: string; files: Item[]; totalBytes: number; more?: boolean };
export type Control = Manifest
  | { type: 'file-complete'; transferId: string; fileId: number }
  | { type: 'transfer-ack'; transferId: string; bytes: number; complete?: boolean }
  | { type: 'transfer-cancel'; transferId: string; reason?: string }
  | { type: 'transfer-pause'; transferId: string; paused: boolean };
export type Wire = { control: (value: Control) => Promise<void>; binary: (value: ArrayBuffer) => Promise<void> };

export function validateManifest(m: Manifest) {
  if (!/^[a-f0-9-]{36}$/.test(m.transferId) || !Array.isArray(m.files) || !m.files.length) throw Error('Invalid transfer manifest.');
  const paths = new Set<string>();
  let total = 0;
  for (const [i, f] of m.files.entries()) {
    const parts = f.relativePath.split('/');
    if (f.fileId !== i || parts.at(-1) !== f.name || parts.some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p))
      || paths.has(f.relativePath) || !Number.isSafeInteger(f.size) || f.size < 0) throw Error('Invalid file path or size.');
    paths.add(f.relativePath);
    total += f.size;
  }
  if (!Number.isSafeInteger(total) || total !== m.totalBytes) throw Error('Invalid transfer size.');
}

export async function frame(key: CryptoKey, fileId: number, offset: number, bytes: Uint8Array<ArrayBuffer>, id: string) {
  const result = new Uint8Array(17 + 12 + bytes.length + 16);
  const header = new DataView(result.buffer);
  header.setUint8(0, 1);
  header.setUint32(1, fileId);
  header.setBigUint64(5, BigInt(offset));
  header.setUint32(13, crc32(bytes));
  const iv = crypto.getRandomValues(result.subarray(17, 29));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(result, id) }, key, bytes);
  result.set(new Uint8Array(cipher), 29);
  return result.buffer;
}
export function aad(frame: Uint8Array, id: string) {
  const bytes = new Uint8Array(17 + id.length);
  bytes.set(frame.subarray(0, 17));
  bytes.set(new TextEncoder().encode(id), 17);
  return bytes;
}
