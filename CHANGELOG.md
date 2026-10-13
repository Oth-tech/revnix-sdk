# Changelog

## Unreleased

### Added

- **`advertisingId`** config option and `nativeAdvertisingId` from `react-native-revnix/store`: stores the Google Advertising ID on the customer as `gps_adid` at launch, resent only when it changes and deleted after an opt-out. Android needs `com.google.android.gms:play-services-ads-identifier` and the `com.google.android.gms.permission.AD_ID` permission in the app; without them, or after an opt-out, nothing is stored.
- **`deviceIntegrity`** config option and `nativeDeviceIntegrity` from `react-native-revnix/store`: attaches Apple App Attest / Google Play Integrity evidence to `POST /v1/installs` and `POST /v1/attribution`, once per customer, bounded to 10 s. Android adds `com.google.android.play:integrity:1.6.0`.
- Paywall blocks: `timer` (countdown to a date or from when the paywall opens), `video` (drawn as its poster; React Native has no built-in player), `toggle` (free-trial switch that flips the selected package) and the card `carousel` layout (swipeable pages with dots and optional auto-advance).

## 1.6.0 (2026-10-12)

### Added

- **`flushEvents()`**: send every queued `track` and paywall interaction
  event now.
- **`preload(placementKeys)`**: fetch placements ahead of time so the next
  `resolvePlacement` answers from the cache. Never throws.
- **`prefetchPaywallImages(resolution)`** from `react-native-revnix/ui`:
  warms React Native's image cache with the paywall's hero, image-block and
  background images.

### Changed

- `track` and `logPaywallEvent` queue to storage (`revnix.eventQueue`, newest
  1000 kept) and resolve once queued. Events go out in batches of up to 100
  to `POST /v1/events` / `POST /v1/paywalls/events`: at 20 queued, 10 s after
  the first, when the app goes to the background, and on the next launch. A
  transient failure keeps them and holds sends for 30 s. Paywall events now
  always carry `eventId` (the `viewId` by default).
- `resolvePlacement` answers instantly from a cache under 24 h old fetched
  for the same customer since the last `setAttributes` or purchase, and
  refreshes it in the background. A 401/403/404/409 seen by that refresh
  drops the cache.
- With a cached entitlements snapshot, the network read times out after 3 s
  (or `requestTimeoutMs`, if lower) and the cache answers.
- The pending-purchase queue keeps the newest 100 and drops purchases queued
  more than 30 days ago.

## 1.5.0 (2026-10-08)

Changes since 1.4.2 were not recorded here; see the commit log.

## 1.4.2 (2026-10-08)

### Changed

- Package renamed to `react-native-revnix`; `revnix-react` is no longer
  published. Install `react-native-revnix` and change imports to
  `react-native-revnix` / `react-native-revnix/ui`.

## 1.4.0 (2026-10-06)

### Added

- **`Revnix.setLocale(tag?)`** (also `setLocale` from `revnix-react/ui`):
  forces every designed paywall mounted after the call into `tag`'s
  language; no argument clears it.
- `linkLabels(locale)` export.

### Changed

- The links block's Restore, Terms and Privacy labels are localized (43
  languages, English fallback).

## 1.3.0 (2026-10-02)

### Added

- **`track(event, properties?, options?)`**: report one custom in-app event
  to `POST /v1/events`, recorded as `custom.<event>` in the ledger. `event`
  must match `^[a-z0-9_]{1,64}$`; an invalid name sends nothing. Not for
  purchases — those report through `registerPurchase`. Fire-and-forget, like
  `logAdRevenue`.
- **`setAttribution(attribution)`**: forward an MMP's attribution callback
  (Adjust, AppsFlyer, Singular, Branch, Kochava, Tenjin, Airbridge) to
  `POST /v1/attribution` so Revnix credits revenue to the right
  network/campaign. Fire-and-forget, like `logAdRevenue`.
- **`setPushToken(token)`**: register the device's push token with
  `POST /v1/push-token` so Revnix can measure uninstalls. Fire-and-forget,
  like `logAdRevenue`.

## 1.2.4 (2026-09-26)

### Added

- **`logAdRevenue(input)`**: report one ad impression's payout (revenue,
  currency, and optional network/mediation/adUnit/placement/format) to
  `POST /v1/ad-revenue`. Fire-and-forget, like the other beacons; a
  non-positive or non-finite `revenue` sends nothing.
- **`getAttribution()` / `onAttribution`**: the install-attribution verdict —
  `installMatch`, `attributedAt`, the campaign facts frozen at judgment time,
  `linkToken`, and `reattributedAt` when a later signal re-attributed the
  customer — from `GET /v1/customers/{id}/attribution`. `onAttribution` fires
  after the cold-start install report and again whenever the verdict changes
  (a late Play referrer, an ASA token resolving, a re-attribution),
  de-duplicated via storage. The SDK never fetches it on its own unless
  `onAttribution` is set. Never throws.
- **`session_start` now reports `previousSessionMs`**: the previous session's
  wall-clock length (background time minus its start), sent on the next
  session's trigger so the server can stamp it onto that prior
  `session.started` event.
- **Web: the landing URL is reported as a deep link** when `document` is
  present and the query carries `utm_*` or `revnix_link` params, so web
  visitors get `link.*` attribution with no host code; a host's own
  `handleDeepLink` call with that same landing URL is skipped once to avoid
  double-reporting.

## 1.2.3 (2026-09-22)

### Added

- **`handleAttributionToken(token)`**: the Apple Search Ads half of install
  attribution. `AAAttribution.attributionToken()` has no JavaScript binding,
  so a host mints the token in a native module and hands the raw string here;
  it rides along with the install and resolves to Apple's verdict —
  `"resolved"`, `"organic"`, or `"pending"` for a token Apple has not
  registered yet, which is worth retrying with a fresh token on the next cold
  start. Never throws.

## 1.2.2 (2026-09-19)

### Added

- **`getLastDeepLink()`**: the most recent link seen by `handleDeepLink` or a
  delivered deferred deep link, as `{ url, receivedAt }` or null, persisted on
  the device so it can be read again after login or onboarding. Never throws.
- **`onDeferredDeepLink(url, match)`**: the link a customer clicked before
  they had the app, delivered at most once per install — exact on Android
  (from the Play Install Referrer), probabilistic on iOS (same-network click
  within the last hour). `POST /v1/installs` returns it only when the link's
  scheme matches the app's configured URL scheme; `handleInstallReferrer`
  also feeds it. (REV-299)
- **`resolveDeepLink(url)`**: unwraps a link an email service provider
  rewrote through its own click-tracking domain back into the original
  app-scheme URL, so a Mailchimp/SendGrid click reaches your router intact.
  Never throws; returns the input unchanged on any failure.

### Changed

- **Deep links always record their attribution.** `handleDeepLink` reports
  every ordinary link, so its `link.*` attributes land on the customer with
  no `onImplicitPaywall` handler and no `deeplink_open` placement. A paywall
  still presents only when implicit placements are on and `deeplink_open`
  is configured; otherwise the report carries `resolve: false` and the
  server stores the link facts only. `/v1/config` is never fetched while
  implicit placements are off.

### Fixed

- **Preview resolutions match the `PlacementResolution` type.** The dashboard
  preview route sends no `status` and a null `revision`; the resolution
  handed to `onImplicitPaywall` now carries `status: "ok"` and `revision: 0`,
  the same as the native SDKs.

## 1.1.2 (2026-09-14)

### Added

- **On-device QR preview.** `handleDeepLink` recognises a dashboard QR/link
  preview URL and hands the draft paywall to `onImplicitPaywall` under
  `placement: "revnix_preview"` (`PREVIEW_PLACEMENT_KEY`); `RevnixPaywall`
  (classic or designed) disables the purchase tap for it, and no view/close/
  interaction is sent to analytics for that display. A host rendering
  `RevnixBlockPaywall` directly is not covered — it takes no `placementKey`.

### Changed

- **Type-level break:** `ImplicitTrigger.placement` widens from
  `ImplicitPlacement` to `ImplicitPlacement | "revnix_preview"`, to carry the
  QR-preview trigger above. Code that switches exhaustively over
  `ImplicitPlacement` on `trigger.placement` needs a `"revnix_preview"` case
  (or a default) to keep compiling.

## 1.1.1 (2026-09-12)

### Added

- **Device attribute contract.** Every `resolvePlacement()` now carries the
  device facts — platform, OS version, app version, locale, currency,
  storefront country, model, install date, SDK version, sandbox, first open —
  in an `X-Revnix-Device` header. The server evaluates targeting rules and
  audiences against them on that request and stores them on the customer as
  reserved `device.*` attributes. In a browser the SDK detects platform, OS
  version and locale itself; pass the rest (and everything, under React
  Native) as `configure({ device: { … } })`, or `device: false` to send
  nothing. `installedAt` is persisted on first launch; `firstOpen` is true for
  that whole first session. Not sent for an ephemeral anonymous id. (REV-268)
- `DeviceFacts` type; `DEVICE_HEADER` and `encodeDeviceHeader` exports.
- **`handleInstallReferrer(referrer)`**: hand over the Android Play Store
  install referrer, verbatim, as the Play Install Referrer library returns it.
  The server reads its campaign parameters into the customer's `link.*`
  attributes, so a customer an ad won is credited to that channel instead of
  "Direct". Fill-only: a deep link opened since is never overwritten. Safe to
  call late or twice; a no-op for an empty string, a disposed client, or an
  ephemeral anonymous id. (REV-283)

### Changed

- `installMetadata` is superseded by `device` (both still feed the install
  report).

### Fixed

- **Photo backgrounds under a scrim rendered black on React Native.** A
  surface painted its gradient's first colour underneath the gradient as a
  fallback, and a scrim's transparent end showed that near-black sheet instead
  of the photo. The solid is now painted only when the gradient cannot be
  drawn: no gradient component passed, or a fill this build cannot parse.
  (REV-279)

## 1.1.0 (2026-09-05)

### Added

- `logPaywallEvent(event, viewId, options?)` reports one of the six paywall
  interactions (`selected`, `purchase_started`, `purchase_abandoned`,
  `purchase_failed`, `restore`, `error`), the rest of a display's life between
  `logPaywallShown` and `logPaywallClosed`. `RevnixPaywall` reports the four it
  observes itself; `onPurchase` may return a `PaywallPurchaseOutcome` so the
  purchase outcome is reported without being guessed. `RevnixPaywallPackage`
  gains an optional `productId`. (REV-263)
- `selectedStyle` and `visibility` on every block: a plan card can change its
  fill, border and text while its package is selected, and a block can be drawn
  only while selected or only while not. Canvas designs scale and centre,
  purchase buttons show pressed and loading states, image blocks load their
  URL. The render contract is a shared wire fixture walked by every SDK's
  suite. (REV-262)
- Customers can close a paywall: a design may mark a block with
  `action: "close"`, and the renderer draws its own close only when the design
  carries none. `onClose` is required for any close to be drawn.
  `logPaywallShown` now returns the view id and `logPaywallClosed` reports
  against it. (REV-252)
- Gradient fills render on every block type, not only `card`; scrims over a
  photo stay translucent. Render diagnostics via `onDiagnostic` /
  `client.reportRenderDiagnostic`. (REV-256)
- The style vocabulary the converted designs use: `basis`, `selfAlign`, and
  percentage strings for `height` / `top` / `right` / `bottom` / `left`.

### Fixed

- `getIdentity()` is secret-key only and now fails fast locally on a
  publishable key, like `identify()`. (REV-259)
- `backgroundBaseColor` collapses a gradient ground to its base colour, as the
  other SDKs already did. (REV-256)
- The background wire contract is pinned by a byte-identical fixture shared
  with revnix-app and every SDK. (REV-254)

## 1.0.0 (2026-08-29)

Stable release: designed paywalls render on device, backgrounds included.
Earlier history lives in the git log.
