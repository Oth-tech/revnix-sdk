// Response and input types for the Revnix /v1 API. These mirror the shapes
// returned by convex/http.ts in revnix-app — the backend is the source of
// truth; update here when the API surface changes.

export type Environment = "sandbox" | "production";
export type Store = "apple" | "google";

export interface RevnixConfig {
  /** API key issued from the Revnix dashboard — publishable (rvx_pk_live_… /
   *  rvx_pk_test_…, safe on-device) or secret (rvx_sk_…, server-side only;
   *  required for identify/alias). Legacy rvx_live_…/rvx_test_… keys have
   *  full access. The key fixes both the app and the environment server-side. */
  apiKey: string;
  /** Convex site URL of the Revnix deployment, e.g. https://xyz.convex.site */
  baseUrl: string;
  /** CTO-SCALE-REVIEW M9: retry delays for the read-your-writes poll after
   *  registerPurchase (entitlements re-fetched until the read's cursor
   *  reflects the purchase). Pass [] to disable. Default [250,500,1000,2000]. */
  readYourWritesDelaysMs?: number[];
  /** Persistent key-value storage for the customer id. Pass an adapter over
   *  MMKV/AsyncStorage in React Native; defaults to in-memory (ids reset on
   *  every app launch — fine for tests, wrong for production). */
  storage?: RevnixStorage;
  /** Start as this customer instead of generating/loading an anonymous id. */
  customerId?: string;
  /** Custom fetch implementation (tests, polyfills). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Report an install (POST /v1/installs) when a fresh anonymous id is
   *  generated — powers the dashboard's Installs / install-conversion charts.
   *  Fire-and-forget; never blocks startup. Defaults to true. */
  reportInstalls?: boolean;
  /** Optional device context attached to the install report. */
  installMetadata?: { platform?: string; appVersion?: string };
  /** C7: per-request timeout in ms (AbortController-based). Defaults to 10000.
   *  A slow or dead backend then fails fast with RevnixTimeoutError instead of
   *  hanging the app until the OS TCP timeout (60–120s+). */
  requestTimeoutMs?: number;
  /** REV-157: placement keys to resolve-and-cache at construction (fire and
   *  forget, never blocks startup), so the session's first paywall can render
   *  from cache even when the device is offline by the time it is shown. */
  prefetchPlacements?: string[];
  /** REV-198 (M23): how old a cached entitlements snapshot may be and still
   *  grant access when served offline. Beyond this (or when the device clock
   *  sits BEFORE the snapshot was written — a rollback), cached entitlements
   *  are served inactive. Default 14 days. */
  offlineMaxCacheAgeMs?: number;
  /** REV-199 (M21): soft TTL on entitlement reads — a fresh network read
   *  younger than this answers getEntitlements()/isEntitled() from memory,
   *  so gating several screens costs one request, not one each. Pass 0 for
   *  the old always-fetch behavior. Default 30000. */
  entitlementsTtlMs?: number;
  /** REV-200 (M26): called whenever a background operation fails — purchase
   *  retries, placement prefetch, install/paywall reporting, storage
   *  read/writes. These were all silent (`catch(() => {})`), so a fleet
   *  failing BEFORE the server (DNS block, broken storage adapter) produced
   *  no signal anywhere. Wire this to your crash/analytics reporter. Must
   *  not throw; exceptions from it are swallowed. */
  onDiagnostic?: (event: RevnixDiagnostic) => void;
}

/** REV-200 (M26): one background failure. */
export interface RevnixDiagnostic {
  /** Which background operation failed, e.g. "retryPendingPurchases",
   *  "prefetchPlacement", "reportInstall", "logPaywallShown",
   *  "waitForEntitlements", "storageWrite", "storageRead". */
  op: string;
  error: unknown;
  /** Unix ms. */
  at: number;
}

export interface RevnixStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

// ——— POST /v1/purchases ———

export interface RegisterPurchaseInput {
  source: Store;
  /** Apple: originalTransactionId · Google: purchaseToken. */
  token: string;
  productId: string;
  transactionId: string;
  /** Unix ms. Defaults server-side to registration time. */
  occurredAt?: number;
  /** Unix ms subscription expiry, when the client knows it. */
  expiresAt?: number;
  /** Raw store payload to retain in the ledger for reprocessing. */
  rawPayload?: unknown;
  /** iOS only — the JWS StoreKit 2 hands you on every transaction
   *  (`VerificationResult.jwsRepresentation`). Send it and the purchase is
   *  proven: Revnix verifies it against Apple's certificate chain, checks it
   *  names this exact transaction, and records a full purchase.
   *
   *  Without it the purchase is accepted but PROVISIONAL — a publishable key
   *  ships inside your app binary, so an unproven claim is only an assertion.
   *  A provisional purchase still grants the entitlement, for a short window,
   *  and is promoted automatically when Apple's or Google's own notification
   *  confirms the charge. Always send it if you can; apps that enable
   *  "require store-verified purchases" reject claims that lack it. */
  signedTransactionInfo?: string;
  /** REV-261: which paywall sold it. Pass the `viewId` `logPaywallShown`
   *  returned for the display the customer bought from and the server
   *  resolves it to that view's paywall and placement, so per-paywall
   *  analytics credit the purchase (and every renewal on it) exactly.
   *  Without it the server attributes the purchase to the customer's last
   *  paywall view inside the previous 24 hours. */
  viewId?: string;
  /** Explicit paywall / placement; each wins over the view's when sent. */
  paywallId?: string;
  placementKey?: string;
}

export interface RegisterPurchaseResult {
  eventId: string;
  /** Ledger position of the write — read-your-writes is assertable (ADR 0004). */
  seq: number;
  /** True when the store webhook already recorded this purchase. */
  duplicate: boolean;
  /** The id THIS caller should use going forward — its own canonical id.
   *  Differs from the id you sent only when identity resolution merged it
   *  away, so following it is always safe. */
  customerId: string;
  /** True when the store token belongs to a different customer than the
   *  caller: the purchase was recorded against them, not you. Safe for every
   *  caller — it reports the outcome without naming anyone. */
  ownedByOtherCustomer?: boolean;
  /** Which customer holds the token, when it is not you. Present only for
   *  secret-key callers — a publishable key learns the outcome above but
   *  never another customer's id. */
  tokenOwner?: string;
  /** True when the token was reassigned TO this caller. */
  transferred: boolean;
  /** Set when an identity side-effect (a transfer, or absorbing an imported
   *  history) was refused because the claim carried no proof. Send
   *  `signedTransactionInfo`, or register from your server with a secret
   *  key. */
  refused?: "unverified-claim";
  /** True when this transaction was already in the ledger — a StoreKit
   *  replay or restore, not a new sale. */
  restored?: boolean;
  /** True when the purchase was recorded without store proof: the entitlement
   *  is live but time-boxed until the store confirms the charge. Send
   *  `signedTransactionInfo` (iOS) to avoid it. */
  provisional?: boolean;
}

// ——— GET /v1/customers/{id}/entitlements ———

export interface EntitlementSource {
  kind: "subscription" | "grant";
  key: string;
  isActive: boolean;
  expiresAt?: number;
}

export interface Entitlement {
  entitlementId: string;
  isActive: boolean;
  expiresAt?: number;
  sources: EntitlementSource[];
}

export interface CustomerEntitlements {
  customerId: string;
  /** Ledger cursor this read reflects. */
  cursor: number;
  entitlements: Entitlement[];
  /** C7 (SDK-populated): true when this was served from the local cache
   *  because the live read failed (offline / incident) — a paying customer is
   *  shown as subscribed from cache rather than as unsubscribed. false on a
   *  fresh server read. */
  stale?: boolean;
  /** C7 (SDK-populated): unix ms these entitlements were fetched/cached. */
  fetchedAt?: number;
}

// ——— POST /v1/identify · POST /v1/customers/{id}/alias ———

export type IdentifyStrategy = "merge" | "block";

export interface IdentifyResult {
  canonicalId: string;
  merged: boolean;
}

export interface AliasResult {
  canonicalId: string;
  aliased: boolean;
}

// ——— GET /v1/customers/{id}/identity ———

export interface IdentityInfo {
  canonicalId: string;
  isAlias: boolean;
  anonymous: boolean;
  linkedIds?: string[];
}

// ——— GET /v1/placements/{key}/offering ———

export interface PlacementPackage {
  packageId: string;
  productId: string;
  metadata?: Record<string, unknown>;
  product: PlacementProduct | null;
}

export interface PlacementProduct {
  productId: string;
  displayName: string;
  entitlementIds: string[];
  prices?: Array<{
    store: Store | "stripe";
    currency: string;
    amountMinor: number;
  }>;
  metadata?: Record<string, unknown>;
}

export interface PlacementOffering {
  offeringId: string;
  displayName: string;
  metadata?: Record<string, unknown>;
  packages: PlacementPackage[];
}

// REV-028: remote paywall design attached to a placement. Render contract —
// the app draws this with its own components; prices still come from the
// store (StoreKit / Play Billing) so the display never disagrees with the
// charge.
export interface PaywallConfig {
  /** Layout — the screen structure RevnixPaywall renders. The dashboard's
   *  template gallery is presets over these layouts; the first three are the
   *  original templates and render exactly as before. */
  template:
    | "focus"
    | "feature-list"
    | "minimal"
    | "hero"
    | "timeline"
    | "plans"
    | "feature-grid"
    | "offer"
    | "reveal";
  /** Color scheme the paywall renders in. Absent (legacy config) = dark.
   *  The host app's explicit `theme` prop still overrides either scheme. */
  mode?: "dark" | "light";
  headline: string;
  subheadline?: string;
  features: Array<{ icon?: string; title: string; description?: string }>;
  ctaLabel: string;
  /** packageId of the visually highlighted package. */
  highlightPackageId?: string;
  /** Badge on the highlighted package, e.g. "SAVE 17%". */
  badgeText?: string;
  /** Accent hex like "#6478ff"; fall back to the app theme when absent. */
  accent?: string;
  /** Hero image URL rendered above the headline in place of the icon tile. */
  heroImageUrl?: string;
  /** Social proof, dashboard-configured. Any layout renders the pieces that
   *  are set: stars/quote card above the packages, `count` under the CTA. */
  review?: {
    /** 0–5; rendered as a star row. */
    rating?: number;
    quote?: string;
    author?: string;
    /** e.g. "Join 2M+ users" — small line under the CTA. */
    count?: string;
  };
  /** Win-back/offer presentation: anchor price struck through on the
   *  highlighted package, urgency line above the CTA. Any layout. */
  offer?: {
    strikethroughPrice?: string;
    urgencyText?: string;
  };
  /** Footer links, dashboard-configured. Absent (legacy config) = show all
   *  three. When a URL is set the SDK opens it directly; otherwise the host
   *  app's onTerms/onPrivacy handler runs. */
  footer?: {
    showRestore: boolean;
    showTerms: boolean;
    showPrivacy: boolean;
    termsUrl?: string;
    privacyUrl?: string;
  };
  /** A designed paywall: the block tree the dashboard's builder authored.
   *  When present RevnixPaywall renders THIS and the fields above act as the
   *  fallback for clients that predate block rendering — so an older app
   *  keeps showing a sane classic screen instead of nothing. Typed as the
   *  block document in "revnix-react/ui"; the core entrypoint keeps it opaque
   *  so non-UI consumers pull in no renderer types. */
  blocks?: unknown;
}

export interface PlacementPaywall {
  paywallId: string;
  name: string;
  config: PaywallConfig;
}

export interface PlacementResolution {
  status: "ok";
  placementKey: string;
  revision: number;
  placementMetadata?: Record<string, unknown>;
  offering: PlacementOffering | null;
  paywall: PlacementPaywall | null;
  /** REV-219: the A/B test serving this resolution — set when the customer
   *  is enrolled in an experiment on this placement (the offering/paywall
   *  above are the assigned variant's). Null when no experiment applies.
   *  Assignment is sticky per customer, survives identity merges, and the
   *  enrollment is recorded as an `experiment.enrolled` ledger event. */
  experiment: { key: string; variantId: string } | null;
  /** REV-157 (SDK-populated): true when this was served from the local cache
   *  because the live read failed (offline / incident) — the paywall renders
   *  the last published resolution rather than not at all. false on a fresh
   *  server read. */
  stale?: boolean;
  /** REV-157 (SDK-populated): unix ms this resolution was fetched/cached. */
  fetchedAt?: number;
}
