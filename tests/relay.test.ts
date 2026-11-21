import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRelay } from '../server/relay';
test('Relay admits exactly two devices and rejects payload storage messages', async () => {
  const server = createServer(); const relay = createRelay(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const sockets: WebSocket[] = [];
  const connect = async (role: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/signal`); sockets.push(socket); await once(socket, 'open');
    const reply = once(socket, 'message'); socket.send(JSON.stringify({ type: 'join', room: 'a'.repeat(32), role }));
    return { socket, reply: JSON.parse(String((await reply)[0])) };
  };
  try {
    const host = await connect('host'); const guest = await connect('guest');
    assert.equal(host.reply.type, 'joined'); assert.equal(guest.reply.type, 'joined');
    assert.equal((await connect('guest')).reply.type, 'error');
    const delivered = once(host.socket, 'message'); guest.socket.send(JSON.stringify({ type: 'hello', key: 'A'.repeat(87) }));
    assert.equal(JSON.parse(String((await delivered)[0])).key, 'A'.repeat(87));
    const rejected = once(guest.socket, 'message'); guest.socket.send(JSON.stringify({ type: 'clipboard', text: 'not allowed on relay' }));
    assert.equal(JSON.parse(String((await rejected)[0])).type, 'error');
  } finally { sockets.forEach(socket => socket.terminate()); await new Promise<void>(resolve => relay.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); }
});
