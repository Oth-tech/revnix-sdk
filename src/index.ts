import { RevnixClient } from "./client";
import type { RevnixConfig } from "./types";

export { RevnixClient } from "./client";
export {
  PurchaseBlockedError,
  RevnixAuthError,
  RevnixError,
  RevnixNetworkError,
  RevnixRateLimitError,
  RevnixTimeoutError,
} from "./errors";
export { purchaseInputFromIap, type IapPurchase } from "./iap";
export { memoryStorage, generateAnonymousId } from "./storage";
export type {
  AliasResult,
  CustomerEntitlements,
  Entitlement,
  EntitlementSource,
  Environment,
  IdentifyResult,
  IdentifyStrategy,
  IdentityInfo,
  PaywallConfig,
  PlacementOffering,
  PlacementPackage,
  PlacementPaywall,
  PlacementProduct,
  PlacementResolution,
  RegisterPurchaseInput,
  RegisterPurchaseResult,
  RevnixConfig,
  RevnixStorage,
  Store,
} from "./types";

let instance: RevnixClient | null = null;

/** Singleton facade — configure once at app start, then import `Revnix`
 *  anywhere. Prefer constructing RevnixClient directly in tests. */
export const Revnix = {
  configure(config: RevnixConfig): RevnixClient {
    instance = new RevnixClient(config);
    return instance;
  },
  get client(): RevnixClient {
    if (!instance) {
      throw new Error("Revnix: call Revnix.configure(...) before use");
    }
    return instance;
  },
};
