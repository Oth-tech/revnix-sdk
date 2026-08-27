// L3: the single source of the SDK version inside src/. Must match
// package.json "version" — version.test.ts fails the build when they drift
// (they had: client.ts said 0.7.0 while the package shipped 0.9.0).
export const SDK_VERSION = "0.15.0";
