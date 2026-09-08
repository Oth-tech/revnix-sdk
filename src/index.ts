import { RevnixClient } from "./client.js";
import type { RevnixConfig } from "./types.js";

export { RevnixClient } from "./client.js";
export {
  PurchaseBlockedError,
  RevnixAuthError,
  RevnixError,
  RevnixNetworkError,
  RevnixRateLimitError,
  RevnixTimeoutError,
} from "./errors.js";
export { purchaseInputFromIap, type IapPurchase } from "./iap.js";
export { memoryStorage, generateAnonymousId } from "./storage.js";
export { SDK_VERSION } from "./version.js";
export { DEVICE_HEADER, encodeDeviceHeader } from "./device.js";
export {
  browserLifecycle,
  DEFAULT_SESSION_TIMEOUT_MS,
  HOST_CALL_PLACEMENT,
  IMPLICIT_PLACEMENTS,
  type ImplicitPlacement,
  type ImplicitSkipReason,
  type ImplicitTrigger,
  type ImplicitTriggerResponse,
  type RevnixLifecycle,
} from "./implicit.js";
export type {
  AliasResult,
  CustomerEntitlements,
  DeviceFacts,
  Entitlement,
  EntitlementSource,
  Environment,
  IdentifyResult,
  IdentifyStrategy,
  IdentityInfo,
  ImplicitResolution,
  PaywallConfig,
  PaywallInteraction,
  PaywallPurchaseOutcome,
  PlacementOffering,
  PlacementPackage,
  PlacementPaywall,
  PlacementProduct,
  PlacementResolution,
  RegisterPurchaseInput,
  RegisterPurchaseResult,
  RevnixConfig,
  RevnixDiagnostic,
  RevnixStorage,
  Store,
} from "./types.js";

let instance: RevnixClient | null = null;

/** Singleton facade — configure once at app start, then import `Revnix`
 *  anywhere. Prefer constructing RevnixClient directly in tests. */
export const Revnix = {
  configure(config: RevnixConfig): RevnixClient {
    // REV-204 (L10): dev fast-refresh re-runs configure(); without teardown
    // the old client kept its retry/prefetch background work running
    // alongside the new one.
    instance?.dispose();
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
