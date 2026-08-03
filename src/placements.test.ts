import { describe, expect, jest, test } from "@jest/globals";
import { RevnixClient } from "./client.js";
import { RevnixNetworkError } from "./errors.js";
import { memoryStorage } from "./storage.js";
import type { PlacementResolution } from "./types.js";

// REV-157: offline-safe placements — resolvePlacement caches its last good
// resolution and serves it with `stale: true` when the live read fails, the
// same last-known-good pattern the C7 entitlements cache uses. Without this,
// every paywall display depended on the network: offline = no paywall = lost
// revenue.

const CONFIG = { apiKey: "rvx_pk_test_abc", baseUrl: "https://demo.convex.site" };

const RESOLUTION: PlacementResolution = {
  status: "ok",
  placementKey: "paywall_main",
  revision: 5,
  offering: {
    offeringId: "default",
    displayName: "Default",
    packages: [
      { packageId: "monthly", productId: "pro.monthly", product: null },
    ],
  },
  paywall: null,
  experiment: null,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function makeClient(
  fetchImpl: typeof fetch,
  storage = memoryStorage(),
  extra?: { prefetchPlacements?: string[] }
) {
  return new RevnixClient({
    ...CONFIG,
    storage,
    customerId: "cust-pl",
    reportInstalls: false,
    fetch: fetchImpl,
    ...extra,
  });
}

describe("REV-157 placement cache", () => {
  test("falls back to the cached resolution when the live read fails", async () => {
    const storage = memoryStorage();
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(RESOLUTION)) // 1st: live
      .mockRejectedValueOnce(new Error("offline")); // 2nd: down
    const client = makeClient(fetchImpl, storage);

    const fresh = await client.resolvePlacement("paywall_main");
    expect(fresh.stale).toBe(false);
    expect(fresh.offering?.packages[0]?.packageId).toBe("monthly");

    // Network is down now → the paywall still renders the last published
    // resolution instead of not at all.
    const cached = await client.resolvePlacement("paywall_main");
    expect(cached.stale).toBe(true);
    expect(cached.revision).toBe(5);
    expect(cached.offering?.packages[0]?.packageId).toBe("monthly");
  });

  test("throws when the read fails and nothing is cached", async () => {
    const offline = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("offline"));
    const client = makeClient(offline);
    await expect(client.resolvePlacement("paywall_main")).rejects.toBeInstanceOf(
      RevnixNetworkError
    );
  });

  test("the cache is per placement key", async () => {
    const storage = memoryStorage();
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(RESOLUTION))
      .mockRejectedValue(new Error("offline"));
    const client = makeClient(fetchImpl, storage);

    await client.resolvePlacement("paywall_main");
    // A different key has no cached copy — the failure surfaces.
    await expect(client.resolvePlacement("onboarding")).rejects.toBeInstanceOf(
      RevnixNetworkError
    );
    // The original key still serves from cache.
    const cached = await client.resolvePlacement("paywall_main");
    expect(cached.stale).toBe(true);
  });

  test("getCachedPlacement reads with no network call; null when empty", async () => {
    const storage = memoryStorage();
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(RESOLUTION));
    const client = makeClient(fetchImpl, storage);

    expect(await client.getCachedPlacement("paywall_main")).toBeNull();
    await client.resolvePlacement("paywall_main"); // caches
    const cached = await client.getCachedPlacement("paywall_main");
    expect(cached?.stale).toBe(true);
    expect(cached?.placementKey).toBe("paywall_main");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("prefetchPlacements warms the cache at construction without blocking", async () => {
    const storage = memoryStorage();
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(RESOLUTION));
    makeClient(fetchImpl, storage, { prefetchPlacements: ["paywall_main"] });
    // Let the fire-and-forget prefetch settle.
    await new Promise((r) => setTimeout(r, 0));

    // A later, offline client still has the paywall.
    const offline = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("offline"));
    const client2 = makeClient(offline, storage);
    const cached = await client2.getCachedPlacement("paywall_main");
    expect(cached?.stale).toBe(true);
    expect(cached?.revision).toBe(5);
  });
});
