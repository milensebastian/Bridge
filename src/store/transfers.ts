import { create } from 'zustand';
// Milestone 2 owns disk handles and the streaming engine; never put file payloads in state.
export type Transfer = { id: number; path: string; size: number; offset: number; status: 'queued' | 'sending' | 'paused' | 'complete' };
export const useTransfers = create<{ queue: Transfer[] }>(() => ({ queue: [] }));
