import {
  PurchaseBlockedError,
  RevnixAuthError,
  RevnixError,
  RevnixNetworkError,
  RevnixRateLimitError,
  RevnixTimeoutError,
} from "./errors.js";
import { generateAnonymousId, generateViewId, resolveStorage } from "./storage.js";
import {
  DEVICE_HEADER,
  INSTALLED_AT_KEY,
  compactPayload,
  detectDeviceFacts,
  encodeDeviceHeader,
} from "./device.js";
import { SDK_VERSION } from "./version.js";
import {
  browserLifecycle,
  DEFAULT_SESSION_TIMEOUT_MS,
  IMPLICIT_CONFIG_RETRY_MS,
  IMPLICIT_PLACEMENTS,
  PREVIEW_PLACEMENT_KEY,
  type ImplicitPlacement,
  type RevnixAppState,
  type RevnixLifecycle,
} from "./implicit.js";
import type {
  AliasResult,
  ImplicitResolution,
  DeviceFacts,
  RevnixDiagnostic,
  CustomerEntitlements,
  IdentifyResult,
  IdentifyStrategy,
  IdentityInfo,
  LastDeepLink,
  PaywallInteraction,
  PlacementResolution,
  RegisterPurchaseInput,
  RegisterPurchaseResult,
  RevnixAttribution,
  RevnixConfig,
  RevnixStorage,
} from "./types.js";

const CUSTOMER_ID_KEY = "revnix.customerId";
const SESSION_STARTED_AT_KEY = "revnix.sessionStartedAt";
const LAST_BACKGROUND_AT_KEY = "revnix.lastBackgroundAt";
const DEFERRED_DEEP_LINK_DELIVERED_KEY = "revnix.deferredDeepLinkDelivered";
const LAST_DEEP_LINK_KEY = "revnix.lastDeepLink";
const ATTRIBUTION_KEY = "revnix.attribution";
const ENTITLEMENTS_CACHE_KEY = "revnix.entitlements";
const PENDING_PURCHASES_KEY = "revnix.pendingPurchases";
const PLACEMENTS_CACHE_KEY = "revnix.placements";
const DEFAULT_TIMEOUT_MS = 10_000;

// REV-204 (L10): how many customers keep a cached entitlements snapshot.
const ENTITLEMENTS_CACHE_MAX = 4;

// REV-204 (L10): http:// is tolerated only for development hosts.
const PRIVATE_HTTP_HOST =
  /^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i;

// URL/URLSearchParams are avoided: React Native's URL polyfill lacks parts of both.
const PREVIEW_TOKEN_RE = /[?&]revnix_preview=([0-9a-f]{64})(?:[&#]|$)/;

// REV-157: how long past a cached entitlement's expiresAt it is still served
// as active. An offline device cannot see the renewal that most likely
// happened at expiry — cutting access at the cached timestamp would lock a
// paying subscriber out mid-flight. Three days absorbs the overwhelmingly
// common auto-renew; a genuinely lapsed subscription still shuts off. Only
// cache-served reads are re-evaluated; a fresh server read is authoritative.
const LOCAL_EXPIRY_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

// REV-198 (CTO-R2 M23): how old a cached snapshot may be and still grant
// access. The expiry rule above bounds entitlements that CARRY an expiresAt —
// but a lifetime grant has none, and rolling the clock back moves every
// expiresAt into "the future", so blocking the domain plus a clock rollback
// was indefinite premium. Bounding on the cache's own age (fetchedAt) closes
// the unbounded variant: client checks are always defeatable, but now it
// takes re-editing the JSON every two weeks, not one Settings change.
const DEFAULT_OFFLINE_MAX_CACHE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// now < fetchedAt means the clock is BEHIND the moment the cache was written
// — a rolled-back clock. Small negative skew is real (NTP corrections), a
// large one is not.
const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000;

// C7: a purchase that failed to register, persisted so it survives an app
// restart and retries later (idempotent server-side via purchaseKey).
interface PendingPurchase {
  customerId: string;
  input: RegisterPurchaseInput;
}

interface InstallResponse {
  deferredDeepLink?: unknown;
  appleAttribution?: string;
}

interface AttributionResponse extends Omit<RevnixAttribution, "installMatch" | "attributedAt"> {
  installMatch: RevnixAttribution["installMatch"] | "unknown";
  attributedAt?: number;
}

// One queue entry per store charge — repeated failures collapse onto it, and
// the retry pass removes by this key rather than by array position.
const pendingKey = (p: RegisterPurchaseInput) =>
  `${p.source}:${p.token}:${p.transactionId}`;

// Queue only failures that can succeed later. Permanent 4xx (bad input,
// revoked key, blocked transfer) would be retried every launch forever;
// unknown non-Revnix errors count as transient to err on the keeping side.
const worthQueueing = (err: unknown): boolean =>
  !(err instanceof RevnixError) || err.isRetryable;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// REV-199 (CTO-R2 M24): ±20% on every scheduled delay.
const jittered = (ms: number) => ms * (0.8 + Math.random() * 0.4);

// REV-199 (M21): how long a fresh entitlements read answers repeat calls
// from memory. Short enough that a webhook-driven change is picked up within
// half a minute; long enough that gating five screens costs one request.
const DEFAULT_ENTITLEMENTS_TTL_MS = 30_000;

export class RevnixClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly storage: RevnixStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly reportInstalls: boolean;
  private readonly persistentStorage: boolean;
  /** True while the current id is a generated anon id living on
   *  NON-persistent storage — it changes every launch, so sending it to
   *  the experiments path would mint a phantom enrollment per launch
   *  (same hazard class the M5 install guard covers). */
  private ephemeralAnonId = false;
  private readonly installMetadata?: {
    platform?: string;
    appVersion?: string;
  };
  // REV-268: the encoded X-Revnix-Device value, built once per client. Null
  // when the app opted out (`device: false`). Resolved asynchronously because
  // installedAt/firstOpen come from storage, which may be async.
  private readonly deviceHeaderPromise: Promise<string | null>;
  private readonly requestTimeoutMs: number;
  private readonly readYourWritesDelaysMs: number[];
  private readonly offlineMaxCacheAgeMs: number;
  private readonly entitlementsTtlMs: number;
  // REV-200 (CTO-R2 M26): background failures used to vanish into
  // catch(() => {}) — a fleet failing before the server produced silence.
  // Every such site now reports here: the app's onDiagnostic callback gets
  // the event, and a counter rides the next successful request as an
  // X-Revnix-Bg-Failures header so the backend can see field pain it would
  // otherwise never receive.
  private readonly onDiagnostic?: (event: RevnixDiagnostic) => void;
  private bgFailures = 0;
  // REV-204 (L10): set by dispose() — stops background loops so a replaced
  // client (dev fast-refresh re-running configure()) does not keep retrying
  // and prefetching alongside its successor.
  private disposed = false;
  private customerIdPromise: Promise<string>;
  // REV-272: implicit placements. Off unless the host said what to do with a
  // paywall — without a handler there is nothing to do with the answer, and
  // firing anyway would spend requests and ledger rows on nobody's behalf.
  private readonly onImplicitPaywall?: RevnixConfig["onImplicitPaywall"];
  private readonly onDeferredDeepLink?: RevnixConfig["onDeferredDeepLink"];
  private readonly onAttribution?: RevnixConfig["onAttribution"];
  private deferredDeepLinkClaimed = false;
  private lastDeepLinkWrite: Promise<void> = Promise.resolve();
  private readonly implicitEnabled: boolean;
  private readonly sessionTimeoutMs: number;
  private implicitConfigPromise: Promise<ReadonlySet<string>> | null = null;
  private implicitConfigRetryAt = 0;
  private lifecycleUnsubscribe: (() => void) | null = null;
  /** The cold-start batch while it runs, resolving to whether it presented a
   *  paywall. A deep link delivered on the first frame — SwiftUI's onOpenURL,
   *  RN's getInitialURL — must wait for it, or the customer gets the launch
   *  paywall AND the link paywall stacked. Null once the batch is over. */
  private launchBatch: Promise<boolean> | null = null;
  /** When the app last went to the BACKGROUND, or null while it has not.
   *  A return after `sessionTimeoutMs` away is a new session; anything sooner
   *  is an app switch. Measured from the background transition, not from the
   *  last return — the latter would mint a session after 35 minutes of
   *  continuous use plus a three-second switch. */
  private lastBackgroundAt: number | null = null;
  /** LOOP GUARD: view ids of displays that came FROM an implicit trigger. A
   *  paywall shown because a paywall was dismissed must not itself fire
   *  `paywall_decline`, or the customer is handed the same screen forever.
   *  Recognised from the placementKey the host reports on logPaywallShown —
   *  a host that reports no placementKey cannot be protected here, which is
   *  why the server keeps its own same-paywall backstop. */
  private readonly implicitViewIds = new Set<string>();
  /** True when this launch generated a fresh anonymous id — the same signal
   *  /v1/installs uses, and independent of the device header (which an app
   *  can turn off entirely). */
  private freshInstall = false;

  constructor(config: RevnixConfig) {
    if (!config.apiKey) throw new Error("Revnix: apiKey is required");
    if (!config.baseUrl) throw new Error("Revnix: baseUrl is required");
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    // REV-204 (L10): a plaintext public base URL ships API keys and
    // entitlements over HTTP. Loopback/private hosts stay allowed — local
    // convex dev and device-to-LAN development legitimately use them.
    if (
      this.baseUrl.startsWith("http://") &&
      !PRIVATE_HTTP_HOST.test(this.baseUrl)
    ) {
      throw new Error(
        "Revnix: baseUrl must be https:// (http:// is only allowed for localhost/private-network development hosts)"
      );
    }
    // M5: web falls back to localStorage automatically; truly memory-only
    // (RN without an adapter) warns and disables install reporting below.
    const resolved = resolveStorage(config.storage);
    this.storage = resolved.storage;
    this.fetchImpl = config.fetch ?? fetch;
    this.reportInstalls = (config.reportInstalls ?? true) && resolved.persistent;
    this.persistentStorage = resolved.persistent;
    this.installMetadata = config.installMetadata;
    this.deviceHeaderPromise = this.buildDeviceHeader(config.device);
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.offlineMaxCacheAgeMs =
      config.offlineMaxCacheAgeMs ?? DEFAULT_OFFLINE_MAX_CACHE_AGE_MS;
    this.entitlementsTtlMs =
      config.entitlementsTtlMs ?? DEFAULT_ENTITLEMENTS_TTL_MS;
    this.onDiagnostic = config.onDiagnostic;
    this.onDeferredDeepLink = config.onDeferredDeepLink;
    this.onAttribution = config.onAttribution;
    this.readYourWritesDelaysMs =
      config.readYourWritesDelaysMs ?? [250, 500, 1000, 2000];
    this.customerIdPromise = this.loadCustomerId(config.customerId);
    // C7: retry any purchases that failed to register on a previous launch, so
    // a paying user never stays locked out because a POST didn't land.
    void this.retryPendingPurchases().catch((err) =>
      this.diag("retryPendingPurchases", err)
    );
    // REV-157: warm the placement cache at launch, so the first paywall of the
    // session can render offline. Fire-and-forget; a failed key just stays on
    // whatever an earlier launch cached.
    for (const key of config.prefetchPlacements ?? []) {
      void this.resolvePlacement(key).catch((err) =>
        this.diag("prefetchPlacement", err)
      );
    }
    // REV-272: the six moments. Started last so a slow /v1/config can never
    // delay the calls above, and fire-and-forget throughout — an implicit
    // paywall that fails to resolve costs the paywall, never the launch.
    this.onImplicitPaywall = config.onImplicitPaywall;
    this.implicitEnabled =
      config.implicitPlacements ?? config.onImplicitPaywall !== undefined;
    this.sessionTimeoutMs =
      config.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    if (this.implicitEnabled) this.startImplicit(config.lifecycle);
  }

  /** The id every call is made as: the stored identified/canonical id, or a
   *  generated-and-persisted anonymous id (rvx_anon_…) on first launch. */
  getCustomerId(): Promise<string> {
    return this.customerIdPromise;
  }

  // C3: identity mutations are server-only — from a device, ANY caller could
  // merge itself into any customer. The server 403s a publishable key; refuse
  // before the network so the failure is deterministic in development (not
  // first discovered on a real login) and the message says what to do.
  //
  // The identity READ is gated the same way (server-side REV-184): the
  // response is an identity graph, and tenants routinely use emails and user
  // ids as customer ids, so a publishable key could walk candidate ids and
  // read back who is a customer. Until REV-259 getIdentity() skipped this
  // check and every device call ended in a 403 the docs never mentioned.
  private requireSecretKey(method: string): void {
    if (this.apiKey.startsWith("rvx_pk_")) {
      throw new RevnixAuthError(
        403,
        `Revnix: ${method}() requires a secret key (rvx_sk_…) and must be ` +
          `called from your backend. A publishable key ships inside the app ` +
          `binary, so it may not read or rewire the identity graph — send ` +
          `the ids to your server and call ${method}() there. Never embed a ` +
          `secret key in the app.`
      );
    }
  }

  /** Merges the current (usually anonymous) customer into `userId`. The
   *  canonical id from the response becomes the id all subsequent calls use.
   *  Safe to call repeatedly — a no-op when already identified as `userId`.
   *
   *  Secret-key only — call this from YOUR BACKEND on login, not from the
   *  device. On a publishable key it throws RevnixAuthError locally, before
   *  any network call: identity merges from a device would let any caller
   *  claim any customer. Device flow: send `getCustomerId()` and your user id
   *  to your server, identify there with an rvx_sk_ key, and the device picks
   *  up the canonical id on its next registerPurchase() (its response always
   *  carries the caller's canonical id). */
  async identify(
    userId: string,
    options?: { strategy?: IdentifyStrategy }
  ): Promise<IdentifyResult> {
    this.requireSecretKey("identify");
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
   *  current customer without switching to it.
   *
   *  Secret-key only, like identify() — throws RevnixAuthError locally on a
   *  publishable key; call it from your backend instead. */
  async alias(aliasId: string): Promise<AliasResult> {
    this.requireSecretKey("alias");
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
    this.ephemeralAnonId = !this.persistentStorage;
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
      // Identity resolution may have merged this device's id away (restore
      // after login), so the server's id is the one to keep using.
      //
      // REV-162: this used to adopt whatever came back, and what came back on
      // a REFUSED claim was the rightful owner's id — so a denied purchase
      // quietly moved this device onto that customer, and the next
      // entitlements read unlocked their subscription. The server now answers
      // the two questions separately: `customerId` is always this caller's own
      // canonical id, and `tokenOwner` (secret-key callers only) says the
      // token belongs to someone else. Following `customerId` is therefore
      // safe in every outcome.
      if (result.customerId !== customerId) {
        await this.setCustomerId(result.customerId);
      }
      // M9: read-your-writes — re-fetch entitlements until the read reflects
      // this purchase (cursor >= seq), warming the C7 cache at exactly the
      // moment it matters. Best-effort: a failure here never fails the
      // purchase (it already registered). Disabled entirely by
      // readYourWritesDelaysMs: [].
      // REV-162: skip the poll when the purchase was recorded against someone
      // else — `seq` is then a position in THEIR stream, which this customer's
      // cursor can never reach, so every delay would be waited out in full
      // before giving up.
      if (this.readYourWritesDelaysMs.length > 0 && !result.ownedByOtherCustomer) {
        await this.waitForEntitlements(result.seq).catch((err) =>
          this.diag("waitForEntitlements", err)
        );
      }
      return result;
    } catch (err) {
      // C7: network/timeout/429/5xx — persist the receipt so the purchase
      // isn't lost, then retry on the next launch / connectivity regain.
      // Idempotent server-side (store.ts purchaseKey), so a later retry or the
      // store webhook never double-counts. Permanent rejections (blocked
      // transfer, bad input, revoked key) are NOT queued — they won't fix
      // themselves. Rethrow either way so the caller can still react now.
      if (worthQueueing(err)) {
        await this.enqueuePurchase(customerId, input);
      }
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
    for (const item of queue) {
      if (this.disposed) return;
      try {
        await this.postPurchase(item.customerId, item.input);
        // Delivered — remove it.
      } catch (err) {
        if (worthQueueing(err)) {
          // REV-200 (M26): a queued purchase that STILL cannot land is the
          // most important background failure there is — report it.
          this.diag("retryPendingPurchases", err);
          continue; // transient — keep for next time
        }
        // Permanent rejection — remove it.
        this.diag("retryPendingPurchases", err);
      }
      // Remove THIS item from the queue as it stands now, not from the
      // snapshot iterated above: each postPurchase can spend seconds in a
      // timeout, and a purchase failing during that window (likely — both
      // happen exactly when the network is bad) enqueues concurrently. A
      // snapshot write-back at the end would silently drop it.
      await this.mutateQueue((current) =>
        current.filter((q) => pendingKey(q.input) !== pendingKey(item.input))
      );
    }
  }

  // REV-199 (CTO-R2 M21): the last fresh network read, held in memory so
  // reads within the soft TTL answer without a round trip — apps gate many
  // screens on isEntitled(), and every one of those was a full request for an
  // answer that had not changed. Stale cache-fallback results are never held
  // here: only a real server read satisfies the TTL.
  private freshEntitlements: {
    customerId: string;
    data: CustomerEntitlements;
    at: number;
  } | null = null;
  // REV-199 (M21): concurrent getEntitlements() calls share one request.
  private inflightEntitlements: {
    customerId: string;
    promise: Promise<CustomerEntitlements>;
  } | null = null;

  /** Current entitlements for this customer, merged across every id linked to
   *  them. Served from memory when a fresh network read is younger than
   *  `entitlementsTtlMs` (REV-199 — pass 0 to disable); otherwise reads the
   *  network (concurrent callers share one request) and caches the result; if
   *  that read FAILS transiently (offline / incident) it falls back to the
   *  last cached entitlements with `stale: true`, so a paying customer is
   *  never shown as unsubscribed just because the network is down. Throws on
   *  a deliberate server rejection (revoked key, …) or when there is nothing
   *  cached. */
  async getEntitlements(): Promise<CustomerEntitlements> {
    const customerId = await this.customerIdPromise;
    const held = this.freshEntitlements;
    if (held && held.customerId === customerId) {
      const age = Date.now() - held.at;
      if (age >= 0 && age < this.entitlementsTtlMs) return held.data;
    }
    if (this.inflightEntitlements?.customerId === customerId) {
      return this.inflightEntitlements.promise;
    }
    const promise = this.fetchEntitlementsWithFallback(customerId);
    this.inflightEntitlements = { customerId, promise };
    const clear = () => {
      if (this.inflightEntitlements?.promise === promise) {
        this.inflightEntitlements = null;
      }
    };
    promise.then(clear, clear);
    return promise;
  }

  /** The authoritative network read: no TTL, no cache fallback — throws so
   *  the caller sees the real failure (waitForEntitlements needs 429s). */
  private async fetchFreshEntitlements(
    customerId: string
  ): Promise<CustomerEntitlements> {
    const fresh = await this.request<CustomerEntitlements>(
      "GET",
      `/v1/customers/${encodeURIComponent(customerId)}/entitlements`
    );
    await this.writeEntitlementsCache(customerId, fresh);
    const result = { ...fresh, stale: false, fetchedAt: Date.now() };
    this.freshEntitlements = { customerId, data: result, at: Date.now() };
    return result;
  }

  private async fetchEntitlementsWithFallback(
    customerId: string
  ): Promise<CustomerEntitlements> {
    try {
      return await this.fetchFreshEntitlements(customerId);
    } catch (err) {
      // REV-198 (CTO-R2 M22): the cache exists to ride out failures that
      // might succeed next time — network, timeout, 429, 5xx. A deliberate
      // server answer (401/403 revoked key, 404, 409) is not an outage, and
      // serving last-known-good over it deleted every kill switch: a revoked
      // key kept unlocking cached entitlements fleet-wide. Non-retryable →
      // the caller hears exactly what the server said.
      if (err instanceof RevnixError && !err.isRetryable) throw err;
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
    const customerId = await this.customerIdPromise;
    let last = await this.getEntitlements();
    for (const delayMs of this.readYourWritesDelaysMs) {
      if (this.disposed || (!last.stale && last.cursor >= seq)) return last;
      // REV-199 (M24): ±20% jitter — promo pushes synchronize a fleet's
      // purchases, and identical delay schedules kept every device's poll in
      // lockstep against our own rate limiter.
      await sleep(jittered(delayMs));
      try {
        // TTL-bypassing read: the whole point of this poll is a FRESH cursor,
        // so the M21 soft-TTL must not answer from memory here.
        last = await this.fetchFreshEntitlements(customerId);
      } catch (err) {
        // REV-199 (M24): the server said exactly how long to back off —
        // honor it instead of fighting our own rate limiter.
        if (err instanceof RevnixRateLimitError && err.retryAfterMs) {
          await sleep(err.retryAfterMs);
        }
        // Transient failure: keep the last read and let the schedule run.
      }
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
    const now = Date.now();
    // REV-198 (M23): fetchedAt was stored but never consulted. A snapshot
    // older than the offline window — or "younger than when it was written"
    // (rolled-back clock) — no longer grants access at all.
    const age = now - (data.fetchedAt ?? now);
    if (
      age > this.offlineMaxCacheAgeMs ||
      age < -CLOCK_ROLLBACK_TOLERANCE_MS
    ) {
      return {
        ...data,
        entitlements: data.entitlements.map((e) =>
          e.isActive ? { ...e, isActive: false } : e
        ),
      };
    }
    const cutoff = now - LOCAL_EXPIRY_GRACE_MS;
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

  /** How the current id resolves: canonical id, alias status, linked ids.
   *
   *  Secret-key only — the response is an identity graph, so the server 403s
   *  a publishable key (REV-184). On an rvx_pk_ key this throws
   *  RevnixAuthError locally, before any network call, like identify(). */
  async getIdentity(): Promise<IdentityInfo> {
    this.requireSecretKey("getIdentity");
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
    const customerId = await this.customerIdPromise;
    try {
      // REV-219: identify the caller so a running experiment on this
      // placement can assign a (sticky, deterministic) variant. Servers
      // without experiments simply ignore the parameter. An EPHEMERAL anon
      // id (memory-only storage — new id every launch) is deliberately NOT
      // sent: each launch would enroll a phantom customer and flip the same
      // user between variants; the server serves the placement default
      // when no customer is identified (same guard class as M5 installs).
      const path = `/v1/placements/${encodeURIComponent(placementKey)}/offering`;
      // REV-268: the device facts ride along so the server can evaluate
      // targeting rules against THIS device on THIS request, and store them
      // as device.* attributes. Not sent for an ephemeral anon id: the server
      // would have no customer to keep them on, and it serves such callers
      // the untargeted default anyway.
      const deviceHeader = this.ephemeralAnonId
        ? null
        : await this.deviceHeaderPromise;
      const fresh = await this.request<PlacementResolution>(
        "GET",
        this.ephemeralAnonId
          ? path
          : `${path}?customer=${encodeURIComponent(customerId)}`,
        undefined,
        deviceHeader ? { [DEVICE_HEADER]: deviceHeader } : undefined
      );
      await this.writePlacementCache(placementKey, fresh, customerId);
      return { ...fresh, stale: false, fetchedAt: Date.now() };
    } catch (err) {
      // REV-198 (M22): same rule as getEntitlements — an unpublished catalog
      // (409) or deleted placement (404) is the server's deliberate answer,
      // and caching over it meant an unpublished paywall kept rendering
      // fleet-wide with no way to pull it.
      if (err instanceof RevnixError && !err.isRetryable) throw err;
      const cached = await this.readPlacementCache(placementKey, customerId);
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
    const customerId = await this.customerIdPromise;
    const cached = await this.readPlacementCache(placementKey, customerId);
    return cached
      ? { ...cached.data, stale: true, fetchedAt: cached.fetchedAt }
      : null;
  }

  /** Report that a paywall was displayed (REV-094). Fire-and-forget like
   *  install reporting — never blocks rendering and never throws; each call
   *  is one view (retries of the same display are deduped by viewId).
   *  RevnixPaywall calls this automatically when given a `client`; headless
   *  paywall UIs call it on their own show event. Powers the analytics
   *  funnel's "Paywall displayed" stage and View → Trial/Paid conversions.
   *
   *  Returns the view id it generated (REV-252). Hold onto it and hand it to
   *  logPaywallClosed when the customer dismisses this display: the pair
   *  sharing one id is what lets the ledger tie a close to the display it
   *  ended, rather than guessing from timestamps. Ignoring the return value
   *  is still valid — it stays a fire-and-forget beacon. */
  logPaywallShown(options?: {
    placementKey?: string;
    paywallId?: string;
  }): string {
    const viewId = generateViewId();
    // REV-272 LOOP GUARD: a display whose placement is one of the six came
    // FROM an implicit trigger, so its dismissal must not fire another one —
    // otherwise "show a win-back when a paywall is declined" hands the
    // customer the same screen until they force-quit. Remembered here rather
    // than asked of the host, because the host already tells us the placement.
    if (
      this.implicitEnabled &&
      options?.placementKey !== undefined &&
      (IMPLICIT_PLACEMENTS as readonly string[]).includes(options.placementKey)
    ) {
      this.implicitViewIds.add(viewId);
    }
    if (options?.placementKey === PREVIEW_PLACEMENT_KEY) return viewId;
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
      .catch((err) => this.diag("logPaywallShown", err));
    return viewId;
  }

  /** Report that the customer dismissed a paywall (REV-252) — the other half
   *  of a display's life. Fire-and-forget and idempotent per view id, exactly
   *  like logPaywallShown.
   *
   *  Pass the id that logPaywallShown returned for THIS display. The two
   *  events then share a view id, so a reader can pair them, and the gap
   *  between their timestamps is the customer's dwell on the screen. Calling
   *  it with a fresh id still records a dismissal; it just cannot be tied
   *  back to the display it ended. RevnixPaywall does all of this for you.
   *
   *  A close is a DECLINE. Do not report one for a display that ended in a
   *  purchase — with implicit placements on, a close is also the
   *  `paywall_decline` moment, and a win-back offer seconds after a successful
   *  purchase is the one thing an operator never means. RevnixPaywall only
   *  reports the close affordances, never a purchase-driven dismissal. */
  logPaywallClosed(
    viewId: string,
    options?: { placementKey?: string; paywallId?: string }
  ): void {
    if (options?.placementKey === PREVIEW_PLACEMENT_KEY) return;
    void this.customerIdPromise
      .then((customerId) =>
        this.request("POST", "/v1/paywalls/closed", {
          customerId,
          viewId,
          occurredAt: Date.now(),
          sdkVersion: SDK_VERSION,
          ...(options?.placementKey ? { placementKey: options.placementKey } : {}),
          ...(options?.paywallId ? { paywallId: options.paywallId } : {}),
        })
      )
      .catch((err) => this.diag("logPaywallClosed", err));
    // REV-272: the dismissal IS the `paywall_decline` moment. No second ledger
    // event — the server reuses the paywall.closed just reported — so this is
    // only the resolve that decides whether anything is attached to it.
    this.fireImplicitFromPaywall("paywall_decline", viewId, options?.paywallId);
  }

  /** Report one of the six paywall interactions (REV-263) — what the customer
   *  DID on a display, between the `logPaywallShown` that opened it and the
   *  `logPaywallClosed` (or purchase) that ended it:
   *
   *    - `selected` — a package was picked
   *    - `purchase_started` — checkout was started
   *    - `purchase_abandoned` — the customer backed out at the store sheet
   *    - `purchase_failed` — the store refused the payment
   *    - `restore` — restore purchases was tapped
   *    - `error` — the paywall itself failed (config, products, render)
   *
   *  Fire-and-forget like the other beacons: never blocks, never throws.
   *
   *  `viewId` is the id `logPaywallShown` returned for THIS display. Passing
   *  it is what threads the whole life of one impression together and puts
   *  the event on the paywall's own analytics row — a fresh id still records
   *  the event, it just cannot be tied back to the display.
   *
   *  RevnixPaywall reports `selected`, `purchase_started`, `restore` and a
   *  no-products `error` for you. The purchase OUTCOME is yours: only the
   *  host performs the store call, so report `purchase_abandoned` /
   *  `purchase_failed` from your own StoreKit / Play error handling — or let
   *  RevnixPaywall do it by returning the outcome from `onPurchase`.
   *
   *  `eventId` is the idempotency key and defaults to the display's `viewId`,
   *  which caps the report at one per display per event type. Pass one per
   *  occurrence (and reuse it across your own retries) to record every
   *  occurrence — e.g. a customer who fails, retries and fails again. */
  logPaywallEvent(
    event: PaywallInteraction,
    viewId: string,
    options?: {
      placementKey?: string;
      paywallId?: string;
      productId?: string;
      /** Store error code — `purchase_failed` / `error`. */
      code?: string;
      message?: string;
      /** Idempotency key for this occurrence; defaults to `viewId`. */
      eventId?: string;
    }
  ): void {
    if (options?.placementKey === PREVIEW_PLACEMENT_KEY) return;
    void this.customerIdPromise
      .then((customerId) =>
        this.request("POST", "/v1/paywalls/events", {
          customerId,
          viewId,
          event,
          occurredAt: Date.now(),
          sdkVersion: SDK_VERSION,
          ...(options?.eventId ? { eventId: options.eventId } : {}),
          ...(options?.placementKey ? { placementKey: options.placementKey } : {}),
          ...(options?.paywallId ? { paywallId: options.paywallId } : {}),
          ...(options?.productId ? { productId: options.productId } : {}),
          ...(options?.code ? { code: options.code } : {}),
          ...(options?.message
            ? { message: options.message.slice(0, 1024) }
            : {}),
        })
      )
      .catch((err) => this.diag("logPaywallEvent", err));
    // REV-272: backing out of the store sheet is the `transaction_abandon`
    // moment. Reuses the paywall.purchase_abandoned event just reported.
    if (event === "purchase_abandoned") {
      this.fireImplicitFromPaywall(
        "transaction_abandon",
        viewId,
        options?.paywallId
      );
    }
  }

  /** REV-272: the two moments that happen ON a paywall, with the loop guard
   *  applied. `fromPaywallId` travels so the server can refuse to hand back
   *  the very paywall being dismissed — the backstop for a host that reports
   *  no placementKey, and for an operator who pointed the rule at the source
   *  paywall by hand. */
  private fireImplicitFromPaywall(
    placement: ImplicitPlacement,
    viewId: string,
    paywallId?: string
  ): void {
    if (this.implicitViewIds.has(viewId)) {
      // One hop, never a chain: this display was itself implicit. The guard
      // is never released: a double-tapped close reports two closes on one
      // id (the server dedupes the event), and releasing on the first would
      // let the second re-enter the loop. The set is bounded by implicit
      // displays per process — a handful of ids, not a leak.
      return;
    }
    this.fireImplicit(placement, {
      fromViewId: viewId,
      ...(paywallId ? { fromPaywallId: paywallId } : {}),
    });
  }

  /** Set attributes on the current customer (REV-033 v2). Attributes are what
   *  A/B-test audiences target, so this is how a mobile-only app becomes able
   *  to run "US + UK users" tests: set `country`, `app_version`, `locale`, or
   *  any custom key you want to segment on.
   *
   *  Pass `null` as a value to delete a key. Awaits the write — unlike the
   *  fire-and-forget telemetry calls — because the very next placement
   *  resolve may depend on it, and silently racing the audience check would
   *  make targeting look broken.
   *
   *  Two server rules to know: `email` and `username` are reserved and only
   *  settable with a secret key from your own backend, and any attribute your
   *  backend already set is authoritative and cannot be changed from a device.
   *  Both throw rather than partially applying. */
  async setAttributes(
    attributes: Record<string, string | number | null>
  ): Promise<void> {
    const customerId = await this.customerIdPromise;
    await this.request(
      "POST",
      `/v1/customers/${encodeURIComponent(customerId)}/attributes`,
      { attributes }
    );
  }

  /** REV-272: hand the SDK the URL that opened your app, from wherever you
   *  already receive it (Linking.getInitialURL / onNewIntent / your router).
   *  This is the one implicit moment the SDK cannot see for itself — the URL
   *  goes to your entry point, and an SDK intercepting it would be fighting
   *  your router.
   *
   *  Fire-and-forget: never blocks, never throws. An ordinary link is
   *  always reported so its `link.*` facts land on the customer; it only
   *  presents a paywall when implicit placements are on AND `deeplink_open`
   *  is configured in the dashboard. A dashboard preview link is always
   *  handed to `onImplicitPaywall`. */
  handleDeepLink(url: string): void {
    const previewToken = PREVIEW_TOKEN_RE.exec(url)?.[1];
    if (previewToken !== undefined) {
      void this.presentPreview(previewToken).catch((err) =>
        this.diag("preview", err)
      );
      return;
    }
    void this.rememberDeepLink(url);
    const extra = { url: url.slice(0, 1024) };
    const batch = this.launchBatch;
    if (batch === null) {
      this.fireImplicit("deeplink_open", extra);
      return;
    }
    // Delivered on the first frame, while the cold-start batch is still
    // deciding what to show: wait for it, and present only if it showed
    // nothing. The moment is still reported either way.
    void batch
      .then((launchPresented) =>
        this.triggerImplicit("deeplink_open", extra, !launchPresented)
      )
      .catch((err) => this.diag("implicit:deeplink_open", err));
  }

  /** Most recent deep link seen via `handleDeepLink` or a delivered
   *  deferred deep link. Null when none recorded. Never throws. */
  async getLastDeepLink(): Promise<LastDeepLink | null> {
    await this.lastDeepLinkWrite;
    try {
      const raw = await this.storage.getItem(LAST_DEEP_LINK_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.url !== "string" ||
        typeof parsed.receivedAt !== "number"
      ) {
        return null;
      }
      return { url: parsed.url, receivedAt: parsed.receivedAt };
    } catch (err) {
      this.diag("getLastDeepLink", err);
      return null;
    }
  }

  /** AT11: the install-attribution verdict for this customer — `null` when
   *  none has been recorded yet (a normal cold-start race, matching the
   *  server's `installMatch: "unknown"`) or when the read fails. Fetches
   *  fresh on every call rather than caching in memory, since the point is
   *  to answer with whatever the server currently believes; a changed
   *  answer also reaches `onAttribution`, so a host that only wants updates
   *  need not call this at all. Never throws. */
  async getAttribution(): Promise<RevnixAttribution | null> {
    if (this.disposed) return null;
    try {
      const customerId = await this.customerIdPromise;
      const verdict = await this.request<AttributionResponse>(
        "GET",
        `/v1/customers/${encodeURIComponent(customerId)}/attribution`
      );
      if (verdict.installMatch === "unknown") return null;
      const attribution = verdict as RevnixAttribution;
      await this.deliverAttribution(attribution);
      return attribution;
    } catch (err) {
      this.diag("getAttribution", err);
      return null;
    }
  }

  private refreshAttribution(): void {
    if (this.onAttribution) void this.getAttribution();
  }

  private async deliverAttribution(attribution: RevnixAttribution): Promise<void> {
    const serialized = JSON.stringify(attribution);
    let cached: string | null = null;
    try {
      cached = await this.storage.getItem(ATTRIBUTION_KEY);
    } catch (err) {
      this.diag("onAttribution", err);
    }
    if (cached === serialized) return;
    try {
      await this.storage.setItem(ATTRIBUTION_KEY, serialized);
    } catch (err) {
      this.diag("onAttribution", err);
    }
    if (this.disposed || !this.onAttribution) return;
    try {
      this.onAttribution(attribution);
    } catch (err) {
      this.diag("onAttribution", err);
    }
  }

  private rememberDeepLink(url: string): Promise<void> {
    const entry: LastDeepLink = { url, receivedAt: Date.now() };
    this.lastDeepLinkWrite = this.lastDeepLinkWrite.then(async () => {
      try {
        await this.storage.setItem(LAST_DEEP_LINK_KEY, JSON.stringify(entry));
      } catch (err) {
        this.diag("rememberDeepLink", err);
      }
    });
    return this.lastDeepLinkWrite;
  }

  private async presentPreview(token: string): Promise<void> {
    await this.launchBatch;
    if (this.disposed) return;
    const resolution = await this.request<PlacementResolution>(
      "GET",
      `/v1/paywalls/preview/${token}`
    );
    if (this.disposed) return;
    if (!this.onImplicitPaywall) {
      this.diag("preview", new Error("no onImplicitPaywall handler configured"));
      return;
    }
    try {
      this.onImplicitPaywall({
        placement: PREVIEW_PLACEMENT_KEY,
        resolution: {
          ...resolution,
          status: "ok",
          revision: resolution.revision ?? 0,
          stale: false,
          fetchedAt: Date.now(),
          skipReason: null,
          recorded: false,
        },
      });
    } catch (err) {
      this.diag("onImplicitPaywall", err);
    }
  }

  /**
   * REV-283: hand over the Android Play Store install referrer.
   *
   * The deferred half of link attribution. A deep link only ever reaches an
   * app that already exists, which leaves out the customers an ad actually
   * won — they saw it, had no app, and installed one. Google Play carries a
   * referrer string through that install, so on Android the answer is exact
   * rather than guessed. (Apple ships no equivalent; that half stays an
   * attribution provider's job.)
   *
   * Read it yourself with the Play Install Referrer library and pass the raw
   * string — `utm_source=instagram&utm_medium=cpc` — exactly as you received
   * it. The SDK cannot read it for you: it is an Android API behind a service
   * binding, and a cross-platform SDK has no business linking it.
   *
   * Safe to call late, and safe to call twice. The Play API answers
   * asynchronously, so the install has usually been reported already; the
   * server absorbs the duplicate and seeds the campaign facts from it anyway.
   * They are fill-only, so a deep link the customer has opened since is never
   * overwritten.
   *
   * Fire-and-forget: never blocks, never throws.
   */
  handleInstallReferrer(referrer: string): void {
    if (this.disposed || referrer.trim().length === 0) return;
    // An id that changes every launch would file the campaign against a
    // customer nobody will see again, and fill the Channel axis with
    // one-launch phantoms. Same guard, same reason, as triggerImplicit.
    if (this.ephemeralAnonId) return;
    void this.customerIdPromise
      .then((customerId) =>
        this.request<InstallResponse>("POST", "/v1/installs", {
          customerId,
          occurredAt: Date.now(),
          sdkVersion: SDK_VERSION,
          installReferrer: referrer.slice(0, 1024),
          ...this.installMetadata,
        })
      )
      .then((body) => {
        this.refreshAttribution();
        return this.deliverDeferredDeepLink(body.deferredDeepLink);
      })
      .catch((err) => this.diag("handleInstallReferrer", err));
  }

  /**
   * AT9: the Apple Search Ads half of install attribution. `AAAttribution
   * .attributionToken()` is an iOS framework call with no JavaScript
   * binding, so a React Native host mints the token in a native module and
   * hands it here — this package cannot mint it itself.
   *
   * Unlike `handleInstallReferrer`, this resolves to the server's verdict
   * (`InstallResponse.appleAttribution`) rather than returning void, because
   * a freshly minted token is unregistered on Apple's side for a few
   * seconds and the server reports that as `"pending"`. The native iOS SDK
   * retries on its own in that case; a host driving this manually needs the
   * verdict to know whether a fresh token on the next cold start is worth
   * trying. `"resolved"` (Apple named a campaign) and `"organic"` (Apple
   * answered, not an ASA install) are final. Resolves to `undefined` when a
   * guard held or the request failed — safe to leave unawaited.
   *
   * Same guards as `handleInstallReferrer`, same reasons: bails when
   * disposed, when the trimmed token is empty, and when `ephemeralAnonId` is
   * set, since an id that changes every launch would file the campaign
   * against a customer nobody will see again.
   */
  handleAttributionToken(token: string): Promise<string | undefined> {
    if (this.disposed || token.trim().length === 0) return Promise.resolve(undefined);
    if (this.ephemeralAnonId) return Promise.resolve(undefined);
    return this.customerIdPromise
      .then((customerId) =>
        this.request<InstallResponse>("POST", "/v1/installs", {
          customerId,
          occurredAt: Date.now(),
          sdkVersion: SDK_VERSION,
          attributionToken: token.slice(0, 2048),
          ...this.installMetadata,
        })
      )
      .then((body) => {
        this.refreshAttribution();
        this.deliverDeferredDeepLink(body.deferredDeepLink);
        return body.appleAttribution;
      })
      .catch((err) => {
        this.diag("handleAttributionToken", err);
        return undefined;
      });
  }

  /** Unwraps a link an email provider rewrote through its click-tracking
   *  domain into the deep link it points at. Never throws; returns `url`
   *  unchanged on any failure. The result can still be an http(s) URL if the
   *  chain could not be unwrapped, so check the scheme before routing on it. */
  async resolveDeepLink(url: string): Promise<string> {
    const trimmed = url.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > 1024 ||
      !/^https?:\/\//i.test(trimmed) ||
      this.disposed
    ) {
      return url;
    }
    try {
      const body = await this.request<{ url: string }>(
        "GET",
        `/v1/links/resolve?url=${encodeURIComponent(trimmed)}`
      );
      return typeof body.url === "string" && body.url.length > 0 ? body.url : url;
    } catch (err) {
      this.diag("resolveDeepLink", err);
      return url;
    }
  }

  private implicitConfig(): Promise<ReadonlySet<string>> {
    if (this.implicitConfigPromise === null && Date.now() < this.implicitConfigRetryAt) {
      return Promise.resolve(new Set<string>());
    }
    return (this.implicitConfigPromise ??= this.customerIdPromise
      .then((customerId) =>
        this.request<{ implicitPlacements?: string[] }>(
          "GET",
          // The id does not change the answer — this route is
          // customer-independent — it only picks the server's rate-limit
          // bucket, so one busy app cannot 429 its own fleet off the feature.
          `/v1/config?customer=${encodeURIComponent(customerId)}`
        )
      )
      .then((body) => new Set(body.implicitPlacements ?? []))
      .catch((err) => {
        this.diag("implicitConfig", err);
        // Not memoised: an offline cold start must not disable every implicit
        // moment for the rest of the session. Retried after a short hold
        // rather than on the very next moment, so an offline burst of paywall
        // interactions costs one probe, not one each.
        this.implicitConfigPromise = null;
        this.implicitConfigRetryAt = Date.now() + IMPLICIT_CONFIG_RETRY_MS;
        return new Set<string>();
      }));
  }

  /** REV-272: report one implicit moment and present whatever it resolves to.
   *  Fire-and-forget in every direction — this runs on an app launch and on
   *  every return to the foreground, so it must never be able to throw into
   *  the host or delay a frame. */
  private fireImplicit(
    placement: ImplicitPlacement,
    extra?: Record<string, string | number>
  ): void {
    void this.triggerImplicit(placement, extra, true).catch((err) =>
      this.diag(`implicit:${placement}`, err)
    );
  }

  /** The trigger itself. Resolves to true when a paywall was handed to the
   *  host. `present` false still reports the moment (its ledger event is a
   *  fact either way) but hands nothing over — how the launch batch keeps a
   *  cold start to ONE paywall. Never throws past its caller's catch. */
  private async triggerImplicit(
    placement: ImplicitPlacement,
    extra: Record<string, string | number> | undefined,
    present: boolean
  ): Promise<boolean> {
    if (this.disposed) return false;
    const configured = this.implicitEnabled
      ? await this.implicitConfig()
      : new Set<string>();
    const resolve = configured.has(placement);
    if (!resolve && placement !== "deeplink_open") return false;
    const customerId = await this.customerIdPromise;
    if (this.disposed || this.ephemeralAnonId) return false;
    const deviceHeader = await this.deviceHeaderPromise;
    const result = await this.request<ImplicitResolution>(
      "POST",
      "/v1/placements/triggered",
      {
        customerId,
        placement,
        // One id per occurrence: retries of the same launch are absorbed,
        // a genuine second launch counts separately. Required server-side
        // for the three moments that append an event.
        occurrenceId: generateViewId(),
        occurredAt: Date.now(),
        sdkVersion: SDK_VERSION,
        ...(resolve ? null : { resolve: false }),
        ...extra,
      },
      deviceHeader ? { [DEVICE_HEADER]: deviceHeader } : undefined
    );
    if (this.disposed || !resolve || !result.paywall || !present)
      return false;
    try {
      this.onImplicitPaywall?.({ placement, resolution: result });
    } catch (err) {
      // The host's presentation code must never take the SDK down.
      this.diag("onImplicitPaywall", err);
    }
    return true;
  }

  private async consumePreviousSessionMs(): Promise<
    Record<string, string | number> | undefined
  > {
    const [startedRaw, lastBgRaw] = await Promise.all([
      this.storage.getItem(SESSION_STARTED_AT_KEY),
      this.storage.getItem(LAST_BACKGROUND_AT_KEY),
    ]);
    const started = Number.parseInt(startedRaw ?? "", 10);
    const lastBg = Number.parseInt(lastBgRaw ?? "", 10);
    const extra =
      Number.isFinite(started) &&
      Number.isFinite(lastBg) &&
      lastBg >= started
        ? { previousSessionMs: lastBg - started }
        : undefined;
    await this.storage.setItem(SESSION_STARTED_AT_KEY, String(Date.now()));
    return extra;
  }

  /** REV-272: the launch-time moments, plus the foreground listener that
   *  `session_start` is built on.
   *
   *  A cold start is always both a launch AND a session — an operator who
   *  configured only `session_start` still wants the first one — and it is an
   *  install too when this launch generated the anonymous id. All three are
   *  independent placements, so an app may have any subset configured and the
   *  others cost nothing. */
  private startImplicit(configured: RevnixConfig["lifecycle"]): void {
    // freshInstall is set inside loadCustomerId, which the constructor kicked
    // off but did not await — so read it after that promise settles rather
    // than now, when it is still false on a genuine first launch.
    //
    // The three launch moments run SEQUENTIALLY, most specific first, and only
    // the first that resolves to a paywall is handed to the host. All three
    // are still reported — a launch is a launch whether or not a paywall
    // showed — but an app that configured all three must not have three
    // paywalls pushed onto its first frame.
    // Subscribed BEFORE the batch, which can take a full network timeout per
    // moment when offline: a customer who backgrounds the app during that
    // window and comes back an hour later is a session, and missing the
    // background transition would lose it.
    if (configured !== false) {
      const lifecycle: RevnixLifecycle | null =
        configured ?? browserLifecycle();
      if (lifecycle) {
        try {
          this.lifecycleUnsubscribe = lifecycle.onStateChange((state) =>
            this.onAppState(state)
          );
        } catch (err) {
          // A broken adapter costs session detection, not the client.
          this.diag("lifecycleSubscribe", err);
        }
      }
    }

    const sessionExtra = this.consumePreviousSessionMs().catch(
      (err: unknown) => {
        this.diag("session", err);
        return undefined;
      }
    );
    this.launchBatch = this.customerIdPromise
      .then(async () => {
        if (this.disposed) return false;
        let presented = false;
        const moments: ImplicitPlacement[] = [
          ...(this.freshInstall ? (["app_install"] as const) : []),
          "app_launch",
          "session_start",
        ];
        for (const placement of moments) {
          const shown: boolean = await this.triggerImplicit(
            placement,
            placement === "session_start" ? await sessionExtra : undefined,
            !presented
          ).catch((err: unknown) => {
            this.diag(`implicit:${placement}`, err);
            return false;
          });
          presented ||= shown;
        }
        return presented;
      })
      .catch((err) => {
        this.diag("implicitLaunch", err);
        return false;
      })
      .finally(() => {
        this.launchBatch = null;
      });
  }

  private onAppState(state: RevnixAppState): void {
    if (this.disposed) return;
    if (state === "background") {
      // First report wins: a platform that repeats "background" (a paused
      // Activity re-reporting) must not keep resetting the clock forward.
      if (this.lastBackgroundAt === null) {
        const now = Date.now();
        this.lastBackgroundAt = now;
        try {
          void Promise.resolve(
            this.storage.setItem(LAST_BACKGROUND_AT_KEY, String(now))
          ).catch((err) => this.diag("session", err));
        } catch (err) {
          this.diag("session", err);
        }
      }
      return;
    }
    const since = this.lastBackgroundAt;
    this.lastBackgroundAt = null;
    // A foreground with no background before it is the launch itself, which
    // the batch above already counted — or a duplicate report.
    if (since === null) return;
    // An app switch is not a session.
    if (Date.now() - since >= this.sessionTimeoutMs) {
      // A new session is also when the memoised config is re-asked: the
      // server promises an operator's change shows up within ~30s, and a
      // process backgrounded for days would otherwise keep firing a moment
      // the operator turned off — or never fire one they turned on — until
      // the next cold start.
      this.implicitConfigPromise = null;
      void this.consumePreviousSessionMs()
        .catch((err) => {
          this.diag("session", err);
          return undefined;
        })
        .then((extra) => this.fireImplicit("session_start", extra));
    }
  }

  /** REV-204 (L10): stop this client's background work (purchase retries,
   *  read-your-writes polls). Called automatically when Revnix.configure()
   *  replaces the singleton; call it yourself when discarding a manually
   *  constructed client. */
  dispose(): void {
    this.disposed = true;
    // REV-272: a replaced client (dev fast-refresh re-running configure())
    // would otherwise keep a foreground listener alive and mint a session on
    // every return alongside its successor.
    this.lifecycleUnsubscribe?.();
    this.lifecycleUnsubscribe = null;
  }

  /** A block paywall reporting a paint string it could not read. Routed to the
   *  same sink as every other swallowed failure, so a host that already wired
   *  `onDiagnostic` needs no new wiring to see render fallbacks. */
  reportRenderDiagnostic(message: string): void {
    this.diag("paywall.render", new Error(message));
  }

  // REV-200 (M26): record one background failure. Never throws.
  private diag(op: string, error: unknown): void {
    this.bgFailures += 1;
    try {
      this.onDiagnostic?.({ op, error, at: Date.now() });
    } catch {
      // The reporter itself must never take the SDK down.
    }
  }

  private async deliverDeferredDeepLink(link: unknown): Promise<void> {
    if (this.disposed || !this.onDeferredDeepLink || this.deferredDeepLinkClaimed) return;
    if (typeof link !== "object" || link === null) return;
    const { url, match } = link as { url?: unknown; match?: unknown };
    if (typeof url !== "string" || (match !== "exact" && match !== "probabilistic")) return;
    this.deferredDeepLinkClaimed = true;
    let delivered: string | null = null;
    try {
      delivered = await this.storage.getItem(DEFERRED_DEEP_LINK_DELIVERED_KEY);
    } catch (err) {
      this.diag("onDeferredDeepLink", err);
    }
    if (delivered !== null) return;
    try {
      await this.storage.setItem(DEFERRED_DEEP_LINK_DELIVERED_KEY, "1");
    } catch (err) {
      this.diag("onDeferredDeepLink", err);
    }
    if (this.disposed) return;
    void this.rememberDeepLink(url);
    try {
      this.onDeferredDeepLink(url, match);
    } catch (err) {
      this.diag("onDeferredDeepLink", err);
    }
  }

  private async loadCustomerId(initial?: string): Promise<string> {
    // REV-204 (L10): a throwing storage adapter (quota, corruption) used to
    // reject customerIdPromise FOREVER — every subsequent API call then
    // failed on the await of an id that exists in memory. Storage problems
    // are reported (M26) and survived; the id lives on for the session.
    if (initial) {
      try {
        await this.storage.setItem(CUSTOMER_ID_KEY, initial);
      } catch (err) {
        this.diag("storageWrite", err);
      }
      return initial;
    }
    let stored: string | null = null;
    try {
      stored = await this.storage.getItem(CUSTOMER_ID_KEY);
    } catch (err) {
      this.diag("storageRead", err);
    }
    if (stored) return stored;
    const anonymousId = generateAnonymousId();
    this.ephemeralAnonId = !this.persistentStorage;
    // REV-272: what makes `app_install` an install rather than a launch.
    this.freshInstall = true;
    try {
      await this.storage.setItem(CUSTOMER_ID_KEY, anonymousId);
    } catch (err) {
      this.diag("storageWrite", err);
    }
    // A freshly generated id IS the install signal: first launch on this
    // device (or a reinstall that wiped storage). logout() deliberately does
    // not report — a new anonymous session is not a new install.
    if (this.reportInstalls) this.reportInstall(anonymousId);
    return anonymousId;
  }

  /** Fire-and-forget install report (REV-093). Never blocks startup and
   *  never throws — the backend absorbs retries idempotently per id. */
  private reportInstall(customerId: string): void {
    void this.request<InstallResponse>("POST", "/v1/installs", {
      customerId,
      occurredAt: Date.now(),
      sdkVersion: SDK_VERSION,
      ...this.installMetadata,
    })
      .then((body) => {
        if (!this.ephemeralAnonId) this.refreshAttribution();
        return this.deliverDeferredDeepLink(body.deferredDeepLink);
      })
      .catch((err) => this.diag("reportInstall", err));
  }

  /** REV-268: assemble and encode the device facts once. Runtime-detected
   *  facts first, the app's `device` over them, then the three the SDK owns.
   *  `installedAt` is the first launch this storage ever saw — written on
   *  that launch and read back on every later one — and `firstOpen` is true
   *  for the whole of that first session. Both are skipped on non-persistent
   *  storage: memory-only storage would make every launch a first open,
   *  which is the same phantom-new-customer hazard the M5 install guard
   *  exists for. */
  private async buildDeviceHeader(
    configured: DeviceFacts | false | undefined
  ): Promise<string | null> {
    if (configured === false) return null;
    const facts: DeviceFacts = {
      ...detectDeviceFacts(),
      // Pre-REV-268 apps described the device for the install report only;
      // those two facts are still true facts, so they count.
      ...(this.installMetadata?.platform !== undefined
        ? { platform: this.installMetadata.platform }
        : {}),
      ...(this.installMetadata?.appVersion !== undefined
        ? { appVersion: this.installMetadata.appVersion }
        : {}),
      ...(configured ?? {}),
    };
    let installedAt: number | undefined;
    let firstOpen: boolean | undefined;
    if (this.persistentStorage) {
      try {
        const stored = await this.storage.getItem(INSTALLED_AT_KEY);
        const parsed = stored === null ? NaN : Number(stored);
        if (Number.isFinite(parsed) && parsed > 0) {
          installedAt = parsed;
          firstOpen = false;
        } else {
          installedAt = Date.now();
          firstOpen = true;
          await this.storage.setItem(INSTALLED_AT_KEY, String(installedAt));
        }
      } catch (err) {
        // Storage trouble costs the two SDK-owned facts, nothing else.
        this.diag("storageWrite", err);
        installedAt = undefined;
        firstOpen = undefined;
      }
    }
    return encodeDeviceHeader(
      compactPayload({
        ...facts,
        sdkVersion: SDK_VERSION,
        installedAt,
        firstOpen,
      })
    );
  }

  /** REV-268: the decoded facts this client sends — for tests and for apps
   *  that want to show what Revnix knows. `null` when disabled. */
  async getDeviceHeader(): Promise<string | null> {
    return this.deviceHeaderPromise;
  }

  private async setCustomerId(customerId: string): Promise<void> {
    // Callers pass stable ids (identify/canonical adoption) — logout()
    // re-flags its generated anon id itself.
    this.ephemeralAnonId = false;
    this.customerIdPromise = Promise.resolve(customerId);
    await this.storage.setItem(CUSTOMER_ID_KEY, customerId);
  }

  // ——— C7: entitlement cache (best-effort; storage failures never throw) ———

  // REV-204 (L10): the cache used to be single-slot — writing customer B
  // dropped customer A, so the first offline launch after identify()/logout()
  // had no gate at all. It is a small per-customer map now (legacy single-slot
  // payloads migrate on read); ENTITLEMENTS_CACHE_MAX bounds it because
  // logout() mints a fresh anonymous id every time.
  private async readEntitlementsMap(): Promise<
    Record<string, { data: CustomerEntitlements; fetchedAt: number }>
  > {
    try {
      const raw = await this.storage.getItem(ENTITLEMENTS_CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      // Pre-REV-204 single-slot shape: { customerId, data, fetchedAt }.
      if ("customerId" in parsed && "data" in parsed) {
        const legacy = parsed as {
          customerId: string;
          data: CustomerEntitlements;
          fetchedAt: number;
        };
        return {
          [legacy.customerId]: {
            data: legacy.data,
            fetchedAt: legacy.fetchedAt,
          },
        };
      }
      return parsed as Record<
        string,
        { data: CustomerEntitlements; fetchedAt: number }
      >;
    } catch (err) {
      this.diag("storageRead", err);
      return {};
    }
  }

  private async writeEntitlementsCache(
    customerId: string,
    data: CustomerEntitlements
  ): Promise<void> {
    try {
      const map = await this.readEntitlementsMap();
      map[customerId] = { data, fetchedAt: Date.now() };
      const ids = Object.keys(map);
      if (ids.length > ENTITLEMENTS_CACHE_MAX) {
        ids
          .sort((a, b) => (map[a]?.fetchedAt ?? 0) - (map[b]?.fetchedAt ?? 0))
          .slice(0, ids.length - ENTITLEMENTS_CACHE_MAX)
          .forEach((id) => delete map[id]);
      }
      await this.storage.setItem(ENTITLEMENTS_CACHE_KEY, JSON.stringify(map));
    } catch (err) {
      // Caching is best-effort — a failure to persist must never break a
      // read. REV-200 (M26): but a broken storage adapter is exactly the
      // fleet-wide failure that used to produce pure silence — report it.
      this.diag("storageWrite", err);
    }
  }

  private async readEntitlementsCache(
    customerId: string
  ): Promise<{ data: CustomerEntitlements; fetchedAt: number } | null> {
    const map = await this.readEntitlementsMap();
    return map[customerId] ?? null;
  }

  // ——— REV-157: placement cache (best-effort; storage failures never throw) ———
  // One JSON map keyed by placementKey. A resolution WITHOUT an experiment is
  // app-scoped and servable to any customer; one WITH an experiment embeds
  // the assigned variant (offering/paywall/experiment) and belongs to the
  // customer it was fetched for — reads treat it as a miss for anyone else
  // (REV-219; the "stamp + check ownership on read" idiom of
  // freshEntitlements). Entries are not cleared on logout/identify so the
  // common no-experiment offline paywall keeps working across identity
  // changes.

  private async readPlacementMap(): Promise<
    Record<
      string,
      { data: PlacementResolution; fetchedAt: number; customerId?: string }
    >
  > {
    try {
      const raw = await this.storage.getItem(PLACEMENTS_CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<
            string,
            {
              data: PlacementResolution;
              fetchedAt: number;
              customerId?: string;
            }
          >)
        : {};
    } catch {
      return {};
    }
  }

  private async readPlacementCache(
    placementKey: string,
    customerId: string
  ): Promise<{ data: PlacementResolution; fetchedAt: number } | null> {
    const map = await this.readPlacementMap();
    const entry = map[placementKey];
    if (!entry) return null;
    // An experiment-assigned resolution must never cross customers — the
    // wrong variant (and its pricing) would be shown and the purchase
    // attributed to an assignment the server never made for this caller.
    // Pre-REV-219 entries carry no customerId and no experiment; they pass.
    if (
      entry.data.experiment != null &&
      entry.customerId !== undefined &&
      entry.customerId !== customerId
    ) {
      return null;
    }
    return entry;
  }

  private async writePlacementCache(
    placementKey: string,
    data: PlacementResolution,
    customerId: string
  ): Promise<void> {
    try {
      const map = await this.readPlacementMap();
      map[placementKey] = { data, fetchedAt: Date.now(), customerId };
      await this.storage.setItem(PLACEMENTS_CACHE_KEY, JSON.stringify(map));
    } catch (err) {
      // Best-effort, but reported (REV-200 M26).
      this.diag("storageWrite", err);
    }
  }

  // ——— C7: persisted purchase retry queue ———

  // Serializes every queue read-modify-write. Storage adapters may be async,
  // so two interleaved mutations (an enqueue during the retry pass, retry
  // passes from constructor + a manual call) would otherwise clobber each
  // other's writes and lose purchases.
  private queueLock: Promise<void> = Promise.resolve();

  private mutateQueue(
    mutate: (queue: PendingPurchase[]) => PendingPurchase[]
  ): Promise<void> {
    const run = this.queueLock.then(async () => {
      const queue = await this.readPurchaseQueue();
      const next = mutate(queue);
      if (next !== queue) await this.writePurchaseQueue(next);
    });
    // The chain must survive a failed mutation or every later one deadlocks.
    this.queueLock = run.catch(() => {});
    return run;
  }

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
    } catch (err) {
      // Best-effort, but reported (REV-200 M26) — a queue that cannot
      // persist is a purchase that will not survive a restart.
      this.diag("storageWrite", err);
    }
  }

  private enqueuePurchase(
    customerId: string,
    input: RegisterPurchaseInput
  ): Promise<void> {
    // Repeated failures of the same purchase collapse to one queued entry.
    return this.mutateQueue((queue) =>
      queue.some((q) => pendingKey(q.input) === pendingKey(input))
        ? queue
        : [...queue, { customerId, input }]
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    // C7: abort the request after requestTimeoutMs so a slow or dead backend
    // can't hang the app. AbortController is guarded for very old runtimes.
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.requestTimeoutMs)
      : undefined;

    // REV-200 (M26): piggyback the background-failure counter on this
    // request so field pain reaches the backend's request logs. Cleared only
    // for the count actually sent, and only on a delivered response —
    // failures that pile up mid-flight ride the next one.
    const reportedBgFailures = this.bgFailures;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          // L3: identify the SDK on EVERY request (reads included) so the
          // backend can triage by version without depending on body fields.
          "X-Revnix-SDK": `revnix-react/${SDK_VERSION}`,
          ...(reportedBgFailures > 0
            ? { "X-Revnix-Bg-Failures": String(reportedBgFailures) }
            : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(extraHeaders ?? {}),
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

    // The counter reached the server (any HTTP status is a delivery).
    this.bgFailures = Math.max(0, this.bgFailures - reportedBgFailures);

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    // REV-204 (L10): a 200 with a non-JSON body used to come back as
    // `undefined as T` — registerPurchase then threw a TypeError AFTER the
    // server had already recorded the purchase. Fail as a typed, retryable
    // error instead (a proxy/captive portal mangling the body is transient).
    if (res.ok && parsed === undefined) {
      throw new RevnixError(
        0,
        `Revnix: server returned a non-JSON response for ${path}`
      );
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
