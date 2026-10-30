<p align="center">
  <a href="https://www.revnix.io"><img src="https://www.revnix.io/sdk/logo.png" width="360" alt="Revnix"></a>
</p>

<h1 align="center">Subscriptions, Paywalls and Attribution<br>for Your React Native App</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/react-native-revnix"><img src="https://img.shields.io/npm/v/react-native-revnix?color=2f6fe0&logo=npm" alt="npm version"></a>
  <a href="https://github.com/Oth-tech/revnix-sdk/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/react-native-revnix?color=2f6fe0" alt="license"></a>
  <img src="https://img.shields.io/badge/TypeScript-ready-2f6fe0?logo=typescript&logoColor=white" alt="TypeScript">
</p>

<p align="center">
  <a href="https://www.revnix.io"><b>Website</b></a> •
  <a href="https://www.revnix.io/docs/react-native"><b>Docs</b></a> •
  <a href="https://www.revnix.io/docs/react-native/reference"><b>API Reference</b></a>
</p>

![Revnix: subscriptions, paywalls and attribution for mobile apps](https://www.revnix.io/sdk/hero.png)

Revnix SDK makes in-app subscriptions, paywalls and attribution for React Native fast and easy. One package buys through StoreKit 2 and Google Play Billing, validates the receipt on the server and unlocks the entitlement. Zero npm dependencies.

## Table of Contents

- [Why Revnix?](#why-revnix)
- [Getting Started](#getting-started)
- [Quick start](#quick-start)
- [Purchases and entitlements without server code](#purchases-and-entitlements-without-server-code)
- [Paywalls that update without app releases](#paywalls-that-update-without-app-releases)
- [A/B tests with a built-in holdout](#ab-tests-with-a-built-in-holdout)
- [Attribution and deep links](#attribution-and-deep-links)
- [Real-time analytics for your React Native app](#real-time-analytics-for-your-react-native-app)
- [Compatibility](#compatibility)
- [Documentation](#documentation)
- [Migrating from another SDK](#migrating-from-another-sdk)
- [Support](#support)
- [License](#license)

## Why Revnix?

- [Purchases in one call](https://www.revnix.io/docs/react-native/make-purchases). `purchase()` opens the App Store or Google Play sheet, validates the receipt on the server and grants the entitlement. No react-native-iap, no server code.
- [Entitlements that work offline](https://www.revnix.io/docs/react-native/check-entitlements). Entitlement checks are cached on device, so a user who paid stays unlocked without a network.
- [Remote paywalls](https://www.revnix.io/docs/paywall-builder). Design paywalls in the dashboard, pick from 250 templates and ship copy, prices and layout changes without an app release.
- [A/B tests and holdouts](https://www.revnix.io/docs/ab-tests). Split a placement between variants, measure revenue per user with credible intervals and ship the winner from the dashboard.
- [Attribution and deep links](https://www.revnix.io/docs/attribution). Install attribution, deferred deep links, Apple Search Ads, Google Ads and MMP forwarding, all from the same SDK.
- [Integrations](https://www.revnix.io/docs/integrations). Send subscription events to analytics, attribution and messaging tools, or to your own server through signed webhooks.
- [Real-time analytics](https://www.revnix.io/docs/analytics). Revenue, MRR, LTV, ROAS, cohorts and funnels for iOS and Android, filtered by store, product, channel and campaign.

## Getting Started

### For React Native projects

```sh
# using npm
npm install react-native-revnix

# or using yarn
yarn add react-native-revnix
```

Then `cd ios && pod install`. Android links through Gradle automatically.

### For Expo projects

```sh
npx expo install react-native-revnix
npx expo prebuild
```

The store module is native code, so Expo needs a development build rather than Expo Go.

Read the [installation guide](https://www.revnix.io/docs/react-native/installation) and [configuration reference](https://www.revnix.io/docs/react-native/configuration) to set up the SDK.

## Quick start

```ts
import "react-native-revnix/store";
import { Revnix } from "react-native-revnix";
import { MMKV } from "react-native-mmkv";

const mmkv = new MMKV();

// 1. Configure once at app start
Revnix.configure({
  apiKey: "rvx_pk_live_…",
  baseUrl: "https://<your-deployment>.convex.site",
  storage: {
    getItem: (k) => mmkv.getString(k) ?? null,
    setItem: (k, v) => mmkv.set(k, v),
  },
});

// 2. Buy: opens the store sheet, validates the receipt, grants the entitlement
await Revnix.client.purchase("pro.monthly");

// 3. Check access anywhere
const pro = await Revnix.client.isEntitled("pro");
```

Your API key and deployment URL are in the dashboard under Settings. See [API keys](https://www.revnix.io/docs/api-keys).

## Purchases and entitlements without server code

**Revnix handles the hard parts of subscriptions in a small, developer-friendly SDK.**

- `purchase(productId)` runs the whole flow: store sheet, server-side receipt validation, entitlement, transaction finish. `restore()` brings purchases back on a new device.
- Consumables on Google Play: list their ids in `consumableProductIds` so they are consumed after Revnix records the purchase and can be bought again.
- Renewals, purchases on other devices and Ask to Buy approvals arrive on their own and are registered automatically.
- Entitlements and placements are cached on device, so paid users stay unlocked offline.
- Failed registrations are retried automatically when the app comes back online.
- Identify users across devices with `identify()`; purchases follow the customer, not the install. See [Identify users](https://www.revnix.io/docs/react-native/identify-users).
- Typed errors for blocked purchases and account transfers. See [Errors and transfers](https://www.revnix.io/docs/react-native/errors-and-transfers).
- Already using `react-native-iap` or another store library? Keep it and call `registerPurchase()` instead. See [Make purchases](https://www.revnix.io/docs/react-native/make-purchases).

## Paywalls that update without app releases

![Revnix paywall builder: element tree, background library and a live iPhone preview](https://www.revnix.io/sdk/react-native/paywalls.png)

With the [Revnix paywall builder](https://www.revnix.io/docs/paywall-builder) you design the paywall in the dashboard and render it natively in your app.

- **Native rendering**: `RevnixPaywall` from `react-native-revnix/ui` draws the paywall with React Native views, no web views, and buys the selected package itself.
- **250 templates**: pick a layout, theme and accent, then edit copy, packages and badges.
- **Update without redeploying**: change prices, copy or layout any time; the next placement resolve picks it up.
- **Localized**: 43 languages for the built-in strings, plus per-locale copy of your own.

Learn more in [Show paywalls](https://www.revnix.io/docs/react-native/show-paywalls) and [Placements](https://www.revnix.io/docs/placements).

## A/B tests with a built-in holdout

![Revnix A/B test results with a winner and credible intervals](https://www.revnix.io/sdk/react-native/ab-test.png)

- Split a placement's traffic between offering and paywall variants. Conversions, trials, revenue per user and MRR are calculated per variant.
- Add a **holdout** variant that shows no paywall at all, to measure what the paywall is really worth.
- Bayesian results with 95% credible intervals and a sample-size planner, so you know when to stop.
- Ship the winner from the dashboard; the SDK needs no change.

Learn more in [A/B tests](https://www.revnix.io/docs/ab-tests).

## Attribution and deep links

![Revnix MRR by country, last 90 days](https://www.revnix.io/sdk/react-native/attribution.png)

- **Install attribution** from Revnix links, with per-link click lookback windows. See [Attribution](https://www.revnix.io/docs/attribution).
- **Deferred deep links** resolve on first launch, so a user who installs from a campaign lands on the right screen. See [Deferred deep links](https://www.revnix.io/docs/deferred-deep-links).
- **Apple Search Ads** and **Google Ads** attribution, with App Tracking Transparency support. See [Apple Search Ads](https://www.revnix.io/docs/apple-search-ads) and [Google Ads](https://www.revnix.io/docs/google-ads-attribution).
- **MMP forwarding** to AppsFlyer and Adjust, **ad revenue** logging and **uninstall measurement**. See [MMP attribution](https://www.revnix.io/docs/mmp-attribution), [Ad revenue](https://www.revnix.io/docs/ad-revenue) and [Uninstall measurement](https://www.revnix.io/docs/uninstall-measurement).
- **Fraud prevention**: anonymous-IP and click-injection checks keep paid channels honest. See [Fraud prevention](https://www.revnix.io/docs/fraud-prevention).

### Device integrity

Pass `nativeDeviceIntegrity` so install reports carry Apple App Attest or Google Play Integrity evidence. With "Require device integrity" on in the dashboard, installs without it lose their attribution.

```ts
import { nativeDeviceIntegrity } from "react-native-revnix/store";

Revnix.configure({
  apiKey: "rvx_pk_live_…",
  baseUrl: "https://<your-deployment>.convex.site",
  deviceIntegrity: nativeDeviceIntegrity,
});
```

It runs once per customer, waits at most 10 seconds and never blocks the report. Needs App Attest on iOS or Google Play services on Android; simulators and emulators send no evidence.

## Real-time analytics for your React Native app

![Revnix overview: active subscriptions, revenue and MRR over 90 days](https://www.revnix.io/sdk/react-native/analytics.png)

- Revenue, MRR, ARR, ARPU, LTV and ROAS, updated from the ledger as purchases arrive.
- Cohorts, retention, funnels and predicted LTV. See [Analytics](https://www.revnix.io/docs/analytics).
- Filter and group by store, product, country, channel, campaign and A/B test variant.
- Saved reports, alerts and a REST API for your own dashboards. See [Reports](https://www.revnix.io/docs/reports) and [REST API](https://www.revnix.io/docs/rest-api).

## Compatibility

- **React Native** 0.72 or later, New Architecture and legacy architecture alike. iOS 15.1 or later (StoreKit 2), Android with Google Play Billing 8.
- **Expo**: supported with a development build. Expo Go cannot load the store module.
- **React and Next.js**: the same package powers web apps; the store module is mobile only, web registers purchases from your server. In a browser pass `fetch: (input, init) => fetch(input, init)` to `configure`, and note the `/v1` API does not answer CORS preflight today, so route calls through your own backend (set `baseUrl` to your proxy) or gate server-side over REST. See [React](https://www.revnix.io/docs/react).
- **Other platforms**: Revnix also ships SDKs for [iOS](https://www.revnix.io/docs/ios), [Android](https://www.revnix.io/docs/android), [Flutter](https://www.revnix.io/docs/flutter), [Capacitor](https://www.revnix.io/docs/capacitor) and [Unity](https://www.revnix.io/docs/unity).
- Ships CommonJS and ESM builds, tree-shakeable, with full TypeScript types.

## Documentation

- [Overview](https://www.revnix.io/docs/react-native)
- [Installation](https://www.revnix.io/docs/react-native/installation)
- [Configuration](https://www.revnix.io/docs/react-native/configuration)
- [Identify users](https://www.revnix.io/docs/react-native/identify-users)
- [Make purchases](https://www.revnix.io/docs/react-native/make-purchases)
- [Check entitlements](https://www.revnix.io/docs/react-native/check-entitlements)
- [Show paywalls](https://www.revnix.io/docs/react-native/show-paywalls)
- [Errors and transfers](https://www.revnix.io/docs/react-native/errors-and-transfers)
- [API reference](https://www.revnix.io/docs/react-native/reference)

## Migrating from another SDK

Moving from Adapty or RevenueCat? Revnix imports your customers and purchase history, and the SDK calls map one to one.

- [Migrate from Adapty](https://www.revnix.io/docs/migrate-from-adapty)
- [Migrate from RevenueCat](https://www.revnix.io/docs/migrate-from-revenuecat)

## Support

- Email [support@revnix.io](mailto:support@revnix.io) with questions, bugs or feature requests.
- Check the [status page](https://www.revnix.io/status) for incidents.

## License

Revnix SDK is available under the MIT license. See [LICENSE](https://github.com/Oth-tech/revnix-sdk/blob/main/LICENSE) for details.
