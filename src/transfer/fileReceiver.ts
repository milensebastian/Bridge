import { crc32 } from './crc32';
import { aad, chunkSize, threshold, validateManifest, type Manifest, type Wire } from './protocol';
import {archiveEnd, fileRecord} from './zip';
import {downloadFor, receivedCache, recordDownload} from './download';
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
  private readonly checksums: number[] = [];
  private readonly offsets: number[] = [];
  private position = 0;
  private readonly zipped: boolean;
  private committed = false;
  private checksum = 0;
  private readonly staging: string;
  private readonly progress;
  constructor(readonly manifest: Manifest, private wire: Wire, private key: CryptoKey) {
    validateManifest(manifest);
    this.staging = crypto.randomUUID();
    this.zipped = manifest.files.length > 1 || manifest.files[0].relativePath.includes('/');
    this.progress = track(manifest,'Receiving');
  }
  async start() {
    if (!navigator.storage?.getDirectory) throw Error('This browser cannot save streamed downloads. Try a current browser in a regular tab.');
    this.root = await receivedCache();
    this.directory = await this.root.getDirectoryHandle(this.staging,{create:true});
    this.handle = await this.directory.getFileHandle('payload',{create:true});
    this.output = await this.handle.createWritable();
    await this.openFile();
    await this.ack(false);
  }
  private async openFile() {
    if(this.zipped) {
      this.offsets.push(this.position);
      const header=fileRecord(this.manifest.files[this.index],0,this.position,false);
      await this.output!.write(header);
      this.position+=header.length;
    }
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
    this.position += length;
    this.offset += length;
    this.received += length;
    this.progress(this.received);
    if (this.received - this.credited >= threshold) await this.ack(false);
  }
  async finishFile(fileId: number) {
    const item = this.manifest.files[this.index];
    if (!this.output || item.fileId !== fileId || this.offset !== item.size) throw Error('Incomplete file.');
    if(this.zipped) {
      // Patch the CRC in the local ZIP header once this entry is complete.
      const checksum=new DataView(new ArrayBuffer(4));
      checksum.setUint32(0,this.checksum,true);
      await this.output.write({type:'write',position:this.offsets[this.index]+14,data:checksum.buffer});
      await this.output.seek(this.position);
      this.checksums.push(this.checksum);
    }
    this.index++;
    if (this.index < this.manifest.files.length) { await this.openFile(); return false; }
    if(this.zipped) {
      const start=this.position;
      for (const [i,file] of this.manifest.files.entries()) {
        const header=fileRecord(file,this.checksums[i],this.offsets[i],true);
        await this.output.write(header);
        this.position+=header.length;
      }
      const end=archiveEnd(this.index,start,this.position);
      await this.output.write(end);
      this.position+=end.length;
    }
    await this.output.close();
    this.output=undefined;
    const file=await this.handle!.getFile();
    if(file.size!==this.position)throw Error('Saved file size mismatch.');
    const name=this.zipped?'Bridge files.zip':item.name;
    const label=this.zipped ? this.manifest.files[0].relativePath.split('/')[0]+' ('+this.index+' files)' : name;
    await recordDownload(this.directory!,{id:this.manifest.transferId,label,total:this.received,name,finished:Date.now()});
    this.committed=true;
    const download=downloadFor(file,name,this.staging);
    update(this.manifest.transferId,{status:'Complete',download});
    await this.ack(true);
    const a=document.createElement('a');
    a.href=download.url;a.download=name;
    document.body.append(a);a.click();a.remove();
    return true;
  }
  async discard() {
    await this.output?.abort().catch(()=>{});
    if(!this.committed) await this.root?.removeEntry(this.staging,{recursive:true}).catch(()=>{});
  }
}
