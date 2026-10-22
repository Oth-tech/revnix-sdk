import { NativeEventEmitter, NativeModules } from "react-native";

import {
  setStoreAdapter,
  type StoreAdapter,
  type StoreTransaction,
} from "../store.js";
import type { IntegrityEvidence, RevnixConfig } from "../types.js";

interface NativeRevnixStore {
  purchase(productId: string, customerId: string): Promise<StoreTransaction | null>;
  restore(): Promise<StoreTransaction[]>;
  finish(transactionId: string, consume: boolean): Promise<void>;
  deviceIntegrity?(customerId: string): Promise<IntegrityEvidence | null>;
  advertisingId?(): Promise<string | null>;
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
      finish: (transactionId, consume) => native.finish(transactionId, consume === true),
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

/** Pass as `deviceIntegrity` in the Revnix config: App Attest on iOS, Play
 *  Integrity on Android, via the RevnixStore native module. Resolves null
 *  where the device or build cannot produce evidence. */
export const nativeDeviceIntegrity: NonNullable<RevnixConfig["deviceIntegrity"]> = (
  customerId
) => native?.deviceIntegrity?.(customerId) ?? Promise.resolve(null);

/** Pass as `advertisingId` in the Revnix config: the Google Advertising ID
 *  on Android, via the RevnixStore native module. Resolves null on iOS. */
export const nativeAdvertisingId: NonNullable<RevnixConfig["advertisingId"]> = () =>
  native?.advertisingId?.() ?? Promise.resolve(null);

if (native) setStoreAdapter(RevnixStore);
