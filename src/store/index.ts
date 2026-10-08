import { NativeEventEmitter, NativeModules } from "react-native";

import {
  setStoreAdapter,
  type StoreAdapter,
  type StoreTransaction,
} from "../store.js";

interface NativeRevnixStore {
  purchase(productId: string, customerId: string): Promise<StoreTransaction | null>;
  restore(): Promise<StoreTransaction[]>;
  finish(transactionId: string): Promise<void>;
}

const native: NativeRevnixStore | undefined = NativeModules.RevnixStore;

const missing = (): Promise<never> =>
  Promise.reject(
    new Error(
      "Revnix: RevnixStore native module not found. Run pod install / rebuild the app (Expo: use a development build)."
    )
  );

export const RevnixStore: StoreAdapter = native
  ? {
      purchase: (productId, { customerId }) => native.purchase(productId, customerId),
      restore: () => native.restore(),
      finish: (transactionId) => native.finish(transactionId),
      observe(onTransaction) {
        const sub = new NativeEventEmitter(NativeModules.RevnixStore).addListener(
          "revnixStoreTransaction",
          (tx) => onTransaction(tx as StoreTransaction)
        );
        return () => sub.remove();
      },
    }
  : {
      purchase: missing,
      restore: missing,
      finish: missing,
      observe: () => () => {},
    };

if (native) setStoreAdapter(RevnixStore);
