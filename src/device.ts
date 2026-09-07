// REV-268: the device attribute contract, SDK side. Every SDK sends the same
// twelve facts about the device on each placement resolve, in the
// X-Revnix-Device header, and the server stores them as reserved `device.*`
// customer attributes — the facts a targeting rule ("US only", "app version
// at least 3", "first open") evaluates against on the very request that
// serves the paywall.
//
// This SDK runs in a browser, in React Native, and under Node, so it cannot
// read most of the facts itself the way the native SDKs can: there is no
// StoreKit storefront in a browser and no `navigator` in Node. The split is
//   - what the runtime can tell us safely (detectDeviceFacts): platform,
//     locale, and — in a browser — the OS version from the user agent;
//   - what the app must tell us (RevnixConfig.device): app version, model,
//     storefront, currency, sandbox — a React Native app has
//     react-native-device-info in hand and this SDK should not depend on it;
//   - what the SDK owns outright: sdkVersion, installedAt, firstOpen.
// Anything unknown is simply omitted; the server treats every field as
// optional and normalizes what it gets (lib/deviceAttributes.ts in
// revnix-app), so nothing here needs to be exact — only honest.

import { SDK_VERSION } from "./version.js";
import type { DeviceFacts } from "./types.js";

/** The header the server reads. Keep in sync with
 *  convex/lib/deviceAttributes.ts DEVICE_HEADER. */
export const DEVICE_HEADER = "X-Revnix-Device";

/** Storage key for the first-launch timestamp. */
export const INSTALLED_AT_KEY = "revnix.installedAt";

/** What goes on the wire: the app-supplied facts plus the three the SDK owns. */
export interface DevicePayload extends DeviceFacts {
  sdkVersion: string;
  installedAt?: number;
  firstOpen?: boolean;
}

/** The facts this runtime can report about itself without help. Browser
 *  only in practice — under Node and React Native `navigator` is absent or
 *  says nothing useful, and those callers pass `device` in configure(). */
export function detectDeviceFacts(): DeviceFacts {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const facts: DeviceFacts = {};
  if (!nav) return facts;
  // A React Native runtime also exposes `navigator` (product: "ReactNative")
  // but its language/userAgent are not the device's — leave those to the app.
  if ((nav as { product?: string }).product === "ReactNative") return facts;
  if (typeof nav.userAgent === "string" && nav.userAgent.length > 0) {
    facts.platform = "web";
    const os = osVersionFromUserAgent(nav.userAgent);
    if (os !== undefined) facts.osVersion = os;
  }
  if (typeof nav.language === "string" && nav.language.length > 0) {
    facts.locale = nav.language;
  }
  return facts;
}

/** Best-effort OS version from a browser UA string; undefined when the UA
 *  gives nothing recognizable. Only the major desktop/mobile families —
 *  this is a targeting hint, not a fingerprinting library. */
export function osVersionFromUserAgent(ua: string): string | undefined {
  const ios = /(?:iPhone|iPad|CPU) OS (\d+(?:_\d+)*)/.exec(ua)?.[1];
  if (ios !== undefined) return ios.replace(/_/g, ".");
  const android = /Android (\d+(?:\.\d+)*)/.exec(ua)?.[1];
  if (android !== undefined) return android;
  const mac = /Mac OS X (\d+(?:[._]\d+)*)/.exec(ua)?.[1];
  if (mac !== undefined) return mac.replace(/_/g, ".");
  const windows = /Windows NT (\d+(?:\.\d+)*)/.exec(ua)?.[1];
  if (windows !== undefined) return windows;
  return undefined;
}

/** Drop undefined/empty fields so the encoded header carries only what is
 *  known — the server would drop them anyway, but bytes on every resolve
 *  are bytes on every resolve. */
export function compactPayload(payload: DevicePayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

/** base64url of the UTF-8 JSON payload. Hand-rolled rather than
 *  btoa/TextEncoder: neither is guaranteed on every React Native runtime
 *  this SDK supports, and a missing global here would fail every paywall
 *  resolve on that platform for the sake of one header. */
export function encodeDeviceHeader(payload: Record<string, unknown>): string {
  return base64url(utf8Bytes(JSON.stringify(payload)));
}

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    // Surrogate pair → one code point.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return bytes;
}

const B64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64url(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64[a >> 2];
    out += B64[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += B64[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += B64[c & 0x3f];
  }
  // No padding: base64url as the server decodes it (it re-pads itself).
  return out;
}
