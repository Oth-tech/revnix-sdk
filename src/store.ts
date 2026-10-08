import type { Store } from "./types.js";

export interface StoreTransaction {
  store: Store;
  productId: string;
  /** Apple: transaction id · Google: purchaseToken. */
  transactionId: string;
  /** Apple: originalTransactionId · Google: purchaseToken. */
  token: string;
  /** Unix ms. */
  occurredAt?: number;
  /** Unix ms. */
  expiresAt?: number;
  /** Apple only: the StoreKit 2 JWS. */
  signedTransactionInfo?: string;
}

export interface StoreAdapter {
  /** Resolves null when the customer cancelled or the purchase is pending. */
  purchase(
    productId: string,
    opts: { customerId: string }
  ): Promise<StoreTransaction | null>;
  restore(): Promise<StoreTransaction[]>;
  finish(transactionId: string): Promise<void>;
  /** Transactions arriving outside purchase(): renewals, other devices, Ask
   *  to Buy, refunds. Returns an unsubscribe. */
  observe(onTransaction: (tx: StoreTransaction) => void): () => void;
}

let adapter: StoreAdapter | null = null;

/** Installs the store that `RevnixClient.purchase()` / `restore()` drive.
 *  `import "react-native-revnix/store"` calls this with the native bridge. */
export function setStoreAdapter(next: StoreAdapter | null): void {
  adapter = next;
}

export function getStoreAdapter(): StoreAdapter | null {
  return adapter;
}
