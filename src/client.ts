import {
  PurchaseBlockedError,
  RevnixAuthError,
  RevnixError,
  RevnixNetworkError,
  RevnixRateLimitError,
  RevnixTimeoutError,
} from "./errors.js";
import { generateAnonymousId, generateViewId, resolveStorage } from "./storage.js";
import { SDK_VERSION } from "./version.js";
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
} from "./types.js";

const CUSTOMER_ID_KEY = "revnix.customerId";
const ENTITLEMENTS_CACHE_KEY = "revnix.entitlements";
const PENDING_PURCHASES_KEY = "revnix.pendingPurchases";
const PLACEMENTS_CACHE_KEY = "revnix.placements";
const DEFAULT_TIMEOUT_MS = 10_000;

// REV-157: how long past a cached entitlement's expiresAt it is still served
// as active. An offline device cannot see the renewal that most likely
// happened at expiry — cutting access at the cached timestamp would lock a
// paying subscriber out mid-flight. Three days absorbs the overwhelmingly
// common auto-renew; a genuinely lapsed subscription still shuts off. Only
// cache-served reads are re-evaluated; a fresh server read is authoritative.
const LOCAL_EXPIRY_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

// C7: a purchase that failed to register, persisted so it survives an app
// restart and retries later (idempotent server-side via purchaseKey).
interface PendingPurchase {
  customerId: string;
  input: RegisterPurchaseInput;
}

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
  private readonly requestTimeoutMs: number;
  private readonly readYourWritesDelaysMs: number[];
  private customerIdPromise: Promise<string>;

  constructor(config: RevnixConfig) {
    if (!config.apiKey) throw new Error("Revnix: apiKey is required");
    if (!config.baseUrl) throw new Error("Revnix: baseUrl is required");
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    // M5: web falls back to localStorage automatically; truly memory-only
    // (RN without an adapter) warns and disables install reporting below.
    const resolved = resolveStorage(config.storage);
    this.storage = resolved.storage;
    this.fetchImpl = config.fetch ?? fetch;
    this.reportInstalls = (config.reportInstalls ?? true) && resolved.persistent;
    this.installMetadata = config.installMetadata;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.readYourWritesDelaysMs =
      config.readYourWritesDelaysMs ?? [250, 500, 1000, 2000];
    this.customerIdPromise = this.loadCustomerId(config.customerId);
    // C7: retry any purchases that failed to register on a previous launch, so
    // a paying user never stays locked out because a POST didn't land.
    void this.retryPendingPurchases().catch(() => {});
    // REV-157: warm the placement cache at launch, so the first paywall of the
    // session can render offline. Fire-and-forget; a failed key just stays on
    // whatever an earlier launch cached.
    for (const key of config.prefetchPlacements ?? []) {
      void this.resolvePlacement(key).catch(() => {});
    }
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
    try {
      const result = await this.postPurchase(customerId, input);
      // A transfer behavior may have resolved the purchase to a different
      // canonical customer (e.g. restore after login) — follow it.
      if (result.customerId !== customerId) {
        await this.setCustomerId(result.customerId);
      }
      // M9: read-your-writes — re-fetch entitlements until the read reflects
      // this purchase (cursor >= seq), warming the C7 cache at exactly the
      // moment it matters. Best-effort: a failure here never fails the
      // purchase (it already registered). Disabled entirely by
      // readYourWritesDelaysMs: [].
      if (this.readYourWritesDelaysMs.length > 0) {
        await this.waitForEntitlements(result.seq).catch(() => {});
      }
      return result;
    } catch (err) {
      // A blocked purchase (409) is a permanent domain rejection — don't queue.
      if (err instanceof PurchaseBlockedError) throw err;
      // C7: network/timeout/5xx — persist the receipt so the purchase isn't
      // lost, then retry on the next launch / connectivity regain. Idempotent
      // server-side (store.ts purchaseKey), so a later retry or the store
      // webhook never double-counts. Rethrow so the caller can still react now.
      await this.enqueuePurchase(customerId, input);
      throw err;
    }
  }

  private postPurchase(
    customerId: string,
    input: RegisterPurchaseInput
  ): Promise<RegisterPurchaseResult> {
    return this.request<RegisterPurchaseResult>("POST", "/v1/purchases", {
      customerId,
      ...input,
    });
  }

  /** C7: retry purchases that failed to register and were persisted locally.
   *  Runs automatically at construction; call again when connectivity returns.
   *  Idempotent and safe to call repeatedly. */
  async retryPendingPurchases(): Promise<void> {
    const queue = await this.readPurchaseQueue();
    if (queue.length === 0) return;
    const remaining: PendingPurchase[] = [];
    for (const item of queue) {
      try {
        await this.postPurchase(item.customerId, item.input);
        // Delivered — drop it from the queue.
      } catch (err) {
        if (err instanceof PurchaseBlockedError) continue; // permanent — drop
        remaining.push(item); // still failing — keep for next time
      }
    }
    await this.writePurchaseQueue(remaining);
  }

  /** Current entitlements for this customer, merged across every id linked to
   *  them. Reads the network first and caches the result; if that read FAILS
   *  (offline / incident) it falls back to the last cached entitlements with
   *  `stale: true`, so a paying customer is never shown as unsubscribed just
   *  because the network is down. Throws only when there is nothing cached. */
  async getEntitlements(): Promise<CustomerEntitlements> {
    const customerId = await this.customerIdPromise;
    try {
      const fresh = await this.request<CustomerEntitlements>(
        "GET",
        `/v1/customers/${encodeURIComponent(customerId)}/entitlements`
      );
      await this.writeEntitlementsCache(customerId, fresh);
      return { ...fresh, stale: false, fetchedAt: Date.now() };
    } catch (err) {
      const cached = await this.readEntitlementsCache(customerId);
      if (cached) {
        return this.withLocalExpiry({
          ...cached.data,
          stale: true,
          fetchedAt: cached.fetchedAt,
        });
      }
      throw err;
    }
  }

  /** M9: read-your-writes — poll getEntitlements until the response's ledger
   *  cursor is at least `seq` (i.e. the read provably includes that write),
   *  then resolve with it. Resolves with the LAST read if the delays run out
   *  or reads only come from the stale cache — never spins forever. Called
   *  automatically by registerPurchase; public for manual flows (e.g. after
   *  a webhook-driven grant the app learns about out-of-band). */
  async waitForEntitlements(seq: number): Promise<CustomerEntitlements> {
    let last = await this.getEntitlements();
    for (const delayMs of this.readYourWritesDelaysMs) {
      if (!last.stale && last.cursor >= seq) return last;
      await new Promise((r) => setTimeout(r, delayMs));
      last = await this.getEntitlements();
    }
    return last;
  }

  /** C7: the last entitlements cached for the current customer, with NO network
   *  call — for an instant, offline-safe gate at launch. Always `stale: true`;
   *  follow with getEntitlements() to revalidate. Null if nothing is cached. */
  async getCachedEntitlements(): Promise<CustomerEntitlements | null> {
    const customerId = await this.customerIdPromise;
    const cached = await this.readEntitlementsCache(customerId);
    return cached
      ? this.withLocalExpiry({
          ...cached.data,
          stale: true,
          fetchedAt: cached.fetchedAt,
        })
      : null;
  }

  /** REV-157: cached entitlements are a snapshot — re-evaluate expiry against
   *  the local clock when serving them, so a subscription that ended long ago
   *  never stays "active" offline forever. Active entitlements keep access
   *  for LOCAL_EXPIRY_GRACE_MS past expiresAt (the renewal an offline device
   *  cannot see yet). Inactive stays inactive; no expiresAt (lifetime/grant)
   *  is untouched. */
  private withLocalExpiry(data: CustomerEntitlements): CustomerEntitlements {
    const cutoff = Date.now() - LOCAL_EXPIRY_GRACE_MS;
    return {
      ...data,
      entitlements: data.entitlements.map((e) =>
        e.isActive && e.expiresAt !== undefined && e.expiresAt < cutoff
          ? { ...e, isActive: false }
          : e
      ),
    };
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
   *  the one-line paywall call. REV-157: reads the network first and caches
   *  the result; if that read FAILS (offline / incident) it falls back to the
   *  last cached resolution with `stale: true`, so the paywall renders the
   *  last published version rather than not at all. Throws only when there
   *  is nothing cached. */
  async resolvePlacement(placementKey: string): Promise<PlacementResolution> {
    try {
      const fresh = await this.request<PlacementResolution>(
        "GET",
        `/v1/placements/${encodeURIComponent(placementKey)}/offering`
      );
      await this.writePlacementCache(placementKey, fresh);
      return { ...fresh, stale: false, fetchedAt: Date.now() };
    } catch (err) {
      const cached = await this.readPlacementCache(placementKey);
      if (cached) {
        return { ...cached.data, stale: true, fetchedAt: cached.fetchedAt };
      }
      throw err;
    }
  }

  /** REV-157: the last resolution cached for `placementKey`, with NO network
   *  call — for an instant, offline-safe paywall at launch. Always
   *  `stale: true`; follow with resolvePlacement() to revalidate. Null if
   *  nothing is cached yet. */
  async getCachedPlacement(
    placementKey: string
  ): Promise<PlacementResolution | null> {
    const cached = await this.readPlacementCache(placementKey);
    return cached
      ? { ...cached.data, stale: true, fetchedAt: cached.fetchedAt }
      : null;
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

  // ——— C7: entitlement cache (best-effort; storage failures never throw) ———

  private async writeEntitlementsCache(
    customerId: string,
    data: CustomerEntitlements
  ): Promise<void> {
    try {
      await this.storage.setItem(
        ENTITLEMENTS_CACHE_KEY,
        JSON.stringify({ customerId, data, fetchedAt: Date.now() })
      );
    } catch {
      // Caching is best-effort — a failure to persist must never break a read.
    }
  }

  private async readEntitlementsCache(
    customerId: string
  ): Promise<{ data: CustomerEntitlements; fetchedAt: number } | null> {
    try {
      const raw = await this.storage.getItem(ENTITLEMENTS_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        customerId: string;
        data: CustomerEntitlements;
        fetchedAt: number;
      };
      // Only trust the cache for the id it was written under — after a
      // logout/identify the cached entitlements belong to a different customer.
      if (parsed.customerId !== customerId) return null;
      return { data: parsed.data, fetchedAt: parsed.fetchedAt };
    } catch {
      return null;
    }
  }

  // ——— REV-157: placement cache (best-effort; storage failures never throw) ———
  // One JSON map keyed by placementKey. Placements are app-scoped, not
  // customer-scoped, so unlike the entitlements cache there is no per-customer
  // ownership check — a logout/identify does not invalidate a paywall.

  private async readPlacementMap(): Promise<
    Record<string, { data: PlacementResolution; fetchedAt: number }>
  > {
    try {
      const raw = await this.storage.getItem(PLACEMENTS_CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, { data: PlacementResolution; fetchedAt: number }>)
        : {};
    } catch {
      return {};
    }
  }

  private async readPlacementCache(
    placementKey: string
  ): Promise<{ data: PlacementResolution; fetchedAt: number } | null> {
    const map = await this.readPlacementMap();
    return map[placementKey] ?? null;
  }

  private async writePlacementCache(
    placementKey: string,
    data: PlacementResolution
  ): Promise<void> {
    try {
      const map = await this.readPlacementMap();
      map[placementKey] = { data, fetchedAt: Date.now() };
      await this.storage.setItem(PLACEMENTS_CACHE_KEY, JSON.stringify(map));
    } catch {
      // Caching is best-effort — a failure to persist must never break a read.
    }
  }

  // ——— C7: persisted purchase retry queue ———

  private async readPurchaseQueue(): Promise<PendingPurchase[]> {
    try {
      const raw = await this.storage.getItem(PENDING_PURCHASES_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as PendingPurchase[]) : [];
    } catch {
      return [];
    }
  }

  private async writePurchaseQueue(queue: PendingPurchase[]): Promise<void> {
    try {
      await this.storage.setItem(PENDING_PURCHASES_KEY, JSON.stringify(queue));
    } catch {
      // best-effort
    }
  }

  private async enqueuePurchase(
    customerId: string,
    input: RegisterPurchaseInput
  ): Promise<void> {
    const queue = await this.readPurchaseQueue();
    const key = (p: RegisterPurchaseInput) =>
      `${p.source}:${p.token}:${p.transactionId}`;
    // Repeated failures of the same purchase collapse to one queued entry.
    if (!queue.some((q) => key(q.input) === key(input))) {
      queue.push({ customerId, input });
      await this.writePurchaseQueue(queue);
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    // C7: abort the request after requestTimeoutMs so a slow or dead backend
    // can't hang the app. AbortController is guarded for very old runtimes.
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.requestTimeoutMs)
      : undefined;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          // L3: identify the SDK on EVERY request (reads included) so the
          // backend can triage by version without depending on body fields.
          "X-Revnix-SDK": `revnix-react/${SDK_VERSION}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (err) {
      if (
        controller?.signal.aborted ||
        (err instanceof Error && err.name === "AbortError")
      ) {
        throw new RevnixTimeoutError(
          `Revnix request to ${path} timed out after ${this.requestTimeoutMs}ms`
        );
      }
      throw new RevnixNetworkError(
        err instanceof Error ? err.message : "network request failed"
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

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
      if (res.status === 401 || res.status === 403) {
        throw new RevnixAuthError(res.status, message);
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        throw new RevnixRateLimitError(
          message,
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : undefined
        );
      }
      throw new RevnixError(res.status, message);
    }
    return parsed as T;
  }
}
