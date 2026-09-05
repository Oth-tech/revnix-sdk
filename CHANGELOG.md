# Changelog

## Unreleased

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
