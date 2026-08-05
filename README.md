# revnix-react

Revnix SDK for React Native / JavaScript. Pure TypeScript over the Revnix
`/v1` REST API — no native modules, no dependencies. Pairs with
`react-native-iap` (or any StoreKit 2 / Play Billing wrapper) for purchases.
Ships CJS + ESM (tree-shakeable); every request carries an
`X-Revnix-SDK: revnix-react/<version>` header (`SDK_VERSION` is exported).

## Install

```sh
npm install revnix-react
```

## Setup

```ts
import { Revnix } from "revnix-react";
import { MMKV } from "react-native-mmkv";

const mmkv = new MMKV();

Revnix.configure({
  apiKey: "rvx_pk_test_…",                     // dashboard → Settings → API keys
  baseUrl: "https://<deployment>.convex.site", // Convex site URL
  storage: {
    getItem: (k) => mmkv.getString(k) ?? null,
    setItem: (k, v) => mmkv.set(k, v),
  },
});
```

`Revnix.configure()` returns the `RevnixClient`; afterwards `Revnix.client`
is available anywhere (it throws if used before `configure`). Re-running
`configure()` disposes the previous client first (stopping its retry drain,
prefetches, and read-your-writes polls — safe under dev fast-refresh). You
can also construct `new RevnixClient(config)` directly; call `dispose()` when
you discard one.

### API keys

The dashboard issues two kinds of key, and the key fixes the app **and**
environment server-side — a test key can never write into production:

- **Publishable** `rvx_pk_live_…` / `rvx_pk_test_…` — safe to embed in the
  app. Can read entitlements/identity, register its own purchases, and report
  installs and paywall views.
- **Secret** `rvx_sk_live_…` / `rvx_sk_test_…` — server-side only, never in
  an app binary. Additionally allowed to call `identify()` and `alias()`
  (plus the server-only grants/attributes endpoints).

Calling a secret-gated method with a publishable key fails with
`RevnixAuthError` (403). Legacy `rvx_live_…`/`rvx_test_…` keys still work and
have full access.

### Config options

| Option | Default | What it does |
|---|---|---|
| `apiKey` (required) | — | Sent as `Authorization: Bearer <key>` |
| `baseUrl` (required) | — | Deployment site URL; trailing slashes stripped. Must be `https://` — `http://` is allowed only for localhost/private-network dev hosts (`localhost`, `127.*`, `10.*`, `192.168.*`, `172.16-31.*`, `[::1]`) |
| `storage` | auto | Persistent adapter; see below |
| `customerId` | — | Start as this customer instead of loading/generating an anonymous id |
| `requestTimeoutMs` | `10000` | Per-request timeout; slow/dead backend fails fast with `RevnixTimeoutError` |
| `readYourWritesDelaysMs` | `[250, 500, 1000, 2000]` | Post-purchase entitlement re-fetch schedule; `[]` disables |
| `entitlementsTtlMs` | `30000` | In-memory soft TTL on `getEntitlements()`/`isEntitled()`: a server read younger than this answers repeat calls from memory. `0` restores always-fetch |
| `offlineMaxCacheAgeMs` | 14 days | Max age of a cache-served entitlements snapshot; older snapshots serve every entitlement as `isActive: false` |
| `reportInstalls` | `true` | `POST /v1/installs` on first launch (forced off on non-persistent storage) |
| `installMetadata` | — | `{ platform?, appVersion? }` attached to the install report |
| `prefetchPlacements` | — | Placement keys resolved-and-cached at construction (fire-and-forget), so the session's first paywall renders even offline |
| `onDiagnostic` | — | Callback invoked on every swallowed background failure (retry drains, prefetches, install/paywall reports, storage errors); see Diagnostics |
| `fetch` | global fetch | Custom fetch (tests, polyfills) |

**Storage:** pass a persistent `storage` adapter (MMKV/AsyncStorage on React
Native). On the web, omitting it automatically falls back to `localStorage`.
If neither is available the SDK runs memory-only: it still works, but it
warns loudly and **disables install reporting** — otherwise every launch
would look like a new anonymous customer and inflate your install metrics
(prior purchases would also not be attached across launches). A storage
adapter that *throws* never breaks the client either: reads/writes are
guarded, the failure is reported via `onDiagnostic`, and the customer id
survives in memory for the session. `memoryStorage()` is exported for tests.

Anonymous ids (`rvx_anon_…`) are minted with `crypto.getRandomValues` — there
is deliberately no `Math.random` fallback. On runtimes without WebCrypto,
polyfill `globalThis.crypto` or pass an explicit `customerId`.

## Identity

```ts
// on-device (publishable key):
await Revnix.client.getCustomerId();   // rvx_anon_… until identified
await Revnix.client.logout();           // fresh anonymous customer

// server-side only (secret rvx_sk_ key — throws locally on a publishable key):
await revnix.identify(user.uid);        // on login — merges anonymous history
```

- `identify(userId, { strategy })` — `"merge"` (default) folds the anonymous
  history into the identified customer; `"block"` refuses when both ids
  already have history. No-op (no network call) when already identified as
  that id. **Requires a secret or legacy key** — on a publishable key the SDK
  throws `RevnixAuthError` locally, before any network call; run it from your
  backend instead and let the device pick up the canonical id on its next
  `registerPurchase()`/`getIdentity()`.
- `alias(aliasId)` — attach an alternate id to the current customer (the
  alias must be a fresh id; use `identify()` to merge existing customers).
  Also secret-gated.
- `getIdentity()` — resolves the current id's identity cluster:
  `{ canonicalId, isAlias, anonymous, linkedIds }`.
- `logout()` — generates a fresh anonymous customer locally (never merges,
  never re-reports an install).

## Purchases

Set `appAccountToken` (iOS) / `obfuscatedAccountIdAndroid` to the Revnix
customer id when requesting the purchase, then register it:

```ts
import { purchaseInputFromIap, PurchaseBlockedError } from "revnix-react";

// in your purchaseUpdatedListener, before finishTransaction:
try {
  await Revnix.client.registerPurchase(
    purchaseInputFromIap(purchase, Platform.OS === "ios" ? "apple" : "google")
  );
} catch (err) {
  if (err instanceof PurchaseBlockedError) {
    // token belongs to another account and the app forbids transfer
  }
  throw err;
}
```

Registration and the store's own webhook share an idempotency key — whichever
arrives first wins, the other becomes a no-op. On Apple, `purchaseInputFromIap`
extracts the StoreKit 2 JWS from `jwsRepresentation` (or `purchaseToken`,
shape-checked), prefers the JWS payload's own `originalTransactionId` as the
token, and sends the JWS as `signedTransactionInfo` automatically — so
purchases registered through the helper arrive *proven*, not provisional,
with no extra work. Google purchases map to
`token = transactionId = purchaseToken` (deliberately — it matches the
webhook's purchase key, not the Play `orderId`).

**Offline resilience:** if registration fails for a *transient* reason
(network, timeout, 429, 5xx) the purchase is persisted to a retry queue and
the error is rethrown; the queue drains automatically on the next app launch
(or call `retryPendingPurchases()` yourself). Permanent rejections — 400 bad
input, 401/403 auth, and `PurchaseBlockedError` (409) — are never queued, and
one that slipped into the queue earlier is drained on the next retry pass.
Repeated failures of the same purchase collapse to one queue entry.

**Read-your-writes:** after a successful `registerPurchase` the SDK re-fetches
entitlements until the response's ledger cursor covers the purchase — so
`getEntitlements()` / `isEntitled()` right after buying never show
pre-purchase state, and the offline cache is warm at exactly the moment it
matters. Tune or disable via `readYourWritesDelaysMs` (pass `[]` to disable).
Each delay gets ±20% jitter, a 429's `Retry-After` is honored as extra sleep,
and every poll bypasses the entitlements soft TTL so it always reads the
server. The poll is skipped when the token turned out to belong to another
customer, and it resolves with the last read when the schedule runs out — it
never throws from the schedule itself. For out-of-band grants (e.g. your
server granted an entitlement and returned its `seq`),
`waitForEntitlements(seq)` runs the same poll on demand.

`customerId` in the result is **the id this caller should use going forward** —
its own canonical id. It differs from the one you sent only when identity
resolution merged that id away (a restore after login), so the SDK follows it
and persists it.

When the token belongs to someone else, that is reported separately and the
SDK stays where it is: `ownedByOtherCustomer: true`, plus `tokenOwner` naming
the holder for secret-key callers only — a publishable key learns the outcome
but never another customer's id. `transferred: true` means the token was
reassigned *to you*.

**Store proof — send `signedTransactionInfo`.** A publishable key ships inside
your app binary, so "this device bought pro.monthly" is an assertion until a
store backs it. Pass StoreKit 2's
`VerificationResult.jwsRepresentation` as `signedTransactionInfo` and the
purchase is proven: Revnix verifies it against Apple's certificate chain and
checks that it names this exact transaction.

```ts
await Revnix.client.registerPurchase({
  source: "apple",
  token: transaction.originalID,
  transactionId: transaction.id,
  productId: transaction.productID,
  expiresAt: transaction.expirationDate,
  signedTransactionInfo: verificationResult.jwsRepresentation, // ← proof
});
```

Without proof the purchase is still accepted, but the result carries
`provisional: true`: the entitlement is granted for a short window rather than
the full period, and no revenue is recorded, until Apple's or Google's own
notification for the charge confirms it — which normally happens within
seconds and promotes the purchase automatically. On Google there is no
client-side receipt; if you have connected Play credentials, Revnix verifies
the purchase token directly with Play instead, and a token Play rejects is
refused with `403`. Once your installed base sends proof, an app can require
it outright (`projects.setRequirePurchaseProof`), after which unproven
registrations get `403` rather than a provisional grant.

**Transfer trust (server-side):** the backend only honors a transfer (or an
imported-history merge) for a claim it can verify — a secret `rvx_sk_…` key,
or that same `signedTransactionInfo`. A publishable-key registration without
proof still binds a *free* token, but a token bound to another customer stays
put and the response carries `refused: "unverified-claim"` — with your own
customer id untouched, so a refused claim never moves the device onto the
rightful owner's identity.

## Entitlements & placements

```ts
const { entitlements, cursor } = await Revnix.client.getEntitlements();
const pro = await Revnix.client.isEntitled("pro");
const { offering, paywall } = await Revnix.client.resolvePlacement("paywall_main");
```

`getEntitlements()` is network-first with an **offline cache**: on success the
response is cached (per customer id — snapshots for up to 4 customers are
kept, oldest evicted, so an offline launch right after `identify()`/`logout()`
still has a gate) and returned with `stale: false`. On a *transient* failure
(offline, timeout, 429, 5xx) the last cached snapshot is returned with
`stale: true` and its original `fetchedAt`; a deliberate server rejection
(401/403/404/409 — e.g. a revoked key) is **always rethrown, cache or not**,
so the cache never defeats a kill switch. It only throws on transient
failures when there is nothing cached. `isEntitled()` goes through the same
path, so entitlement gates keep working offline. `getCachedEntitlements()`
reads the cache without touching the network (returns `null` when empty) —
useful for instant startup gating.

**Soft TTL & coalescing:** a server read younger than `entitlementsTtlMs`
(default 30 s) answers repeat `getEntitlements()`/`isEntitled()` calls from
memory with no request, and concurrent calls share one in-flight request —
so a screen full of entitlement gates costs one fetch. Set
`entitlementsTtlMs: 0` to always hit the network; `waitForEntitlements()`
and the post-purchase poll always bypass the TTL. Practical consequence:
out-of-band entitlement changes (a webhook-driven grant or revoke) become
visible within ~30 s, not instantly.

**Local expiry grace:** cache-served entitlements are re-evaluated against the
device clock — an entitlement whose `expiresAt` passed more than **3 days**
ago is served as `isActive: false`, so a long-lapsed subscription never stays
active offline forever. Within those 3 days it stays active (the auto-renewal
an offline device cannot see yet). Independently of per-entitlement expiry, a
cached snapshot older than `offlineMaxCacheAgeMs` (default **14 days**) — or
one that appears to be from the *future* because the device clock rolled back
more than 5 minutes — is served with every entitlement inactive, so even a
lifetime grant cannot be farmed by keeping a device offline forever. Fresh
server reads are authoritative and never re-evaluated.

`resolvePlacement(placementKey)` resolves the latest *published* catalog
revision. Both `offering` and `paywall` are nullable — guard before rendering
(a placement can exist with nothing attached, and an unpublished environment
is an error).

**Placements are offline-safe too:** each successful `resolvePlacement` caches
its resolution (per placement key); when the live read fails *transiently*
the cached copy is returned with `stale: true`, so the paywall renders the
last published version rather than not at all — it only throws when nothing
is cached. Deliberate answers pass through the cache: a deleted placement
(404) or an unpublished environment (409) still throws, so a pulled paywall
stays pulled.
`getCachedPlacement(placementKey)` reads that cache with no network call, and
`prefetchPlacements` (config) warms it at app start.

## Diagnostics

The SDK swallows failures it can recover from (retry-queue drains, placement
prefetches, install and paywall-view reports, storage read/write errors) —
`onDiagnostic` surfaces them: it is called with `{ op, error, at }` for every
such failure (ops: `retryPendingPurchases`, `prefetchPlacement`,
`waitForEntitlements`, `reportInstall`, `logPaywallShown`, `storageRead`,
`storageWrite`); exceptions thrown by your callback are swallowed. The count
of background failures since the last report also rides the next request as
an `X-Revnix-Bg-Failures: <n>` header, so the backend can see silent client
pain without any app-side wiring. One related guard: a 200 response with a
non-JSON body (captive portal, misbehaving proxy) throws a *retryable*
`RevnixError` instead of returning garbage.

## Errors

All API errors extend `RevnixError` (`status` + `isRetryable`, which is true
for status 0, 429, and 5xx):

| Class | Status | When |
|---|---|---|
| `RevnixTimeoutError` | 0 | Request exceeded `requestTimeoutMs` |
| `RevnixNetworkError` | 0 | fetch failed (offline, DNS, TLS) |
| `RevnixAuthError` | 401/403 | Bad/revoked key, or publishable key on a secret-gated endpoint |
| `PurchaseBlockedError` | 409 | Purchase token owned by another customer, transfers blocked |
| `RevnixRateLimitError` | 429 | Rate limited; `retryAfterMs` when the server sent `Retry-After` |
| `RevnixError` | other | Anything else; message from the server's `error` field |

## Rendering the paywall (React Native)

`RevnixPaywall` renders a published paywall design exactly as the dashboard
paywall builder previews it — template, accent color, hero image, badge,
highlighted package, and feature list all come from the placement's
`paywall.config`. The app supplies localized store prices (StoreKit / Play
Billing) and the purchase handlers, so the display never disagrees with the
charge.

```tsx
import { RevnixPaywall } from "revnix-react/ui";

const { paywall, offering } = await Revnix.client.resolvePlacement("paywall_main");
if (!paywall || !offering) return null; // both are nullable — guard first

<RevnixPaywall
  config={paywall.config}
  packages={offering.packages.map((pkg) => ({
    packageId: pkg.packageId,
    title: pkg.product?.displayName ?? pkg.productId,
    priceLabel: storePriceFor(pkg.productId), // localized, from the store
  }))}
  onPurchase={(packageId) => startPurchase(packageId)}
  loading={purchasing}
  onRestore={restorePurchases}
  onTerms={openTerms}
  onPrivacy={openPrivacy}
  client={Revnix.client}                 // auto-reports paywall.viewed on mount
  placementKey="paywall_main"
/>;
```

- Pass `client` to report a `paywall.viewed` event once per mount (opt out
  with `disableViewTracking`); or call `client.logPaywallShown()` yourself —
  it's fire-and-forget and never throws.
- Theming: dark by default, `config.mode: "light"` switches to the light
  theme; override any token via the `theme` prop
  (`DEFAULT_PAYWALL_THEME` / `LIGHT_PAYWALL_THEME` are exported).
- Selection can be controlled (`selectedPackageId` + `onSelectPackage`) or
  left internal (defaults to the highlighted package).

The `/ui` entrypoint is separate from the core so pure-JS consumers never
load `react` / `react-native` (both are peer dependencies used only by `/ui`).

## Endpoints used

| Method | Endpoint | Key |
|---|---|---|
| `registerPurchase` | `POST /v1/purchases` | any |
| `getEntitlements` / `waitForEntitlements` | `GET /v1/customers/{id}/entitlements` | any |
| `getIdentity` | `GET /v1/customers/{id}/identity` | any |
| `resolvePlacement` | `GET /v1/placements/{key}/offering` | any |
| install report | `POST /v1/installs` | any |
| `logPaywallShown` | `POST /v1/paywalls/viewed` | any |
| `identify` | `POST /v1/identify` | secret |
| `alias` | `POST /v1/customers/{id}/alias` | secret |

## Development

```sh
npm install
npm test
npm run build   # CJS + ESM (dist/ and dist/esm/)
```
