import { Check, Link, Unplug } from 'lucide-react';
import type { Bridge } from '../lib/bridge';
import { useSession } from '../store/session';

export function RoomDevices({ bridge, qr, report }: { bridge?: Bridge; qr: string; report: (message: string) => void }) {
  const { deviceId, devices, recipient, url } = useSession();
  const verified = devices.filter(device => device.ready);
  const label = deviceId === 1 ? 'Host' : `Device ${deviceId}`;
  const showError = (error: unknown) => report(error instanceof Error ? error.message : String(error));

  return <div className="room-devices">
    <p className="room-summary">{label} (you) · {devices.length + 1} / 20 in room</p>
    {url && <>
      {qr && <div className="qr-wrap"><img src={qr} width="224" height="224" alt="Scan this QR code to join the room"/></div>}
      <p className="pair-description">Scan the QR code, then confirm the matching symbols on both devices.</p>
      <button className="full" onClick={() => void navigator.clipboard.writeText(url)
        .then(() => report('Room invite copied')).catch(showError)}><Link size={15}/>Copy room invite</button>
    </>}
    <ul className="room-roster" aria-label="Room devices">
      {devices.map(device => <li key={device.id}>
        <div className="room-device-heading"><strong>{device.name}</strong>
          <span>{device.ready ? 'Connected' : device.failed ? 'Connection failed' : device.sas && !device.verified ? 'Verify' : device.connected || device.connecting ? 'Connecting…' : 'In room'}</span>
        </div>
        {device.sas && !device.ready && <>
          <p>Compare these symbols on both devices.</p>
          <div className="sas" aria-label={`Verification symbols for ${device.name}`}>{device.sas}</div>
          {device.verified ? <p>{device.connected ? 'Waiting for the other device to confirm.' : 'Confirmed here. Waiting for the connection to open.'}</p> :
            <button className="primary full" onClick={() => void bridge?.verify(device.id).catch(showError)}>
              <Check size={16}/>The symbols match
            </button>}
        </>}
        {device.failed && <p role="status">{bridge?.connectionHelp}</p>}
        {device.connected || device.connecting ?
          <button className="text-button" onClick={() => bridge?.disconnect(device.id)}>
            {device.ready ? 'Disconnect' : 'Cancel connection to'} {device.name}
          </button> :
          <button className="full" onClick={() => {
            try { bridge?.connect(device.id); } catch (error) { showError(error); }
          }}>Connect to {device.name}</button>}
      </li>)}
    </ul>
    {verified.length > 0 && <label className="room-recipient">
      Send to
      <select value={recipient ?? ''} onChange={event => bridge?.select(Number(event.target.value) || undefined)}>
        <option value="" disabled>Choose a device</option>
        {verified.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
      </select>
    </label>}
    <button className="text-button" onClick={() => bridge?.close()}><Unplug size={15}/>{deviceId === 1 ? 'End room' : 'Leave room'}</button>
  </div>;
}
