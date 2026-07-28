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

// CTO-SCALE-REVIEW M5: what actually backs the client when `storage` is
// omitted. Memory-only used to be the silent default — every launch became a
// new anonymous customer + a new install report (analytics inflated by the
// DAU multiplier, purchases orphaned on the previous launch's id). Now:
//   1. explicit adapter → use it (unchanged);
//   2. web (localStorage usable) → use localStorage automatically;
//   3. truly nothing (React Native without an adapter) → memory, but WARN
//      loudly, and the client skips install reporting (see client.ts) so a
//      forgotten config line can't fabricate fleet-wide installs.
export function resolveStorage(configured?: RevnixStorage): {
  storage: RevnixStorage;
  persistent: boolean;
} {
  if (configured) return { storage: configured, persistent: true };

  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (ls) {
    try {
      const probe = "revnix.__probe";
      ls.setItem(probe, "1");
      ls.removeItem(probe);
      return {
        storage: {
          getItem: (key) => ls.getItem(key),
          setItem: (key, value) => {
            ls.setItem(key, value);
          },
        },
        persistent: true,
      };
    } catch {
      // Private mode / quota quirks — fall through to memory.
    }
  }

  console.warn(
    "[revnix] No `storage` adapter configured and no localStorage available — " +
      "the customer id lives in memory only. Every launch will look like a NEW " +
      "anonymous customer: prior purchases won't be attached and analytics " +
      "would be inflated, so install reporting is disabled. Pass a persistent " +
      "adapter (AsyncStorage/MMKV on React Native) to fix this."
  );
  return { storage: memoryStorage(), persistent: false };
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  // L2: no Math.random fallback — a guessable customer id is readable by
  // anyone holding the public key, so failing loudly beats failing silently.
  // Every supported runtime (browsers, RN ≥0.72 via Hermes, Node ≥19) exposes
  // getRandomValues; older Node needs `globalThis.crypto = require("crypto").webcrypto`.
  if (!cryptoObj?.getRandomValues) {
    throw new Error(
      "[revnix] crypto.getRandomValues is unavailable in this runtime — " +
        "cannot generate a secure customer id. Polyfill globalThis.crypto " +
        "or pass an explicit `customerId` in configure()."
    );
  }
  cryptoObj.getRandomValues(bytes);
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
