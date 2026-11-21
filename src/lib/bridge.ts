import { createIdentity, publicKey, deriveSession, encrypt, decrypt } from './crypto';
import { useSession } from '../store/session';
import { FileSender, type Source } from '../transfer/fileSender';
import { FileReceiver } from '../transfer/fileReceiver';
import { chunkSize, threshold, windowBytes, type Control, type Manifest, type Wire } from '../transfer/protocol';
import { update, useTransfers } from '../store/transfers';
import {receiveTouch, resetTouch, type TouchMessage} from '../touch/session';
type Signal = { type: string; key?: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; message?: string; turnServer?: RTCIceServer };
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
  private realtime?:RTCDataChannel;
  private touchSeq=0;
  private lastInk=-1;
  private lastLaser=-1;
  private bindRealtime(channel:RTCDataChannel) {
    this.realtime=channel;
    channel.onmessage=event=>{
      if (!this.key || !state().verified || !state().peerVerified || typeof event.data!=='string' || event.data.length>50000) return;
      void decrypt(this.key,event.data,this.room+':motion:'+ (this.role==='host'?'guest':'host')).then(raw=>{
        if(this.disposed || !state().verified || !state().peerVerified)return;
        const msg=raw as TouchMessage & {order:number};
        if(msg.type==='touch' && (msg.action==='laser' || (msg.action==='ink' && !msg.confirmed))) this.acceptTouch(msg);
      }).catch(this.fail);
    };
  }
  private acceptTouch(msg:TouchMessage & {order?:number}) {
    if(msg.action==='ink' || msg.action==='laser') {
      const field=msg.action==='ink'?'lastInk':'lastLaser';
      const order=msg.order;
      if(typeof order!=='number' || !Number.isSafeInteger(order) || order<=this[field])return;
      this[field]=order;
    }
    receiveTouch(msg);
  }
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
      const iceServers: RTCIceServer[] = import.meta.env.VITE_ICE_SERVERS
        ? JSON.parse(import.meta.env.VITE_ICE_SERVERS)
        : [{ urls: 'stun:stun.cloudflare.com:3478' }];
      const peer = this.peer = new RTCPeerConnection({ iceServers });
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
            if (message.turnServer) peer.setConfiguration({ iceServers: [...iceServers, message.turnServer] });
            if (this.role === 'host') {
              const url = new URL('/pair', location.origin); url.searchParams.set('r', this.room); url.hash = `pk=${ownKey}`;
              state().set({ url: url.href, status: 'Waiting for a device' });
            } else {
              sendSignal({ type: 'hello', key: ownKey });
              this.bind(peer.createDataChannel('reliable-stream', { ordered: true }));
              this.bindRealtime(peer.createDataChannel('realtime-input', { ordered: false, maxRetransmits: 0 }));
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
      peer.ondatachannel = event => { if (event.channel.label === 'reliable-stream') this.bind(event.channel); else if(event.channel.label==='realtime-input') this.bindRealtime(event.channel); };
      peer.onconnectionstatechange = () => {
        if (this.disposed) return;
        if (peer.connectionState === 'connected') {
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
  private sender?: FileSender;
  private receiver?: FileReceiver;
  private pendingBytes = 0;
  private partialManifest?: Manifest;

  private async announce(m: Manifest) {
    const limit = Math.min(99000,this.peer?.sctp?.maxMessageSize || 65536);
    let page: Manifest = {...m,files:[]};
    let size = 256;
    for (const file of m.files) {
      const length = new TextEncoder().encode(JSON.stringify(file)).length + 1;
      if (page.files.length && (size + length) * 4/3 + 160 > limit) {
        await this.send({...page,more:true});
        page = {...m,files:[]};
        size = 256;
      }
      page.files.push(file);
      size += length;
    }
    await this.send(page);
  }
  private get wire(): Wire {
    return {control: value => value.type === 'transfer-manifest' ? this.announce(value) : this.send(value), binary: value => this.write(value)};
  }
  private async write(payload: string | ArrayBuffer) {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') throw Error('Connection closed.');
    if (channel.bufferedAmount > threshold) await new Promise<void>((resolve,reject) => {
      const cleanup = () => {
        channel.removeEventListener('bufferedamountlow', low);
        channel.removeEventListener('close', closed);
      };
      const low = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(Error('Connection closed.')); };
      channel.addEventListener('bufferedamountlow',low);
      channel.addEventListener('close',closed);
    });
    if (typeof payload === 'string') channel.send(payload);
    else channel.send(payload);
  }
  async sendFiles(sources: Source[]) {
    if (!this.key || !state().verified || !state().peerVerified) throw Error('Confirm the symbols on both devices first.');
    if (this.sender) throw Error('Finish the current outgoing transfer first.');
    const max = this.peer?.sctp?.maxMessageSize || 65536;
    if (max < 16429) throw Error('This connection does not support file-sized messages.');
    const sender = new FileSender(sources,this.wire,this.key,Math.min(chunkSize,max - 45));
    this.sender = sender;
    const id = sender.manifest.transferId;
    try { await sender.run(); }
    catch (error) {
      const row = useTransfers.getState().queue.find(row => row.id === id);
      if (row?.status === 'Active' || row?.status === 'Paused') {
        update(id,{status:'Failed',detail:String(error)});
        await this.send({type:'transfer-cancel',transferId:id,reason:String(error)}).catch(()=>{});
      }
    } finally { if (this.sender === sender) this.sender = undefined; }
  }
  private async stopTransfer(id: string, reason?: string) {
    if (this.partialManifest?.transferId === id) this.partialManifest = undefined;
    update(id,{status:reason ? 'Failed' : 'Cancelled',detail:reason});
    if (this.sender?.manifest.transferId === id) this.sender.cancel();
    if (this.receiver?.manifest.transferId === id) {
      const receiver = this.receiver;
      this.receiver = undefined;
      await receiver.discard();
    }
  }
  async cancelTransfer(id: string) {
    update(id,{status:'Cancelled'});
    if (this.sender?.manifest.transferId === id) this.sender.cancel();
    this.incoming = this.incoming.then(()=>this.stopTransfer(id)).catch(this.fail);
    await this.send({type:'transfer-cancel',transferId:id});
  }
  async pauseTransfer(id: string, paused: boolean) {
    if (this.sender?.manifest.transferId === id) this.sender.pause(paused);
    update(id,{status:paused ? 'Paused' : 'Active'});
    await this.send({type:'transfer-pause',transferId:id,paused});
  }
  private endTransfers() {
    this.sender?.cancel();
    const receiver = this.receiver;
    this.incoming = this.incoming.then(async () => {
      if (receiver && this.receiver === receiver) await this.stopTransfer(receiver.manifest.transferId,'Connection closed.');
    }).catch(this.fail);
  }
  private async control(message: Control) {
    const id = message.transferId;
    if (message.type === 'transfer-manifest') {
      if (this.receiver || this.sender?.manifest.transferId === id) {
        await this.send({type:'transfer-cancel',transferId:id,reason:'Receiver is busy.'}); return;
      }
      if (this.partialManifest) {
        if (this.partialManifest.transferId !== id || this.partialManifest.totalBytes !== message.totalBytes) throw Error('Unexpected manifest page.');
        this.partialManifest.files.push(...message.files);
      } else this.partialManifest = {...message,files:[...message.files]};
      if (message.more) return;
      const manifest = this.partialManifest;
      this.partialManifest = undefined;
      this.receiver = new FileReceiver(manifest,this.wire,this.key!);
      await this.receiver.start();
    } else if (message.type === 'transfer-cancel') {
      if (id === this.receiver?.manifest.transferId || id === this.sender?.manifest.transferId || id === this.partialManifest?.transferId) await this.stopTransfer(id,message.reason);
    } else if (message.type === 'transfer-ack' && this.sender?.manifest.transferId === id) {
      this.sender.acknowledge(message.bytes,message.complete);
    } else if (message.type === 'file-complete' && this.receiver?.manifest.transferId === id) {
      if (await this.receiver.finishFile(message.fileId)) this.receiver = undefined;
    } else if (message.type === 'transfer-pause' && (id === this.receiver?.manifest.transferId || id === this.sender?.manifest.transferId)) {
      if (id === this.sender?.manifest.transferId) this.sender.pause(message.paused);
      update(id,{status:message.paused ? 'Paused' : 'Active'});
    }
  }
  private async rejectTransfer(id: string, error: unknown) {
    const reason = error instanceof Error ? error.message : 'Transfer failed.';
    await this.stopTransfer(id,reason);
    await this.send({type:'transfer-cancel',transferId:id,reason});
  }
  private bind(channel: RTCDataChannel) {
    this.channel = channel; channel.bufferedAmountLowThreshold = threshold;
    channel.binaryType = 'arraybuffer';
    const opened = () => {
      if (this.disposed) return;
      state().set({connected:true,status:'Verify your devices',url:''});
      clearTimeout(this.timeout);
      this.socket?.close();
    };
    channel.onopen = opened;
    if (channel.readyState === 'open') opened();
    channel.onclose = () => {
      this.endTransfers();
      if (!this.disposed) resetTouch();
      if (!this.disposed) state().set({connected:false,verified:false,peerVerified:false,status:'Disconnected'});
    };
    channel.onmessage = event => {
      const size = event.data instanceof ArrayBuffer ? event.data.byteLength : 0;
      this.pendingBytes += size;
      if (this.pendingBytes > windowBytes * 2) { channel.close(); return; }
      this.incoming = this.incoming.then(async () => {
        if (this.disposed) return;
        if (event.data instanceof ArrayBuffer) {
          if (!state().verified || !state().peerVerified) throw Error('Unverified transfer.');
          const receiver = this.receiver;
          if (receiver) {
            try { await receiver.chunk(event.data); }
            catch (error) { await this.rejectTransfer(receiver.manifest.transferId,error); }
          }
          return;
        }
        if (!this.key || typeof event.data !== 'string' || event.data.length > 100000) throw Error('Invalid encrypted message');
        const message = await decrypt(this.key, event.data, `${this.room}:${this.role === 'host' ? 'guest' : 'host'}`) as ({ seq: number } & (TouchMessage | Control | { type: 'verify' | 'clipboard'; text?: string }));
        if (!Number.isSafeInteger(message.seq) || message.seq <= this.rx) throw Error('Replayed message rejected');
        this.rx = message.seq;
        if (message.type === 'touch') {
          if (!state().verified || !state().peerVerified || this.disposed) throw Error('Verify both devices before using Touch & sign.');
          this.acceptTouch(message);
          return;
        }
        if ('transferId' in message) {
          if (!state().verified || !state().peerVerified) throw Error('Unverified transfer.');
          try { await this.control(message); }
          catch (error) { await this.rejectTransfer(message.transferId,error); }
          return;
        }
        if (message.type === 'verify') state().set({ peerVerified: true });
        if (message.type === 'clipboard') {
          if (!state().verified || !state().peerVerified || typeof message.text !== 'string' || message.text.length > 12000) throw Error('Unverified clipboard message rejected');
          state().add({ id: crypto.randomUUID(), text: message.text, at: Date.now(), source: 'Other device' });
        }
      }).catch(this.fail).finally(()=>{ this.pendingBytes -= size; });
    };
  }
  private send(message: TouchMessage | Control | { type: 'clipboard' | 'verify'; text?: string }) {
    const operation = this.outgoing.then(async () => {
      if (!this.key || this.channel?.readyState !== 'open') throw Error('The other device is not ready yet.');
      const limit = Math.min(99000,this.peer?.sctp?.maxMessageSize || 65536);
      if (new TextEncoder().encode(JSON.stringify(message)).length * 4/3 + 160 > limit) throw Error('Too many file names for one transfer. Select a smaller group.');
      await this.write(await encrypt(this.key, { ...message, seq: this.tx++ }, `${this.room}:${this.role}`));
    });
    this.outgoing = operation.catch(() => {}); return operation;
  }
  async sendTouch(message:TouchMessage) {
    if (!state().connected || !state().verified || !state().peerVerified) throw Error('Verify both devices first.');
    const packet={...message,order:this.touchSeq++};
    const realtime=this.realtime;
    if (this.key && realtime?.readyState==='open' && ((message.action==='laser' && message.point) || (message.action==='ink' && !message.confirmed && message.strokes.length))) {
      if(realtime.bufferedAmount>32768)return;
      const payload=await encrypt(this.key,packet,this.room+':motion:'+this.role);
      if(payload.length<=(this.peer?.sctp?.maxMessageSize || 65536) && realtime.readyState==='open') realtime.send(payload);
    } else await this.send(packet);
  }
  async verify() { await this.send({ type: 'verify' }); state().set({ verified: true }); }
  async sendText(text: string) {
    if (!state().verified || !state().peerVerified) throw Error('Confirm the symbols on both devices first.');
    if (!text.trim() || text.length > 12000) throw Error('Enter between 1 and 12,000 characters.');
    await this.send({ type: 'clipboard', text });
    state().add({ id: crypto.randomUUID(), text, at: Date.now(), source: 'You' });
  }
  close() {
    resetTouch(); this.endTransfers(); useTransfers.setState(s=>({queue:s.queue.filter(row=>row.download)}));
    this.disposed = true; clearTimeout(this.timeout); this.socket?.close(); this.peer?.close(); this.key = undefined;
    state().set({ connected: false, verified: false, peerVerified: false, url: '', sas: '', clips: [], error: '', status: 'Not connected', route: '' });
  }
}
