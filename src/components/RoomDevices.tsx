import { useState } from 'react';
import { Check, Link, Pencil, Unplug } from 'lucide-react';
import type { Bridge } from '../lib/bridge';
import { ROOM_NAME_LIMIT, ROOM_SIZE, userLabel } from '../lib/roomProfile';
import { useSession } from '../store/session';

const colors = [
  '#ed6969', '#4ba3ec', '#38ad76', '#eaaa3c', '#a779e5',
  '#38c5c6', '#f4885a', '#db6ead', '#8db946', '#6b79dc',
  '#b77e55', '#4eaca2', '#c96bdb', '#c9ae64', '#7aafed',
  '#a7cb68', '#f2a0b4', '#a78aa1', '#879397', '#d1d8e3',
];

function MemberColor({ slot }: { slot: number }) {
  return <span className="member-color" aria-hidden="true" style={{ backgroundColor: colors[slot - 1] }}/>;
}

export function RoomDevices({ bridge, qr, report }: { bridge?: Bridge; qr: string; report: (message: string) => void }) {
  const { deviceId, devices, profile, recipient, url } = useSession();
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const verified = devices.filter(device => device.ready);
  const selected = verified.find(device => device.id === recipient);
  const ownSlot = profile?.slot ?? (deviceId - 1) % ROOM_SIZE + 1;
  const fallback = userLabel(ownSlot);
  const label = profile?.name || fallback;
  const showError = (error: unknown) => report(error instanceof Error ? error.message : String(error));

  return <div className="room-devices">
    <div className="room-summary">
      <p className="member-name"><MemberColor slot={ownSlot}/><strong dir="auto">{label}</strong><span>(you{url ? ' · host' : ''})</span></p>
      <p>{devices.length + 1} / {ROOM_SIZE} in room</p>
    </div>
    {profile && (editingName ?
      <form className="room-name-form" onSubmit={event => {
        event.preventDefault();
        try { bridge?.rename(draftName); setEditingName(false); }
        catch (error) { showError(error); }
      }}>
        <label>Display name
          <input autoFocus maxLength={ROOM_NAME_LIMIT} placeholder={fallback} value={draftName}
            onChange={event => setDraftName(event.target.value)}/>
        </label>
        <p>Visible to everyone in the room. Leave blank to use {fallback}.</p>
        <div className="file-actions">
          <button className="primary" type="submit">Save name</button>
          <button type="button" onClick={() => setEditingName(false)}>Cancel</button>
        </div>
      </form> :
      <button className="text-button" onClick={() => {
        setDraftName(profile.name);
        setEditingName(true);
      }}><Pencil size={14}/>{profile.name ? 'Edit name' : 'Add a name'}</button>)}
    {url && <>
      {qr && <div className="qr-wrap"><img src={qr} width="224" height="224" alt="Scan this QR code to join the room"/></div>}
      <p className="pair-description">Scan the QR code, then confirm the matching symbols on both devices.</p>
      <button className="full" onClick={() => void navigator.clipboard.writeText(url)
        .then(() => report('Room invite copied')).catch(showError)}><Link size={15}/>Copy room invite</button>
    </>}
    <ul className="room-roster" aria-label="Room devices">
      {devices.map(device => <li key={device.id}>
        <div className="room-device-heading">
          <div className="member-name">
            <MemberColor slot={device.slot}/><strong dir="auto">{device.name}</strong>
            {device.customName && <span>· {userLabel(device.slot)}</span>}
          </div>
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
      <span className="member-name">{selected && <MemberColor slot={selected.slot}/>}Send to</span>
      <select value={recipient ?? ''} onChange={event => bridge?.select(Number(event.target.value) || undefined)}>
        <option value="" disabled>Choose a device</option>
        {verified.map(device => <option key={device.id} value={device.id}>
          {device.customName ? `${device.name} · ${userLabel(device.slot)}` : device.name}
        </option>)}
      </select>
    </label>}
    <button className="text-button" onClick={() => bridge?.close()}><Unplug size={15}/>{deviceId === 1 ? 'End room' : 'Leave room'}</button>
  </div>;
}
