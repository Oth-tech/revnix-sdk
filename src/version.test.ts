import { describe, expect, it } from "@jest/globals";
import { SDK_VERSION } from "./version";

// L3 regression guard: client.ts once reported 0.7.0 while the package
// shipped 0.9.0. The version now lives in exactly one src file; this pins
// it to package.json so a release bump can't drift again.
describe("SDK_VERSION", () => {
  it("matches package.json", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../package.json") as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
