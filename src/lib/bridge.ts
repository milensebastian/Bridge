import { createIdentity, publicKey, deriveSession, encrypt, decrypt } from './crypto';
import { useSession } from '../store/session';
type Signal = { type: string; key?: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; message?: string };
const state = useSession.getState;
export class Bridge {
  private socket?: WebSocket;
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private key?: CryptoKey;
  private room = '';
  private role: 'host' | 'guest' = 'host';
  private disposed = false;
  private tx = 0;
  private rx = -1;
  private outgoing = Promise.resolve();
  private incoming = Promise.resolve();
  private timeout?: ReturnType<typeof setTimeout>;
  private fail = (error: unknown) => { if (!this.disposed) state().set({ error: error instanceof Error ? error.message : String(error) }); };
  async start(pairUrl?: string) {
    try {
      if (!crypto.subtle) throw Error('Use HTTPS (or localhost) to enable secure pairing.');
      this.role = pairUrl ? 'guest' : 'host';
      const identity = await createIdentity();
      if (this.disposed) return;
      const ownKey = await publicKey(identity);
      let hostKey = '';
      if (pairUrl) {
        const url = new URL(pairUrl);
        this.room = url.searchParams.get('r') ?? '';
        hostKey = new URLSearchParams(url.hash.slice(1)).get('pk') ?? '';
        if (!/^[a-f0-9]{32}$/.test(this.room) || !hostKey) throw Error('This pairing link is incomplete.');
        const session = await deriveSession(identity, hostKey, this.room);
        this.key = session.aes; state().set({ sas: session.sas });
      } else {
        this.room = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
      }
      if (this.disposed) return;
      const peer = this.peer = new RTCPeerConnection({ iceServers: JSON.parse(import.meta.env.VITE_ICE_SERVERS || '[]') as RTCIceServer[] });
      const signalUrl = import.meta.env.VITE_RELAY_URL || import.meta.env.VITE_SIGNAL_URL || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`;
      const socket = this.socket = new WebSocket(signalUrl);
      const sendSignal = (value: Signal) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
      const candidates: RTCIceCandidateInit[] = [];
      let remoteKeySet = false;
      let signalQueue = Promise.resolve();
      socket.onopen = () => socket.send(JSON.stringify({ type: 'join', room: this.room, role: this.role }));
      socket.onerror = () => this.fail('Cannot reach the signaling server. Check that it is running.');
      socket.onclose = () => { if (!this.disposed && !state().connected) state().set({ status: 'Pairing ended', error: 'Pairing expired or the relay disconnected. Start a new session.' }); };
      socket.onmessage = event => {
        signalQueue = signalQueue.then(async () => {
          if (this.disposed) return;
          const message = JSON.parse(event.data as string) as Signal;
          if (message.type === 'error') throw Error(message.message);
          if (message.type === 'joined') {
            if (this.role === 'host') {
              const url = new URL('/pair', location.origin); url.searchParams.set('r', this.room); url.hash = `pk=${ownKey}`;
              state().set({ url: url.href, status: 'Waiting for a device' });
            } else {
              sendSignal({ type: 'hello', key: ownKey });
              this.bind(peer.createDataChannel('reliable-stream', { ordered: true }));
              peer.createDataChannel('realtime-input', { ordered: false, maxRetransmits: 0 });
              await peer.setLocalDescription(await peer.createOffer());
              sendSignal({ type: 'offer', sdp: peer.localDescription! });
            }
          } else if (message.type === 'hello' && this.role === 'host' && !remoteKeySet && message.key) {
            remoteKeySet = true;
            const session = await deriveSession(identity, message.key, this.room);
            this.key = session.aes; state().set({ sas: session.sas, status: 'Connecting' });
          } else if ((message.type === 'offer' || message.type === 'answer') && message.sdp) {
            if (!this.key) throw Error('Missing encryption handshake');
            await peer.setRemoteDescription(message.sdp);
            for (const candidate of candidates.splice(0)) await peer.addIceCandidate(candidate);
            if (message.type === 'offer') {
              await peer.setLocalDescription(await peer.createAnswer());
              sendSignal({ type: 'answer', sdp: peer.localDescription! });
            }
          } else if (message.type === 'ice' && message.candidate) {
            if (peer.remoteDescription) await peer.addIceCandidate(message.candidate); else candidates.push(message.candidate);
          }
        }).catch(this.fail);
      };
      peer.onicecandidate = event => { if (event.candidate) sendSignal({ type: 'ice', candidate: event.candidate.toJSON() }); };
      peer.ondatachannel = event => { if (event.channel.label === 'reliable-stream') this.bind(event.channel); };
      peer.onconnectionstatechange = () => {
        if (this.disposed) return;
        if (peer.connectionState === 'connected') {
          state().set({ connected: true, status: 'Verify your devices', url: '' });
          clearTimeout(this.timeout); socket.close();
          void peer.getStats().then(stats => {
            stats.forEach(report => { if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
              const local = stats.get(report.localCandidateId); const remote = stats.get(report.remoteCandidateId);
              state().set({ route: local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN relay' : 'Direct P2P' });
            } });
          });
        } else if (['disconnected', 'failed', 'closed'].includes(peer.connectionState)) {
          state().set({ connected: false, verified: false, peerVerified: false, status: 'Disconnected', error: 'Connection interrupted. Start a new session to reconnect securely.' });
        }
      };
      state().set({ status: 'Preparing connection', error: '' });
      this.timeout = setTimeout(() => { if (!state().connected) { this.fail('Pairing expired. Start a new session.'); this.socket?.close(); } }, 300000);
    } catch (error) { this.fail(error); }
  }
  private bind(channel: RTCDataChannel) {
    this.channel = channel; channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onmessage = event => {
      this.incoming = this.incoming.then(async () => {
        if (!this.key || typeof event.data !== 'string' || event.data.length > 100000) throw Error('Invalid encrypted message');
        const message = await decrypt(this.key, event.data, `${this.room}:${this.role === 'host' ? 'guest' : 'host'}`) as { seq: number; type: string; text?: string };
        if (!Number.isSafeInteger(message.seq) || message.seq <= this.rx) throw Error('Replayed message rejected');
        this.rx = message.seq;
        if (message.type === 'verify') state().set({ peerVerified: true });
        if (message.type === 'clipboard') {
          if (!state().verified || !state().peerVerified || typeof message.text !== 'string' || message.text.length > 12000) throw Error('Unverified clipboard message rejected');
          state().add({ id: crypto.randomUUID(), text: message.text, at: Date.now(), source: 'Other device' });
        }
      }).catch(this.fail);
    };
  }
  private send(message: { type: string; text?: string }) {
    const operation = this.outgoing.then(async () => {
      if (!this.key || this.channel?.readyState !== 'open') throw Error('The other device is not ready yet.');
      if (this.channel.bufferedAmount > 256 * 1024) throw Error('Connection is busy. Try again in a moment.');
      this.channel.send(await encrypt(this.key, { ...message, seq: this.tx++ }, `${this.room}:${this.role}`));
    });
    this.outgoing = operation.catch(() => {}); return operation;
  }
  async verify() { await this.send({ type: 'verify' }); state().set({ verified: true }); }
  async sendText(text: string) {
    if (!state().verified || !state().peerVerified) throw Error('Confirm the symbols on both devices first.');
    if (!text.trim() || text.length > 12000) throw Error('Enter between 1 and 12,000 characters.');
    await this.send({ type: 'clipboard', text });
    state().add({ id: crypto.randomUUID(), text, at: Date.now(), source: 'You' });
  }
  close() {
    this.disposed = true; clearTimeout(this.timeout); this.socket?.close(); this.peer?.close(); this.key = undefined;
    state().set({ connected: false, verified: false, peerVerified: false, url: '', sas: '', clips: [], error: '', status: 'Not connected', route: '' });
  }
}
