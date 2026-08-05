import type { RegisterPurchaseInput, Store } from "./types.js";

// Glue for react-native-iap: turn its purchase object into the
// RegisterPurchaseInput the Revnix API expects. Structurally typed so the
// SDK carries no dependency on react-native-iap itself.
//
// Token semantics per store (must match what the store webhook reports, or
// client-register and webhook won't dedupe):
//   Apple  → originalTransactionId  (StoreKit 2 originalTransactionIdentifierIOS)
//   Google → purchaseToken

export interface IapPurchase {
  productId: string;
  transactionId?: string | null;
  /** Unix ms. */
  transactionDate?: number | null;
  /** Android purchase token. react-native-iap v13+ also sets it on iOS,
   *  where it is the StoreKit 2 JWS — not the token Revnix needs, but the
   *  proof it wants (`signedTransactionInfo`), so the Apple branch picks it
   *  up from here when it has the JWS shape. */
  purchaseToken?: string | null;
  /** StoreKit 2 JWS (`VerificationResult.jwsRepresentation`), for IAP
   *  libraries that expose it under its own name. */
  jwsRepresentation?: string | null;
  originalTransactionIdentifierIOS?: string | null;
}

// A JWS is three dot-separated base64url segments. Older react-native-iap
// versions put other receipt shapes in purchaseToken on iOS — shape-check so
// only a real JWS is sent as proof (the server rejects a malformed one).
const JWS_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function jwsFromIap(purchase: IapPurchase): string | undefined {
  for (const candidate of [purchase.jwsRepresentation, purchase.purchaseToken]) {
    if (candidate && JWS_SHAPE.test(candidate)) return candidate;
  }
  return undefined;
}

// REV-200 (CTO-R2 M25): base64url → string without atob (not available on
// every React Native runtime). The ids read from the payload are ASCII;
// multi-byte content is never consulted.
const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64UrlDecode(segment: string): string {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const ch of b64) {
    const idx = B64_ALPHABET.indexOf(ch);
    if (idx === -1) continue; // padding / stray characters
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

// The JWS payload's own ids — read WITHOUT verifying the signature, which is
// fine here: the server verifies the chain and only trusts the proof when the
// verified payload's ids match what we send. Reading them locally is exactly
// how we make them match.
function jwsPayload(
  jws: string
): { originalTransactionId?: string; transactionId?: string } | undefined {
  try {
    const segment = jws.split(".")[1];
    if (!segment) return undefined;
    const parsed: unknown = JSON.parse(base64UrlDecode(segment));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as { originalTransactionId?: string; transactionId?: string })
      : undefined;
  } catch {
    return undefined;
  }
}

export function purchaseInputFromIap(
  purchase: IapPurchase,
  source: Store,
  extras?: { expiresAt?: number; rawPayload?: unknown }
): RegisterPurchaseInput {
  if (source === "apple") {
    const transactionId = purchase.transactionId;
    if (!transactionId) {
      throw new Error("Revnix: Apple purchase is missing transactionId");
    }
    const jws = jwsFromIap(purchase);
    const proof = jws ? jwsPayload(jws) : undefined;
    return {
      source,
      // REV-200 (M25): token precedence. The old fallback (original id
      // missing → the renewal's own transactionId) minted a purchaseKey the
      // store webhook would never produce — a second purchase.completed and
      // double-counted revenue — AND failed the server's proof check, which
      // requires the verified JWS's originalTransactionId to EQUAL this
      // token, silently downgrading a proof-carrying purchase to
      // provisional. The JWS payload names the true original id, so when a
      // JWS is present it wins; the IAP library's field is next; the bare
      // transactionId remains only for the proof-less first purchase, where
      // original === transaction anyway.
      token:
        proof?.originalTransactionId ??
        purchase.originalTransactionIdentifierIOS ??
        transactionId,
      productId: purchase.productId,
      transactionId,
      occurredAt: purchase.transactionDate ?? undefined,
      expiresAt: extras?.expiresAt,
      rawPayload: extras?.rawPayload,
      // Without this the purchase lands PROVISIONAL (see
      // RegisterPurchaseInput.signedTransactionInfo).
      signedTransactionInfo: jws,
    };
  }
  const token = purchase.purchaseToken;
  if (!token) {
    throw new Error("Revnix: Google purchase is missing purchaseToken");
  }
  return {
    source,
    token,
    productId: purchase.productId,
    // The Google webhook adapter (convex/lib/google.ts) reports the
    // purchaseToken as the transactionId — send the same, never the Play
    // orderId, or client-register and webhook won't share a purchaseKey.
    transactionId: token,
    occurredAt: purchase.transactionDate ?? undefined,
    expiresAt: extras?.expiresAt,
    rawPayload: extras?.rawPayload,
  };
}
