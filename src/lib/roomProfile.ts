export const ROOM_SIZE = 20;
export const ROOM_NAME_LIMIT = 24;

export type RoomProfile = { id: number; slot: number; name: string };

export function cleanRoomName(value: string) {
  return value.replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, ROOM_NAME_LIMIT);
}

export function userLabel(slot: number) { return `User ${slot}`; }
