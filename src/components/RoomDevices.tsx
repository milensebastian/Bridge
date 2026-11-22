import { useEffect, useRef, useState } from 'react';
import { Check, Link, Pencil, Unplug } from 'lucide-react';
import type { Bridge } from '../lib/bridge';
import { memberColor, ROOM_NAME_LIMIT, ROOM_SIZE, userLabel } from '../lib/roomProfile';
import { useSession, type Device } from '../store/session';

function MemberColor({ slot }: { slot: number }) {
  return <span className="member-color" aria-hidden="true" style={{ backgroundColor: memberColor(slot) }}/>;
}

export function RecipientPicker({ devices, recipient, onSelect, all, multiple }: {
  devices: Device[]; recipient?: number; onSelect: (id: number) => void;
  all?: { selected: boolean; select: () => void };
  multiple?: { selected: boolean; select: () => void };
}) {
  const selected = devices.find(device => device.id === recipient);
  const value = multiple?.selected && devices.length ? 'multiple'
    : all?.selected && devices.length ? 'all' : recipient ?? '';
  return <label className="room-recipient">
    <span className="member-name">{selected && <MemberColor slot={selected.slot}/>}Send to</span>
    <select value={value} disabled={!devices.length} onChange={event => {
      if (event.target.value === 'all') all?.select();
      else if (event.target.value === 'multiple') multiple?.select();
      else onSelect(Number(event.target.value));
    }}>
      <option value="" disabled>{devices.length ? 'Choose a device' : 'No verified devices yet'}</option>
      {all && devices.length > 0 && <option value="all">All verified devices</option>}
      {multiple && devices.length > 0 && <option value="multiple">Select devices</option>}
      {recipient !== undefined && !selected && <option value={recipient} disabled>Device disconnected</option>}
      {devices.map(device => <option key={device.id} value={device.id}>
        {device.customName ? `${device.name} · ${userLabel(device.slot)}` : device.name}
      </option>)}
    </select>
  </label>;
}

export function RecipientChecklist({ devices, selected, toggle, removeUnavailable }: {
  devices: Device[]; selected: number[]; toggle: (id: number) => void; removeUnavailable: () => void;
}) {
  const unavailable = selected.filter(id => !devices.some(device => device.id === id)).length;
  const firstCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => { firstCheckbox.current?.focus({ preventScroll: true }); }, []);
  return <fieldset className="recipient-checklist">
    <legend>Choose recipients</legend>
    {devices.length ? <div className="recipient-checklist-items">
      {devices.map((device, index) => <label className="recipient-check" key={device.id}>
        <input ref={index === 0 ? firstCheckbox : undefined} type="checkbox" checked={selected.includes(device.id)} onChange={() => toggle(device.id)}/>
        <MemberColor slot={device.slot}/>
        <span dir="auto">{device.name}{device.customName && <small> · {userLabel(device.slot)}</small>}</span>
      </label>)}
    </div> : <p>No verified devices yet.</p>}
    {unavailable > 0 && <div className="recipient-unavailable">
      <p role="status">{unavailable} selected {unavailable === 1 ? 'device is' : 'devices are'} unavailable.</p>
      <button type="button" className="text-button" onClick={removeUnavailable}>Remove unavailable</button>
    </div>}
  </fieldset>;
}

const pairingSteps = ['Joining', 'Confirm symbols', 'Connected'];

export function RoomDevices({ bridge, qr, report, showRecipient }: {
  bridge?: Bridge; qr: string; report: (message: string) => void; showRecipient: boolean;
}) {
  const { deviceId, devices, profile, recipient, url } = useSession();
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const verified = devices.filter(device => device.ready);
  const nextToVerify = devices.find(device => device.sas && !device.verified && !device.ready)?.id;
  const verification = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (nextToVerify !== undefined && matchMedia('(max-width: 800px), (pointer: coarse)').matches) {
      verification.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [nextToVerify]);
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
        try {
          if (bridge?.rename(draftName) === false) report('Your name changed for this room. This browser blocked saving it for next time.');
          setEditingName(false);
        }
        catch (error) { showError(error); }
      }}>
        <label>Display name
          <input autoFocus maxLength={ROOM_NAME_LIMIT} placeholder={fallback} value={draftName}
            onChange={event => setDraftName(event.target.value)}/>
        </label>
        <p>Remembered in this browser and visible to room members. Leave blank to use {fallback}.</p>
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
      {devices.map(device => {
        const step = device.ready ? 2 : device.sas ? 1 : 0;
        const route = device.route === 'TURN relay' ? 'Via relay' : device.route === 'Direct P2P' ? 'Direct' : '';
        return <li key={device.id}>
        <div className="room-device-heading">
          <div className="member-name">
            <MemberColor slot={device.slot}/><strong dir="auto">{device.name}</strong>
            {device.customName && <span>· {userLabel(device.slot)}</span>}
          </div>
          <span>{device.ready ? route || 'Connected' : device.failed ? 'Connection failed' : !device.connecting && !device.connected ? 'In room' : ''}</span>
        </div>
        {!device.failed && (device.connecting || device.connected) && <ol className="pair-steps" aria-label={`Pairing progress for ${device.name}`}>
          {pairingSteps.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}
            className={step > index ? 'step-done' : undefined}>{label}</li>)}
        </ol>}
        {device.sas && !device.ready && <div className="verify-card" ref={device.id === nextToVerify ? verification : undefined}>
          <p>Compare these symbols on both devices.</p>
          <div className="sas" aria-label={`Verification symbols for ${device.name}`}>{device.sas}</div>
          {device.verified ? <p>{device.connected ? 'Waiting for the other device to confirm.' : 'Confirmed here. Waiting for the connection to open.'}</p> :
            <button className="primary full" onClick={() => void bridge?.verify(device.id).catch(showError)}>
              <Check size={16}/>The symbols match
            </button>}
        </div>}
        {device.failed && <p role="status">{bridge?.connectionHelp}</p>}
        {device.connected || device.connecting ?
          <button className="text-button" onClick={() => bridge?.disconnect(device.id)}>
            {device.ready ? 'Disconnect' : 'Cancel connection to'} {device.name}
          </button> :
          <button className="full" onClick={() => {
            try { bridge?.connect(device.id); } catch (error) { showError(error); }
          }}>Connect to {device.name}</button>}
      </li>;
      })}
    </ul>
    {showRecipient && verified.length > 0 &&
      <RecipientPicker devices={verified} recipient={recipient} onSelect={id => bridge?.select(id)}/>}
    <button className="text-button" onClick={() => bridge?.close()}><Unplug size={15}/>{deviceId === 1 ? 'End room' : 'Leave room'}</button>
  </div>;
}
