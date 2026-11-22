import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Clipboard, Coffee, Copy, Files, Monitor, Moon, Plus, ScanLine, ShieldCheck, Smartphone, Sun, Touchpad, X } from 'lucide-react';
import QRCode from 'qrcode';
import { Bridge } from './lib/bridge';
import { useSession } from './store/session';
import {FileTools,TransferQueue} from './components/FileTools';
import {useTouch} from './touch/session';
import Scanner from './components/Scanner';
import { CameraTools } from './components/CameraTools';
import { RecipientChecklist, RecipientPicker, RoomDevices } from './components/RoomDevices';
import { ClipboardHistory } from './components/ClipboardHistory';

const TouchTools = lazy(()=>import('./touch/TouchTools'));
type ClipboardTarget = 'all' | 'multiple' | number;
type ClipboardDestination = 'all' | number | readonly number[];
const modules = [{ name: 'Clipboard', icon: Clipboard }, { name: 'Files', icon: Files }, { name: 'Camera & scan', icon: Camera }, { name: 'Touch & sign', icon: Touchpad }];
export default function App() {
  const session = useSession(); const bridge = useRef<Bridge | undefined>(undefined);
  const initialPairUrl = useRef(location.pathname === '/pair' && location.search && location.hash ? location.href : undefined);
  const lastInvite = useRef<string | undefined>(undefined);
  const [tab, setTab] = useState('Clipboard'); const [text, setText] = useState('');
  const [clipboardTarget, setClipboardTarget] = useState<ClipboardTarget>('all');
  const [selectedRecipients, setSelectedRecipients] = useState<number[]>([]);
  const [openedTouch,setOpenedTouch]=useState(false);
  const signatureRequest=useTouch(s=>s.request);
  useEffect(()=>{if(signatureRequest){setOpenedTouch(true);setTab('Touch & sign');}},[signatureRequest]);
  const [qr, setQr] = useState(''); const [scanner, setScanner] = useState(false);
  const [mode, setMode] = useState(() => matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop');
  const [dark, setDark] = useState(() => localStorage.getItem('bridge-theme') === 'dark');
  const [notice, setNotice] = useState(''); const [pairLink, setPairLink] = useState(''); const [autoSync, setAutoSync] = useState(false);
  const ready = session.recipient !== undefined;
  const verifiedDevices = session.devices.filter(device => device.ready);
  const verifiedCount = verifiedDevices.length;
  const individualTarget = typeof clipboardTarget === 'number' ? clipboardTarget : undefined;
  const clipboardDestination = clipboardTarget === 'multiple' ? selectedRecipients : clipboardTarget;
  const isVerified = (id: number) => verifiedDevices.some(device => device.id === id);
  const clipboardReady = clipboardTarget === 'all' ? verifiedCount > 0
    : clipboardTarget === 'multiple' ? selectedRecipients.length > 0 && selectedRecipients.every(isVerified)
    : isVerified(clipboardTarget);
  const canAutoSync = individualTarget !== undefined && clipboardReady;
  const changeClipboardTarget = (target: ClipboardTarget) => {
    setAutoSync(false);
    setClipboardTarget(target);
  };
  useEffect(() => { setAutoSync(false); }, [clipboardTarget, canAutoSync]);
  const start = useCallback((url?: string) => {
    setClipboardTarget('all');
    setSelectedRecipients([]);
    setAutoSync(false);
    lastInvite.current = url;
    bridge.current?.close();
    bridge.current = new Bridge();
    void bridge.current.start(url);
  }, []);
  useEffect(() => {
    if (initialPairUrl.current) {
      history.replaceState(null, '', '/pair'); start(initialPairUrl.current); setMode('mobile');
    }
    return () => bridge.current?.close();
  }, [start]);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('bridge-theme', dark ? 'dark' : 'light'); }, [dark]);
  useEffect(() => { let cancelled = false; setQr(''); if (session.url) void QRCode.toDataURL(session.url, { width: 224, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#202423', light: '#ffffff' } }).then(value => { if (!cancelled) setQr(value); }); return () => { cancelled = true; }; }, [session.url]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timer); } }, [notice]);
  const perform = async (action: () => Promise<void>, success?: string) => { try { await action(); if (success) setNotice(success); } catch (error) { setNotice(error instanceof Error ? error.message : 'This action is unavailable.'); } };
  const sync = useCallback(async (target: ClipboardDestination) => {
    const current = bridge.current;
    if (!current) throw Error('Connect a verified device first.');
    const value = await navigator.clipboard.readText();
    if (target === 'all') await current.sendText(value, true);
    else await current.sendText(value, false, target);
  }, []);
  useEffect(() => {
    if (!autoSync || !canAutoSync || individualTarget === undefined) return;
    const focus = () => void sync(individualTarget).catch(() => setNotice('Could not sync the clipboard. Check the device connection and clipboard permission.'));
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [autoSync, canAutoSync, individualTarget, sync]);
  const scanned = useCallback((url: string) => { setScanner(false); start(url); }, [start]);
  return <div className={`app ${mode}`}>
    <header className="topbar"><a className="brand" href="/" aria-label="Bridge home"><span className="brand-symbol"><span /><span /></span>bridge</a><div className="top-actions"><span className="local-label">A little closer, wirelessly.</span><button className="icon-button" aria-label={dark ? 'Use light theme' : 'Use dark theme'} onClick={() => setDark(!dark)}>{dark ? <Sun size={18}/> : <Moon size={18}/>}</button><span className="divider"/><button className="mode-button" onClick={() => setMode(mode === 'desktop' ? 'mobile' : 'desktop')}>{mode === 'desktop' ? <Monitor size={16}/> : <Smartphone size={16}/>}<span>{mode === 'desktop' ? 'Desktop' : 'Companion'}</span></button>
      <a className="coffee-link" href="https://buymeacoffee.com/MilenSebastian" aria-label="Buy me a coffee" title="Buy me a coffee" target="_blank" rel="noopener noreferrer"><Coffee size={15} aria-hidden="true"/><span>Buy me a coffee</span></a>
    </div></header>
    <main><div className="page-heading"><div><div className="eyebrow">YOUR PERSONAL WORKSPACE</div><h1>Your devices. Together.</h1><p>Send files, text and links between your phone and computer.</p></div><span className={`connection ${session.connected ? 'online' : ''}`}><i/>{session.connected ? `${verifiedCount} verified` : 'No device connected'}</span></div>
      <div className="workspace"><aside>
        <section className="pair-panel"><div className="section-heading"><h2>{session.roomActive ? 'Your room' : 'Connect a device'}</h2><Smartphone size={18}/></div>
          {session.roomActive ? <RoomDevices bridge={bridge.current} qr={qr} report={setNotice} showRecipient={tab !== 'Clipboard'}/> : <>
            {qr ? <div className="qr-wrap"><img src={qr} width="224" height="224" alt="Scan this QR code to pair your device"/></div> : <div className="pair-illustration"><div className="drawn-monitor"><span className="tiny-logo">b.</span></div><div className="drawn-phone"><span/></div><div className="connection-line"/></div>}
            <h3>{session.connecting ? 'Joining' : qr ? 'Scan to connect' : 'A bridge between screens.'}</h3><p className="pair-description">{qr ? 'Open your phone’s camera and scan the code. Keep this tab open.' : 'Pair your phone and computer to share directly, without an account.'}</p>
            {session.connecting ? <>
              <p className="pair-description" role="status">{session.status}</p>
              <button className="full" onClick={() => bridge.current?.close()}>Cancel connection</button>
            </> : <>
            {session.error && <p className="pair-description" role="alert">{session.error}</p>}
            <button className="primary full" onClick={() => start(lastInvite.current && session.error ? lastInvite.current : undefined)}><Plus size={16}/>{lastInvite.current && session.error ? 'Retry joining room' : 'Create a room'}</button>
            <div className="or"><span/>or join another device<span/></div><button className="full" onClick={() => setScanner(true)}><ScanLine size={16}/>Scan a QR code</button><form className="join-form" onSubmit={event => { event.preventDefault(); start(pairLink); }}><input aria-label="Pairing link" placeholder="Paste a pairing link" type="url" required value={pairLink} onChange={event => setPairLink(event.target.value)}/><button aria-label="Join pairing link" type="submit" disabled={!pairLink.trim()}>Join</button></form>
            </>}
          </>}
        </section><div className="privacy-note"><ShieldCheck size={18}/><div><strong>Between verified devices.</strong><p>Encrypted in transit. No accounts.<br/>No clipboard stored on a server.</p></div></div>
      </aside><section className="content-panel"><nav className="tabs" aria-label="Workspace tools">{modules.map(({ name, icon: Icon }) => <button key={name} className={tab === name ? 'active' : ''} aria-current={tab === name ? 'page' : undefined} onClick={() => {setTab(name);if(name==='Touch & sign')setOpenedTouch(true);}}><Icon size={17}/><span>{name}</span>{name === 'Camera & scan' && <span className="coming-dot"/>}</button>)}</nav>
      {tab === 'Clipboard' ? <div className="clipboard-workspace"><div className="tool-heading"><div><h2>A shared clipboard</h2><p>Text, links, and little things worth sending.</p></div><span className="shortcut"><Clipboard size={16}/></span></div>
        <ClipboardHistory clips={session.clips} ready={clipboardReady} clear={() => session.set({ clips: [] })}
          copy={value => void perform(() => navigator.clipboard.writeText(value), 'Copied to clipboard')}/>
        <form className="composer" onSubmit={event => {
          event.preventDefault();
          if (!bridge.current || !clipboardReady || !text.trim()) return;
          const current = bridge.current;
          const draft = text;
          void perform(async () => {
            if (clipboardDestination === 'all') await current.sendText(draft, true);
            else await current.sendText(draft, false, clipboardDestination);
            setText(value => value === draft ? '' : value);
          }, 'Clipboard sent');
        }}>
          <textarea aria-label="Text to send" placeholder="Paste a link, jot a note, or drop in some text…"
            maxLength={12000} value={text} onChange={event => setText(event.target.value)}/>
          {clipboardTarget === 'multiple' && <RecipientChecklist devices={verifiedDevices} selected={selectedRecipients}
            toggle={id => setSelectedRecipients(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id])}
            removeUnavailable={() => setSelectedRecipients(ids => ids.filter(isVerified))}/>}
          <div className="composer-footer">
            <span>{text.length ? `${text.length.toLocaleString()} / 12,000` : 'Only shared when you send.'}</span>
            <div className="composer-actions">
              <RecipientPicker devices={verifiedDevices} recipient={individualTarget} onSelect={changeClipboardTarget}
                all={{ selected: clipboardTarget === 'all', select: () => changeClipboardTarget('all') }}
                multiple={{ selected: clipboardTarget === 'multiple', select: () => changeClipboardTarget('multiple') }}/>
              <button className="primary" disabled={!clipboardReady || !text.trim()} type="submit">
                {clipboardTarget === 'multiple' && selectedRecipients.length
                  ? `Send to ${selectedRecipients.length} ${selectedRecipients.length === 1 ? 'device' : 'devices'}` : 'Send'}
              </button>
            </div>
          </div>
        </form>
        <div className="sync-row">
          <button className="text-button" disabled={!clipboardReady} onClick={() => void perform(() => sync(clipboardDestination), 'Clipboard sent')}><Copy size={15}/>Sync clipboard now</button>
          <label><input type="checkbox" disabled={!canAutoSync} checked={autoSync && canAutoSync}
            onChange={event => setAutoSync(event.target.checked)}/>Sync when I return{individualTarget === undefined ? ' (one device only)' : ''}</label>
        </div>
        <div className="workspace-note"><ShieldCheck size={14}/><span>Session history stays in this tab and clears when you disconnect.</span></div></div> : tab === 'Files' ? <FileTools bridge={bridge.current} ready={ready} report={setNotice}/> : tab === 'Camera & scan' ? <CameraTools bridge={bridge.current} ready={ready} report={setNotice}/> : tab === 'Touch & sign' ? null : <div className="upcoming"><div className="empty-icon"><Touchpad size={25}/></div><span className="eyebrow">COMING IN A LATER MILESTONE</span><h2>{tab}</h2><p>Sign with your phone and control presentations from your seat.</p><button onClick={() => setTab('Clipboard')}>Back to clipboard</button></div>}
      {openedTouch && <Suspense fallback={<p role="status">Opening presenter�</p>}><TouchTools bridge={bridge.current} ready={ready} report={setNotice} visible={tab==='Touch & sign'}/></Suspense>}
      <TransferQueue bridge={bridge.current} report={setNotice}/>
      </section></div>
      {session.roomActive && session.error && <div className="error" role="alert">{session.error}<button className="icon-button" aria-label="Dismiss error" onClick={() => session.set({ error: '' })}><X size={16}/></button></div>}
      <footer><nav aria-label="Bridge resources"><a href="/guide/" target="_blank" rel="noopener noreferrer">How to send files</a><button className="text-button" onClick={()=>void perform(async()=>{
        const url='https://bridge-eight-beryl.vercel.app/';
        if(navigator.share){try{await navigator.share({title:'Bridge',text:'Send files between your phone and laptop.',url});return;}catch(error){if(error instanceof Error && error.name==='AbortError')return;}}
        await navigator.clipboard.writeText(url);setNotice('Public Bridge link copied');
      })}>Share Bridge</button></nav><div><span>{session.connected ? 'AES-256-GCM' : 'PRIVATE BY DESIGN'}</span><span>·</span><span>{session.route || 'BROWSER TO BROWSER'}</span></div></footer>
    </main>{notice && <div className="toast" role="status">{notice}</div>}{scanner && <Scanner onScan={scanned} onClose={() => setScanner(false)}/>}
  </div>;
}
