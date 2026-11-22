import { createIdentity, publicKey } from './crypto';
import { useSession } from '../store/session';
import { useTransfers } from '../store/transfers';
import type { Source } from '../transfer/fileSender';
import { receiveTouch, resetTouch, type TouchMessage } from '../touch/session';
import { PeerLink, type PeerSignal } from './peerLink';

type RoomSignal = PeerSignal & { from: number };
type Notice = { type: 'joined'; id: number; members: number[]; turnServer?: RTCIceServer }
  | { type: 'member-joined' | 'member-left'; id: number }
  | { type: 'bye'; from: number }
  | { type: 'error'; message: string }
  | RoomSignal;

const state = useSession.getState;

export class Bridge {
  private socket?: WebSocket;
  private identity?: CryptoKeyPair;
  private ownKey = '';
  private hostKey = '';
  private room = '';
  private id = 0;
  private disposed = false;
  private iceServers: RTCIceServer[] = [];
  private members = new Set<number>();
  private links = new Map<number, PeerLink>();
  private queues = new Map<number, Promise<void>>();
  private slides = new Map<number, Extract<TouchMessage, { action: 'slides' }>>();
  private selected?: number;

  private fail = (error: unknown) => {
    if (!this.disposed) state().set({ error: error instanceof Error ? error.message : String(error) });
  };

  private publish() {
    if (this.disposed) return;
    const devices = [...this.members].map(id => {
      const link = this.links.get(id);
      return { id, name: id === 1 ? 'Host' : `Device ${id}`, connected: link?.connected ?? false,
        connecting: Boolean(link && !link.connected), verified: link?.verified ?? false,
        ready: link?.ready ?? false, sas: link?.sas ?? '', route: link?.route ?? '' };
    });
    const verified = devices.filter(device => device.ready);
    const recipient = verified.find(device => device.id === this.selected) ?? (verified.length === 1 ? verified[0] : undefined);
    if (state().recipient !== recipient?.id) {
      resetTouch();
      const slides = recipient && this.slides.get(recipient.id);
      if (slides) {
        try { receiveTouch(slides); } catch (error) { this.fail(error); }
      }
    }
    state().set({ roomActive: Boolean(this.id), deviceId: this.id, devices, recipient: recipient?.id,
      connected: devices.some(device => device.connected), route: recipient?.route ?? '' });
  }

  private signal(message: object) {
    if (!this.disposed && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  async start(pairUrl?: string) {
    try {
      if (!globalThis.crypto?.subtle) throw Error('Use HTTPS (or localhost) to enable secure pairing.');
      this.identity = await createIdentity();
      this.ownKey = await publicKey(this.identity);
      if (this.disposed) return;
      if (pairUrl) {
        const url = new URL(pairUrl);
        this.room = url.searchParams.get('r') ?? '';
        this.hostKey = new URLSearchParams(url.hash.slice(1)).get('pk') ?? '';
        if (!/^[a-f0-9]{32}$/.test(this.room) || !/^[A-Za-z0-9_-]{87}$/.test(this.hostKey)) {
          throw Error('This pairing link is incomplete.');
        }
      } else this.room = crypto.randomUUID().replaceAll('-', '');

      const configured: RTCIceServer[] = import.meta.env.VITE_ICE_SERVERS
        ? JSON.parse(import.meta.env.VITE_ICE_SERVERS) : [{ urls: 'stun:stun.cloudflare.com:3478' }];
      this.iceServers = configured.flatMap(server => {
        const urls = [server.urls].flat().filter(url => /^stuns?:/i.test(url));
        return urls.length ? [{ urls }] : [];
      });
      const signalUrl = import.meta.env.VITE_RELAY_URL || import.meta.env.VITE_SIGNAL_URL
        || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`;
      const socket = this.socket = new WebSocket(signalUrl);
      state().set({ status: 'Preparing connection', error: '' });
      socket.onopen = () => this.signal({ type: 'join', version: 2, room: this.room, role: pairUrl ? 'guest' : 'host' });
      socket.onerror = () => this.fail('Cannot reach the signaling server.');
      socket.onclose = () => {
        if (this.disposed) return;
        const error = state().error || 'Room closed or invite expired. Start or join a new room.';
        this.close();
        state().set({ error });
      };
      socket.onmessage = event => {
        if (this.disposed) return;
        try { this.handle(JSON.parse(event.data as string) as Notice); }
        catch (error) { this.fail(error); socket.close(); }
      };
    } catch (error) { this.fail(error); }
  }

  private handle(message: Notice) {
    if (message.type === 'error') { this.fail(message.message); return; }
    if (message.type === 'joined') {
      if (!Number.isSafeInteger(message.id) || !Array.isArray(message.members)) {
        throw Error('The signaling server needs the room update before group pairing can work.');
      }
      this.id = message.id;
      this.members = new Set(message.members);
      if (message.turnServer) this.iceServers.push(message.turnServer);
      if (this.id === 1) {
        const url = new URL('/pair', location.origin);
        url.searchParams.set('r', this.room);
        url.hash = `pk=${this.ownKey}`;
        state().set({ url: url.href, status: 'Invite ready' });
      } else this.connect(1);
      this.publish();
      return;
    }
    if (message.type === 'member-joined') { this.members.add(message.id); this.publish(); return; }
    if (message.type === 'member-left') {
      this.members.delete(message.id);
      this.drop(message.id);
      return;
    }
    if (!('from' in message) || !this.members.has(message.from)) return;
    const id = message.from;
    if (message.type === 'bye') { this.drop(id); return; }
    if (message.type === 'hello' && id === 1 && message.key !== this.hostKey) {
      this.disconnect(id);
      this.fail('The host key does not match the invitation. Ask the host for a fresh link.');
      return;
    }
    const link = this.links.get(id) ?? (message.type === 'hello' ? this.connect(id) : undefined);
    if (!link) return;
    const work = (this.queues.get(id) ?? Promise.resolve()).then(() => link.handle(message)).catch(error => {
      if (this.links.get(id) !== link) return;
      this.disconnect(id);
      this.fail(error);
    });
    this.queues.set(id, work);
  }

  connect(id: number) {
    const existing = this.links.get(id);
    if (existing || !this.members.has(id) || !this.identity || this.disposed) return existing;
    const link = new PeerLink(id, this.id, this.room, this.identity, this.iceServers,
      message => this.signal({ ...message, to: id }),
      () => this.publish(),
      () => {
        if (this.links.get(id) !== link) return;
        this.disconnect(id);
        this.fail(`Could not keep a connection with ${id === 1 ? 'the host' : `Device ${id}`}. Try connecting again.`);
      },
      this.fail,
      text => state().add({ id: crypto.randomUUID(), text, at: Date.now(), source: id === 1 ? 'Host' : `Device ${id}` }),
      message => {
        if (message.action === 'slides') this.slides.set(id, message);
        if (state().recipient === id) receiveTouch(message);
      },
    );
    this.links.set(id, link);
    this.signal({ type: 'hello', key: this.ownKey, to: id });
    this.publish();
    return link;
  }

  private drop(id: number) {
    const link = this.links.get(id);
    this.links.delete(id);
    this.queues.delete(id);
    this.slides.delete(id);
    link?.close();
    if (this.selected === id) this.selected = undefined;
    this.publish();
  }

  disconnect(id: number) {
    this.signal({ type: 'bye', to: id });
    this.drop(id);
  }

  select(id?: number) {
    this.selected = id;
    this.publish();
  }

  async verify(id: number) {
    const link = this.links.get(id);
    if (!link?.connected) throw Error('This device is still connecting.');
    await link.verify();
  }

  private target(id = state().recipient) {
    const link = id === undefined ? undefined : this.links.get(id);
    if (!link?.ready) throw Error('Choose a verified device first.');
    return link;
  }

  async sendFiles(sources: Source[], id?: number) { await this.target(id).sendFiles(sources); }
  sendTouch(message: TouchMessage) { return this.target().sendTouch(message); }

  async sendText(text: string, broadcast = false, recipient?: number) {
    if (!text.trim() || text.length > 12000) throw Error('Enter between 1 and 12,000 characters.');
    const links = broadcast ? [...this.links.values()].filter(link => link.ready) : [this.target(recipient)];
    if (!links.length) throw Error('Verify a device first.');
    const results = await Promise.allSettled(links.map(link => link.sendText(text)));
    const sent = results.filter(result => result.status === 'fulfilled').length;
    if (sent) state().add({ id: crypto.randomUUID(), text, at: Date.now(), source: 'You' });
    if (sent !== links.length) throw Error(`Sent to ${sent} of ${links.length} devices.`);
  }

  async cancelTransfer(id: string) {
    const link = [...this.links.values()].find(peer => peer.ownsTransfer(id));
    await link?.cancelTransfer(id);
  }

  async pauseTransfer(id: string, paused: boolean) {
    const link = [...this.links.values()].find(peer => peer.ownsTransfer(id));
    await link?.pauseTransfer(id, paused);
  }

  close() {
    if (this.disposed) return;
    this.disposed = true;
    this.socket?.close();
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.queues.clear();
    resetTouch();
    useTransfers.setState(s => ({ queue: s.queue.filter(row => row.download) }));
    state().set({ connected: false, roomActive: false, deviceId: 0, devices: [], recipient: undefined,
      url: '', clips: [], error: '', status: 'Not connected', route: '' });
  }
}
