import {useEffect, useRef, useState} from 'react';
import type {Bridge} from '../lib/bridge';
import {Download as DownloadIcon} from 'lucide-react';
import {removeDownload,restoreDownloads,saveDownload,type Download} from '../transfer/download';
import {useTransfers} from '../store/transfers';
import {useSession} from '../store/session';
import {dropped, type Source} from '../transfer/fileSender';

type Props = {bridge?: Bridge; ready: boolean; report: (message: string) => void};
const size = (bytes: number) => new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(bytes >= 1e9 ? bytes/1e9 : bytes >= 1e6 ? bytes/1e6 : bytes/1e3) + (bytes >= 1e9 ? ' GB' : bytes >= 1e6 ? ' MB' : ' kB');

export function FileTools({bridge,ready,report}: Props) {
  const files = useRef<HTMLInputElement>(null), folder = useRef<HTMLInputElement>(null);
  const [hover,setHover] = useState(false);
  const recipient = useSession(s => s.recipient);
  const busy = useTransfers(s => s.queue.some(r => r.device === recipient && r.direction === 'Sending' && ['Active','Paused'].includes(r.status)));
  const enabled = ready && !busy;
  async function send(sources: Source[] | Promise<Source[]>) {
    try {
      if (!enabled || !bridge) throw Error('Pair and verify both devices before sending files.');
      const selection = await sources;
      if (selection.length) await bridge.sendFiles(selection, recipient);
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
      <p>{ready ? 'Drop files or a folder here' : 'Verify a device and choose it under Send to.'}</p>
      <div className="file-actions"><button className="primary" disabled={!enabled} onClick={()=>files.current?.click()}>Choose files</button>
        <button disabled={!enabled} onClick={()=>folder.current?.click()}>Choose folder</button></div>
      <input hidden ref={files} type="file" multiple onChange={e=>select(e.currentTarget)}/>
      <input hidden ref={el=>{folder.current=el; el?.setAttribute('webkitdirectory','');}} type="file" multiple onChange={e=>select(e.currentTarget)}/>
    </div></div>;
}

export function TransferQueue({bridge,report}: Omit<Props,'ready'>) {
  const queue = useTransfers(s=>s.queue);
  const devices = useSession(s => s.devices);
  useEffect(() => {
    void restoreDownloads().catch(e=>report(String(e)));
  },[report]);
  if (!queue.length) return null;
  return <section className="transfer-queue" aria-label="Transfers queue"><h3>Transfers</h3>{[...queue].reverse().map(row=>{
    const active = row.status === 'Active' || row.status === 'Paused';
    return <article key={row.id}><strong>{row.label}</strong>
      <p>{row.direction}{row.device ? ` ${row.direction === 'Sending' ? 'to' : 'from'} ${devices.find(device => device.id === row.device)?.name ?? 'a room member'}` : ''} · {row.download ? size(row.total) : `${size(row.bytes)} of ${size(row.total)} · ${row.status}`}</p>
      {!row.download && <progress aria-label={row.label} max={row.total || 1} value={row.total ? row.bytes : Number(row.status === 'Complete')}/>}
      {active && <><p>{row.status === 'Active' ? row.speedMBps.toFixed(1) + ' MB/s' : 'Paused'}{row.etaSeconds > 0 && row.status === 'Active' && ' · ' + Math.ceil(row.etaSeconds) + 's left'}</p>
        {row.direction === 'Receiving' && <p>Keep this tab open and your screen awake.</p>}
        <div className="file-actions"><button onClick={()=>void bridge?.pauseTransfer(row.id,row.status !== 'Paused').catch(e=>report(String(e)))}>{row.status === 'Paused' ? 'Resume' : 'Pause'}</button>
          <button onClick={()=>void bridge?.cancelTransfer(row.id).catch(e=>report(String(e)))}>Cancel</button></div></>}
      {row.detail && <p role="alert">{row.detail}</p>}
      {row.download && <ReceivedFile id={row.id} download={row.download} report={report}/>}
    </article>;
  })}</section>;
}

function ReceivedFile({ id, download, report }: { id: string; download: Download; report: Props['report'] }) {
  const [status, setStatus] = useState<'ready' | 'saving' | 'saved' | 'requested' | 'failed'>('ready');
  const [error, setError] = useState('');
  async function save() {
    setStatus('saving');
    setError('');
    try {
      setStatus(await saveDownload(download));
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : '';
      if (name === 'AbortError') { setStatus('ready'); return; }
      setStatus('failed');
      if (name === 'NotFoundError') setError('The local copy is missing. Ask the sender to resend the file.');
      else if (name === 'QuotaExceededError') setError('There isn’t enough storage to save the file. Free some space and retry.');
      else if (name === 'NotAllowedError' || name === 'SecurityError') setError('The browser blocked saving. Try from a regular browser tab or choose another folder.');
      else setError(cause instanceof Error ? `Couldn’t save the file. ${cause.message}` : 'Couldn’t save the file. Try again.');
    }
  }
  return <div className="received-file">
    <p role="status">{status === 'ready' ? 'Ready to save' : status === 'saving' ? 'Saving…' :
      status === 'saved' ? 'Saved' : status === 'requested' ? 'Download requested. Check your browser’s downloads.' : 'Save failed'}</p>
    {error && <p className="save-error" role="alert">{error}</p>}
    <div className="file-actions">
      <button className="primary" disabled={status === 'saving'} onClick={() => void save()}>
        <DownloadIcon size={16}/>{status === 'failed' ? 'Retry save' : status === 'saved' ? 'Save another copy' :
          status === 'requested' ? 'Download again' : download.name.endsWith('.zip') ? 'Save ZIP' : 'Save file'}
      </button>
      <button className="text-button" disabled={status === 'saving'}
        onClick={() => void removeDownload(id, download).catch(error => report(String(error)))}>Remove local copy</button>
    </div>
    <p>Local copy available for up to 24 hours.</p>
  </div>;
}
