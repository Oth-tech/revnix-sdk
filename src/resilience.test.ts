import { describe, expect, jest, test } from "@jest/globals";
import { RevnixClient } from "./client.js";
import {
  RevnixNetworkError,
  RevnixRateLimitError,
  RevnixTimeoutError,
} from "./errors.js";
import { memoryStorage } from "./storage.js";

// C7: SDK resilience — request timeouts, offline entitlement cache, and a
// persisted purchase retry queue.

const CONFIG = { apiKey: "rvx_pk_test_abc", baseUrl: "https://demo.convex.site" };

const ENT_BODY = {
  customerId: "cust-c7",
  cursor: 5,
  entitlements: [{ entitlementId: "pro", isActive: true, sources: [] }],
};

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("C7 request timeout", () => {
  test("a hung request rejects with RevnixTimeoutError, not a hang", async () => {
    // Never resolves; only rejects when the timeout aborts the signal.
    const hangFetch = jest.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
    );
    const client = new RevnixClient({
      ...CONFIG,
      storage: memoryStorage(),
      reportInstalls: false,
      fetch: hangFetch,
      requestTimeoutMs: 40,
    });
    await expect(client.resolvePlacement("main")).rejects.toBeInstanceOf(
      RevnixTimeoutError
    );
  });
});

describe("C7 typed errors", () => {
  test("429 → RevnixRateLimitError with retryAfterMs", async () => {
    const fetch429 = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ error: "rate limit exceeded" }, 429, {
          "Retry-After": "2",
        })
      );
    const client = new RevnixClient({
      ...CONFIG,
      storage: memoryStorage(),
      reportInstalls: false,
      fetch: fetch429,
    });
    const err = await client.resolvePlacement("main").catch((e) => e);
    expect(err).toBeInstanceOf(RevnixRateLimitError);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.isRetryable).toBe(true);
  });

  test("a network failure → RevnixNetworkError", async () => {
    const offline = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("Network request failed"));
    const client = new RevnixClient({
      ...CONFIG,
      storage: memoryStorage(),
      reportInstalls: false,
      fetch: offline,
    });
    await expect(client.resolvePlacement("main")).rejects.toBeInstanceOf(
      RevnixNetworkError
    );
  });
});

describe("C7 entitlement cache", () => {
  test("falls back to cached entitlements when the network read fails", async () => {
    const storage = memoryStorage();
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(ENT_BODY)) // 1st: live
      .mockRejectedValueOnce(new Error("offline")); // 2nd: down
    const client = new RevnixClient({
      ...CONFIG,
      storage,
      customerId: "cust-c7",
      reportInstalls: false,
      fetch: fetchImpl,
      // REV-199: this test exercises the offline fallback, so the soft TTL
      // must not answer the second read from memory.
      entitlementsTtlMs: 0,
    });

    const fresh = await client.getEntitlements();
    expect(fresh.stale).toBe(false);
    expect(fresh.entitlements[0]?.entitlementId).toBe("pro");

    // Network is down now → the paying customer is still shown as entitled.
    const cached = await client.getEntitlements();
    expect(cached.stale).toBe(true);
    expect(cached.entitlements[0]?.isActive).toBe(true);
    expect(await client.isEntitled("pro")).toBe(true);
  });

  test("getCachedEntitlements reads the cache with no network call", async () => {
    const storage = memoryStorage();
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(ENT_BODY));
    const client = new RevnixClient({
      ...CONFIG,
      storage,
      customerId: "cust-c7",
      reportInstalls: false,
      fetch: fetchImpl,
    });
    expect(await client.getCachedEntitlements()).toBeNull(); // nothing yet
    await client.getEntitlements(); // caches
    const cached = await client.getCachedEntitlements();
    expect(cached?.stale).toBe(true);
    expect(cached?.entitlements[0]?.entitlementId).toBe("pro");
    // Only the one live fetch happened.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("REV-157 local expiry on cached entitlements", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function entBody(expiresAt?: number) {
    return {
      customerId: "cust-c7",
      cursor: 5,
      entitlements: [
        { entitlementId: "pro", isActive: true, expiresAt, sources: [] },
      ],
    };
  }

  async function cachedServe(expiresAt?: number) {
    const storage = memoryStorage();
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(entBody(expiresAt))) // 1st: live
      .mockRejectedValue(new Error("offline")); // then: down
    const client = new RevnixClient({
      ...CONFIG,
      storage,
      customerId: "cust-c7",
      reportInstalls: false,
      fetch: fetchImpl,
      // REV-199: these tests exercise the cache-served path — TTL off.
      entitlementsTtlMs: 0,
    });
    const fresh = await client.getEntitlements();
    // The fresh read is authoritative — served verbatim even when the local
    // clock disagrees.
    expect(fresh.entitlements[0]?.isActive).toBe(true);
    return { client, cached: await client.getEntitlements() };
  }

  test("expired beyond the 3-day grace → served inactive from cache", async () => {
    const { client, cached } = await cachedServe(Date.now() - 5 * DAY_MS);
    expect(cached.stale).toBe(true);
    expect(cached.entitlements[0]?.isActive).toBe(false);
    expect(await client.isEntitled("pro")).toBe(false);
  });

  test("expired within the grace → still active (the renewal an offline device cannot see)", async () => {
    const { client, cached } = await cachedServe(Date.now() - 1 * DAY_MS);
    expect(cached.stale).toBe(true);
    expect(cached.entitlements[0]?.isActive).toBe(true);
    expect(await client.isEntitled("pro")).toBe(true);
  });

  test("no expiresAt (lifetime/grant) → untouched", async () => {
    const { cached } = await cachedServe(undefined);
    expect(cached.entitlements[0]?.isActive).toBe(true);
  });

  test("getCachedEntitlements applies the same evaluation", async () => {
    const { client } = await cachedServe(Date.now() - 5 * DAY_MS);
    const cached = await client.getCachedEntitlements();
    expect(cached?.entitlements[0]?.isActive).toBe(false);
  });
});

describe("C7 persisted purchase retry", () => {
  const PURCHASE = {
    source: "apple" as const,
    token: "otx-1",
    productId: "pro.monthly",
    transactionId: "tx-1",
  };

  test("a failed registerPurchase is queued, then drained on retry", async () => {
    const storage = memoryStorage();
    const offline = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("offline"));
    const client = new RevnixClient({
      ...CONFIG,
      storage,
      customerId: "cust-p",
      reportInstalls: false,
      fetch: offline,
    });

    await expect(client.registerPurchase(PURCHASE)).rejects.toBeInstanceOf(
      RevnixNetworkError
    );
    const queued = JSON.parse(
      (await storage.getItem("revnix.pendingPurchases")) as string
    );
    expect(queued).toHaveLength(1);
    expect(queued[0].input.token).toBe("otx-1");

    // A later launch with connectivity drains the queue (idempotent server-side).
    const okFetch = jest.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          eventId: "e1",
          seq: 3,
          duplicate: false,
          customerId: "cust-p",
          transferred: false,
        },
        201
      )
    );
    const client2 = new RevnixClient({
      ...CONFIG,
      storage,
      customerId: "cust-p",
      reportInstalls: false,
      fetch: okFetch,
    });
    await client2.retryPendingPurchases();

    const after = JSON.parse(
      (await storage.getItem("revnix.pendingPurchases")) as string
    );
    expect(after).toHaveLength(0);
    expect(okFetch).toHaveBeenCalled();
  });

  test("the same failing purchase is not queued twice", async () => {
    const storage = memoryStorage();
    const offline = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("offline"));
    const client = new RevnixClient({
      ...CONFIG,
      storage,
      customerId: "cust-p",
      reportInstalls: false,
      fetch: offline,
    });
    await client.registerPurchase(PURCHASE).catch(() => {});
    await client.registerPurchase(PURCHASE).catch(() => {});
    const queued = JSON.parse(
      (await storage.getItem("revnix.pendingPurchases")) as string
    );
    expect(queued).toHaveLength(1);
  });
});

// REV-198 (M22): the cache rides out transient failures only — a deliberate
// server answer must surface, or there is no kill switch.
describe("REV-198 cache fallback discipline", () => {
  test("a 401 (revoked key) is NOT papered over by the cache", async () => {
    const storage = memoryStorage();
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(ENT_BODY)) // warm the cache
      .mockResolvedValue(jsonResponse({ error: "revoked" }, 401));
    const client = new RevnixClient({
      ...CONFIG,
      storage,
      customerId: "cust-c7",
      reportInstalls: false,
      fetch: fetchImpl,
      entitlementsTtlMs: 0,
    });
    await client.getEntitlements(); // cached
    await expect(client.getEntitlements()).rejects.toMatchObject({
      status: 401,
    });
  });

  test("a 404 unknown placement is NOT papered over by the cache", async () => {
    const storage = memoryStorage();
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ status: "ok", placementKey: "main", revision: 1 })
      )
      .mockResolvedValue(jsonResponse({ error: "unknown placement" }, 404));
    const client = new RevnixClient({
      ...CONFIG,
      storage,
      reportInstalls: false,
      fetch: fetchImpl,
    });
    await client.resolvePlacement("main"); // cached
    await expect(client.resolvePlacement("main")).rejects.toMatchObject({
      status: 404,
    });
  });

  test("a 500 still falls back to the cache (that is what it is for)", async () => {
    const storage = memoryStorage();
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(ENT_BODY))
      .mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    const client = new RevnixClient({
      ...CONFIG,
      storage,
      customerId: "cust-c7",
      reportInstalls: false,
      fetch: fetchImpl,
      entitlementsTtlMs: 0,
    });
    await client.getEntitlements();
    const cached = await client.getEntitlements();
    expect(cached.stale).toBe(true);
    expect(cached.entitlements[0]?.isActive).toBe(true);
  });
});

// REV-198 (M23): fetchedAt bounds how long a stale snapshot grants access.
describe("REV-198 offline cache age bound", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  async function serveWithFetchedAt(fetchedAt: number) {
    const storage = memoryStorage();
    await storage.setItem(
      "revnix.entitlements",
      JSON.stringify({ customerId: "cust-c7", data: ENT_BODY, fetchedAt })
    );
    const offline = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("offline"));
    const client = new RevnixClient({
      ...CONFIG,
      storage,
      customerId: "cust-c7",
      reportInstalls: false,
      fetch: offline,
      entitlementsTtlMs: 0,
    });
    return client.getEntitlements();
  }

  test("a lifetime entitlement stops granting past the offline window", async () => {
    const tooOld = await serveWithFetchedAt(Date.now() - 15 * DAY_MS);
    expect(tooOld.stale).toBe(true);
    expect(tooOld.entitlements[0]?.isActive).toBe(false);
  });

  test("within the window it still grants", async () => {
    const recent = await serveWithFetchedAt(Date.now() - 13 * DAY_MS);
    expect(recent.entitlements[0]?.isActive).toBe(true);
  });

  test("a rolled-back clock (now before fetchedAt) stops granting", async () => {
    const future = await serveWithFetchedAt(Date.now() + 60 * 60 * 1000);
    expect(future.entitlements[0]?.isActive).toBe(false);
  });
});

// REV-199 (M21): soft TTL + in-flight coalescing on entitlement reads.
describe("REV-199 entitlement read TTL + coalescing", () => {
  test("reads within the TTL cost one request; concurrent reads share one", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(ENT_BODY));
    const client = new RevnixClient({
      ...CONFIG,
      storage: memoryStorage(),
      customerId: "cust-c7",
      reportInstalls: false,
      fetch: fetchImpl,
    });
    // Concurrent burst → one request.
    await Promise.all([
      client.isEntitled("pro"),
      client.isEntitled("pro"),
      client.getEntitlements(),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Within the TTL → still one.
    await client.getEntitlements();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("entitlementsTtlMs: 0 restores always-fetch", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(ENT_BODY));
    const client = new RevnixClient({
      ...CONFIG,
      storage: memoryStorage(),
      customerId: "cust-c7",
      reportInstalls: false,
      fetch: fetchImpl,
      entitlementsTtlMs: 0,
    });
    await client.getEntitlements();
    await client.getEntitlements();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
