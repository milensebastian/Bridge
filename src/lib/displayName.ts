import { cleanRoomName } from './roomProfile';

const storageKey = 'bridge-display-name';

export function rememberedDisplayName() {
  try {
    return cleanRoomName(localStorage.getItem(storageKey) ?? '');
  } catch {
    return '';
  }
}

export function rememberDisplayName(name: string) {
  try {
    if (name) localStorage.setItem(storageKey, name);
    else localStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}
