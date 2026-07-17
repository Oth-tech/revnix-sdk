import type { RevnixStorage } from "./types";

/** Default storage: survives only the current JS runtime. Real apps must
 *  pass a persistent adapter (MMKV, AsyncStorage, localStorage) or every
 *  launch becomes a new anonymous customer. */
export function memoryStorage(): RevnixStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateAnonymousId(): string {
  return `rvx_anon_${randomHex(16)}`;
}

/** One id per paywall display (REV-094) — the backend dedupes retries on it
 *  while genuine repeat views (fresh ids) count separately. */
export function generateViewId(): string {
  return `rvx_view_${randomHex(16)}`;
}
