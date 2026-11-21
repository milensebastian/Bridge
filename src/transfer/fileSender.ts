import { chunkSize, frame, validateManifest, windowBytes, type Manifest, type Wire } from './protocol';
import { track, update } from '../store/transfers';

export type Source = { file: File; path: string };

export async function dropped(items: DataTransferItemList): Promise<Source[]> {
  const roots = Array.from(items).filter(i => i.kind === 'file').map(i => ({entry: i.webkitGetAsEntry?.(), file: i.getAsFile()}));
  const result: Source[] = [];
  async function visit(entry: FileSystemEntry, prefix: string) {
    const path = prefix + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
      result.push({file, path});
    } else {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (true) {
        const entries = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
        if (!entries.length) break;
        for (const child of entries) await visit(child, path + '/');
      }
    }
  }
  for (const {entry,file} of roots) {
    if (entry) await visit(entry, '');
    else if (file) result.push({file,path:file.name});
  }
  return result;
}

export class FileSender {
  readonly manifest: Manifest;
  private credit = -1;
  private sent = 0;
  private finished = false;
  private paused = false;
  private stopped = false;
  private wake?: () => void;

  constructor(private sources: Source[], private wire: Wire, private key: CryptoKey, private block = chunkSize) {
    const files = sources.map(({file,path}, fileId) => ({fileId,relativePath:path,name:file.name,size:file.size,mimeType:file.type}));
    this.manifest = {type:'transfer-manifest',transferId:crypto.randomUUID(),files,totalBytes:files.reduce((n,f)=>n+f.size,0)};
    validateManifest(this.manifest);
  }
  acknowledge(bytes: number, complete = false) {
    if (!Number.isSafeInteger(bytes) || bytes < this.credit || bytes > this.sent) throw Error('Invalid disk acknowledgement.');
    this.credit = bytes;
    this.finished = complete && bytes === this.manifest.totalBytes;
    this.wake?.();
  }
  pause(value: boolean) {
    this.paused = value;
    update(this.manifest.transferId,{status:value ? 'Paused' : 'Active'});
    this.wake?.();
  }
  cancel() { this.stopped = true; this.wake?.(); }
  private async wait(ready: () => boolean) {
    while (!this.stopped && (this.paused || !ready())) {
      await new Promise<void>((resolve,reject) => {
        const timer = this.paused ? undefined : setTimeout(() => reject(Error('The receiving device stopped responding.')), 90000);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    this.wake = undefined;
    if (this.stopped) throw Error('Transfer cancelled.');
  }
  async run() {
    const progress = track(this.manifest,'Sending');
    const id = this.manifest.transferId;
    await this.wire.control(this.manifest);
    await this.wait(() => this.credit >= 0);
    for (const [fileId,{file}] of this.sources.entries()) {
      const reader = file.stream().getReader();
      let offset = 0;
      try {
        while (true) {
          const {done,value} = await reader.read();
          if (done) break;
          for (let pos = 0; pos < value.length; pos += this.block) {
            const bytes = value.subarray(pos,pos + this.block);
            await this.wait(() => this.sent + bytes.length <= this.credit + windowBytes);
            const packet = await frame(this.key,fileId,offset,bytes,id);
            await this.wait(() => true);
            this.sent += bytes.length;
            await this.wire.binary(packet);
            offset += bytes.length;
            progress(this.sent);
          }
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      await this.wait(() => true);
      await this.wire.control({type:'file-complete',transferId:id,fileId});
    }
    await this.wait(() => this.finished);
    update(id,{status:'Complete'});
  }
}
