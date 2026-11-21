import { create } from 'zustand';
export type Clip = { id: string; text: string; at: number; source: 'You' | 'Other device' };
type Session = { status: string; url: string; sas: string; verified: boolean; peerVerified: boolean; connected: boolean; error: string; clips: Clip[]; route: string; set: (state: Partial<Omit<Session, 'set' | 'add'>>) => void; add: (clip: Clip) => void };
export const useSession = create<Session>(set => ({ status: 'Not connected', url: '', sas: '', verified: false, peerVerified: false, connected: false, error: '', clips: [], route: '', set: state => set(state), add: clip => set(state => ({ clips: [clip, ...state.clips].slice(0, 50) })) }));
