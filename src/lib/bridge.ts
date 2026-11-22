import { createIdentity, publicKey } from './crypto';
import { useSession } from '../store/session';
import { useTransfers } from '../store/transfers';
import type { Source } from '../transfer/fileSender';
import { receiveTouch, resetTouch, type TouchMessage } from '../touch/session';
import { PeerLink, type PeerSignal } from './peerLink';
import { cleanRoomName, ROOM_SIZE, userLabel, type RoomProfile } from './roomProfile';
import { rememberedDisplayName, rememberDisplayName } from './displayName';

type RoomSignal = PeerSignal & { from: number };
type Notice = { type: 'joined'; id: number; members: number[]; profiles?: RoomProfile[]; turnServer?: RTCIceServer }
  | { type: 'member-joined'; id: number; profile?: RoomProfile }
  | { type: 'member-left'; id: number }
  | { type: 'member-renamed'; profile: RoomProfile }
  | { type: 'bye'; from: number }
  | { type: 'error'; message: string }
  | RoomSignal;

const state = useSession.getState;
const SIGNAL_WAIT = 85_000;
const SIGNAL_ATTEMPT = 12_000;
const SIGNAL_RETRY = 2_500;

export class Bridge {
  private socket?: WebSocket;
  private signalTimer?: ReturnType<typeof setTimeout>;
  private wakeRequest?: AbortController;
  private identity?: CryptoKeyPair;
  private ownKey = '';
  private hostKey = '';
  private room = '';
  private id = 0;
  private disposed = false;
  private iceServers: RTCIceServer[] = [];
  private members = new Set<number>();
  private profiles = new Map<number, RoomProfile>();
  private links = new Map<number, PeerLink>();
  private queues = new Map<number, Promise<void>>();
  private slides = new Map<number, Extract<TouchMessage, { action: 'slides' }>>();
  private failedLinks = new Set<number>();
  private turnAvailable = false;
  private selected?: number;

  private fail = (error: unknown) => {
    if (!this.disposed) state().set({ error: error instanceof Error ? error.message : String(error) });
  };

  private label(id: number) {
    const profile = this.profiles.get(id);
    return profile?.name || userLabel(profile?.slot ?? id);
  }

  private memberSlot(id: number) {
    return this.profiles.get(id)?.slot ?? (id - 1) % ROOM_SIZE + 1;
  }

  private publish() {
    if (this.disposed) return;
    const devices = [...this.members].map(id => {
      const link = this.links.get(id);
      const profile = this.profiles.get(id);
      return { id, slot: this.memberSlot(id), name: this.label(id),
        customName: Boolean(profile?.name), connected: link?.connected ?? false,
        connecting: Boolean(link && !link.connected), verified: link?.confirmed ?? false,
        failed: this.failedLinks.has(id),
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
    state().set({ roomActive: Boolean(this.id), deviceId: this.id, profile: this.profiles.get(this.id), devices, recipient: recipient?.id,
      connected: devices.some(device => device.connected), route: recipient?.route ?? '' });
  }

  private signal(message: object) {
    if (!this.disposed && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  async start(pairUrl?: string) {
    state().set({ status: 'Connecting to the signaling server…', connecting: true, error: '' });
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
      this.openSignal(signalUrl, pairUrl ? 'guest' : 'host', Date.now() + SIGNAL_WAIT);
    } catch (error) {
      if (this.disposed) return;
      this.close();
      state().set({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  private openSignal(url: string, role: 'guest' | 'host', deadline: number) {
    if (this.disposed) return;
    const socket = this.socket = new WebSocket(url);
    const current = () => !this.disposed && this.socket === socket;
    let rejection: string | undefined;
    const retry = () => {
      if (!current()) return;
      clearTimeout(this.signalTimer);
      if (this.id || rejection || deadline - Date.now() <= SIGNAL_RETRY) {
        const error = rejection || (this.id
          ? 'The signaling connection closed. Start or join a new room.'
          : 'Cannot reach the signaling server after several tries. Try another network or turn off your VPN, then retry.');
        this.close();
        state().set({ error });
        return;
      }
      this.socket = undefined;
      socket.close();
      state().set({ status: 'Still connecting. The free server may be waking up…' });
      if (!this.wakeRequest) {
        const health = new URL('/health', url);
        health.protocol = health.protocol === 'wss:' ? 'https:' : 'http:';
        this.wakeRequest = new AbortController();
        void fetch(health, { mode: 'no-cors', cache: 'no-store', signal: this.wakeRequest.signal }).catch(() => {});
      }
      this.signalTimer = setTimeout(() => this.openSignal(url, role, deadline), SIGNAL_RETRY);
    };
    socket.onopen = () => {
      if (current()) this.signal({ type: 'join', version: 2, room: this.room, role });
    };
    socket.onclose = retry;
    socket.onmessage = event => {
      if (!current()) return;
      try {
        const message = JSON.parse(event.data as string) as Notice;
        if (message.type === 'error') throw Error(message.message);
        this.handle(message);
        if (message.type === 'joined') {
          clearTimeout(this.signalTimer);
          this.wakeRequest?.abort();
          state().set({ connecting: false });
        }
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
        retry();
      }
    };
    this.signalTimer = setTimeout(retry, Math.min(SIGNAL_ATTEMPT, Math.max(1, deadline - Date.now())));
  }

  private handle(message: Notice) {
    if (message.type === 'joined') {
      if (!Number.isSafeInteger(message.id) || !Array.isArray(message.members)) {
        throw Error('The signaling server needs the room update before group pairing can work.');
      }
      this.id = message.id;
      this.members = new Set(message.members);
      this.profiles = new Map(message.profiles?.map(profile => [profile.id, profile]));
      const name = rememberedDisplayName();
      if (name && this.profiles.has(this.id)) this.signal({ type: 'rename', name });
      if (message.turnServer) {
        this.iceServers.push(message.turnServer);
        this.turnAvailable = true;
      }
      if (this.id === 1) {
        const url = new URL('/pair', location.origin);
        url.searchParams.set('r', this.room);
        url.hash = `pk=${this.ownKey}`;
        state().set({ url: url.href, status: 'Invite ready' });
      } else this.connect(1);
      this.publish();
      return;
    }
    if (message.type === 'member-joined') {
      this.members.add(message.id);
      if (message.profile) this.profiles.set(message.id, message.profile);
      if (this.id === 1) this.connect(message.id);
      this.publish();
      return;
    }
    if (message.type === 'member-left') {
      this.members.delete(message.id);
      this.profiles.delete(message.id);
      this.failedLinks.delete(message.id);
      this.drop(message.id);
      return;
    }
    if (message.type === 'member-renamed') {
      const { profile } = message;
      if (profile.id === this.id || this.members.has(profile.id)) {
        this.profiles.set(profile.id, profile);
        this.publish();
      }
      return;
    }
    if (!('from' in message) || !this.members.has(message.from)) return;
    const id = message.from;
    if (message.type === 'bye') {
      const link = this.links.get(id);
      if (link && !link.connected) this.failedLinks.add(id);
      this.drop(id);
      return;
    }
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
    this.failedLinks.delete(id);
    const link = new PeerLink(id, this.id, this.room, this.identity, this.iceServers,
      message => this.signal({ ...message, to: id }),
      () => this.publish(),
      () => {
        if (this.links.get(id) !== link) return;
        if (!link.connected) this.failedLinks.add(id);
        this.disconnect(id);
        if (link.connected) this.fail('The device disconnected. Use Connect to try again.');
      },
      this.fail,
      text => state().add({ id: crypto.randomUUID(), text, at: Date.now(), source: this.label(id), slot: this.memberSlot(id), sentByMe: false }),
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

  rename(name: string) {
    if (!this.profiles.has(this.id) || this.socket?.readyState !== WebSocket.OPEN) {
      throw Error('Display names are unavailable in this room.');
    }
    const cleanName = cleanRoomName(name);
    this.signal({ type: 'rename', name: cleanName });
    return rememberDisplayName(cleanName);
  }

  async verify(id: number) {
    const link = this.links.get(id);
    if (!link?.sas) throw Error('Wait for the verification symbols.');
    await link.verify();
  }

  get connectionHelp() {
    return this.turnAvailable
      ? 'Neither path connected. The relay may be blocked on this network or its free monthly quota may be used up. Keep both tabs open and try Connect again.'
      : 'A direct connection could not open and a relay is unavailable. Try both devices on the same Wi-Fi, then use Connect.';
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
    if (sent && !this.disposed) state().add({ id: crypto.randomUUID(), text, at: Date.now(), source: 'You', slot: this.memberSlot(this.id), sentByMe: true });
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
    clearTimeout(this.signalTimer);
    this.wakeRequest?.abort();
    this.socket?.close();
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.queues.clear();
    resetTouch();
    useTransfers.setState(s => ({ queue: s.queue.filter(row => row.download) }));
    state().set({ connected: false, connecting: false, roomActive: false, deviceId: 0, profile: undefined, devices: [], recipient: undefined,
      url: '', clips: [], error: '', status: 'Not connected', route: '' });
  }
}
