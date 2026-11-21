import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, publicKey, deriveSession, encrypt, decrypt } from '../src/lib/crypto';
test('Both peers derive the same SAS and can exchange authenticated ciphertext', async () => {
  const alice = await createIdentity(); const bob = await createIdentity();
  const a = await deriveSession(alice, await publicKey(bob), 'room');
  const b = await deriveSession(bob, await publicKey(alice), 'room');
  assert.equal(a.sas, b.sas);
  const payload = { type: 'clipboard', text: 'Hello from another device 👋', seq: 0 };
  const encrypted = await encrypt(a.aes, payload, 'room:host');
  assert.ok(!encrypted.includes(payload.text));
  assert.deepEqual(await decrypt(b.aes, encrypted, 'room:host'), payload);
  await assert.rejects(decrypt(b.aes, encrypted, 'room:guest'));
  const changed = JSON.parse(encrypted); changed.data = (changed.data[0] === 'A' ? 'B' : 'A') + changed.data.slice(1);
  await assert.rejects(decrypt(b.aes, JSON.stringify(changed), 'room:host'));
});
test('Different rooms derive isolated encryption keys', async () => {
  const a = await createIdentity(); const b = await createIdentity();
  const first = await deriveSession(a, await publicKey(b), 'one');
  const second = await deriveSession(b, await publicKey(a), 'two');
  await assert.rejects(decrypt(second.aes, await encrypt(first.aes, 'secret', 'context'), 'context'));
});
