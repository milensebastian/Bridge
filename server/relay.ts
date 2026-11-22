import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

export function createRelay(server: Server, allowedOrigins: string[] = []) {
  const wss = new WebSocketServer({ server, path: '/signal', maxPayload: 64 * 1024, verifyClient: ({ origin }: { origin: string }) => !allowedOrigins.length || allowedOrigins.includes(origin) });
  type Room = { host: WebSocket; members: Map<number, WebSocket>; group: boolean; nextId: number; expires: number };
  const rooms = new Map<string, Room>();
  wss.on('connection', socket => {
    let roomId: string | undefined;
    let memberId = 0;
    let alive = true;
    let count = 0;
    const rate = setInterval(() => { count = 0; }, 1000);
    const heartbeat = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      if (socket.readyState === WebSocket.OPEN) {
        alive = false;
        socket.ping();
      }
    }, 30000);
    socket.on('pong', () => { alive = true; });
    const joinTimeout = setTimeout(() => { if (!roomId) socket.close(1008, 'Join timeout'); }, 10000);
    socket.on('error', () => {});
    socket.on('message', raw => {
      if (++count > 240) return socket.close(1008, 'Rate limit');
      try {
        const message = JSON.parse(raw.toString());
        if (!roomId) {
          if (message.type !== 'join' || typeof message.room !== 'string' || !/^[a-f0-9]{32}$/.test(message.room) || !['host', 'guest'].includes(message.role)) throw Error('Invalid join');
          let room = rooms.get(message.room);
          const group = message.version === 2;
          if (message.role === 'host') {
            if (room || rooms.size >= 1000) throw Error('Room unavailable');
            room = { host: socket, members: new Map(), group, nextId: 1, expires: Date.now() + 300000 };
            rooms.set(message.room, room);
          } else {
            if (!room || room.group !== group || room.host.readyState !== WebSocket.OPEN) throw Error('Room unavailable or expired');
            if (room.members.size >= (room.group ? 20 : 2)) throw Error('This room is full');
          }
          roomId = message.room;
          memberId = room.nextId++;
          const members = [...room.members.keys()];
          room.members.set(memberId, socket);
          if (room.group && room.members.size > 1) room.expires = Infinity;
          const secret = process.env.TURN_SHARED_SECRET;
          const urls = process.env.TURN_URLS?.split(',').map(url => url.trim()).filter(Boolean);
          let turnServer;
          const allowTurn = !group || process.env.BRIDGE_QUOTA_MANAGED_TURN === 'true';
          if (allowTurn && process.env.TURN_CLIENT_CONFIG) {
            turnServer = JSON.parse(process.env.TURN_CLIENT_CONFIG);
          }
          if (allowTurn && secret && urls?.length) {
            const username = `${Math.floor(Date.now() / 1000) + 3600}:${randomUUID()}`;
            const credential = createHmac('sha1', secret).update(username).digest('base64');
            turnServer = { urls, username, credential };
          }
          socket.send(JSON.stringify({ type: 'joined', turnServer, ...(group ? { id: memberId, members } : {}) }));
          if (group) for (const [id, peer] of room.members) {
            if (id !== memberId && peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'member-joined', id: memberId }));
          }
          return;
        }
        const room = rooms.get(roomId);
        if (!room) return;
        if (room.group && (!Number.isSafeInteger(message.to) || message.to === memberId)) throw Error('Invalid signaling destination');
        if (!['hello', 'offer', 'answer', 'ice'].includes(message.type) && !(room.group && message.type === 'bye')) throw Error('Signaling only');
        let forwarded: Record<string, unknown>;
        if (message.type === 'bye') {
          forwarded = { type: 'bye' };
        } else if (message.type === 'hello') {
          if (typeof message.key !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(message.key)) throw Error('Invalid public key');
          forwarded = { type: 'hello', key: message.key };
        } else if (message.type === 'ice') {
          const c = message.candidate;
          if (!c || typeof c.candidate !== 'string' || c.candidate.length > 4096 || !(c.sdpMid == null || typeof c.sdpMid === 'string') || !(c.sdpMLineIndex == null || Number.isInteger(c.sdpMLineIndex))) throw Error('Invalid ICE candidate');
          forwarded = { type: 'ice', candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } };
        } else {
          if (message.sdp?.type !== message.type || typeof message.sdp.sdp !== 'string' || !message.sdp.sdp.startsWith('v=0')) throw Error('Invalid SDP');
          forwarded = { type: message.type, sdp: { type: message.sdp.type, sdp: message.sdp.sdp } };
        }
        const peer = room.group ? room.members.get(message.to) : [...room.members.values()].find(member => member !== socket);
        if (peer?.readyState === WebSocket.OPEN) peer.send(JSON.stringify(room.group ? { ...forwarded, from: memberId } : forwarded));
      } catch (error) {
        socket.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Invalid message' }));
        socket.close(1008);
      }
    });
    socket.on('close', () => {
      clearInterval(rate); clearInterval(heartbeat); clearTimeout(joinTimeout);
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room || room.members.get(memberId) !== socket) return;
      room.members.delete(memberId);
      if (!room.group) {
        if (!room.members.size) rooms.delete(roomId!);
        return;
      }
      if (socket === room.host) {
        rooms.delete(roomId!);
        for (const member of room.members.values()) member.close(1000, 'Host left');
      } else {
        if (room.members.size === 1) room.expires = Date.now() + 300000;
        for (const member of room.members.values()) {
          if (member.readyState === WebSocket.OPEN) member.send(JSON.stringify({ type: 'member-left', id: memberId }));
        }
      }
    });
  });
  const cleanup = setInterval(() => {
    for (const [id, room] of rooms) if (room.expires <= Date.now()) {
      for (const member of room.members.values()) member.close(1000, 'Pairing expired');
      rooms.delete(id);
    }
  }, 1000);
  wss.on('close', () => clearInterval(cleanup));
  return wss;
}
