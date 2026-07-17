import { PurchaseBlockedError, RevnixError } from "./errors";
import { generateAnonymousId, generateViewId, memoryStorage } from "./storage";
import type {
  AliasResult,
  CustomerEntitlements,
  IdentifyResult,
  IdentifyStrategy,
  IdentityInfo,
  PlacementResolution,
  RegisterPurchaseInput,
  RegisterPurchaseResult,
  RevnixConfig,
  RevnixStorage,
} from "./types";

const CUSTOMER_ID_KEY = "revnix.customerId";
const SDK_VERSION = "0.5.0";

export class RevnixClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly storage: RevnixStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly reportInstalls: boolean;
  private readonly installMetadata?: {
    platform?: string;
    appVersion?: string;
  };
  private customerIdPromise: Promise<string>;

  constructor(config: RevnixConfig) {
    if (!config.apiKey) throw new Error("Revnix: apiKey is required");
    if (!config.baseUrl) throw new Error("Revnix: baseUrl is required");
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.storage = config.storage ?? memoryStorage();
    this.fetchImpl = config.fetch ?? fetch;
    this.reportInstalls = config.reportInstalls ?? true;
    this.installMetadata = config.installMetadata;
    this.customerIdPromise = this.loadCustomerId(config.customerId);
  }

  /** The id every call is made as: the stored identified/canonical id, or a
   *  generated-and-persisted anonymous id (rvx_anon_…) on first launch. */
  getCustomerId(): Promise<string> {
    return this.customerIdPromise;
  }

  /** Call on login: merges the current (usually anonymous) customer into
   *  `userId`. The canonical id from the response becomes the id all
   *  subsequent calls use. Safe to call repeatedly — a no-op when already
   *  identified as `userId`. */
  async identify(
    userId: string,
    options?: { strategy?: IdentifyStrategy }
  ): Promise<IdentifyResult> {
    const previousId = await this.customerIdPromise;
    if (previousId === userId) {
      return { canonicalId: userId, merged: false };
    }
    const result = await this.request<IdentifyResult>(
      "POST",
      "/v1/identify",
      {
        previousId,
        newId: userId,
        strategy: options?.strategy,
      }
    );
    await this.setCustomerId(result.canonicalId);
    return result;
  }

  /** Attach an additional external id (legacy id, email hash, …) to the
   *  current customer without switching to it. */
  async alias(aliasId: string): Promise<AliasResult> {
    const customerId = await this.customerIdPromise;
    return await this.request<AliasResult>(
      "POST",
      `/v1/customers/${encodeURIComponent(customerId)}/alias`,
      { aliasId }
    );
  }

  /** Call on logout: forget the identified customer and start a fresh
   *  anonymous one. Never merges — purchases made while logged out belong
   *  to the new anonymous customer until the next identify(). */
  async logout(): Promise<string> {
    const anonymousId = generateAnonymousId();
    await this.setCustomerId(anonymousId);
    return anonymousId;
  }

  /** Call right after a successful store purchase: binds the store token to
   *  the current customer and appends the purchase to the ledger, so
   *  entitlement never waits on the store webhook. Throws
   *  PurchaseBlockedError when the token belongs to another customer and the
   *  app's transfer behavior forbids reassignment. */
  async registerPurchase(
    input: RegisterPurchaseInput
  ): Promise<RegisterPurchaseResult> {
    const customerId = await this.customerIdPromise;
    const result = await this.request<RegisterPurchaseResult>(
      "POST",
      "/v1/purchases",
      { customerId, ...input }
    );
    // A transfer behavior may have resolved the purchase to a different
    // canonical customer (e.g. restore after login) — follow it.
    if (result.customerId !== customerId) {
      await this.setCustomerId(result.customerId);
    }
    return result;
  }

  /** Current entitlements for this customer, merged across every id linked
   *  to them. `cursor` is the ledger position the read reflects. */
  async getEntitlements(): Promise<CustomerEntitlements> {
    const customerId = await this.customerIdPromise;
    return await this.request<CustomerEntitlements>(
      "GET",
      `/v1/customers/${encodeURIComponent(customerId)}/entitlements`
    );
  }

  /** Convenience: is one entitlement active right now? */
  async isEntitled(entitlementId: string): Promise<boolean> {
    const { entitlements } = await this.getEntitlements();
    return entitlements.some(
      (e) => e.entitlementId === entitlementId && e.isActive
    );
  }

  /** How the current id resolves: canonical id, alias status, linked ids. */
  async getIdentity(): Promise<IdentityInfo> {
    const customerId = await this.customerIdPromise;
    return await this.request<IdentityInfo>(
      "GET",
      `/v1/customers/${encodeURIComponent(customerId)}/identity`
    );
  }

  /** Resolve a named in-app location to the currently published offering —
   *  the one-line paywall call. */
  async resolvePlacement(placementKey: string): Promise<PlacementResolution> {
    return await this.request<PlacementResolution>(
      "GET",
      `/v1/placements/${encodeURIComponent(placementKey)}/offering`
    );
  }

  /** Report that a paywall was displayed (REV-094). Fire-and-forget like
   *  install reporting — never blocks rendering and never throws; each call
   *  is one view (retries of the same display are deduped by viewId).
   *  RevnixPaywall calls this automatically when given a `client`; headless
   *  paywall UIs call it on their own show event. Powers the analytics
   *  funnel's "Paywall displayed" stage and View → Trial/Paid conversions. */
  logPaywallShown(options?: {
    placementKey?: string;
    paywallId?: string;
  }): void {
    const viewId = generateViewId();
    void this.customerIdPromise
      .then((customerId) =>
        this.request("POST", "/v1/paywalls/viewed", {
          customerId,
          viewId,
          occurredAt: Date.now(),
          sdkVersion: SDK_VERSION,
          ...(options?.placementKey ? { placementKey: options.placementKey } : {}),
          ...(options?.paywallId ? { paywallId: options.paywallId } : {}),
        })
      )
      .catch(() => {});
  }

  private async loadCustomerId(initial?: string): Promise<string> {
    if (initial) {
      await this.storage.setItem(CUSTOMER_ID_KEY, initial);
      return initial;
    }
    const stored = await this.storage.getItem(CUSTOMER_ID_KEY);
    if (stored) return stored;
    const anonymousId = generateAnonymousId();
    await this.storage.setItem(CUSTOMER_ID_KEY, anonymousId);
    // A freshly generated id IS the install signal: first launch on this
    // device (or a reinstall that wiped storage). logout() deliberately does
    // not report — a new anonymous session is not a new install.
    if (this.reportInstalls) this.reportInstall(anonymousId);
    return anonymousId;
  }

  /** Fire-and-forget install report (REV-093). Never blocks startup and
   *  never throws — the backend absorbs retries idempotently per id. */
  private reportInstall(customerId: string): void {
    void this.request("POST", "/v1/installs", {
      customerId,
      occurredAt: Date.now(),
      sdkVersion: SDK_VERSION,
      ...this.installMetadata,
    }).catch(() => {});
  }

  private async setCustomerId(customerId: string): Promise<void> {
    this.customerIdPromise = Promise.resolve(customerId);
    await this.storage.setItem(CUSTOMER_ID_KEY, customerId);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const message =
        (parsed as { error?: string } | undefined)?.error ??
        `Revnix request failed (${res.status})`;
      if (res.status === 409 && path === "/v1/purchases") {
        throw new PurchaseBlockedError(message);
      }
      throw new RevnixError(res.status, message);
    }
    return parsed as T;
  }
}
