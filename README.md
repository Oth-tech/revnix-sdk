# revnix-react

Revnix SDK for React Native / JavaScript. Pure TypeScript over the Revnix
`/v1` REST API — no native modules, no dependencies. Pairs with
`react-native-iap` (or any StoreKit 2 / Play Billing wrapper) for purchases.

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
  apiKey: "rvx_test_…",                       // dashboard → Settings → API keys
  baseUrl: "https://<deployment>.convex.site", // Convex site URL
  storage: {
    getItem: (k) => mmkv.getString(k) ?? null,
    setItem: (k, v) => mmkv.set(k, v),
  },
});
```

The API key fixes the app **and** environment server-side — a test key can
never write into production. Pass a persistent `storage` adapter or every
app launch becomes a new anonymous customer.

## Identity

```ts
await Revnix.client.getCustomerId();   // rvx_anon_… until identified
await Revnix.client.identify(user.uid); // on login — merges anonymous history
await Revnix.client.logout();           // fresh anonymous customer
```

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
arrives first wins, the other becomes a no-op.

## Entitlements & placements

```ts
const { entitlements, cursor } = await Revnix.client.getEntitlements();
const pro = await Revnix.client.isEntitled("pro");
const { offering } = await Revnix.client.resolvePlacement("paywall_main");
```

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
/>;
```

The `/ui` entrypoint is separate from the core so pure-JS consumers never
load `react` / `react-native` (both are optional peer dependencies).

## Development

```sh
npm install
npm test
npm run build
```
