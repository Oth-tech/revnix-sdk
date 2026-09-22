import { describe, expect, jest, test } from "@jest/globals";
import { RevnixClient } from "./client.js";
import { memoryStorage } from "./storage.js";

// AT9: the Apple Search Ads half of install attribution, SDK side.
//
// The SDK cannot mint the token itself — `AAAttribution.attributionToken()`
// is an iOS framework call with no JavaScript binding — so the host mints it
// in a native module and hands it here. What is worth testing is the same
// refusals as `handleInstallReferrer`, plus the one real difference: this
// method resolves to the server's verdict so a host can decide whether a
// "pending" answer is worth retrying with a fresh token.

const CONFIG = { apiKey: "rvx_pk_test_abc", baseUrl: "https://demo.convex.site" };

interface RecordedCall {
  path: string;
  body?: Record<string, unknown>;
}

function stubFetch(status = 201, response: Record<string, unknown> = { ok: true }) {
  const calls: RecordedCall[] = [];
  const impl = jest.fn<typeof fetch>(async (input, init) => {
    calls.push({
      path: new URL(String(input)).pathname,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });
    return new Response(JSON.stringify(response), { status });
  });
  return { impl, calls };
}

function makeClient(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof RevnixClient>[0]> = {},
) {
  return new RevnixClient({
    ...CONFIG,
    storage: memoryStorage(),
    customerId: "cust-attribution",
    reportInstalls: false,
    fetch: fetchImpl,
    ...extra,
  });
}

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

const installsIn = (calls: RecordedCall[]) =>
  calls.filter((c) => c.path === "/v1/installs");

describe("handleAttributionToken", () => {
  test("posts the token and resolves the server's verdict", async () => {
    const { impl, calls } = stubFetch(201, { appleAttribution: "resolved" });
    const client = makeClient(impl);
    await settle();
    calls.length = 0;

    const result = await client.handleAttributionToken("abc-token");

    const posts = installsIn(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({
      customerId: "cust-attribution",
      attributionToken: "abc-token",
    });
    expect(result).toBe("resolved");
  });

  test("an over-long token is truncated to the server's bound", async () => {
    const { impl, calls } = stubFetch(201, { appleAttribution: "organic" });
    const client = makeClient(impl);
    await settle();
    calls.length = 0;

    await client.handleAttributionToken("x".repeat(3000));

    expect(
      String(installsIn(calls)[0]?.body?.attributionToken),
    ).toHaveLength(2048);
  });

  test("an empty or blank token sends nothing", async () => {
    const { impl, calls } = stubFetch();
    const client = makeClient(impl);
    await settle();
    calls.length = 0;

    const results = await Promise.all([
      client.handleAttributionToken(""),
      client.handleAttributionToken("   "),
    ]);

    expect(installsIn(calls)).toHaveLength(0);
    expect(results).toEqual([undefined, undefined]);
  });

  test("a disposed client sends nothing", async () => {
    const { impl, calls } = stubFetch();
    const client = makeClient(impl);
    await settle();
    client.dispose();
    calls.length = 0;

    const result = await client.handleAttributionToken("abc-token");

    expect(installsIn(calls)).toHaveLength(0);
    expect(result).toBeUndefined();
  });

  test("an ephemeral anonymous id sends nothing", async () => {
    const { impl, calls } = stubFetch();
    const client = makeClient(impl, {
      customerId: undefined,
      storage: undefined,
    });
    await settle();
    calls.length = 0;

    const result = await client.handleAttributionToken("abc-token");

    expect(installsIn(calls)).toHaveLength(0);
    expect(result).toBeUndefined();
  });

  test("a failed request resolves to undefined rather than rejecting", async () => {
    const { impl } = stubFetch(500, { error: "boom" });
    const client = makeClient(impl);
    await settle();

    await expect(client.handleAttributionToken("abc-token")).resolves.toBeUndefined();
  });
});
