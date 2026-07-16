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

export function generateAnonymousId(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `rvx_anon_${hex}`;
}
