import {useTransfers, type Row} from '../store/transfers';

const cacheName = 'bridge-received-v1';
const day = 24 * 60 * 60 * 1000;
type Receipt = Pick<Row,'id'|'label'|'total'> & {name:string; finished:number};

export type Download = {url:string; name:string; file:File; directory:string};

export async function receivedCache() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(cacheName,{create:true});
}
export function downloadFor(file:File, name:string, directory:string): Download {
  return {url:URL.createObjectURL(file),file,name,directory};
}
export async function recordDownload(dir:FileSystemDirectoryHandle, receipt:Receipt) {
  const out=await (await dir.getFileHandle('receipt',{create:true})).createWritable();
  try {await out.write(JSON.stringify(receipt));await out.close();}
  catch(e){await out.abort().catch(()=>{});throw e;}
}
export async function restoreDownloads() {
  if(!navigator.storage?.getDirectory)return;
  const cache=await receivedCache();
  // OPFS directory iteration is supported by browsers implementing getDirectory.
  const entries=cache as FileSystemDirectoryHandle & {values():AsyncIterable<FileSystemDirectoryHandle|FileSystemFileHandle>};
  for await(const entry of entries.values()){
    if(entry.kind!=='directory')continue;
    try {
      const meta=await (await entry.getFileHandle('receipt')).getFile();
      const receipt:Receipt=JSON.parse(await meta.text());
      const exists=()=>useTransfers.getState().queue.some(row=>row.id===receipt.id);
      if(exists())continue;
      if(Date.now()-receipt.finished>day){await cache.removeEntry(entry.name,{recursive:true});continue;}
      const file=await (await entry.getFileHandle('payload')).getFile();
      if(exists())continue;
      const download=downloadFor(file,receipt.name,entry.name);
      useTransfers.setState(s=>({queue:[...s.queue,{id:receipt.id,label:receipt.label,total:receipt.total,bytes:receipt.total,
        direction:'Receiving',status:'Complete',etaSeconds:0,speedMBps:0,download}]}));
    } catch(error) {
      if(!(error instanceof DOMException && error.name==='NotFoundError'))throw error;
      // An active transfer has no receipt until the payload is closed.
    }
  }
}
export async function removeDownload(id:string, download:Download) {
  const cache=await receivedCache();
  try {await cache.removeEntry(download.directory,{recursive:true});}
  catch(e){if(!(e instanceof DOMException && e.name==='NotFoundError'))throw e;}
  URL.revokeObjectURL(download.url);
  useTransfers.setState(s=>({queue:s.queue.filter(row=>row.id!==id)}));
}
type SavePicker = (opts:{suggestedName:string})=>Promise<FileSystemFileHandle>;
export async function saveDownload(download:Download) {
  const picker=(window as Window & {showSaveFilePicker?:SavePicker}).showSaveFilePicker;
  if(!picker) {
    const anchor=document.createElement('a');
    anchor.href=download.url;anchor.download=download.name;
    document.body.append(anchor);anchor.click();anchor.remove();
    return;
  }
  const destination=await picker.call(window,{suggestedName:download.name});
  await download.file.stream().pipeTo(await destination.createWritable());
}
