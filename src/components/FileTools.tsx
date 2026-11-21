import {useEffect, useRef, useState} from 'react';
import type {Bridge} from '../lib/bridge';
import {removeDownload,restoreDownloads,saveDownload} from '../transfer/download';
import {useTransfers} from '../store/transfers';
import {dropped, type Source} from '../transfer/fileSender';

type Props = {bridge?: Bridge; ready: boolean; report: (message: string) => void};
const size = (bytes: number) => new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(bytes >= 1e9 ? bytes/1e9 : bytes >= 1e6 ? bytes/1e6 : bytes/1e3) + (bytes >= 1e9 ? ' GB' : bytes >= 1e6 ? ' MB' : ' kB');

export function FileTools({bridge,ready,report}: Props) {
  const files = useRef<HTMLInputElement>(null), folder = useRef<HTMLInputElement>(null);
  const [hover,setHover] = useState(false);
  const busy = useTransfers(s => s.queue.some(r => r.direction === 'Sending' && ['Active','Paused'].includes(r.status)));
  const enabled = ready && !busy;
  async function send(sources: Source[] | Promise<Source[]>) {
    try {
      if (!enabled || !bridge) throw Error('Pair and verify both devices before sending files.');
      const selection = await sources;
      if (selection.length) await bridge.sendFiles(selection);
      else report('The selection contains no files.');
    } catch (error) { report(error instanceof Error ? error.message : String(error)); }
  }
  const select = (input: HTMLInputElement) => {
    const list = Array.from(input.files ?? [],file => ({file,path:file.webkitRelativePath || file.name}));
    input.value = '';
    void send(list);
  };
  return <div className="clipboard-workspace"><div className="tool-heading"><div><h2>Files</h2><p>Send files and folders to your paired device.</p></div></div>
    <div className={'file-drop' + (hover ? ' hover' : '')} onDragOver={e=>{e.preventDefault(); setHover(enabled);}}
      onDragLeave={()=>setHover(false)} onDrop={e=>{e.preventDefault(); setHover(false); if(enabled) void send(dropped(e.dataTransfer.items));}}>
      <p>{ready ? 'Drop files or a folder here' : 'Pair and verify both devices to send files.'}</p>
      <div className="file-actions"><button className="primary" disabled={!enabled} onClick={()=>files.current?.click()}>Choose files</button>
        <button disabled={!enabled} onClick={()=>folder.current?.click()}>Choose folder</button></div>
      <input hidden ref={files} type="file" multiple onChange={e=>select(e.currentTarget)}/>
      <input hidden ref={el=>{folder.current=el; el?.setAttribute('webkitdirectory','');}} type="file" multiple onChange={e=>select(e.currentTarget)}/>
    </div></div>;
}

export function TransferQueue({bridge,report}: Omit<Props,'ready'>) {
  const queue = useTransfers(s=>s.queue);
  useEffect(() => {
    void restoreDownloads().catch(e=>report(String(e)));
  },[report]);
  if (!queue.length) return null;
  return <section className="transfer-queue" aria-label="Transfers queue"><h3>Transfers</h3>{queue.map(row=>{
    const active = row.status === 'Active' || row.status === 'Paused';
    return <article key={row.id}><strong>{row.label}</strong>
      <p>{row.direction} · {size(row.bytes)} of {size(row.total)} · {row.status}</p>
      <progress aria-label={row.label} max={row.total || 1} value={row.total ? row.bytes : Number(row.status === 'Complete')}/>
      {active && <><p>{row.status === 'Active' ? row.speedMBps.toFixed(1) + ' MB/s' : 'Paused'}{row.etaSeconds > 0 && row.status === 'Active' && ' · ' + Math.ceil(row.etaSeconds) + 's left'}</p>
        {row.direction === 'Receiving' && <p>Keep this tab open and your screen awake.</p>}
        <div className="file-actions"><button onClick={()=>void bridge?.pauseTransfer(row.id,row.status !== 'Paused').catch(e=>report(String(e)))}>{row.status === 'Paused' ? 'Resume' : 'Pause'}</button>
          <button onClick={()=>void bridge?.cancelTransfer(row.id).catch(e=>report(String(e)))}>Cancel</button></div></>}
      {row.detail && <p role="alert">{row.detail}</p>}
      {row.download && <><p>Available here for 24 hours. Save a copy to keep it.</p><div className="file-actions"><button className="primary" onClick={()=>void saveDownload(row.download!).catch(e=>{
        if(e?.name!=='AbortError')report('Could not save the file: '+String(e));
      })}>Save {row.download.name.endsWith('.zip')?'ZIP':'file'}</button>
        <button onClick={()=>void removeDownload(row.id,row.download!).catch(e=>report(String(e)))}>Remove local copy</button></div></>}
    </article>;
  })}</section>;
}
