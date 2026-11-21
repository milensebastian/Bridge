import { crc32 } from './crc32';
import { aad, chunkSize, threshold, validateManifest, type Manifest, type Wire } from './protocol';
import { track, update } from '../store/transfers';

export class FileReceiver {
  private directory?: FileSystemDirectoryHandle;
  private root?: FileSystemDirectoryHandle;
  private output?: FileSystemWritableFileStream;
  private handle?: FileSystemFileHandle;
  private index = 0;
  private offset = 0;
  private received = 0;
  private credited = 0;
  private checksums: number[] = [];
  private checksum = 0;
  private readonly staging: string;
  private readonly progress;
  constructor(readonly manifest: Manifest, private wire: Wire, private key: CryptoKey) {
    validateManifest(manifest);
    this.staging = manifest.transferId + '/' + crypto.randomUUID();
    this.progress = track(manifest,'Receiving');
  }
  async start() {
    if (!navigator.storage?.getDirectory || !navigator.serviceWorker) throw Error('This browser cannot save streamed downloads. Try a current browser in a regular tab.');
    const registration = await navigator.serviceWorker.register('/bridge-download-sw.js',{scope:'/'});
    const worker = registration.installing ?? registration.waiting;
    if (!registration.active && worker) await new Promise<void>((ok,fail) => {
      const changed = () => {
        if (worker.state === 'activated' || worker.state === 'redundant') {
          worker.removeEventListener('statechange',changed);
          if (worker.state === 'activated') ok(); else fail(Error('Download service unavailable.'));
        }
      };
      worker.addEventListener('statechange',changed); changed();
    });
    const root = await navigator.storage.getDirectory();
    this.root = await root.getDirectoryHandle(this.manifest.transferId,{create:true});
    this.directory = await this.root.getDirectoryHandle(this.staging.split('/')[1],{create:true});
    await this.openFile();
    await this.ack(false);
  }
  private async openFile() {
    const item = this.manifest.files[this.index];
    let dir = await this.directory!.getDirectoryHandle('files',{create:true});
    for (const part of item.relativePath.split('/').slice(0,-1)) dir = await dir.getDirectoryHandle(part,{create:true});
    this.handle = await dir.getFileHandle(item.name,{create:true});
    this.output = await this.handle.createWritable();
    this.offset = this.checksum = 0;
  }
  private async ack(complete: boolean) {
    this.credited = this.received;
    await this.wire.control({type:'transfer-ack',transferId:this.manifest.transferId,bytes:this.received,complete});
  }
  async chunk(buffer: ArrayBuffer) {
    const item = this.manifest.files[this.index];
    const h = new DataView(buffer);
    const length = buffer.byteLength - 45;
    if (!this.output || length <= 0 || length > chunkSize || h.getUint8(0) !== 1 || h.getUint32(1) !== item.fileId
      || h.getBigUint64(5) !== BigInt(this.offset) || this.offset + length > item.size) throw Error('Unexpected file chunk.');
    const bytes = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(buffer,17,12),
      additionalData:aad(new Uint8Array(buffer),this.manifest.transferId)},this.key,new Uint8Array(buffer,29)));
    if (crc32(bytes) !== h.getUint32(13)) throw Error('File checksum mismatch.');
    await this.output.write(bytes);
    this.checksum = crc32(bytes,this.checksum);
    this.offset += length;
    this.received += length;
    this.progress(this.received);
    if (this.received - this.credited >= threshold) await this.ack(false);
  }
  async finishFile(fileId: number) {
    const item = this.manifest.files[this.index];
    if (!this.output || item.fileId !== fileId || this.offset !== item.size) throw Error('Incomplete file.');
    await this.output.close();
    this.output = undefined;
    if ((await this.handle!.getFile()).size !== item.size) throw Error('Saved file size mismatch.');
    this.checksums.push(this.checksum);
    this.index++;
    if (this.index < this.manifest.files.length) { await this.openFile(); return false; }
    const meta = await (await this.directory!.getFileHandle('manifest',{create:true})).createWritable();
    try { await meta.write(JSON.stringify({files:this.manifest.files,checksums:this.checksums})); await meta.close(); }
    catch (error) { await meta.abort().catch(()=>{}); throw error; }
    const url = '/bridge-download/' + this.staging;
    const a = document.createElement('a');
    a.href = url; a.download = this.manifest.files.length === 1 && !item.relativePath.includes('/') ? item.name : 'Bridge files.zip';
    document.body.append(a); a.click(); a.remove();
    update(this.manifest.transferId,{status:'Complete',download:url});
    await this.ack(true);
    return true;
  }
  async discard() {
    await this.output?.abort().catch(()=>{});
    await this.root?.removeEntry(this.staging.split('/')[1],{recursive:true}).catch(()=>{});
  }
}
