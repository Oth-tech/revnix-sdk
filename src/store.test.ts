import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { RevnixClient } from "./client.js";
import { PurchaseBlockedError, RevnixError } from "./errors.js";
import { memoryStorage } from "./storage.js";
import { setStoreAdapter, type StoreAdapter, type StoreTransaction } from "./store.js";

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
    body: init.body ? JSON.parse(init.body as string) : undefined,
  };
}

function fakeAdapter(overrides: Partial<StoreAdapter> = {}): StoreAdapter {
  return {
    purchase: overrides.purchase ?? (async () => null),
    restore: overrides.restore ?? (async () => []),
    finish: overrides.finish ?? (async () => {}),
    observe: overrides.observe ?? (() => () => {}),
  };
}

afterEach(() => {
  setStoreAdapter(null);
});

describe("purchase()", () => {
  test("rejects when no store adapter is registered", async () => {
    const client = new RevnixClient({
      ...CONFIG,
      fetch: jest.fn<typeof fetch>(),
      customerId: "cust-1",
      reportInstalls: false,
    });
    await expect(client.purchase("pro.monthly")).rejects.toThrow(
      /react-native-revnix\/store/
    );
  });

  test("resolves null when the store adapter returns null, with no purchases POST", async () => {
    const finishCalls: string[] = [];
    setStoreAdapter(
      fakeAdapter({
        purchase: async () => null,
        finish: async (id) => {
          finishCalls.push(id);
        },
      })
    );
    const fetchImpl = jest.fn<typeof fetch>();
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      customerId: "cust-1",
      reportInstalls: false,
    });

    const result = await client.purchase("pro.monthly");
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(finishCalls).toHaveLength(0);
  });

  test("registers the transaction, forwards opts, and finishes after the POST lands", async () => {
    const order: string[] = [];
    const tx: StoreTransaction = {
      store: "apple",
      productId: "pro.monthly",
      transactionId: "2001",
      token: "1001",
      occurredAt: 1000,
      expiresAt: 2000,
      signedTransactionInfo: "a.b.c",
    };
    const finishCalls: string[] = [];
    setStoreAdapter(
      fakeAdapter({
        purchase: async () => tx,
        finish: async (id) => {
          order.push("finish");
          finishCalls.push(id);
        },
      })
    );
    const fetchImpl = jest.fn<typeof fetch>().mockImplementation(async () => {
      order.push("fetch");
      return new Response(
        JSON.stringify({ eventId: "e1", seq: 1, duplicate: false, customerId: "cust-1" }),
        { status: 201 }
      );
    });
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      customerId: "cust-1",
      reportInstalls: false,
    });

    const result = await client.purchase("pro.monthly", {
      viewId: "view-1",
      placementKey: "paywall_main",
    });

    expect(order).toEqual(["fetch", "finish"]);
    expect(finishCalls).toEqual(["2001"]);
    expect(result?.seq).toBe(1);
    const call = lastCall(fetchImpl);
    expect(call.url).toBe("https://demo.convex.site/v1/purchases");
    expect(call.body).toMatchObject({
      source: "apple",
      token: "1001",
      transactionId: "2001",
      productId: "pro.monthly",
      signedTransactionInfo: "a.b.c",
      viewId: "view-1",
      placementKey: "paywall_main",
    });
  });

  test("a 409 refused claim rejects and never finishes the transaction", async () => {
    const tx: StoreTransaction = {
      store: "apple",
      productId: "pro.monthly",
      transactionId: "2001",
      token: "1001",
    };
    const finishCalls: string[] = [];
    setStoreAdapter(
      fakeAdapter({
        purchase: async () => tx,
        finish: async (id) => {
          finishCalls.push(id);
        },
      })
    );
    const fetchImpl = mockFetch({
      status: 409,
      body: { error: "purchase token belongs to another customer" },
    });
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      customerId: "cust-1",
      reportInstalls: false,
    });

    await expect(client.purchase("pro.monthly")).rejects.toBeInstanceOf(
      PurchaseBlockedError
    );
    expect(finishCalls).toHaveLength(0);
  });

  test("a permanent 403 rejects but still finishes the transaction", async () => {
    const tx: StoreTransaction = {
      store: "google",
      productId: "pro.monthly",
      transactionId: "g-token-1",
      token: "g-token-1",
    };
    const finishCalls: string[] = [];
    setStoreAdapter(
      fakeAdapter({
        purchase: async () => tx,
        finish: async (id) => {
          finishCalls.push(id);
        },
      })
    );
    const fetchImpl = mockFetch({ status: 403, body: { error: "forbidden" } });
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      customerId: "cust-1",
      reportInstalls: false,
    });

    await expect(client.purchase("pro.monthly")).rejects.toBeInstanceOf(
      RevnixError
    );
    expect(finishCalls).toEqual(["g-token-1"]);
  });

  test("a retryable failure queues the purchase and still finishes the transaction", async () => {
    const tx: StoreTransaction = {
      store: "apple",
      productId: "pro.monthly",
      transactionId: "2001",
      token: "1001",
    };
    const finishCalls: string[] = [];
    setStoreAdapter(
      fakeAdapter({
        purchase: async () => tx,
        finish: async (id) => {
          finishCalls.push(id);
        },
      })
    );
    const storage = memoryStorage();
    const fetchImpl = mockFetch({ status: 503, body: { error: "boom" } });
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      storage,
      customerId: "cust-1",
      reportInstalls: false,
    });

    await expect(client.purchase("pro.monthly")).rejects.toBeInstanceOf(
      RevnixError
    );
    expect(finishCalls).toEqual(["2001"]);
    const queued = JSON.parse(
      (await storage.getItem("revnix.pendingPurchases")) as string
    );
    expect(queued).toHaveLength(1);
    expect(queued[0].input.token).toBe("1001");
  });

  test("a throwing finish never rejects the purchase", async () => {
    const tx: StoreTransaction = {
      store: "apple",
      productId: "pro.monthly",
      transactionId: "2001",
      token: "1001",
    };
    setStoreAdapter(
      fakeAdapter({
        purchase: async () => tx,
        finish: async () => {
          throw new Error("ack failed");
        },
      })
    );
    const fetchImpl = mockFetch({
      status: 201,
      body: { eventId: "e1", seq: 1, duplicate: false, customerId: "cust-1" },
    });
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      customerId: "cust-1",
      reportInstalls: false,
    });

    const result = await client.purchase("pro.monthly");
    expect(result?.seq).toBe(1);
  });
});

describe("restore()", () => {
  const appleTx: StoreTransaction = {
    store: "apple",
    productId: "pro.monthly",
    transactionId: "a-1",
    token: "orig-a-1",
  };
  const googleTx: StoreTransaction = {
    store: "google",
    productId: "pro.monthly",
    transactionId: "g-token-1",
    token: "g-token-1",
  };

  test("registers every transaction, only acknowledging the Google token", async () => {
    const finishCalls: string[] = [];
    setStoreAdapter(
      fakeAdapter({
        restore: async () => [appleTx, googleTx],
        finish: async (id) => {
          finishCalls.push(id);
        },
      })
    );
    const fetchImpl = mockFetch(
      { status: 201, body: { eventId: "e1", seq: 1, duplicate: false, customerId: "cust-1" } },
      { status: 201, body: { eventId: "e2", seq: 2, duplicate: false, customerId: "cust-1" } }
    );
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      customerId: "cust-1",
      reportInstalls: false,
    });

    const restored = await client.restore();
    expect(restored).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(finishCalls).toEqual(["g-token-1"]);
  });

  test("one purchase failing to register does not fail the whole restore", async () => {
    const finishCalls: string[] = [];
    setStoreAdapter(
      fakeAdapter({
        restore: async () => [appleTx, googleTx],
        finish: async (id) => {
          finishCalls.push(id);
        },
      })
    );
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "boom" }), { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ eventId: "e2", seq: 2, duplicate: false, customerId: "cust-1" }),
          { status: 201 }
        )
      );
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      customerId: "cust-1",
      reportInstalls: false,
    });

    const restored = await client.restore();
    expect(restored).toBe(1);
    expect(finishCalls).toEqual(["g-token-1"]);
  });
});

describe("store observer wiring", () => {
  test("a transaction pushed through the observer registers and finishes; dispose unsubscribes", async () => {
    let observedCallback: ((tx: StoreTransaction) => void) | undefined;
    let unsubscribed = false;
    const finishCalls: string[] = [];
    setStoreAdapter(
      fakeAdapter({
        observe: (cb) => {
          observedCallback = cb;
          return () => {
            unsubscribed = true;
          };
        },
        finish: async (id) => {
          finishCalls.push(id);
        },
      })
    );
    const fetchImpl = mockFetch({
      status: 201,
      body: { eventId: "e1", seq: 1, duplicate: false, customerId: "cust-1" },
    });
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      customerId: "cust-1",
      reportInstalls: false,
    });

    expect(observedCallback).toBeDefined();
    observedCallback?.({
      store: "apple",
      productId: "pro.monthly",
      transactionId: "renew-1",
      token: "orig-renew-1",
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(finishCalls).toEqual(["renew-1"]);

    client.dispose();
    expect(unsubscribed).toBe(true);
  });

  test("a store adapter registered after construction skips the observer, but purchase still works", async () => {
    const observeSpy = jest.fn(() => () => {});
    const fetchImpl = mockFetch({
      status: 201,
      body: { eventId: "e1", seq: 1, duplicate: false, customerId: "cust-1" },
    });
    const client = new RevnixClient({
      ...CONFIG,
      fetch: fetchImpl,
      customerId: "cust-1",
      reportInstalls: false,
    });

    const finishCalls: string[] = [];
    const tx: StoreTransaction = {
      store: "apple",
      productId: "pro.monthly",
      transactionId: "2001",
      token: "1001",
    };
    setStoreAdapter(
      fakeAdapter({
        purchase: async () => tx,
        observe: observeSpy,
        finish: async (id) => {
          finishCalls.push(id);
        },
      })
    );
    expect(observeSpy).not.toHaveBeenCalled();

    const result = await client.purchase("pro.monthly");
    expect(result?.seq).toBe(1);
    expect(finishCalls).toEqual(["2001"]);
  });
});
