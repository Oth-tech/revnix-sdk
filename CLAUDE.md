# revnix-sdk (npm `react-native-revnix`)

Revnix client SDK for React Native, Expo (dev build), React and Next.js. Talks to the Revnix `/v1` HTTP API (Convex HTTP routes in `../revnix-app/convex/http.ts`). One npm package, three entry points, plus an RN native module for StoreKit 2 / Play Billing / device integrity. Repo `Oth-tech/revnix-sdk` (public), default branch `main`.

## Package
- npm name `react-native-revnix` (renamed from `revnix-react` in 1.4.2; the old name is no longer published). Podspec `react-native-revnix.podspec` (iOS 15.1, version from package.json, git tag `v<version>`).
- Entry points (`exports` in package.json):
  - `react-native-revnix` → `src/index.ts`: `Revnix` singleton (`configure`, `client`, `setLocale`), `RevnixClient`, errors, `setStoreAdapter`, `purchaseInputFromIap`, `memoryStorage`, `SDK_VERSION`, types. Must stay free of react / react-native imports.
  - `react-native-revnix/ui` → `src/ui/index.ts`: `RevnixPaywall`, `RevnixBlockPaywall`, block helpers (imports react-native).
  - `react-native-revnix/store` → `src/store/index.ts`: side-effect import that wraps `NativeModules.RevnixStore` and calls `setStoreAdapter`; also `nativeDeviceIntegrity`, `nativeAdvertisingId`.
- Root shims `ui.js` / `ui.d.ts`, `store.js` / `store.d.ts` serve resolvers without `exports` support (Metro, TS `node`). Keep them in sync with new subpaths.
- Peers `react >=18`, `react-native >=0.72`, both optional. Zero runtime deps; keep it that way (`iap.ts` is structurally typed so there is no react-native-iap dependency).
- Consumed by `../RevnixSDK-Capacitor` (web layer) and by VoiGu via a local `file:` tarball.

## Stack
- TypeScript 5.8, strict + `noUncheckedIndexedAccess`, target ES2020, `jsx: react`.
- `tsconfig.json` → CJS + `.d.ts` into `dist/`; `tsconfig.esm.json` → ESM (no decls) into `dist/esm/` and writes `dist/esm/package.json` `{type: module}`. Tests excluded from both.
- Source imports use explicit `.js` extensions (ESM); `jest.config.mjs` maps them back to `.ts`.
- Jest 29 + ts-jest, node env, `testMatch: src/**/*.test.ts` (no `.tsx` tests). Tests sit next to source. Dev versions: react 19.1, react-native 0.81.
- Android (`android/`): Kotlin RN module `com.revnix.reactnative.RevnixStoreModule` + `RevnixStorePackage`; Play Billing 8.3.0, Play Integrity 1.6.0, ads-identifier (compileOnly); JVM 17, compileSdk 35, minSdk 24.
- iOS (`ios/`): `RevnixStore.swift` + `RevnixStore.m` (RCT_EXTERN bridge); StoreKit 2, DeviceCheck / App Attest. Old-architecture `NativeModules` / `NativeEventEmitter` (event `revnixStoreTransaction`), not a TurboModule. Native methods: `purchase`, `restore`, `finish(id, consume)`, `deviceIntegrity`, `advertisingId` (Android only).

## Layout
- `src/client.ts` (~2.5k lines): `RevnixClient`, all network, caching and queues. `src/types.ts`, `src/errors.ts`, `src/storage.ts` (storage resolution), `src/device.ts` (`X-Revnix-Device`), `src/implicit.ts` (implicit placements + lifecycle), `src/store.ts` (`StoreAdapter` contract), `src/iap.ts` (react-native-iap glue), `src/version.ts` (`SDK_VERSION`).
- `src/blocks/`: pure paywall-block render logic (style, color, background, locale, tags, selection). `paywall-selection-wire.json` / `paywall-background-wire.json` are byte-identical copies of `../revnix-app/tests/fixtures/` (the render contract shared by every SDK); change them there first.
- `src/ui/`: React Native paywall components. `scripts/release.mjs`: CHANGELOG-driven version bump, CI only.
- `dist/`: gitignored build output; the local copy can be stale, never read it as truth. `*.tgz` at root: local `npm pack` tarballs for testing in apps, gitignored. `android/.gradle/`: untracked local Gradle cache, not gitignored; never commit it.

## How it works
- `Revnix.configure({ apiKey, baseUrl, storage, … })`. `apiKey` and `baseUrl` are both required, there is no default URL (`https://<deployment>.convex.site`); `http://` only for localhost / private hosts. Re-configure disposes the old client.
- Every request: `Authorization: Bearer <apiKey>`, `X-Revnix-SDK: react-native-revnix/<SDK_VERSION>`, optional `X-Revnix-Bg-Failures`, `X-Revnix-Device`; 10 s timeout. Errors: `RevnixAuthError` (401/403), `RevnixRateLimitError` (429 + Retry-After), `PurchaseBlockedError` (409 on purchases), `RevnixTimeoutError`, `RevnixNetworkError`.
- Endpoints (all exist in `revnix-app/convex/http.ts`): `/v1/identify`, `/v1/customers/{id}/{alias,entitlements,identity,attributes,attribution}`, `/v1/purchases`, `/v1/placements/{key}/offering`, `/v1/placements/triggered`, `/v1/paywalls/{viewed,closed,events}`, `/v1/paywalls/preview/{token}`, `/v1/events`, `/v1/ad-revenue`, `/v1/attribution`, `/v1/push-token`, `/v1/installs`, `/v1/links/resolve`, `/v1/config`.
- Persistence keys `revnix.*` in the storage adapter. Without an adapter: web uses localStorage; RN falls back to memory, warns, and disables install reporting.
- Queues: pending purchases (cap 100, 30 days, retried at launch); events from `track` / paywall events batched (flush at 20 queued, 10 s, background, next launch; batch 100, cap 1000, 30 s hold after failure). Entitlements and placements cached for offline. Background failures surface via `onDiagnostic`.

## Commands (`package.json` scripts)
```bash
npm ci
npm run typecheck
npm test                 # jest
npm run build            # build:cjs + build:esm; prepack runs clean + build
```
- No lint script. No release script to run by hand.
- `/usr/bin/git` is blocked by the Xcode license prompt on this Mac; use `/Applications/GitHub Desktop.app/Contents/Resources/app/git/bin/git`.

## Git, CI, release
- `.github/workflows/ci.yml`: PRs to `main` + manual. Job `check` (Node 22: typecheck + test); job `native` packs the SDK into a fresh RN host app and builds Android (gradle) and iOS (pod install + xcodebuild).
- `.github/workflows/release.yml`: `workflow_dispatch` only (inputs `bump`, `version`, `app_sha`, `run_key`), dispatched by `../revnix-app/.github/workflows/release-sdks.yml` (job `react-native-revnix`, after revnix-app "Deploy production" succeeds on `main`). The Capacitor release job takes this version as input.
- Release flow: typecheck + test → skip if nothing changed since `v<current>` (ignores `.github` and `*.md`) → `scripts/release.mjs` bumps package.json, lockfile, `src/version.ts`, dates the CHANGELOG → PR `release/vX.Y.Z` merged with `gh pr merge --merge` → `npm publish` (OIDC trusted publishing or `NPM_TOKEN`) → tag `vX.Y.Z` + GitHub release.
- Never hand-bump versions. Every change gets a bullet under `## Unreleased` in `CHANGELOG.md`: `### Breaking` / `### Removed` → major, `### Added` → minor, else patch. `src/version.test.ts` enforces `src/version.ts` == package.json.
- Merge commits only into `main` (ruleset; squash is refused). Opposite of revnix-app, which squash-merges into `dev`.

## Conventions
- Keep the core entry RN-free; RN code lives only in `src/ui/` and `src/store/`.
- Changing native method signatures or `StoreAdapter` / `StoreTransaction` is a contract change for custom adapters; call it out in the CHANGELOG.
- Server-dependent behavior ships after the matching revnix-app deploy (see the 1.9.0 CHANGELOG note).
- The `/v1` API does not answer CORS preflight; README tells browser apps to proxy.

## Gotchas
- Testing a rebuilt tarball in an app (VoiGu): same filename + same version → `npm install` serves the lockfile-cached OLD tarball silently. Either give the tarball a new filename (`revnix-react-main-<sha>.tgz` style) or extract by hand into `node_modules/react-native-revnix`, `find … -type f -exec touch {} +` (npm tarballs carry 1985 mtimes, so Metro keeps the stale module), `rm -rf "${TMPDIR}"metro-*`, restart Metro with `-c`. Confirm with `grep -c <symbol>` on the dist file that actually contains it (for example `dist/ui/RevnixBlockPaywall.js`).
- Expo Go cannot load the store module; it needs a development build. `RevnixStore native module not found` = pods not installed or app not rebuilt.
