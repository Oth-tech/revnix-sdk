# revnix-react

Revnix SDK for React Native / JavaScript. Pure TypeScript over the Revnix
`/v1` REST API, no native modules, no dependencies. Pairs with
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
read-your-writes polls, implicit triggers and foreground listener, safe under
dev fast-refresh). You
can also construct `new RevnixClient(config)` directly; call `dispose()` when
you discard one.

### API keys

The dashboard issues two kinds of key, and the key fixes the app **and**
environment server-side; a test key can never write into production:

- **Publishable** `rvx_pk_live_…` / `rvx_pk_test_…`: safe to embed in the
  app. Can read entitlements, register its own purchases, report installs and
  paywall views/closes, and set non-reserved attributes.
- **Secret** `rvx_sk_live_…` / `rvx_sk_test_…`: server-side only, never in
  an app binary. Additionally allowed to call `identify()`, `alias()` and
  `getIdentity()` (the identity graph is server-only), plus the server-only
  grants/attributes endpoints.

Calling a secret-gated method with a publishable key fails with
`RevnixAuthError` (403). Legacy `rvx_live_…`/`rvx_test_…` keys still work and
have full access.

### Config options

| Option | Default | What it does |
|---|---|---|
| `apiKey` (required) | n/a | Sent as `Authorization: Bearer <key>` |
| `baseUrl` (required) | n/a | Deployment site URL; trailing slashes stripped. Must be `https://`, `http://` is allowed only for localhost/private-network dev hosts (`localhost`, `127.*`, `10.*`, `192.168.*`, `172.16-31.*`, `[::1]`) |
| `storage` | auto | Persistent adapter; see below |
| `customerId` | n/a | Start as this customer instead of loading/generating an anonymous id |
| `requestTimeoutMs` | `10000` | Per-request timeout; slow/dead backend fails fast with `RevnixTimeoutError` |
| `readYourWritesDelaysMs` | `[250, 500, 1000, 2000]` | Post-purchase entitlement re-fetch schedule; `[]` disables |
| `entitlementsTtlMs` | `30000` | In-memory soft TTL on `getEntitlements()`/`isEntitled()`: a server read younger than this answers repeat calls from memory. `0` restores always-fetch |
| `offlineMaxCacheAgeMs` | 14 days | Max age of a cache-served entitlements snapshot; older snapshots serve every entitlement as `isActive: false` |
| `reportInstalls` | `true` | `POST /v1/installs` on first launch (forced off on non-persistent storage) |
| `installMetadata` | n/a | `{ platform?, appVersion? }` attached to the install report (superseded by `device`) |
| `device` | detected | `{ platform?, osVersion?, appVersion?, locale?, currency?, storefront?, model?, sandbox? }` sent with every placement resolve as `X-Revnix-Device`, evaluated by targeting rules on that request and stored as `device.*` attributes. Browser detects platform/OS/locale; React Native apps pass what `react-native-device-info` gives them. `false` disables |
| `prefetchPlacements` | n/a | Placement keys resolved-and-cached at construction (fire-and-forget), so the session's first paywall renders even offline |
| `onDiagnostic` | n/a | Callback invoked on every swallowed background failure (retry drains, prefetches, install/paywall reports, storage errors); see Diagnostics |
| `fetch` | global fetch | Custom fetch (tests, polyfills) |
| `onImplicitPaywall` | n/a | Handler for implicit placement moments (`app_launch`, `session_start`, etc.), configured in the dashboard |
| `implicitPlacements` | whether `onImplicitPaywall` is set | Explicit off switch for implicit placements, even when `onImplicitPaywall` is set |
| `onDeferredDeepLink` | n/a | Delivers the link the customer clicked before install, at most once. Since 1.2.2 |
| `onAttribution` | n/a | Fires after the first-launch install report and whenever the install-attribution verdict changes. Turns on the background fetch for it (unreleased: ships in the release after 1.2.3) |
| `lifecycle` | `visibilitychange` listener in a browser, nothing under React Native | How the SDK learns the app came to the foreground; `false` disables foreground detection |
| `sessionTimeoutMs` | `1800000` (30 minutes) | How long the app must be backgrounded before the return counts as a new session |

`getDeviceHeader()` returns the encoded `X-Revnix-Device` value this client
sends, or `null` when `device: false`.

**Storage:** pass a persistent `storage` adapter (MMKV/AsyncStorage on React
Native). On the web, omitting it automatically falls back to `localStorage`.
If neither is available the SDK runs memory-only: it still works, but it
warns loudly and **disables install reporting**; otherwise every launch
would look like a new anonymous customer and inflate your install metrics
(prior purchases would also not be attached across launches). A storage
adapter that *throws* never breaks the client either: reads/writes are
guarded, the failure is reported via `onDiagnostic`, and the customer id
survives in memory for the session. `memoryStorage()` is exported for tests.

Anonymous ids (`rvx_anon_…`) are minted with `crypto.getRandomValues`; there
is deliberately no `Math.random` fallback. On runtimes without WebCrypto,
polyfill `globalThis.crypto` or pass an explicit `customerId`.

## Identity

```ts
// on-device (publishable key):
await Revnix.client.getCustomerId();   // rvx_anon_… until identified
await Revnix.client.logout();           // fresh anonymous customer

// server-side only (secret rvx_sk_ key, throws locally on a publishable key):
import { RevnixClient } from "revnix-react";

const revnix = new RevnixClient({
  apiKey: process.env.REVNIX_SECRET_KEY!,      // rvx_sk_…
  baseUrl: "https://<deployment>.convex.site",
  customerId: deviceCustomerId,                // what the device sent from getCustomerId()
  reportInstalls: false,
});
await revnix.identify(user.uid);        // on login, merges anonymous history
```

Pass the device's id in as `customerId`: without it the server-side client
generates its own anonymous id and merges that instead, so the device's
history is never merged. Build one client per request.

- `identify(userId, { strategy })`: `"merge"` (default) folds the anonymous
  history into the identified customer; `"block"` refuses when both ids
  already have history. No-op (no network call) when already identified as
  that id. **Requires a secret or legacy key**, on a publishable key the SDK
  throws `RevnixAuthError` locally, before any network call; run it from your
  backend instead and let the device pick up the canonical id on its next
  `registerPurchase()` (its response always carries the caller's canonical id).
- `alias(aliasId)`: attach an alternate id to the current customer (the
  alias must be a fresh id; use `identify()` to merge existing customers).
  Also secret-gated.
- `getIdentity()`: resolves the current id's identity cluster:
  `{ canonicalId, isAlias, anonymous, linkedIds }`. **Also secret-gated**:
  the response is an identity graph, so the server refuses publishable keys
  and the SDK throws `RevnixAuthError` locally on one, before any network call.
- `logout()`: generates a fresh anonymous customer locally (never merges,
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

Registration and the store's own webhook share an idempotency key; whichever
arrives first wins, the other becomes a no-op. On Apple, `purchaseInputFromIap`
extracts the StoreKit 2 JWS from `jwsRepresentation` (or `purchaseToken`,
shape-checked), prefers the JWS payload's own `originalTransactionId` as the
token, and sends the JWS as `signedTransactionInfo` automatically, so
purchases registered through the helper arrive *proven*, not provisional,
with no extra work. Google purchases map to
`token = transactionId = purchaseToken` (deliberately: it matches the
webhook's purchase key, not the Play `orderId`).

**Offline resilience:** if registration fails for a *transient* reason
(network, timeout, 429, 5xx) the purchase is persisted to a retry queue and
the error is rethrown; the queue drains automatically on the next app launch
(or call `retryPendingPurchases()` yourself). Permanent rejections, 400 bad
input, 401/403 auth, and `PurchaseBlockedError` (409), are never queued, and
one that slipped into the queue earlier is drained on the next retry pass.
Repeated failures of the same purchase collapse to one queue entry.

**Read-your-writes:** after a successful `registerPurchase` the SDK re-fetches
entitlements until the response's ledger cursor covers the purchase, so
`getEntitlements()` / `isEntitled()` right after buying normally include the
purchase, and the offline cache is warm at exactly the moment it
matters. Tune or disable via `readYourWritesDelaysMs` (pass `[]` to disable).
Each delay gets ±20% jitter, a 429's `Retry-After` is honored as extra sleep,
and every poll bypasses the entitlements soft TTL so it always reads the
server. The poll is skipped when the token turned out to belong to another
customer, and it resolves with the last read when the schedule runs out, it
never throws from the schedule itself. For out-of-band grants (e.g. your
server granted an entitlement and returned its `seq`),
`waitForEntitlements(seq)` runs the same poll on demand.

`customerId` in the result is **the id this caller should use going forward**, its own canonical id. It differs from the one you sent only when identity
resolution merged that id away (a restore after login), so the SDK follows it
and persists it.

When the token belongs to someone else, that is reported separately and the
SDK stays where it is: `ownedByOtherCustomer: true`, plus `tokenOwner` naming
the holder for secret-key callers only, a publishable key learns the outcome
but never another customer's id. `transferred: true` means the token was
reassigned *to you*.

**Store proof, send `signedTransactionInfo`.** A publishable key ships inside
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
notification for the charge confirms it, which normally happens within
seconds and promotes the purchase automatically. On Google there is no
client-side receipt; if you have connected Play credentials, Revnix verifies
the purchase token directly with Play instead, and a token Play rejects is
refused with `403`. Once your installed base sends proof, an app can require
it outright (`projects.setRequirePurchaseProof`), after which unproven
registrations get `403` rather than a provisional grant.

**Transfer trust (server-side):** the backend only honors a transfer (or an
imported-history merge) for a claim it can verify: a secret `rvx_sk_…` key,
or that same `signedTransactionInfo`. A publishable-key registration without
proof still binds a *free* token, but a token bound to another customer stays
put and the response carries `refused: "unverified-claim"`, with your own
customer id untouched, so a refused claim never moves the device onto the
rightful owner's identity.

## Entitlements & placements

```ts
const { entitlements, cursor } = await Revnix.client.getEntitlements();
const pro = await Revnix.client.isEntitled("pro");
const { offering, paywall } = await Revnix.client.resolvePlacement("paywall_main");
```

`getEntitlements()` is network-first with an **offline cache**: on success the
response is cached (per customer id, snapshots for up to 4 customers are
kept, oldest evicted, so an offline launch right after `identify()`/`logout()`
still has a gate) and returned with `stale: false`. On a *transient* failure
(offline, timeout, 429, 5xx) the last cached snapshot is returned with
`stale: true` and its original `fetchedAt`; a deliberate server rejection
(401/403/404/409, e.g. a revoked key) is **always rethrown, cache or not**,
so the cache never defeats a kill switch. It only throws on transient
failures when there is nothing cached. `isEntitled()` goes through the same
path, so entitlement gates keep working offline. `getCachedEntitlements()`
reads the cache without touching the network (returns `null` when empty), useful for instant startup gating.

**Soft TTL & coalescing:** a server read younger than `entitlementsTtlMs`
(default 30 s) answers repeat `getEntitlements()`/`isEntitled()` calls from
memory with no request, and concurrent calls share one in-flight request; so a screen full of entitlement gates costs one fetch. Set
`entitlementsTtlMs: 0` to always hit the network; `waitForEntitlements()`
and the post-purchase poll always bypass the TTL. Practical consequence:
out-of-band entitlement changes (a webhook-driven grant or revoke) become
visible within ~30 s, not instantly.

**Local expiry grace:** cache-served entitlements are re-evaluated against the
device clock, an entitlement whose `expiresAt` passed more than **3 days**
ago is served as `isActive: false`, so a long-lapsed subscription never stays
active offline forever. Within those 3 days it stays active (the auto-renewal
an offline device cannot see yet). Independently of per-entitlement expiry, a
cached snapshot older than `offlineMaxCacheAgeMs` (default **14 days**), or
one that appears to be from the *future* because the device clock rolled back
more than 5 minutes, is served with every entitlement inactive, so even a
lifetime grant cannot be farmed by keeping a device offline forever. Fresh
server reads are authoritative and never re-evaluated.

`resolvePlacement(placementKey)` resolves the latest *published* catalog
revision. Both `offering` and `paywall` are nullable; guard before rendering
(a placement can exist with nothing attached, and an unpublished environment
is an error).

**Placements are offline-safe too:** each successful `resolvePlacement` caches
its resolution (per placement key); when the live read fails *transiently*
the cached copy is returned with `stale: true`, so the paywall renders the
last published version rather than not at all; it only throws when nothing
is cached. Deliberate answers pass through the cache: a deleted placement
(404) or an unpublished environment (409) still throws, so a pulled paywall
stays pulled.
`getCachedPlacement(placementKey)` reads that cache with no network call, and
`prefetchPlacements` (config) warms it at app start.

## Implicit placements

Six placements resolve without a `resolvePlacement` call: `app_install`,
`app_launch`, `session_start`, `deeplink_open`, `paywall_decline` and
`transaction_abandon` are moments the SDK recognises itself, so an operator
can attach a paywall to any of them from the dashboard with no release. Five
need no app code; `deeplink_open` needs the `handleDeepLink` call shown
below on native (the web SDK reports the landing URL itself, see below;
unreleased: ships in the release after 1.2.3). **Off by default**: passing
`onImplicitPaywall` is what turns
them on; without it the SDK makes no extra requests for the other five
moments, though `handleDeepLink` always sends its one report regardless.
With `onImplicitPaywall` set, the SDK asks `GET /v1/config` once at
construction and fires for the moments the dashboard has configured plus
`session_start`, which the server always lists so every app records
`session.started`; an app that configured nothing costs one cached
`/v1/config` response per launch and one `session_start` trigger per
session.

```ts
Revnix.configure({
  apiKey, baseUrl, storage,
  onImplicitPaywall: ({ placement, resolution }) => present(resolution),
  // session_start needs foreground detection. A browser is handled for you
  // (visibilitychange); React Native passes an adapter over AppState.
  lifecycle: {
    onStateChange: (handler) => {
      const sub = AppState.addEventListener("change", (s) =>
        handler(s === "active" ? "foreground" : "background"));
      return () => sub.remove();
    },
  },
});

// deeplink_open is the one moment the SDK cannot see itself: the URL
// reaches your router.
Linking.getInitialURL().then((url) => url && Revnix.client.handleDeepLink(url));
Linking.addEventListener("url", ({ url }) => Revnix.client.handleDeepLink(url));
```

`getInitialURL()` is the cold start (the link that launched a closed app);
the `url` event is a link arriving while the app is already running. Run
both once, at module scope, not inside a component effect that can remount
(StrictMode runs effects twice in development). A full JS reload (dev
reload, an OTA update) makes `getInitialURL()` return the same URL again,
and `handleDeepLink` would report that open twice.

On the web (`document` present) the SDK does this step itself (unreleased:
ships in the release after 1.2.3; on 1.2.3 call
`handleDeepLink(window.location.href)` yourself): a landing URL whose query
carries `utm_*` or `revnix_link` is reported once at construction, no host
code needed. Call `handleDeepLink` yourself only for client-side navigations
or for URLs without those params. A call with the
same landing URL is skipped once so it doesn't double-report; anything
after that reports normally.

`handleDeepLink` also recognises the dashboard's QR/link preview
(`…?revnix_preview=<token>`) and routes it through the same
`onImplicitPaywall` handler with `placement: "revnix_preview"`, no extra
wiring needed. Purchases are disabled on that display: `RevnixPaywall`
(classic or designed) shows an alert instead of calling `onPurchase`, and no
paywall view/close/interaction is sent to analytics for it. A host rendering
`RevnixBlockPaywall` directly, without `RevnixPaywall`, is not covered: it
takes no `placementKey` and has no way to know the display is a preview.

The SDK never presents for you; it does not own your navigation stack. You
get the same `PlacementResolution` as `resolvePlacement` returns. When you
render it, **pass `resolution.placementKey` to `RevnixPaywall` /
`logPaywallShown`**: that marks the display as implicit, which is the only
thing that stops a `paywall_decline` paywall from firing `paywall_decline`
again when dismissed. A cold start hands you at most one paywall (install →
launch → session, first that resolves wins), and a deep link on the first
frame waits for that decision. A close is a decline: never report one for a
display that ended in a purchase. `sessionTimeoutMs` (default 30 min) is how
long the app must be backgrounded for the return to count as a session.

## Deferred deep links

A click on a Revnix link (`https://<deployment>.convex.site/l/<token>`,
created on the Links page) sends Android to Google Play with the link's query
string as the install referrer, iOS to the App Store, and desktop to the
link's fallback URL, and remembers every non-Android click for the link's
click window (1 hour by default, set per link). `POST /v1/installs` (fired
automatically on first launch) can come back with the link the install
matched: exact on Android, from that install referrer; probabilistic on iOS,
from a same-network click or impression within the link's window, so it can
be wrong on a shared network. Only a link whose scheme
matches your app's configured URL scheme is ever returned. Pass
`onDeferredDeepLink` to get it, delivered at most once per install; route the
URL yourself, optionally also through `handleDeepLink` for `deeplink_open`
paywall rules:

```ts
Revnix.configure({
  apiKey, baseUrl, storage,
  onDeferredDeepLink: (url, match) => router.push(url),
});
```

On Android, the same link can also arrive later through the Play Install
Referrer service; read it yourself and hand the raw string to
`Revnix.client.handleInstallReferrer(referrer)`, which also feeds the
`deferredDeepLink` response into the same `onDeferredDeepLink` handler.

An email service provider (Mailchimp, SendGrid) rewrites links through its
own click-tracking domain before your customer ever sees them; pass those
through `resolveDeepLink` first, then to your router and `handleDeepLink`:

```ts
const url = await Revnix.client.resolveDeepLink(clickedUrl);
router.push(url);
Revnix.client.handleDeepLink(url);
```

A failure (bad input, network error) hands the URL back unchanged. The
result can still be an http(s) URL if the chain could not be unwrapped, so
check the scheme before routing on it.

## Apple Search Ads attribution

iOS-only, and only for a host that mints its own token: `AAAttribution
.attributionToken()` is an iOS framework call with no JavaScript binding, so
this package cannot read it for you. Mint it in a native module and hand the
raw string to `Revnix.client.handleAttributionToken(token)`, which reports it
alongside the install and resolves to Apple's verdict:

```ts
const verdict = await Revnix.client.handleAttributionToken(token);
```

- `"resolved"`: Apple named a Search Ads campaign. Final.
- `"organic"`: Apple answered, but this was not an ASA install. Final.
- `"pending"`: a freshly minted token is unregistered on Apple's side for a
  few seconds; worth minting a fresh token and retrying on the next cold
  start.

Safe to leave unawaited: it never throws, and resolves to `undefined` if
the client is disposed, the token is blank, storage is memory-only, or the
request failed.

## Install attribution

Unreleased: `getAttribution()` and `onAttribution` ship in the release after
1.2.3. On 1.2.3, call `GET /v1/customers/{id}/attribution` yourself.

`GET /v1/customers/{id}/attribution` returns the install-attribution verdict
for the current customer: `installMatch` (`"referrer"` / `"click"` /
`"impression"` / `"organic"`), `attributedAt`, the campaign facts frozen at
that judgment (`source`, `medium`, `campaign`, `term`, `content`), the
evidence behind it (`referrerSource`, `matchSignals`), `linkToken`, and
`reattributedAt` when a later signal re-attributed the customer.

```ts
const attribution = await Revnix.client.getAttribution();
```

`null` means no install has been recorded yet (a normal cold-start race) or
the request failed. Pass `onAttribution` to be told about it instead of
polling: it fires after the first-launch install report resolves and after
`handleInstallReferrer` / `handleAttributionToken`, whenever the verdict
differs from the last one delivered (persisted, so an unchanged verdict never
fires twice). The SDK does not poll: call `getAttribution()` (e.g. at launch)
to pick up a later re-attribution, which also fires `onAttribution` when it
changed.

```ts
Revnix.configure({
  apiKey, baseUrl, storage,
  onAttribution: (attribution) => analytics.setUserProperties(attribution),
});
```

The SDK never fetches attribution on its own unless `onAttribution` is set.

## Ad revenue

Unreleased: ships in the release after 1.2.3. On 1.2.3, call
`POST /v1/ad-revenue` yourself.

```ts
Revnix.client.logAdRevenue({ revenue: 0.0032, currency: "USD", network: "admob" });
```

Input: `revenue` (major units, must be > 0), `currency` (ISO 4217), and
optional `network`, `mediation`, `adUnit`, `placement`, `format`, `eventId`.
Fire-and-forget: it never blocks or throws, and a non-positive or non-finite
`revenue` sends nothing.

## MMP attribution

If you already run an MMP (Adjust, AppsFlyer, Singular, Branch, Kochava,
Tenjin, Airbridge), call `setAttribution` from its attribution callback so
Revnix credits revenue to the right network/campaign.

```ts
// Adjust's attribution callback
adjustAttributionListener((attribution) => {
  Revnix.client.setAttribution({
    provider: "adjust",
    network: attribution.network,
    campaign: attribution.campaign,
    adGroup: attribution.adgroup,
    creative: attribution.creative,
  });
});

// AppsFlyer's onConversionDataSuccess
onConversionDataSuccess((data) => {
  if (data.af_status === "Organic") return;
  Revnix.client.setAttribution({
    provider: "appsflyer",
    network: data.media_source,
    campaign: data.campaign,
    adGroup: data.af_adset,
    creative: data.af_ad,
  });
});
```

Fire-and-forget, like `logAdRevenue`: it never blocks or throws.

## Last deep link

The SDK remembers the most recent link it saw, from either `handleDeepLink`
or a delivered deferred deep link, so you can ask for it again later, for
example after login or onboarding swallowed the original delivery:

```ts
const last = await Revnix.client.getLastDeepLink();
if (last) router.push(last.url);
```

`last` is `{ url, receivedAt }` or `null` when nothing has been recorded yet.
A dashboard preview link (`…?revnix_preview=<token>`) is never recorded. The
value is not cleared on logout.

## A/B tests

`resolvePlacement` sends the current customer id, so a running A/B test on
that placement serves this customer their assigned variant. The returned
`offering` and `paywall` are **already the variant's**; render what you get.
The assignment is exposed only so you can attribute your own analytics:

```ts
const { offering, paywall, experiment } = await Revnix.client.resolvePlacement(
  "paywall_main"
);
if (experiment) {
  analytics.track("paywall_shown", {
    experiment: experiment.key,
    variant: experiment.variantId,
  });
}
```

`experiment` is `null` when no running test covers the placement. Assignment
is sticky per customer, survives `identify()` merges, and enrolls the
customer exactly once; the server records an `experiment.enrolled` ledger
event in the same transaction as the assignment.

### Targeting: `setAttributes`

A test can be narrowed to an *audience*: conditions over customer
attributes. `setAttributes` is how a mobile app supplies the facts those
conditions read:

```ts
await Revnix.client.setAttributes({
  country: "US",
  app_version: "4.2.0",
  lifetime_orders: 3,
  stale_key: null, // null deletes
});
```

Unlike the fire-and-forget beacons this **awaits** the write, because the very
next `resolvePlacement` may depend on it and silently racing the audience
check would make targeting look broken. Set the attributes an audience targets
*before* the first resolve on a covered placement: eligibility is evaluated at
that resolve, and a customer described only afterwards enrolls on their next
one.

This is the one write under `/v1/customers/*` a publishable key may make. Two
server rules bound it, and each rejects the whole batch rather than applying
part of it: `email` and `username` are reserved (secret key, from your own
backend), and an attribute your backend already set cannot be changed from a
device.

## Diagnostics

The SDK swallows failures it can recover from (retry-queue drains, placement
prefetches, install and paywall-view reports, storage read/write errors). `onDiagnostic` surfaces them: it is called with `{ op, error, at }` for every
such failure (ops include `retryPendingPurchases`, `prefetchPlacement`,
`waitForEntitlements`, `reportInstall`, `logPaywallShown`, `logPaywallClosed`,
`logPaywallEvent`, `paywall.render`, `storageRead`, `storageWrite`,
`handleInstallReferrer`, `handleAttributionToken`, `resolveDeepLink`,
`getLastDeepLink`, `rememberDeepLink`, `onDeferredDeepLink`,
`onImplicitPaywall`, `implicitConfig`, `implicitLaunch`,
`implicit:<placement>`, `preview`, `lifecycleSubscribe`, `session`, and,
unreleased, `getAttribution`, `onAttribution`, `logAdRevenue`);
exceptions thrown by your callback are swallowed. The count of background
failures since the last report also rides the next request as an
`X-Revnix-Bg-Failures: <n>` header, so the backend can see silent client pain
without any app-side wiring. One related guard: a 200 response with a
non-JSON body (captive portal, misbehaving proxy) throws a *retryable*
`RevnixError` instead of returning garbage.

`paywall.render` is the one op nothing on the network produces: a block
paywall reporting a paint string it could not read (a gradient, a clip, a
tile size this build does not draw). `RevnixPaywall` routes those through
`client.reportRenderDiagnostic(message)`, so a host that already wired
`onDiagnostic` sees render fallbacks with no new wiring. Call it yourself only
if you are drawing paywall blocks with your own renderer.

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
paywall builder previews it; layout, copy, accent color, hero image, badge,
highlighted package, feature list, social proof, and offer framing all come
from the placement's `paywall.config`. The app supplies localized store prices
(StoreKit / Play Billing) and the purchase handlers, so the display never
disagrees with the charge.

`config.template` selects one of **nine layouts**, `focus`, `feature-list`,
`minimal` (the three original templates, byte-identical to how they always
rendered) plus `hero`, `timeline`, `plans`, `feature-grid`, `offer`, and
`reveal`. The dashboard's 200-template gallery is presets over these nine, so
a preset never introduces a shape this component cannot draw. Two optional
blocks compose onto any layout: `config.review` (star rating, quote, author,
and a `count` line under the CTA) and `config.offer` (struck-through anchor
price on the highlighted package, urgency line above the CTA).

```tsx
import { RevnixPaywall } from "revnix-react/ui";

const { paywall, offering } = await Revnix.client.resolvePlacement("paywall_main");
if (!paywall || !offering) return null; // both are nullable; guard first

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
  with `disableViewTracking`); or call `client.logPaywallShown()` yourself, it's fire-and-forget and never throws.
- Report the **end** of the display too: `logPaywallShown()` hands back the
  `viewId` it minted, and `client.logPaywallClosed(viewId, …)` closes that one
  display. The shared id is what makes it idempotent, so a retry or a
  double-dismiss can never count two. Without the close, a funnel knows how
  many saw the paywall but not how many left without buying.
- `client.logPaywallEvent(event, viewId, options?)` reports what happened **in
  between**, one of six: `selected`, `purchase_started`,
  `purchase_abandoned`, `purchase_failed`, `restore`, `error`. `RevnixPaywall`
  sends `selected`, `purchase_started`, `restore` and a no-products `error`
  for you; the purchase *outcome* is yours, because your app performs the
  store call. All six are pure ledger history: over-reporting can skew a
  report, never grant or revoke access.
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
| `getIdentity` | `GET /v1/customers/{id}/identity` | secret |
| `resolvePlacement` | `GET /v1/placements/{key}/offering` | any |
| install report | `POST /v1/installs` | any |
| `logPaywallShown` | `POST /v1/paywalls/viewed` | any |
| `logPaywallClosed` | `POST /v1/paywalls/closed` | any |
| `logPaywallEvent` | `POST /v1/paywalls/events` | any |
| `setAttributes` | `POST /v1/customers/{id}/attributes` | any |
| `identify` | `POST /v1/identify` | secret |
| `alias` | `POST /v1/customers/{id}/alias` | secret |
| implicit placement config | `GET /v1/config` | any |
| implicit moments / `handleDeepLink` | `POST /v1/placements/triggered` | any |
| dashboard preview link | `GET /v1/paywalls/preview/{token}` | any |
| `resolveDeepLink` | `GET /v1/links/resolve` | any (since 1.2.2) |
| `handleInstallReferrer` / `handleAttributionToken` | `POST /v1/installs` | any |
| `getAttribution` | `GET /v1/customers/{id}/attribution` | any (unreleased: ships in the release after 1.2.3) |
| `logAdRevenue` | `POST /v1/ad-revenue` | any (unreleased: ships in the release after 1.2.3) |

## Development

```sh
npm install
npm test
npm run build   # CJS + ESM (dist/ and dist/esm/)
```
