import { describe, expect, jest, test } from "@jest/globals";
import { RevnixClient } from "./client.js";
import { PurchaseBlockedError, RevnixError } from "./errors.js";
import { purchaseInputFromIap } from "./iap.js";
import { memoryStorage } from "./storage.js";
import type { RevnixStorage } from "./types.js";

// readYourWritesDelaysMs: [] keeps the pre-M9 suites byte-identical (no
// post-purchase entitlement poll); the M9 describe below opts back in.
const CONFIG = {
  apiKey: "rvx_test_abc",
  baseUrl: "https://demo.convex.site/",
  readYourWritesDelaysMs: [] as number[],
};

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
    const client = new RevnixClient({
      ...CONFIG,
      storage: memoryStorage(),
      fetch: fetchImpl,
    });
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
  test("posts the purchase as the current customer and follows its canonical id", async () => {
    // REV-162: `customerId` is the id THIS caller should use — it differs
    // from the one sent only when identity resolution merged that id away.
    // It is no longer "whoever owns the token", which is what made following
    // it dangerous: a refused claim used to return the rightful owner here.
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
    // user_9 was merged into owner_1 — the SDK follows its own canonical id.
    expect(await client.getCustomerId()).toBe("owner_1");

    // A refused claim keeps the caller where it was. The server now returns
    // the caller's own id with `tokenOwner` naming the holder separately, so
    // there is nothing here for the SDK to adopt — this is the case that used
    // to move the device onto the other customer and unlock their
    // subscription on the next entitlements read.
    const refusedFetch = mockFetch({
      status: 201,
      body: {
        eventId: "evt2",
        seq: 8,
        duplicate: false,
        customerId: "user_9",
        ownedByOtherCustomer: true,
        tokenOwner: "victim_1",
        transferred: false,
        refused: "unverified-claim",
      },
    });
    const denied = new RevnixClient({
      ...CONFIG,
      fetch: refusedFetch,
      customerId: "user_9",
    });
    const refusedResult = await denied.registerPurchase({
      source: "apple",
      token: "otx-victim",
      productId: "pro.monthly",
      transactionId: "tx-2",
    });
    expect(refusedResult.refused).toBe("unverified-claim");
    expect(await denied.getCustomerId()).toBe("user_9");
    // And no read-your-writes poll ran against a stream that is not ours.
    expect(refusedFetch.mock.calls).toHaveLength(1);
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

  // REV-200 (M25): when a JWS is present its payload names the true
  // originalTransactionId — the token must come from there, or a renewal
  // with a missing original id mints a purchaseKey the webhook never
  // produces (double count) AND fails the server's proof match.
  test("apple: the JWS payload's originalTransactionId wins the token", () => {
    const payload = {
      originalTransactionId: "1000000456",
      transactionId: "2000000999",
    };
    const b64url = Buffer.from(JSON.stringify(payload))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const jws = `eyJhbGciOiJFUzI1NiJ9.${b64url}.c2ln`;

    const input = purchaseInputFromIap(
      {
        productId: "pro.monthly",
        transactionId: "2000000999", // a renewal; original id NOT provided
        jwsRepresentation: jws,
      },
      "apple"
    );
    expect(input.token).toBe("1000000456"); // old code: "2000000999"
    expect(input.signedTransactionInfo).toBe(jws);
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

describe("paywall view reporting", () => {
  test("logPaywallShown posts one view with a fresh viewId per call", async () => {
    const fetchImpl = mockFetch(
      { status: 201, body: { eventId: "evt1", seq: 1, duplicate: false } },
      { status: 201, body: { eventId: "evt2", seq: 2, duplicate: false } }
    );
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      reportInstalls: false,
    });
    const id = await client.getCustomerId();

    client.logPaywallShown({ placementKey: "onboarding", paywallId: "pw_1" });
    client.logPaywallShown({ placementKey: "onboarding", paywallId: "pw_1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const call = lastCall(fetchImpl);
    expect(call.url).toBe("https://demo.convex.site/v1/paywalls/viewed");
    expect(call.method).toBe("POST");
    expect(call.body).toMatchObject({
      customerId: id,
      placementKey: "onboarding",
      paywallId: "pw_1",
    });
    expect(call.body.viewId).toMatch(/^rvx_view_[0-9a-f]{32}$/);

    // Two displays → two distinct viewIds (each is a genuine view).
    const first = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const firstBody = JSON.parse(first[1].body as string) as { viewId: string };
    expect(firstBody.viewId).not.toBe(call.body.viewId);
  });

  test("a failed view report never surfaces", async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    fetchImpl.mockRejectedValueOnce(new Error("offline"));
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      reportInstalls: false,
    });
    await client.getCustomerId();
    client.logPaywallShown();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// CTO-SCALE-REVIEW M5: omitting `storage` used to silently run memory-only —
// every launch a new anonymous customer + a new install report. Now the web
// falls back to localStorage automatically, and truly memory-only mode warns
// loudly and never fabricates installs.
describe("M5: storage default behavior", () => {
  test("web: no storage configured → localStorage picked up automatically", async () => {
    const backing = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    };
    try {
      const fetchImpl = mockFetch({
        status: 201,
        body: { eventId: "evt1", seq: 1, duplicate: false },
      });
      const client = new RevnixClient({ ...CONFIG, fetch: fetchImpl });
      const id = await client.getCustomerId();
      await new Promise((r) => setTimeout(r, 0));
      // Persistent → the install IS reported, once.
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // A second client (same runtime = same localStorage) resumes the id —
      // no phantom new customer, no second install.
      const again = new RevnixClient({ ...CONFIG, fetch: fetchImpl });
      expect(await again.getCustomerId()).toBe(id);
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  test("memory-only (no storage, no localStorage): warns once and never reports installs", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl = jest.fn<typeof fetch>();
      const client = new RevnixClient({ ...CONFIG, fetch: fetchImpl });
      const id = await client.getCustomerId();
      await new Promise((r) => setTimeout(r, 0));

      expect(id).toMatch(/^rvx_anon_/); // the client still works…
      expect(fetchImpl).not.toHaveBeenCalled(); // …but fabricates NO install
      expect(
        warn.mock.calls.some(
          (c) => typeof c[0] === "string" && c[0].includes("[revnix]")
        )
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("an explicit adapter keeps full behavior (installs report)", async () => {
    const fetchImpl = mockFetch({
      status: 201,
      body: { eventId: "evt1", seq: 1, duplicate: false },
    });
    const client = new RevnixClient({
      ...CONFIG,
      storage: memoryStorage(), // explicitly chosen → developer's call
      fetch: fetchImpl,
    });
    await client.getCustomerId();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// CTO-SCALE-REVIEW M9: read-your-writes. registerPurchase re-fetches
// entitlements until the response cursor covers the purchase's seq, so the
// caller (and the C7 cache) can't observe pre-purchase state right after
// buying.
describe("M9: read-your-writes after registerPurchase", () => {
  const PURCHASE = {
    productId: "pro.monthly",
    source: "apple" as const,
    token: "orig-1",
    transactionId: "txn-1",
    occurredAt: 1,
  };
  const ENT = (cursor: number, isActive: boolean) => ({
    body: {
      customerId: "rvx_anon_x",
      cursor,
      entitlements: [{ entitlementId: "pro", isActive }],
    },
  });

  test("polls until the cursor covers the purchase, then caches the fresh read", async () => {
    const storage = memoryStorage();
    const fetchImpl = mockFetch(
      { status: 201, body: { eventId: "e1", seq: 5, duplicate: false, customerId: "rvx_anon_x" } },
      ENT(3, false), // first read: ledger cursor behind the purchase
      ENT(5, true)   // caught up — entitlement visible
    );
    const client = new RevnixClient({
      ...CONFIG,
      customerId: "rvx_anon_x",
      storage,
      fetch: fetchImpl,
      reportInstalls: false,
      readYourWritesDelaysMs: [1, 1, 1],
    });
    const result = await client.registerPurchase(PURCHASE);
    expect(result.seq).toBe(5);
    // purchase POST + 2 entitlement GETs
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // The C7 cache now holds the POST-purchase state.
    const cached = await client.getCachedEntitlements();
    expect(cached?.cursor).toBe(5);
    expect(cached?.entitlements[0]).toMatchObject({ entitlementId: "pro", isActive: true });
  });

  test("gives up after the delays run out — the purchase still resolves", async () => {
    const fetchImpl = mockFetch(
      { status: 201, body: { eventId: "e1", seq: 9, duplicate: false, customerId: "rvx_anon_x" } },
      ENT(2, false),
      ENT(2, false)
    );
    const client = new RevnixClient({
      ...CONFIG,
      customerId: "rvx_anon_x",
      storage: memoryStorage(),
      fetch: fetchImpl,
      reportInstalls: false,
      readYourWritesDelaysMs: [1],
    });
    const result = await client.registerPurchase(PURCHASE);
    expect(result.seq).toBe(9); // never throws, never spins forever
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("an entitlements failure never fails the registered purchase", async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ eventId: "e1", seq: 2, duplicate: false, customerId: "rvx_anon_x" }),
        { status: 201 }
      )
    );
    fetchImpl.mockRejectedValue(new Error("offline right after purchase"));
    const client = new RevnixClient({
      ...CONFIG,
      customerId: "rvx_anon_x",
      storage: memoryStorage(),
      fetch: fetchImpl,
      reportInstalls: false,
      readYourWritesDelaysMs: [1],
    });
    await expect(client.registerPurchase(PURCHASE)).resolves.toMatchObject({ seq: 2 });
  });
});

// REV-204 (L10): SDK hygiene contracts.
describe("REV-204 hygiene", () => {
  test("public http:// baseUrl is refused; localhost is allowed", () => {
    expect(
      () =>
        new RevnixClient({
          apiKey: "rvx_pk_test_abc",
          baseUrl: "http://api.example.com",
          storage: memoryStorage(),
          reportInstalls: false,
        })
    ).toThrow(/https/);
    expect(
      () =>
        new RevnixClient({
          apiKey: "rvx_pk_test_abc",
          baseUrl: "http://localhost:8187",
          storage: memoryStorage(),
          reportInstalls: false,
        })
    ).not.toThrow();
  });

  test("entitlement cache keeps multiple customers (identify/logout survives offline)", async () => {
    const storage = memoryStorage();
    const body = (id: string) => ({
      customerId: id,
      cursor: 1,
      entitlements: [{ entitlementId: "pro", isActive: true, sources: [] }],
    });
    const fetchA = jest
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        new Response(JSON.stringify(body("cust-a")), { status: 200 })
      );
    const a = new RevnixClient({
      ...CONFIG,
      storage,
      customerId: "cust-a",
      reportInstalls: false,
      fetch: fetchA,
    });
    await a.getEntitlements();

    const fetchB = jest
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify(body("cust-b")), { status: 200 })
      )
      .mockRejectedValue(new Error("offline"));
    const b = new RevnixClient({
      ...CONFIG,
      storage,
      customerId: "cust-b",
      reportInstalls: false,
      fetch: fetchB,
      entitlementsTtlMs: 0,
    });
    await b.getEntitlements(); // caches cust-b WITHOUT dropping cust-a
    // Offline read for cust-a still has a gate (old single-slot cache lost it).
    const backToA = new RevnixClient({
      ...CONFIG,
      storage,
      customerId: "cust-a",
      reportInstalls: false,
      fetch: jest.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    });
    const cached = await backToA.getCachedEntitlements();
    expect(cached?.entitlements[0]?.entitlementId).toBe("pro");
  });

  test("a throwing storage adapter still yields a customer id", async () => {
    const broken = {
      getItem: () => {
        throw new Error("quota");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    const client = new RevnixClient({
      ...CONFIG,
      storage: broken,
      reportInstalls: false,
      fetch: jest.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    });
    // Old behavior: customerIdPromise rejected forever → every call died here.
    const id = await client.getCustomerId();
    expect(id).toMatch(/^rvx_anon_/);
  });
});
