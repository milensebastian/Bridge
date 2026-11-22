export const ROOM_SIZE = 20;
export const ROOM_NAME_LIMIT = 24;

export type RoomProfile = { id: number; slot: number; name: string };

export function cleanRoomName(value: string) {
  return value.replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, ROOM_NAME_LIMIT);
}

export function userLabel(slot: number) { return `User ${slot}`; }

const memberColors = [
  '#ed6969', '#4ba3ec', '#38ad76', '#eaaa3c', '#a779e5',
  '#38c5c6', '#f4885a', '#db6ead', '#8db946', '#6b79dc',
  '#b77e55', '#4eaca2', '#c96bdb', '#c9ae64', '#7aafed',
  '#a7cb68', '#f2a0b4', '#a78aa1', '#879397', '#d1d8e3',
];

export function memberColor(slot: number) { return memberColors[slot - 1]; }
