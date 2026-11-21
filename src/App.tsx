import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Camera, Check, Clipboard, Copy, Files, Link, Monitor, Moon, MoreHorizontal, Plus, ScanLine, ShieldCheck, Smartphone, Sun, Touchpad, Unplug, X } from 'lucide-react';
import QRCode from 'qrcode';
import { Bridge } from './lib/bridge';
import { useSession } from './store/session';
import {FileTools,TransferQueue} from './components/FileTools';
import Scanner from './components/Scanner';

const modules = [{ name: 'Clipboard', icon: Clipboard }, { name: 'Files', icon: Files }, { name: 'Camera & scan', icon: Camera }, { name: 'Touch & sign', icon: Touchpad }];
export default function App() {
  const session = useSession(); const bridge = useRef<Bridge | undefined>(undefined);
  const initialPairUrl = useRef(location.pathname === '/pair' && location.search && location.hash ? location.href : undefined);
  const [tab, setTab] = useState('Clipboard'); const [text, setText] = useState('');
  const [qr, setQr] = useState(''); const [scanner, setScanner] = useState(false);
  const [mode, setMode] = useState(() => matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop');
  const [dark, setDark] = useState(() => localStorage.getItem('bridge-theme') === 'dark');
  const [notice, setNotice] = useState(''); const [pairLink, setPairLink] = useState(''); const [autoSync, setAutoSync] = useState(false);
  const ready = session.connected && session.verified && session.peerVerified;
  const start = useCallback((url?: string) => { bridge.current?.close(); bridge.current = new Bridge(); void bridge.current.start(url); }, []);
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
  const sync = useCallback(async () => {
    if (!bridge.current) throw Error('Pair a device first.');
    await bridge.current.sendText(await navigator.clipboard.readText());
  }, []);
  useEffect(() => { const focus = () => { if (autoSync && ready) void sync().catch(() => setNotice('Clipboard permission is needed. Use Sync clipboard to try again.')); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [autoSync, ready, sync]);
  const scanned = useCallback((url: string) => { setScanner(false); start(url); }, [start]);
  return <div className={`app ${mode}`}>
    <header className="topbar"><a className="brand" href="/" aria-label="Bridge home"><span className="brand-symbol"><span /><span /></span>bridge<span className="beta">BETA</span></a><div className="top-actions"><span className="local-label">A little closer, wirelessly.</span><button className="icon-button" aria-label={dark ? 'Use light theme' : 'Use dark theme'} onClick={() => setDark(!dark)}>{dark ? <Sun size={18}/> : <Moon size={18}/>}</button><span className="divider"/><button className="mode-button" onClick={() => setMode(mode === 'desktop' ? 'mobile' : 'desktop')}>{mode === 'desktop' ? <Monitor size={16}/> : <Smartphone size={16}/>}<span>{mode === 'desktop' ? 'Desktop' : 'Companion'}</span></button></div></header>
    <main><div className="page-heading"><div><div className="eyebrow">YOUR PERSONAL WORKSPACE</div><h1>Your devices. Together.</h1><p>Move something from here to there. Keep it between you.</p></div><span className={`connection ${session.connected ? 'online' : ''}`}><i/>{session.connected ? 'Device connected' : 'No device connected'}</span></div>
      <div className="workspace"><aside>
        <section className="pair-panel"><div className="section-heading"><h2>{session.connected ? 'Your connection' : 'Connect a device'}</h2><Smartphone size={18}/></div>
          {session.connected ? <div className="verification"><div className="device-pair"><Monitor size={31}/><span>······</span><Smartphone size={31}/></div><h3>{ready ? 'You’re connected' : 'One quick check'}</h3><p>Make sure these four symbols match on both screens.</p><div className="sas" aria-label="Verification symbols">{session.sas}</div>{!session.verified ? <button className="primary full" onClick={() => void perform(async () => { await bridge.current?.verify(); })}><Check size={16}/>The symbols match</button> : <p className="verification-note">{session.peerVerified ? 'Confirmed on both devices' : 'Waiting for confirmation on your other device…'}</p>}<button className="text-button" onClick={() => bridge.current?.close()}><Unplug size={15}/>Disconnect</button></div> : <>
            {qr ? <div className="qr-wrap"><img src={qr} width="224" height="224" alt="Scan this QR code to pair your device"/></div> : <div className="pair-illustration"><div className="drawn-monitor"><span className="tiny-logo">b.</span></div><div className="drawn-phone"><span/></div><div className="connection-line"/></div>}
            <h3>{qr ? 'Scan. Connect. Done.' : 'A bridge between screens.'}</h3><p className="pair-description">{qr ? 'Open your phone’s camera and scan the code. Keep this tab open.' : 'Pair your phone and computer to share directly, without an account.'}</p>
            {!qr ? <button className="primary full" onClick={() => start()}><Plus size={16}/>Create a connection</button> : <><div className="waiting"><i/>{session.status}</div><button className="full" onClick={() => void perform(() => navigator.clipboard.writeText(session.url), 'Pairing link copied')}><Link size={15}/>Copy pairing link</button><button className="text-button" onClick={() => start()}>Generate a new code</button></>}
            <div className="or"><span/>or join another device<span/></div><button className="full" onClick={() => setScanner(true)}><ScanLine size={16}/>Scan a QR code</button><form className="join-form" onSubmit={event => { event.preventDefault(); start(pairLink); }}><input aria-label="Pairing link" placeholder="Paste a pairing link" type="url" required value={pairLink} onChange={event => setPairLink(event.target.value)}/><button aria-label="Join pairing link" type="submit" disabled={!pairLink.trim()}>Join</button></form>
          </>}
        </section><div className="privacy-note"><ShieldCheck size={18}/><div><strong>Just your two devices.</strong><p>Encrypted in transit. No accounts.<br/>No clipboard stored on a server.</p></div></div>
      </aside><section className="content-panel"><nav className="tabs" aria-label="Workspace tools">{modules.map(({ name, icon: Icon }) => <button key={name} className={tab === name ? 'active' : ''} aria-current={tab === name ? 'page' : undefined} onClick={() => setTab(name)}><Icon size={17}/><span>{name}</span>{name !== 'Clipboard' && name !== 'Files' && <span className="coming-dot"/>}</button>)}</nav>
      {tab === 'Clipboard' ? <div className="clipboard-workspace"><div className="tool-heading"><div><h2>A shared clipboard</h2><p>Text, links, and little things worth sending.</p></div><span className="shortcut"><Clipboard size={16}/></span></div>
        <form className="composer" onSubmit={event => { event.preventDefault(); void perform(async () => { if (!bridge.current) throw Error('Pair a device first.'); await bridge.current.sendText(text); setText(''); }, 'Sent to your other device'); }}><textarea aria-label="Text to send" placeholder="Paste a link, jot a note, or drop in some text…" maxLength={12000} value={text} onChange={event => setText(event.target.value)}/><div className="composer-footer"><span>{text.length ? `${text.length.toLocaleString()} / 12,000` : 'Only shared when you send.'}</span><button className="primary" disabled={!ready || !text.trim()} type="submit">Send to device</button></div></form>
        <div className="sync-row"><button className="text-button" disabled={!ready} onClick={() => void perform(sync, 'Clipboard sent')}><Copy size={15}/>Sync clipboard now</button><label><input type="checkbox" checked={autoSync} onChange={event => setAutoSync(event.target.checked)}/>Sync when I return</label></div>
        <div className="history-heading"><h3>Shared this session <span>{session.clips.length}</span></h3><button className="text-button" disabled={!session.clips.length} onClick={() => session.set({ clips: [] })}>Clear history</button></div>
        {session.clips.length ? <div className="feed">{session.clips.map(clip => { let url: string | undefined; try { const candidate = new URL(clip.text.trim()); if (['https:', 'http:'].includes(candidate.protocol)) url = candidate.href; } catch { /* Plain text. */ } return <article className="clip" key={clip.id}><div className="clip-meta"><span>{clip.source}</span><time>{new Date(clip.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><button className="icon-button" aria-label="Copy shared text" onClick={() => void perform(() => navigator.clipboard.writeText(clip.text), 'Copied to clipboard')}><Copy size={15}/></button>{url && <a href={url} target="_blank" rel="noreferrer" aria-label="Open shared link"><ArrowUpRight size={17}/></a>}</div><pre>{clip.text}</pre></article>; })}</div> : <div className="empty-state"><div className="empty-icon"><Clipboard size={24} strokeWidth={1.3}/><span><MoreHorizontal size={17}/></span></div><h3>A clean slate.</h3><p>Your shared text and links will appear here.<br/>{ready ? 'Send your first note above.' : 'Connect a device to send your first note.'}</p></div>}
        <div className="workspace-note"><ShieldCheck size={14}/><span>Session history stays in this tab and clears when you disconnect.</span></div></div> : tab === 'Files' ? <FileTools bridge={bridge.current} ready={ready} report={setNotice}/> : <div className="upcoming"><div className="empty-icon">{tab === 'Camera & scan' ? <Camera size={25}/> : <Touchpad size={25}/>}</div><span className="eyebrow">COMING IN A LATER MILESTONE</span><h2>{tab}</h2><p>{tab === 'Camera & scan' ? 'Your phone’s camera, document scans, and PDFs on the big screen.' : 'Sign with your phone and control presentations from your seat.'}</p><button onClick={() => setTab('Clipboard')}>Back to clipboard</button></div>}
      <TransferQueue bridge={bridge.current} report={setNotice}/>
      </section></div>
      {session.error && <div className="error" role="alert">{session.error}<button className="icon-button" aria-label="Dismiss error" onClick={() => session.set({ error: '' })}><X size={16}/></button></div>}
      <footer><span>Less friction. More flow.</span><div><span>{session.connected ? 'AES-256-GCM' : 'PRIVATE BY DESIGN'}</span><span>·</span><span>{session.route || 'BROWSER TO BROWSER'}</span></div></footer>
    </main>{notice && <div className="toast" role="status">{notice}</div>}{scanner && <Scanner onScan={scanned} onClose={() => setScanner(false)}/>}
  </div>;
}
