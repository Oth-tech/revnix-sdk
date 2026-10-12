import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { paywallImageUrls, RevnixClient } from "./client.js";
import { RevnixNetworkError } from "./errors.js";
import { memoryStorage } from "./storage.js";
import type { PlacementResolution } from "./types.js";

// REV-157: offline-safe placements — resolvePlacement caches its last good
// resolution and serves it with `stale: true` when the live read fails, the
// same last-known-good pattern the C7 entitlements cache uses. Without this,
// every paywall display depended on the network: offline = no paywall = lost
// revenue.

const CONFIG = { apiKey: "rvx_pk_test_abc", baseUrl: "https://demo.convex.site" };
const HOUR_MS = 60 * 60 * 1000;

afterEach(() => {
  jest.restoreAllMocks();
});

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

    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * HOUR_MS);
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
    expect(cached.revision).toBe(5);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function waitFor(condition: () => Promise<boolean>) {
  for (let i = 0; i < 100 && !(await condition()); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(await condition()).toBe(true);
}

function placementCalls(fetchImpl: jest.Mock<typeof fetch>) {
  return fetchImpl.mock.calls.filter(([url]) => String(url).includes("/v1/placements/"));
}

function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  jest.spyOn(Date, "now").mockImplementation(() => now);
  return { advance: (ms: number) => (now += ms) };
}

describe("cache-first placements", () => {
  test("a fresh cache answers without waiting and refreshes in the background", async () => {
    const storage = memoryStorage();
    const refresh = deferred<Response>();
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(RESOLUTION))
      .mockReturnValueOnce(refresh.promise);
    const client = makeClient(fetchImpl, storage);
    await client.resolvePlacement("paywall_main");

    const cached = await client.resolvePlacement("paywall_main");
    expect(cached.revision).toBe(5);
    expect(cached.stale).toBe(false);
    await waitFor(async () => placementCalls(fetchImpl).length === 2);

    refresh.resolve(jsonResponse({ ...RESOLUTION, revision: 6 }));
    await waitFor(
      async () => (await client.getCachedPlacement("paywall_main"))?.revision === 6
    );
    fetchImpl.mockResolvedValue(jsonResponse({ ...RESOLUTION, revision: 6 }));
    expect((await client.resolvePlacement("paywall_main")).revision).toBe(6);
  });

  test("a cache fetched for another customer goes to the network", async () => {
    const storage = memoryStorage();
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(RESOLUTION));
    await makeClient(fetchImpl, storage).resolvePlacement("paywall_main");
    const other = new RevnixClient({
      ...CONFIG,
      storage,
      customerId: "cust-other",
      reportInstalls: false,
      fetch: fetchImpl,
    });

    await other.resolvePlacement("paywall_main");
    expect(placementCalls(fetchImpl)).toHaveLength(2);
    expect(String(placementCalls(fetchImpl)[1]?.[0])).toContain("customer=cust-other");
  });

  test("setAttributes and a registered purchase each send the next resolve to the network", async () => {
    const clock = fakeClock();
    const fetchImpl = jest.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).includes("/v1/purchases")
        ? jsonResponse({ eventId: "e", seq: 1, duplicate: false, customerId: "cust-pl" }, 201)
        : jsonResponse(String(url).includes("/attributes") ? {} : RESOLUTION)
    );
    const client = new RevnixClient({
      ...CONFIG,
      storage: memoryStorage(),
      customerId: "cust-pl",
      reportInstalls: false,
      fetch: fetchImpl,
      readYourWritesDelaysMs: [],
    });
    await client.resolvePlacement("paywall_main");
    clock.advance(1000);
    await client.setAttributes({ plan: "pro" });
    clock.advance(1000);
    await client.resolvePlacement("paywall_main");
    expect(placementCalls(fetchImpl)).toHaveLength(2);

    clock.advance(1000);
    await client.registerPurchase({
      source: "apple",
      token: "otx",
      productId: "pro.monthly",
      transactionId: "tx",
    });
    clock.advance(1000);
    await client.resolvePlacement("paywall_main");
    expect(placementCalls(fetchImpl)).toHaveLength(3);
  });

  test("a cache older than 24 hours goes to the network", async () => {
    const clock = fakeClock();
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(RESOLUTION))
      .mockResolvedValueOnce(jsonResponse({ ...RESOLUTION, revision: 6 }));
    const client = makeClient(fetchImpl);
    await client.resolvePlacement("paywall_main");

    clock.advance(25 * HOUR_MS);
    const resolution = await client.resolvePlacement("paywall_main");
    expect(resolution.revision).toBe(6);
    expect(placementCalls(fetchImpl)).toHaveLength(2);
  });

  test("a refresh in flight when attributes change is not served cache-first", async () => {
    const clock = fakeClock();
    const refresh = deferred<Response>();
    const fetchImpl = jest.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).includes("/attributes") ? jsonResponse({}) : jsonResponse(RESOLUTION)
    );
    const client = makeClient(fetchImpl);
    await client.resolvePlacement("paywall_main");

    clock.advance(1000);
    fetchImpl.mockReturnValueOnce(refresh.promise);
    await client.resolvePlacement("paywall_main");
    await waitFor(async () => placementCalls(fetchImpl).length === 2);
    clock.advance(1000);
    await client.setAttributes({ plan: "pro" });
    refresh.resolve(jsonResponse({ ...RESOLUTION, revision: 6 }));
    await waitFor(
      async () => (await client.getCachedPlacement("paywall_main"))?.revision === 6
    );

    clock.advance(1000);
    fetchImpl.mockResolvedValueOnce(jsonResponse({ ...RESOLUTION, revision: 7 }));
    expect((await client.resolvePlacement("paywall_main")).revision).toBe(7);
  });

  test("preload caches every key so the next resolve skips the network", async () => {
    const diagnostics: string[] = [];
    const fetchImpl = jest.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).includes("/broken/")
        ? jsonResponse({ error: "boom" }, 500)
        : jsonResponse(RESOLUTION)
    );
    const client = new RevnixClient({
      ...CONFIG,
      storage: memoryStorage(),
      customerId: "cust-pl",
      reportInstalls: false,
      fetch: fetchImpl,
      onDiagnostic: (d) => diagnostics.push(d.op),
    });
    await client.preload(["paywall_main", "onboarding", "broken"]);
    expect(placementCalls(fetchImpl)).toHaveLength(3);
    expect(diagnostics).toEqual(["resolvePlacement"]);

    fetchImpl.mockRejectedValue(new Error("offline"));
    for (const key of ["paywall_main", "onboarding"]) {
      expect(await client.resolvePlacement(key)).toMatchObject({ revision: 5, stale: false });
    }
  });

  test("paywallImageUrls collects only the fields the renderers load", () => {
    const paywall = {
      config: {
        heroImageUrl: "https://cdn.test/hero.png",
        blocks: {
          background: { color: "#000", image: { url: "https://cdn.test/bg.png" } },
          blocks: [
            { type: "image", url: "https://cdn.test/block.png" },
            { type: "image", url: "" },
            { type: "button", url: "https://cdn.test/not-an-image" },
            { type: "stack", children: [{ type: "image", url: "https://cdn.test/nested.png" }] },
          ],
        },
      },
    };
    expect(new Set(paywallImageUrls(paywall))).toEqual(
      new Set([
        "https://cdn.test/hero.png",
        "https://cdn.test/bg.png",
        "https://cdn.test/block.png",
        "https://cdn.test/nested.png",
      ])
    );
  });
});
