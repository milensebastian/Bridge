import { deriveSession, encrypt, decrypt } from './crypto';
import { FileSender, type Source } from '../transfer/fileSender';
import { FileReceiver } from '../transfer/fileReceiver';
import { chunkSize, threshold, windowBytes, type Control, type Manifest, type Wire } from '../transfer/protocol';
import { update, useTransfers } from '../store/transfers';
import {type TouchMessage} from '../touch/session';
export type PeerSignal = { type: 'hello' | 'offer' | 'answer' | 'ice'; key?: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

export class PeerLink {
  private peer: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private realtime?: RTCDataChannel;
  private key?: CryptoKey;
  private disposed = false;
  private tx = 0;
  private rx = -1;
  connected = false;
  verified = false;
  peerVerified = false;
  sas = '';
  route = '';
  private candidates: RTCIceCandidateInit[] = [];
  private timeout: ReturnType<typeof setTimeout>;

  get ready() { return this.connected && this.verified && this.peerVerified; }

  constructor(
    readonly id: number,
    private localId: number,
    private room: string,
    private identity: CryptoKeyPair,
    iceServers: RTCIceServer[],
    private signal: (message: PeerSignal) => void,
    private changed: () => void,
    private ended: () => void,
    private fail: (error: unknown) => void,
    private receiveText: (text: string) => void,
    private receiveTouch: (message: TouchMessage) => void,
  ) {
    const peer = this.peer = new RTCPeerConnection({ iceServers });
    this.timeout = setTimeout(() => this.ended(), 45_000);
    peer.onicecandidate = event => {
      if (!this.disposed && event.candidate) this.signal({ type: 'ice', candidate: event.candidate.toJSON() });
    };
    peer.ondatachannel = ({channel}) => {
      if (channel.label === 'reliable-stream' && !this.channel) this.bind(channel);
      else if (channel.label === 'realtime-input' && !this.realtime) this.bindRealtime(channel);
      else channel.close();
    };
    peer.onconnectionstatechange = () => {
      if (this.disposed) return;
      if (peer.connectionState === 'failed') this.ended();
      if (peer.connectionState === 'connected') void peer.getStats().then(stats => {
        if (this.disposed) return;
        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
            const local = stats.get(report.localCandidateId);
            const remote = stats.get(report.remoteCandidateId);
            this.route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN relay' : 'Direct P2P';
            this.changed();
          }
        });
      }).catch(this.fail);
    };
  }

  private context(sender: number, motion = false) {
    return `${this.room}:${Math.min(this.id, this.localId)}:${Math.max(this.id, this.localId)}:${sender}:${motion ? 'motion' : 'data'}`;
  }

  async handle(message: PeerSignal) {
    if (this.disposed) return;
    const peer = this.peer;
    if (message.type === 'hello' && !this.key && message.key) {
      const session = await deriveSession(this.identity, message.key, this.context(Math.min(this.id, this.localId)));
      if (this.disposed) return;
      this.key = session.aes;
      this.sas = session.sas;
      if (this.localId > this.id) {
        this.bind(peer.createDataChannel('reliable-stream', { ordered: true }));
        this.bindRealtime(peer.createDataChannel('realtime-input', { ordered: false, maxRetransmits: 0 }));
        await peer.setLocalDescription(await peer.createOffer());
        this.signal({ type: 'offer', sdp: peer.localDescription! });
      }
    } else if ((message.type === 'offer' || message.type === 'answer') && message.sdp) {
      if (!this.key) throw Error('Missing encryption handshake');
      await peer.setRemoteDescription(message.sdp);
      for (const candidate of this.candidates.splice(0)) await peer.addIceCandidate(candidate);
      if (message.type === 'offer') {
        await peer.setLocalDescription(await peer.createAnswer());
        this.signal({ type: 'answer', sdp: peer.localDescription! });
      }
    } else if (message.type === 'ice' && message.candidate) {
      if (peer.remoteDescription) await peer.addIceCandidate(message.candidate);
      else this.candidates.push(message.candidate);
    }
  }

  private touchSeq=0;
  private lastInk=-1;
  private lastLaser=-1;
  private bindRealtime(channel:RTCDataChannel) {
    this.realtime=channel;
    channel.onmessage=event=>{
      if (!this.key || !this.ready || typeof event.data!=='string' || event.data.length>50000) return;
      void decrypt(this.key,event.data,this.context(this.id, true)).then(raw=>{
        if(this.disposed || !this.ready)return;
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
    this.receiveTouch(msg);
  }
  private outgoing = Promise.resolve();
  private incoming = Promise.resolve();
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
    if (!this.key || !this.ready) throw Error('Confirm the symbols on both devices first.');
    if (this.sender) throw Error('Finish the current outgoing transfer first.');
    const max = this.peer?.sctp?.maxMessageSize || 65536;
    if (max < 16429) throw Error('This connection does not support file-sized messages.');
    const sender = new FileSender(sources,this.wire,this.key,Math.min(chunkSize,max - 45));
    this.sender = sender;
    const id = sender.manifest.transferId;
    try {
      const transfer = sender.run();
      update(id, { device: this.id });
      await transfer;
    }
    catch (error) {
      const row = useTransfers.getState().queue.find(row => row.id === id);
      if (row?.status === 'Active' || row?.status === 'Paused') {
        update(id,{status:'Failed',detail:String(error)});
        await this.send({type:'transfer-cancel',transferId:id,reason:String(error)}).catch(()=>{});
      }
      if (row?.status !== 'Cancelled') throw error;
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
      if (useTransfers.getState().queue.some(row => row.id === id)) {
        await this.send({type:'transfer-cancel',transferId:id,reason:'Transfer ID already in use.'});
        return;
      }
      this.receiver = new FileReceiver(manifest,this.wire,this.key!);
      update(id, { device: this.id });
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
    if (this.ownsTransfer(id) || this.partialManifest?.transferId === id) await this.stopTransfer(id,reason);
    await this.send({type:'transfer-cancel',transferId:id,reason});
  }
  private bind(channel: RTCDataChannel) {
    this.channel = channel; channel.bufferedAmountLowThreshold = threshold;
    channel.binaryType = 'arraybuffer';
    const opened = () => {
      if (this.disposed) return;
      this.connected = true;
      clearTimeout(this.timeout);
      this.changed();
    };
    channel.onopen = opened;
    if (channel.readyState === 'open') opened();
    channel.onclose = () => {
      if (!this.disposed) this.ended();
    };
    channel.onmessage = event => {
      const size = event.data instanceof ArrayBuffer ? event.data.byteLength : 0;
      this.pendingBytes += size;
      if (this.pendingBytes > windowBytes * 2) { channel.close(); return; }
      this.incoming = this.incoming.then(async () => {
        if (this.disposed) return;
        if (event.data instanceof ArrayBuffer) {
          if (!this.ready) throw Error('Unverified transfer.');
          const receiver = this.receiver;
          if (receiver) {
            try { await receiver.chunk(event.data); }
            catch (error) { await this.rejectTransfer(receiver.manifest.transferId,error); }
          }
          return;
        }
        if (!this.key || typeof event.data !== 'string' || event.data.length > 100000) throw Error('Invalid encrypted message');
        const message = await decrypt(this.key, event.data, this.context(this.id)) as ({ seq: number } & (TouchMessage | Control | { type: 'verify' | 'clipboard'; text?: string }));
        if (!Number.isSafeInteger(message.seq) || message.seq <= this.rx) throw Error('Replayed message rejected');
        this.rx = message.seq;
        if (message.type === 'touch') {
          if (!this.ready || this.disposed) throw Error('Verify both devices before using Touch & sign.');
          this.acceptTouch(message);
          return;
        }
        if ('transferId' in message) {
          if (!this.ready) throw Error('Unverified transfer.');
          try { await this.control(message); }
          catch (error) { await this.rejectTransfer(message.transferId,error); }
          return;
        }
        if (message.type === 'verify') { this.peerVerified = true; this.changed(); }
        if (message.type === 'clipboard') {
          if (!this.ready || typeof message.text !== 'string' || message.text.length > 12000) throw Error('Unverified clipboard message rejected');
          this.receiveText(message.text);
        }
      }).catch(this.fail).finally(()=>{ this.pendingBytes -= size; });
    };
  }
  private send(message: TouchMessage | Control | { type: 'clipboard' | 'verify'; text?: string }) {
    const operation = this.outgoing.then(async () => {
      if (!this.key || this.channel?.readyState !== 'open') throw Error('The other device is not ready yet.');
      const limit = Math.min(99000,this.peer?.sctp?.maxMessageSize || 65536);
      if (new TextEncoder().encode(JSON.stringify(message)).length * 4/3 + 160 > limit) throw Error('Too many file names for one transfer. Select a smaller group.');
      await this.write(await encrypt(this.key, { ...message, seq: this.tx++ }, this.context(this.localId)));
    });
    this.outgoing = operation.catch(() => {}); return operation;
  }
  async sendTouch(message:TouchMessage) {
    if (!this.ready) throw Error('Verify both devices first.');
    const packet={...message,order:this.touchSeq++};
    const realtime=this.realtime;
    if (this.key && realtime?.readyState==='open' && ((message.action==='laser' && message.point) || (message.action==='ink' && !message.confirmed && message.strokes.length))) {
      if(realtime.bufferedAmount>32768)return;
      const payload=await encrypt(this.key,packet,this.context(this.localId, true));
      if(payload.length<=(this.peer?.sctp?.maxMessageSize || 65536) && realtime.readyState==='open') realtime.send(payload);
    } else await this.send(packet);
  }
  async verify() {
    await this.send({ type: 'verify' });
    this.verified = true;
    this.changed();
  }

  sendText(text: string) { return this.send({ type: 'clipboard', text }); }

  get busy() { return Boolean(this.sender); }

  ownsTransfer(id: string) {
    return this.sender?.manifest.transferId === id || this.receiver?.manifest.transferId === id;
  }

  close() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timeout);
    this.endTransfers();
    this.peer.close();
    this.key = undefined;
  }
}
