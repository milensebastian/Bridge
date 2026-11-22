import { create } from 'zustand';
import type { RoomProfile } from '../lib/roomProfile';
export type Clip = { id: string; text: string; at: number; source: string; slot: number };
export type Device = {
  id: number; slot: number; name: string; customName: boolean; connected: boolean; connecting: boolean;
  verified: boolean; ready: boolean; failed: boolean; sas: string; route: string;
};
type Session = {
  status: string; url: string; roomActive: boolean; deviceId: number; devices: Device[]; profile?: RoomProfile;
  recipient?: number; connected: boolean; connecting: boolean; error: string; clips: Clip[]; route: string;
  set: (state: Partial<Omit<Session, 'set' | 'add'>>) => void; add: (clip: Clip) => void;
};
export const useSession = create<Session>(set => ({
  status: 'Not connected', url: '', roomActive: false, deviceId: 0, devices: [],
  connected: false, connecting: false, error: '', clips: [], route: '',
  set: state => set(state), add: clip => set(state => ({ clips: [clip, ...state.clips].slice(0, 50) })),
}));
