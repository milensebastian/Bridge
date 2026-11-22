import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { ArrowUpRight, Clipboard, Copy, MoreHorizontal } from 'lucide-react';
import { memberColor } from '../lib/roomProfile';
import type { Clip } from '../store/session';

export function ClipboardHistory({ clips, ready, clear, copy }: {
  clips: Clip[]; ready: boolean; clear: () => void; copy: (text: string) => void;
}) {
  const feed = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  useLayoutEffect(() => {
    const el = feed.current;
    if (!el || !clips.length) followLatest.current = true;
    else if (followLatest.current) el.scrollTop = el.scrollHeight;
  }, [clips]);

  return <>
    <div className="history-heading">
      <h3>Shared this session <span>{clips.length}</span></h3>
      <button className="text-button" disabled={!clips.length} onClick={clear}>Clear history</button>
    </div>
    {clips.length ? <div className="feed" ref={feed} tabIndex={0} role="log" aria-label="Shared clipboard"
      onScroll={event => {
        const el = event.currentTarget;
        followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
      }}>
      {clips.map(clip => {
        let url: string | undefined;
        try {
          const candidate = new URL(clip.text.trim());
          if (['https:', 'http:'].includes(candidate.protocol)) url = candidate.href;
        } catch { /* Plain text. */ }
        return <article className={clip.sentByMe ? 'clip clip-sent' : 'clip'} key={clip.id}
          style={{ '--clip-tint': memberColor(clip.slot) } as CSSProperties}>
          <div className="clip-meta">
            <span className="clip-sender" dir="auto">{clip.source}</span>
            <time dateTime={new Date(clip.at).toISOString()}>{new Date(clip.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            <button className="icon-button" aria-label="Copy shared text" onClick={() => copy(clip.text)}><Copy size={15}/></button>
            {url && <a href={url} target="_blank" rel="noreferrer" aria-label="Open shared link"><ArrowUpRight size={17}/></a>}
          </div>
          <pre>{clip.text}</pre>
        </article>;
      })}
    </div> : <div className="empty-state">
      <div className="empty-icon"><Clipboard size={24} strokeWidth={1.3}/><span><MoreHorizontal size={17}/></span></div>
      <h3>No messages yet</h3>
      <p>{ready ? 'Send your first note below.' : 'Connect a device to share text and links.'}</p>
    </div>}
  </>;
}
