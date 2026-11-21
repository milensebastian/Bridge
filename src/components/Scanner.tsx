import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
export default function Scanner({ onScan, onClose }: { onScan: (url: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null); const [error, setError] = useState('');
  useEffect(() => {
    let stream: MediaStream | undefined; let stopped = false; let frame = 0;
    const canvas = document.createElement('canvas'); const context = canvas.getContext('2d', { willReadFrequently: true })!;
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: 640 }, audio: false }).then(async media => {
      if (stopped) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media; video.current!.srcObject = media; await video.current!.play();
      const scan = () => {
        if (stopped) return;
        const source = video.current;
        if (source?.readyState === 4) {
          canvas.width = source.videoWidth; canvas.height = source.videoHeight; context.drawImage(source, 0, 0);
          const data = context.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(data.data, data.width, data.height);
          if (code) { try { const url = new URL(code.data); if (url.origin === location.origin && url.pathname === '/pair' && url.hash.includes('pk=')) { onScan(url.href); return; } } catch { /* Keep scanning unrelated codes. */ } }
        }
        frame = requestAnimationFrame(scan);
      }; scan();
    }).catch(() => setError('Camera access is unavailable. Paste a pairing link instead.'));
    return () => { stopped = true; cancelAnimationFrame(frame); stream?.getTracks().forEach(track => track.stop()); };
  }, [onScan]);
  return <div className="modal" role="dialog" aria-modal="true" aria-label="Scan pairing code"><div><h2>Scan your desktop’s code</h2><video ref={video} muted playsInline />{error && <p role="alert">{error}</p>}<button autoFocus onClick={onClose}>Close scanner</button></div></div>;
}
