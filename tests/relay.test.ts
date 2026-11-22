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

test('Group relay admits 20 devices, routes signals privately, and reuses open slots', async () => {
  const server = createServer();
  const relay = createRelay(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  const sockets: WebSocket[] = [];
  const read = async (socket: WebSocket) => JSON.parse(String((await once(socket, 'message'))[0]));
  async function join(role: 'host' | 'guest') {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/signal`);
    sockets.push(socket);
    await once(socket, 'open');
    const reply = read(socket);
    socket.send(JSON.stringify({ type: 'join', version: 2, room: 'b'.repeat(32), role }));
    return { socket, reply: await reply };
  }
  try {
    const host = await join('host');
    assert.deepEqual(host.reply.members, []);
    assert.equal(host.reply.id, 1);
    const firstJoin = read(host.socket);
    const first = await join('guest');
    assert.deepEqual(await firstJoin, { type: 'member-joined', id: 2 });
    const secondJoin = read(host.socket);
    const second = await join('guest');
    assert.deepEqual(await secondJoin, { type: 'member-joined', id: 3 });
    assert.deepEqual(second.reply.members, [1, 2]);
    const delivered = read(second.socket);
    const unrelated = (message: Buffer) => assert.fail(`Host received unrelated signal: ${message}`);
    host.socket.on('message', unrelated);
    first.socket.send(JSON.stringify({ type: 'hello', key: 'A'.repeat(87), to: 3, from: 1 }));
    assert.deepEqual(await delivered, { type: 'hello', key: 'A'.repeat(87), from: 2 });
    host.socket.off('message', unrelated);
    for (let id = 4; id <= 20; id++) {
      const announced = read(host.socket);
      assert.equal((await join('guest')).reply.id, id);
      assert.deepEqual(await announced, { type: 'member-joined', id });
    }
    assert.equal((await join('guest')).reply.type, 'error');
    const departure = read(host.socket);
    first.socket.close();
    assert.deepEqual(await departure, { type: 'member-left', id: 2 });
    assert.equal((await join('guest')).reply.id, 21);
    const guestClosed = once(second.socket, 'close');
    host.socket.close();
    await guestClosed;
  } finally {
    sockets.forEach(socket => socket.terminate());
    await new Promise<void>(resolve => relay.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
