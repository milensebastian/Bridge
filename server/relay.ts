import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

export function createRelay(server: Server, allowedOrigins: string[] = []) {
  const wss = new WebSocketServer({ server, path: '/signal', maxPayload: 64 * 1024, verifyClient: ({ origin }: { origin: string }) => !allowedOrigins.length || allowedOrigins.includes(origin) });
  const rooms = new Map<string, { host: WebSocket; guest?: WebSocket; expires: number }>();
  wss.on('connection', socket => {
    let roomId: string | undefined;
    let count = 0;
    const rate = setInterval(() => { count = 0; }, 1000);
    const joinTimeout = setTimeout(() => { if (!roomId) socket.close(1008, 'Join timeout'); }, 10000);
    socket.on('error', () => {});
    socket.on('message', raw => {
      if (++count > 80) return socket.close(1008, 'Rate limit');
      try {
        const message = JSON.parse(raw.toString());
        if (!roomId) {
          if (message.type !== 'join' || !/^[a-f0-9]{32}$/.test(message.room) || !['host', 'guest'].includes(message.role)) throw Error('Invalid join');
          const room = rooms.get(message.room);
          if (message.role === 'host') {
            if (room || rooms.size >= 1000) throw Error('Room unavailable');
            rooms.set(message.room, { host: socket, expires: Date.now() + 300000 });
          } else {
            if (!room || room.guest || room.host.readyState !== WebSocket.OPEN) throw Error('Room unavailable or expired');
            room.guest = socket;
          }
          roomId = message.room;
          const secret = process.env.TURN_SHARED_SECRET;
          const urls = process.env.TURN_URLS?.split(',').map(url => url.trim()).filter(Boolean);
          let turnServer;
          if (process.env.TURN_CLIENT_CONFIG) {
            turnServer = JSON.parse(process.env.TURN_CLIENT_CONFIG);
          }
          if (secret && urls?.length) {
            const username = `${Math.floor(Date.now() / 1000) + 3600}:${randomUUID()}`;
            const credential = createHmac('sha1', secret).update(username).digest('base64');
            turnServer = { urls, username, credential };
          }
          socket.send(JSON.stringify({ type: 'joined', turnServer }));
          return;
        }
        if (!['hello', 'offer', 'answer', 'ice'].includes(message.type)) throw Error('Signaling only');
        let forwarded: unknown;
        if (message.type === 'hello') {
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
        const room = rooms.get(roomId);
        const peer = room?.host === socket ? room.guest : room?.host;
        if (peer?.readyState === WebSocket.OPEN) peer.send(JSON.stringify(forwarded));
      } catch (error) {
        socket.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Invalid message' }));
        socket.close(1008);
      }
    });
    socket.on('close', () => {
      clearInterval(rate); clearTimeout(joinTimeout);
      const room = roomId ? rooms.get(roomId) : undefined;
      if (room && room.host.readyState !== WebSocket.OPEN && (!room.guest || room.guest.readyState !== WebSocket.OPEN)) rooms.delete(roomId!);
    });
  });
  const cleanup = setInterval(() => {
    for (const [id, room] of rooms) if (room.expires <= Date.now()) {
      room.host.close(1000, 'Pairing expired'); room.guest?.close(1000, 'Pairing expired'); rooms.delete(id);
    }
  }, 1000);
  wss.on('close', () => clearInterval(cleanup));
  return wss;
}
