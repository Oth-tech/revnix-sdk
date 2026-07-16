import type { RegisterPurchaseInput, Store } from "./types";

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
  /** Android purchase token (also set on iOS by some react-native-iap
   *  versions, where it is a JWS — NOT the token Revnix needs). */
  purchaseToken?: string | null;
  originalTransactionIdentifierIOS?: string | null;
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
