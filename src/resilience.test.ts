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
