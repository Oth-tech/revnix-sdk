import { describe, expect, jest, test } from "@jest/globals";
import { RevnixClient } from "./client.js";
import { memoryStorage } from "./storage.js";

const CONFIG = { apiKey: "rvx_pk_test_abc", baseUrl: "https://demo.convex.site" };

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

describe("resolveDeepLink", () => {
  test("returns the server-resolved url and hits the resolve route", async () => {
    const wrapped = "https://click.mailchimp.com/track/abc";
    const fetchImpl = jest.fn<typeof fetch>(async (input) => {
      expect(String(input)).toContain(
        `/v1/links/resolve?url=${encodeURIComponent(wrapped)}`,
      );
      return new Response(
        JSON.stringify({ url: "com.voigu.app://promo?utm_source=email", hops: 2 }),
        { status: 200 },
      );
    });
    const client = makeClient(fetchImpl);

    const result = await client.resolveDeepLink(wrapped);

    expect(result).toBe("com.voigu.app://promo?utm_source=email");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("a failed request returns the input unchanged and reports via onDiagnostic", async () => {
    const onDiagnostic = jest.fn();
    const fetchImpl = jest.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });
    const client = makeClient(fetchImpl, { onDiagnostic });

    const url = "https://click.mailchimp.com/track/abc";
    const result = await client.resolveDeepLink(url);

    expect(result).toBe(url);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ op: "resolveDeepLink" }),
    );
  });

  test("an empty string is returned as-is with no request", async () => {
    const fetchImpl = jest.fn<typeof fetch>(async () => {
      throw new Error("should not be called");
    });
    const client = makeClient(fetchImpl);

    const result = await client.resolveDeepLink("   ");

    expect(result).toBe("   ");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("an app-scheme url is returned as-is with no request", async () => {
    const fetchImpl = jest.fn<typeof fetch>(async () => {
      throw new Error("should not be called");
    });
    const client = makeClient(fetchImpl);

    const url = "com.voigu.app://promo?utm_source=email";
    const result = await client.resolveDeepLink(url);

    expect(result).toBe(url);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a url over 1024 chars is returned as-is with no request", async () => {
    const fetchImpl = jest.fn<typeof fetch>(async () => {
      throw new Error("should not be called");
    });
    const client = makeClient(fetchImpl);

    const url = "https://click.mailchimp.com/track/" + "a".repeat(1025 - "https://click.mailchimp.com/track/".length);
    expect(url.length).toBe(1025);
    const result = await client.resolveDeepLink(url);

    expect(result).toBe(url);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
