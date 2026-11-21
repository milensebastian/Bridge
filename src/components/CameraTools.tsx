import { useRef, useState } from 'react';
import { Camera, FileText, ScanLine, Send } from 'lucide-react';
import jsQR from 'jsqr';
import type { Bridge } from '../lib/bridge';

type Props = { bridge?: Bridge; ready: boolean; report: (message: string) => void };

export function CameraTools({ bridge, ready, report }: Props) {
  const camera = useRef<HTMLInputElement>(null), documents = useRef<HTMLInputElement>(null), qr = useRef<HTMLInputElement>(null);
  const [decoded, setDecoded] = useState('');
  const send = async (files: File[]) => {
    if (!bridge || !ready) throw Error('Pair and verify both devices before sending camera captures.');
    if (files.length) await bridge.sendFiles(files.map(file => ({ file, path: file.name })));
  };
  const capture = (input: HTMLInputElement) => { const files = Array.from(input.files ?? []); input.value = ''; void send(files).then(() => files.length && report(files.length > 1 ? 'Scans sent to your other device' : 'Photo sent to your other device')).catch(error => report(error instanceof Error ? error.message : String(error))); };
  const scanQr = async (input: HTMLInputElement) => {
    const file = input.files?.[0]; input.value = ''; if (!file) return;
    const image = new Image(); image.src = URL.createObjectURL(file);
    try { await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const context = canvas.getContext('2d', { willReadFrequently: true }); const data = context?.getImageData(0, 0, canvas.width, canvas.height); const code = data && jsQR(data.data, data.width, data.height); if (!code) throw Error('No QR code found in that image.'); setDecoded(code.data); if (bridge && ready) await bridge.sendText(code.data); report('QR result sent to your other device'); } catch (error) { report(error instanceof Error ? error.message : String(error)); } finally { URL.revokeObjectURL(image.src); }
  };
  return <div className="clipboard-workspace camera-workspace"><div className="tool-heading"><div><h2>Camera &amp; scan</h2><p>Capture a photo, scan documents, or send a QR result.</p></div><Camera size={18}/></div><div className="camera-actions"><button className="primary" disabled={!ready} onClick={() => camera.current?.click()}><Camera size={16}/>Take a photo</button><button disabled={!ready} onClick={() => documents.current?.click()}><FileText size={16}/>Scan documents</button><button disabled={!ready} onClick={() => qr.current?.click()}><ScanLine size={16}/>Scan a QR image</button></div><input hidden ref={camera} type="file" accept="image/*" capture="environment" onChange={e => capture(e.currentTarget)}/><input hidden ref={documents} type="file" accept="image/*,application/pdf" multiple capture="environment" onChange={e => capture(e.currentTarget)}/><input hidden ref={qr} type="file" accept="image/*" onChange={e => void scanQr(e.currentTarget)}/>{decoded && <div className="scan-result"><span>Last QR result</span><code>{decoded}</code><button className="icon-button" aria-label="Send QR result" onClick={() => void bridge?.sendText(decoded).then(() => report('QR result sent')).catch(error => report(String(error)))}><Send size={15}/></button></div>}<p className="workspace-note">Photos and scans are sent directly to the paired device and are not stored on Bridge servers.</p></div>;
}
