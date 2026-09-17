import { describe, expect, jest, test } from "@jest/globals";
import { RevnixClient } from "./client.js";
import { memoryStorage } from "./storage.js";

const CONFIG = { apiKey: "rvx_pk_test_abc", baseUrl: "https://demo.convex.site" };
const TOKEN = "a".repeat(64);

function stubFetch(deferredDeepLink?: { url: string; match: "exact" | "probabilistic" }) {
  return jest.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/v1/paywalls/preview/")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, deferredDeepLink }), { status: 201 });
  });
}

function makeClient(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof RevnixClient>[0]> = {},
) {
  return new RevnixClient({
    ...CONFIG,
    storage: memoryStorage(),
    reportInstalls: false,
    fetch: fetchImpl,
    ...extra,
  });
}

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("getLastDeepLink", () => {
  test("null before any link is seen", async () => {
    const client = makeClient(stubFetch());
    await settle();

    await expect(client.getLastDeepLink()).resolves.toBeNull();
  });

  test("handleDeepLink stores the url and a receivedAt timestamp", async () => {
    const client = makeClient(stubFetch());
    await settle();

    const before = Date.now();
    client.handleDeepLink("https://example.com/promo");
    await settle();
    const after = Date.now();

    const last = await client.getLastDeepLink();
    expect(last?.url).toBe("https://example.com/promo");
    expect(last?.receivedAt).toBeGreaterThanOrEqual(before);
    expect(last?.receivedAt).toBeLessThanOrEqual(after);
  });

  test("a later link overwrites the earlier one", async () => {
    const client = makeClient(stubFetch());
    await settle();

    client.handleDeepLink("https://example.com/a");
    await settle();
    client.handleDeepLink("https://example.com/b");
    await settle();

    const last = await client.getLastDeepLink();
    expect(last?.url).toBe("https://example.com/b");
  });

  test("a dashboard preview link is not stored", async () => {
    const client = makeClient(stubFetch(), { onImplicitPaywall: () => undefined });
    await settle();

    client.handleDeepLink(`voigu://revnix-preview?revnix_preview=${TOKEN}`);
    await settle();

    await expect(client.getLastDeepLink()).resolves.toBeNull();
  });

  test("a delivered deferred deep link is stored", async () => {
    const onDeferredDeepLink = jest.fn();
    const fetchImpl = stubFetch({ url: "https://app.example/promo", match: "exact" });
    const client = makeClient(fetchImpl, { reportInstalls: true, onDeferredDeepLink });
    await settle();

    expect(onDeferredDeepLink).toHaveBeenCalledTimes(1);
    const last = await client.getLastDeepLink();
    expect(last?.url).toBe("https://app.example/promo");
  });

  test("malformed stored JSON returns null", async () => {
    const storage = memoryStorage();
    const client = makeClient(stubFetch(), { storage });
    await settle();
    await storage.setItem("revnix.lastDeepLink", "{not json");

    await expect(client.getLastDeepLink()).resolves.toBeNull();
  });

  test("a throwing storage adapter returns null and never throws", async () => {
    const storage = {
      getItem: () => {
        throw new Error("storage read failed");
      },
      setItem: () => {
        throw new Error("storage write failed");
      },
    };
    const client = makeClient(stubFetch(), { storage });
    await settle();

    await expect(client.getLastDeepLink()).resolves.toBeNull();
  });

  test("a slow earlier write never overwrites a later link, and a read waits for pending writes", async () => {
    const base = memoryStorage();
    let first = true;
    const storage = {
      ...base,
      getItem: (key: string) => base.getItem(key),
      setItem: async (key: string, value: string) => {
        if (key === "revnix.lastDeepLink" && first) {
          first = false;
          await new Promise((r) => setTimeout(r, 30));
        }
        await base.setItem(key, value);
      },
    };
    const client = makeClient(stubFetch(), { storage });
    await settle();

    client.handleDeepLink("myapp://first");
    client.handleDeepLink("myapp://second");

    const last = await client.getLastDeepLink();
    expect(last?.url).toBe("myapp://second");
  });
});
