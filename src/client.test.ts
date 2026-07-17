import { describe, expect, jest, test } from "@jest/globals";
import { RevnixClient } from "./client";
import { PurchaseBlockedError, RevnixError } from "./errors";
import { purchaseInputFromIap } from "./iap";
import { memoryStorage } from "./storage";
import type { RevnixStorage } from "./types";

const CONFIG = { apiKey: "rvx_test_abc", baseUrl: "https://demo.convex.site/" };

type FetchMock = jest.Mock<typeof fetch>;

function mockFetch(
  ...responses: Array<{ status?: number; body: unknown }>
): FetchMock {
  const fn = jest.fn<typeof fetch>();
  for (const r of responses) {
    fn.mockResolvedValueOnce(
      new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
    );
  }
  return fn;
}

function lastCall(fetchImpl: FetchMock) {
  const calls = fetchImpl.mock.calls;
  const [url, init] = calls[calls.length - 1] as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  };
}

describe("customer id lifecycle", () => {
  test("generates and persists an anonymous id on first launch", async () => {
    const storage = memoryStorage();
    const client = new RevnixClient({
      ...CONFIG,
      storage,
      reportInstalls: false,
    });
    const id = await client.getCustomerId();
    expect(id).toMatch(/^rvx_anon_[0-9a-f]{32}$/);

    // A second client over the same storage resumes the same customer.
    const again = new RevnixClient({
      ...CONFIG,
      storage,
      reportInstalls: false,
    });
    expect(await again.getCustomerId()).toBe(id);
  });

  test("reports an install once when a fresh anonymous id is generated", async () => {
    const storage = memoryStorage();
    const fetchImpl = mockFetch({
      status: 201,
      body: { eventId: "evt1", seq: 1, duplicate: false },
    });
    const client = new RevnixClient({ ...CONFIG, storage, fetch: fetchImpl });
    const id = await client.getCustomerId();
    // The report is fire-and-forget — let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = lastCall(fetchImpl);
    expect(call.url).toBe("https://demo.convex.site/v1/installs");
    expect(call.body).toMatchObject({ customerId: id });

    // Resuming the stored id is not a new install.
    const again = new RevnixClient({ ...CONFIG, storage, fetch: fetchImpl });
    await again.getCustomerId();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("a failed install report never surfaces", async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    fetchImpl.mockRejectedValueOnce(new Error("offline"));
    const client = new RevnixClient({ ...CONFIG, fetch: fetchImpl });
    const id = await client.getCustomerId();
    await new Promise((r) => setTimeout(r, 0));
    expect(id).toMatch(/^rvx_anon_/);
  });

  test("identify merges the anonymous customer and adopts the canonical id", async () => {
    const fetchImpl = mockFetch({
      body: { canonicalId: "user_42", merged: true },
    });
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      reportInstalls: false,
    });
    const anonId = await client.getCustomerId();

    const result = await client.identify("user_42");
    expect(result).toEqual({ canonicalId: "user_42", merged: true });
    expect(await client.getCustomerId()).toBe("user_42");

    const call = lastCall(fetchImpl);
    expect(call.url).toBe("https://demo.convex.site/v1/identify");
    expect(call.headers.Authorization).toBe("Bearer rvx_test_abc");
    expect(call.body).toEqual({ previousId: anonId, newId: "user_42" });
  });

  test("identify is a no-op when already that customer; logout starts fresh", async () => {
    const fetchImpl = mockFetch();
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      customerId: "user_42",
    });

    const result = await client.identify("user_42");
    expect(result).toEqual({ canonicalId: "user_42", merged: false });
    expect(fetchImpl).not.toHaveBeenCalled();

    const fresh = await client.logout();
    expect(fresh).toMatch(/^rvx_anon_/);
    expect(await client.getCustomerId()).toBe(fresh);
  });
});

describe("registerPurchase", () => {
  test("posts the purchase as the current customer and follows a transfer", async () => {
    const fetchImpl = mockFetch({
      status: 201,
      body: {
        eventId: "evt1",
        seq: 7,
        duplicate: false,
        customerId: "owner_1",
        transferred: true,
      },
    });
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      customerId: "user_9",
    });

    const result = await client.registerPurchase({
      source: "apple",
      token: "otx-1",
      productId: "pro.monthly",
      transactionId: "tx-1",
      occurredAt: 1000,
    });
    expect(result.seq).toBe(7);

    const call = lastCall(fetchImpl);
    expect(call.url).toBe("https://demo.convex.site/v1/purchases");
    expect(call.body).toMatchObject({
      customerId: "user_9",
      source: "apple",
      token: "otx-1",
      transactionId: "tx-1",
    });
    // The backend resolved ownership to owner_1 — the SDK follows.
    expect(await client.getCustomerId()).toBe("owner_1");
  });

  test("409 surfaces as PurchaseBlockedError, other failures as RevnixError", async () => {
    const fetchImpl = mockFetch(
      { status: 409, body: { error: "purchase token belongs to another customer" } },
      { status: 401, body: { error: "Unknown or revoked API key" } }
    );
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      customerId: "user_9",
    });

    const input = {
      source: "apple" as const,
      token: "otx-1",
      productId: "pro.monthly",
      transactionId: "tx-1",
    };
    await expect(client.registerPurchase(input)).rejects.toThrow(
      PurchaseBlockedError
    );
    await expect(client.getEntitlements()).rejects.toThrow(RevnixError);
  });
});

describe("reads", () => {
  test("entitlements + isEntitled use the current customer id, url-encoded", async () => {
    const body = {
      customerId: "user 9",
      cursor: 3,
      entitlements: [
        { entitlementId: "pro", isActive: true, sources: [] },
        { entitlementId: "extra", isActive: false, sources: [] },
      ],
    };
    const fetchImpl = mockFetch({ body }, { body });
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      customerId: "user 9",
    });

    const ents = await client.getEntitlements();
    expect(ents.cursor).toBe(3);
    expect(lastCall(fetchImpl).url).toBe(
      "https://demo.convex.site/v1/customers/user%209/entitlements"
    );
    expect(await client.isEntitled("pro")).toBe(true);
  });

  test("resolvePlacement hits the placements endpoint", async () => {
    const fetchImpl = mockFetch({
      body: { status: "ok", placementKey: "paywall_main", revision: 2, offering: null },
    });
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      reportInstalls: false,
    });
    const res = await client.resolvePlacement("paywall_main");
    expect(res.revision).toBe(2);
    expect(lastCall(fetchImpl).url).toBe(
      "https://demo.convex.site/v1/placements/paywall_main/offering"
    );
  });
});

describe("purchaseInputFromIap", () => {
  test("apple: original transaction id is the token, falls back to transactionId", () => {
    expect(
      purchaseInputFromIap(
        {
          productId: "pro.monthly",
          transactionId: "2000000123",
          transactionDate: 1720000000000,
          originalTransactionIdentifierIOS: "1000000456",
        },
        "apple"
      )
    ).toMatchObject({ source: "apple", token: "1000000456", transactionId: "2000000123" });

    expect(
      purchaseInputFromIap(
        { productId: "pro.monthly", transactionId: "2000000123" },
        "apple"
      ).token
    ).toBe("2000000123");
  });

  test("google: purchaseToken doubles as transactionId (RTDN reports the token)", () => {
    const input = purchaseInputFromIap(
      {
        productId: "pro.monthly",
        transactionId: "GPA.1234-5678",
        purchaseToken: "g-token-1",
      },
      "google"
    );
    expect(input).toMatchObject({
      source: "google",
      token: "g-token-1",
      transactionId: "g-token-1",
    });
  });

  test("missing identifiers throw", () => {
    expect(() =>
      purchaseInputFromIap({ productId: "p" }, "apple")
    ).toThrow(/transactionId/);
    expect(() =>
      purchaseInputFromIap({ productId: "p", transactionId: "t" }, "google")
    ).toThrow(/purchaseToken/);
  });
});

describe("async storage adapters", () => {
  test("works with a promise-based storage (AsyncStorage-style)", async () => {
    const map = new Map<string, string>();
    const storage: RevnixStorage = {
      getItem: async (k) => map.get(k) ?? null,
      setItem: async (k, v) => {
        map.set(k, v);
      },
    };
    const client = new RevnixClient({ ...CONFIG, storage, reportInstalls: false });
    const id = await client.getCustomerId();
    expect(map.get("revnix.customerId")).toBe(id);
  });
});
