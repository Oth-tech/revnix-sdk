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
    return {
      source,
      // First purchase: originalTransactionId === transactionId, and StoreKit
      // may omit the original — fall back to the transaction itself.
      token: purchase.originalTransactionIdentifierIOS ?? transactionId,
      productId: purchase.productId,
      transactionId,
      occurredAt: purchase.transactionDate ?? undefined,
      expiresAt: extras?.expiresAt,
      rawPayload: extras?.rawPayload,
      // Without this the purchase lands PROVISIONAL (see
      // RegisterPurchaseInput.signedTransactionInfo).
      signedTransactionInfo: jwsFromIap(purchase),
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
