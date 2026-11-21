import {create} from 'zustand';
import type {Manifest} from '../transfer/protocol';

export type Row = { id: string; label: string; direction: 'Sending' | 'Receiving'; total: number; bytes: number;
  speedMBps: number; etaSeconds: number; status: 'Active' | 'Paused' | 'Complete' | 'Cancelled' | 'Failed'; detail?: string; download?: string };
export const useTransfers = create<{queue: Row[]}>(() => ({queue: []}));
export function update(id: string, change: Partial<Row>) {
  useTransfers.setState(s => ({queue: s.queue.map(row => row.id === id ? {...row, ...change} : row)}));
}
export function track(m: Manifest, direction: Row['direction']) {
  const first = m.files[0].relativePath.split('/')[0];
  const label = m.files.length === 1 ? m.files[0].relativePath : first + ' · ' + m.files.length + ' files';
  useTransfers.setState(s => ({queue: [...s.queue, {id:m.transferId,label,direction,total:m.totalBytes,bytes:0,speedMBps:0,etaSeconds:0,status:'Active'}]}));
  let time = performance.now(), previous = 0;
  return (bytes: number) => {
    const now = performance.now(), elapsed = now - time;
    if (elapsed < 100 && bytes !== m.totalBytes) return;
    const speed = (bytes - previous) / Math.max(elapsed, 1) / 1000;
    update(m.transferId, {bytes, speedMBps:speed, etaSeconds:speed ? (m.totalBytes-bytes)/1e6/speed : 0});
    time = now; previous = bytes;
  };
}
