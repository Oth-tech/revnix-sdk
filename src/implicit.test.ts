import { describe, expect, jest, test } from "@jest/globals";
import { RevnixClient } from "./client.js";
import {
  browserLifecycle,
  DEFAULT_SESSION_TIMEOUT_MS,
  HOST_CALL_PLACEMENT,
  IMPLICIT_PLACEMENTS,
  PREVIEW_PLACEMENT_KEY,
  type RevnixLifecycle,
} from "./implicit.js";
import { memoryStorage } from "./storage.js";
import type { ImplicitResolution, PlacementResolution } from "./types.js";

const CONFIG = { apiKey: "rvx_pk_test_abc", baseUrl: "https://demo.convex.site" };

const RESOLUTION: PlacementResolution = {
  status: "ok",
  placementKey: "app_launch",
  revision: 5,
  offering: {
    offeringId: "default",
    displayName: "Default",
    packages: [{ packageId: "monthly", productId: "pro.monthly", product: null }],
  },
  paywall: { paywallId: "pw_launch", name: "Launch", config: {} },
  experiment: null,
} as PlacementResolution;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** A fetch that answers /v1/config with `configured` and every trigger with
 *  `RESOLUTION`, recording the paths it was asked for. */
function stubFetch(configured: string[], triggerBody: unknown = RESOLUTION) {
  const calls: RecordedCall[] = [];
  const impl = jest.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ path, body });
    if (path === "/v1/config") {
      return jsonResponse({ revision: 1, implicitPlacements: configured });
    }
    if (path === "/v1/placements/triggered") {
      return jsonResponse(triggerBody);
    }
    return jsonResponse({ ok: true }, 201);
  });
  return { impl, calls };
}

function makeClient(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof RevnixClient>[0]> = {}
) {
  return new RevnixClient({
    ...CONFIG,
    storage: memoryStorage(),
    customerId: "cust-implicit",
    reportInstalls: false,
    fetch: fetchImpl,
    ...extra,
  });
}

/** Let the constructor's fire-and-forget launch work settle. */
async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A lifecycle adapter a test can drive by hand. */
function manualLifecycle() {
  let handler: ((state: "foreground" | "background") => void) | null = null;
  const lifecycle: RevnixLifecycle = {
    onStateChange: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
  };
  return {
    lifecycle,
    foreground: () => handler?.("foreground"),
    background: () => handler?.("background"),
    get subscribed() {
      return handler !== null;
    },
  };
}


interface RecordedCall {
  path: string;
  body?: Record<string, unknown>;
}

const triggersIn = (calls: RecordedCall[]) =>
  calls.filter((c) => c.path === "/v1/placements/triggered");

describe("the vocabulary matches the server's", () => {
  test("six keys, lowercase, in contract order", () => {
    // The server 400s a key it does not know, and the failure is silent from
    // the app's side (the moment simply never fires), so this list drifting
    // is the one bug here nobody would notice in the field.
    expect([...IMPLICIT_PLACEMENTS]).toEqual([
      "app_install",
      "app_launch",
      "session_start",
      "deeplink_open",
      "paywall_decline",
      "transaction_abandon",
    ]);
    for (const key of IMPLICIT_PLACEMENTS) {
      expect(key).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
    }
  });

  test("the deep link moment is the one needing a host call", () => {
    expect(HOST_CALL_PLACEMENT).toBe("deeplink_open");
  });

  test("a session is 30 minutes away, matching every other Revnix SDK", () => {
    expect(DEFAULT_SESSION_TIMEOUT_MS).toBe(30 * 60_000);
  });
});

describe("opting in", () => {
  test("no handler means no requests at all — not even /v1/config", async () => {
    // The default has to be free. Asking /v1/config for every app in the
    // fleet, including the overwhelming majority that configured none of the
    // six, is exactly the cost this feature is designed to avoid.
    const { impl, calls } = stubFetch(["app_launch"]);
    makeClient(impl);
    await settle();
    expect(calls).toEqual([]);
  });

  test("a handler turns it on and the launch moments fire", async () => {
    const { impl, calls } = stubFetch(["app_launch", "session_start"]);
    const seen: string[] = [];
    makeClient(impl, { onImplicitPaywall: (t) => seen.push(t.placement) });
    await settle();

    expect(calls.filter((c) => c.path === "/v1/config")).toHaveLength(1);
    // A cold start is both a launch and a session; app_install did not fire
    // because this client was handed an explicit customerId.
    expect(triggersIn(calls).map((c) => c.body?.placement)).toEqual([
      "app_launch",
      "session_start",
    ]);
    // Both reported, ONE presented — see the coalescing test below.
    expect(seen).toEqual(["app_launch"]);
  });

  test("a cold start hands the host ONE paywall, however many moments are configured", async () => {
    // All three launch moments configured, all three resolving to a paywall.
    // Three paywalls pushed onto the first frame is not a feature.
    const { impl, calls } = stubFetch(["app_install", "app_launch", "session_start"]);
    const seen: string[] = [];
    // No customerId → a fresh anonymous id → this launch is the install.
    new RevnixClient({
      ...CONFIG,
      storage: memoryStorage(),
      reportInstalls: false,
      fetch: impl,
      onImplicitPaywall: (t) => seen.push(t.placement),
    });
    await settle();

    // Every moment is still REPORTED — a launch is a launch — most specific
    // first, but only the first paywall reaches the host.
    expect(triggersIn(calls).map((c) => c.body?.placement)).toEqual([
      "app_install",
      "app_launch",
      "session_start",
    ]);
    expect(seen).toEqual(["app_install"]);
  });

  test("when the first launch moment has no paywall, the next one may present", async () => {
    const withPaywall = new Set(["session_start"]);
    const impl = jest.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/config") {
        return jsonResponse({
          revision: 1,
          implicitPlacements: ["app_launch", "session_start"],
        });
      }
      const body = JSON.parse(String(init?.body)) as { placement: string };
      return jsonResponse({
        ...RESOLUTION,
        paywall: withPaywall.has(body.placement) ? RESOLUTION.paywall : null,
      });
    });
    const seen: string[] = [];
    makeClient(impl, { onImplicitPaywall: (t) => seen.push(t.placement) });
    await settle();
    expect(seen).toEqual(["session_start"]);
  });

  test("implicitPlacements:false wins over a handler", async () => {
    const { impl, calls } = stubFetch(["app_launch"]);
    makeClient(impl, {
      implicitPlacements: false,
      onImplicitPaywall: () => undefined,
    });
    await settle();
    expect(calls).toEqual([]);
  });

  test("an app that configured NOTHING asks once, plus one report per deep link", async () => {
    const { impl, calls } = stubFetch([]);
    const client = makeClient(impl, { onImplicitPaywall: () => undefined });
    await settle();
    client.handleDeepLink("https://example.com/promo");
    await settle();

    expect(calls.map((c) => c.path)).toEqual([
      "/v1/config",
      "/v1/placements/triggered",
    ]);
    expect(triggersIn(calls)[0]?.body?.resolve).toBe(false);
  });

  test("/v1/config is asked ONCE, however many moments fire", async () => {
    const { impl, calls } = stubFetch(["app_launch", "session_start", "deeplink_open"]);
    const client = makeClient(impl, { onImplicitPaywall: () => undefined });
    await settle();
    client.handleDeepLink("https://example.com/promo");
    await settle();

    expect(calls.filter((c) => c.path === "/v1/config")).toHaveLength(1);
    expect(triggersIn(calls)).toHaveLength(3);
  });

  test("a /v1/config failure costs the feature, not the app", async () => {
    // Implicit placements are a bonus on top of the app. A config route that
    // is down must not make the SDK retry forever or throw into the host.
    const impl = jest.fn<typeof fetch>(async (input) => {
      if (new URL(String(input)).pathname === "/v1/config") {
        throw new Error("offline");
      }
      return jsonResponse(RESOLUTION);
    });
    const diagnostics: string[] = [];
    const seen: string[] = [];
    const client = makeClient(impl, {
      onImplicitPaywall: (t) => seen.push(t.placement),
      onDiagnostic: (event) => diagnostics.push(event.op),
    });
    await settle();
    client.handleDeepLink("https://example.com/x");
    await settle();

    expect(diagnostics).toContain("implicitConfig");
    const triggers = impl.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === "/v1/placements/triggered"
    );
    expect(triggers).toHaveLength(1);
    const [, init] = triggers[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.resolve).toBe(false);
    expect(seen).toEqual([]);
  });

  test("a failed /v1/config is retried after the hold, not memoised for the session", async () => {
    let configCalls = 0;
    const impl = jest.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/config") {
        configCalls += 1;
        if (configCalls === 1) throw new Error("offline");
        return jsonResponse({ revision: 1, implicitPlacements: ["paywall_decline"] });
      }
      return jsonResponse(RESOLUTION);
    });
    const now = jest.spyOn(Date, "now");
    const t0 = 1_700_000_000_000;
    now.mockReturnValue(t0);
    const seen: string[] = [];
    const client = makeClient(impl, {
      onImplicitPaywall: (t) => seen.push(t.placement),
    });
    await settle();
    expect(seen).toEqual([]);

    // Inside the hold: answered "none" without a request.
    const viewId1 = client.logPaywallShown({
      placementKey: "premium_button",
      paywallId: "pw_sale",
    });
    await settle();
    client.logPaywallClosed(viewId1, {
      placementKey: "premium_button",
      paywallId: "pw_sale",
    });
    await settle();
    expect(configCalls).toBe(1);
    expect(seen).toEqual([]);

    // An hour later, on good network.
    now.mockReturnValue(t0 + 60 * 60_000);
    const viewId2 = client.logPaywallShown({
      placementKey: "premium_button",
      paywallId: "pw_sale",
    });
    await settle();
    client.logPaywallClosed(viewId2, {
      placementKey: "premium_button",
      paywallId: "pw_sale",
    });
    await settle();
    expect(configCalls).toBe(2);
    expect(seen).toEqual(["paywall_decline"]);
    now.mockRestore();
  });
});

describe("what the handler receives", () => {
  test("a resolution with no paywall is not handed over", async () => {
    // `skipReason: "not_configured"` means the operator removed the placement
    // between the config read and now. There is nothing to present.
    const { impl } = stubFetch(["app_launch"], {
      ...RESOLUTION,
      paywall: null,
      skipReason: "not_configured",
      recorded: false,
    });
    const seen: unknown[] = [];
    makeClient(impl, { onImplicitPaywall: (t) => seen.push(t) });
    await settle();
    expect(seen).toEqual([]);
  });

  test("skipReason and recorded survive onto the resolution", async () => {
    const { impl } = stubFetch(["app_launch"], {
      ...RESOLUTION,
      skipReason: null,
      recorded: true,
    });
    const seen: ImplicitResolution[] = [];
    makeClient(impl, { onImplicitPaywall: (t) => seen.push(t.resolution) });
    await settle();
    expect(seen[0]?.recorded).toBe(true);
    expect(seen[0]?.paywall?.paywallId).toBe("pw_launch");
  });

  test("a throwing handler is reported, never rethrown into the SDK", async () => {
    const { impl } = stubFetch(["app_launch"]);
    const diagnostics: string[] = [];
    makeClient(impl, {
      onImplicitPaywall: () => {
        throw new Error("navigation blew up");
      },
      onDiagnostic: (event) => diagnostics.push(event.op),
    });
    await settle();
    expect(diagnostics).toContain("onImplicitPaywall");
  });
});

describe("the loop guard", () => {
  test("dismissing an implicitly-shown paywall does NOT fire another trigger", async () => {
    // The loop this prevents: decline → win-back paywall → decline → win-back,
    // with no way out but force-quitting.
    const { impl, calls } = stubFetch(["paywall_decline"]);
    const client = makeClient(impl, { onImplicitPaywall: () => undefined });
    await settle();

    const viewId = client.logPaywallShown({
      placementKey: "paywall_decline",
      paywallId: "pw_winback",
    });
    await settle();
    client.logPaywallClosed(viewId, {
      placementKey: "paywall_decline",
      paywallId: "pw_winback",
    });
    await settle();

    expect(triggersIn(calls)).toHaveLength(0);
  });

  test("dismissing an ORDINARY paywall does fire, with the source paywall named", async () => {
    const { impl, calls } = stubFetch(["paywall_decline"]);
    const client = makeClient(impl, { onImplicitPaywall: () => undefined });
    await settle();

    const viewId = client.logPaywallShown({
      placementKey: "premium_button",
      paywallId: "pw_sale",
    });
    await settle();
    client.logPaywallClosed(viewId, {
      placementKey: "premium_button",
      paywallId: "pw_sale",
    });
    await settle();

    const triggers = triggersIn(calls);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.body?.placement).toBe("paywall_decline");
    // The server's own backstop needs this to refuse serving pw_sale back.
    expect(triggers[0]?.body?.fromPaywallId).toBe("pw_sale");
    expect(triggers[0]?.body?.fromViewId).toBe(viewId);
  });

  test("only purchase_abandoned triggers transaction_abandon", async () => {
    const { impl, calls } = stubFetch(["transaction_abandon"]);
    const client = makeClient(impl, { onImplicitPaywall: () => undefined });
    await settle();

    const viewId = client.logPaywallShown({ placementKey: "premium_button" });
    await settle();
    client.logPaywallEvent("purchase_started", viewId);
    client.logPaywallEvent("purchase_failed", viewId);
    await settle();
    expect(triggersIn(calls)).toHaveLength(0);

    client.logPaywallEvent("purchase_abandoned", viewId, {
      paywallId: "pw_sale",
    });
    await settle();
    expect(triggersIn(calls).map((c) => c.body?.placement)).toEqual([
      "transaction_abandon",
    ]);
  });

  test("abandoning checkout and THEN dismissing an implicit paywall fires neither", async () => {
    // The sequence that would re-enter the loop if the guard were spent on
    // the first read: tap buy → cancel the store sheet (transaction_abandon)
    // → dismiss the paywall (paywall_decline). Both happen on one display.
    const { impl, calls } = stubFetch(["paywall_decline", "transaction_abandon"]);
    const client = makeClient(impl, { onImplicitPaywall: () => undefined });
    await settle();

    const viewId = client.logPaywallShown({
      placementKey: "paywall_decline",
      paywallId: "pw_winback",
    });
    await settle();
    client.logPaywallEvent("purchase_abandoned", viewId, { paywallId: "pw_winback" });
    await settle();
    client.logPaywallClosed(viewId, {
      placementKey: "paywall_decline",
      paywallId: "pw_winback",
    });
    await settle();

    expect(triggersIn(calls)).toHaveLength(0);
  });

  test("a double-tapped close is still guarded — the guard is never released", async () => {
    // Two closes on one id is the common shape of a dismiss handler racing an
    // onDisappear beacon; the server dedupes the event, and releasing the
    // guard on the first would let the second re-enter the loop.
    const { impl, calls } = stubFetch(["paywall_decline"]);
    const client = makeClient(impl, { onImplicitPaywall: () => undefined });
    await settle();

    const viewId = client.logPaywallShown({ placementKey: "app_launch" });
    await settle();
    client.logPaywallClosed(viewId, { placementKey: "app_launch" });
    client.logPaywallClosed(viewId, { placementKey: "app_launch" });
    await settle();
    expect(triggersIn(calls)).toHaveLength(0);
  });

  test("a deep link on the first frame waits for the launch batch and presents only if it did not", async () => {
    const { impl, calls } = stubFetch(["app_launch", "deeplink_open"]);
    const seen: string[] = [];
    const client = makeClient(impl, {
      onImplicitPaywall: (t) => seen.push(t.placement),
    });
    // Delivered synchronously after construction — SwiftUI's onOpenURL and
    // RN's getInitialURL both land here, while the batch is still in flight.
    client.handleDeepLink("https://example.com/promo");
    await settle();

    // Both moments reported; ONE paywall presented.
    expect(triggersIn(calls).map((c) => c.body?.placement)).toEqual([
      "app_launch",
      "deeplink_open",
    ]);
    expect(seen).toEqual(["app_launch"]);
  });

  test("a new session re-asks /v1/config so an operator's change reaches a long-running process", async () => {
    const { impl, calls } = stubFetch(["session_start"]);
    const life = manualLifecycle();
    makeClient(impl, {
      onImplicitPaywall: () => undefined,
      lifecycle: life.lifecycle,
      sessionTimeoutMs: 0,
    });
    await settle();
    expect(calls.filter((c) => c.path === "/v1/config")).toHaveLength(1);

    life.background();
    life.foreground();
    await settle();
    expect(calls.filter((c) => c.path === "/v1/config")).toHaveLength(2);
  });

  test("an offline burst costs ONE config probe, not one per interaction", async () => {
    const impl = jest.fn<typeof fetch>(async () => {
      throw new Error("offline");
    });
    const client = makeClient(impl, { onImplicitPaywall: () => undefined });
    await settle();
    const afterLaunch = impl.mock.calls.length;

    for (let i = 0; i < 5; i++) {
      const viewId = client.logPaywallShown({ placementKey: "premium_button" });
      client.logPaywallClosed(viewId, { placementKey: "premium_button" });
    }
    await settle();
    const configProbes = impl.mock.calls
      .slice(afterLaunch)
      .filter(([input]) => new URL(String(input)).pathname === "/v1/config");
    // Inside the retry hold every close answers "none" without a request.
    expect(configProbes).toHaveLength(0);
  });
});

describe("sessions", () => {
  test("a quick return is an app switch, not a session", async () => {
    const { impl, calls } = stubFetch(["session_start"]);
    const life = manualLifecycle();
    makeClient(impl, {
      onImplicitPaywall: () => undefined,
      lifecycle: life.lifecycle,
    });
    await settle();
    const atLaunch = triggersIn(calls).length;

    life.background();
    life.foreground();
    await settle();
    // Answering a message and coming back must not mint a session — a paywall
    // on every app switch is the failure mode this timeout exists for.
    expect(triggersIn(calls)).toHaveLength(atLaunch);
  });

  test("a return past the timeout is a new session", async () => {
    const { impl, calls } = stubFetch(["session_start"]);
    const life = manualLifecycle();
    makeClient(impl, {
      onImplicitPaywall: () => undefined,
      lifecycle: life.lifecycle,
      sessionTimeoutMs: 0,
    });
    await settle();
    const atLaunch = triggersIn(calls).length;

    life.background();
    life.foreground();
    await settle();
    expect(triggersIn(calls).length).toBe(atLaunch + 1);
  });

  test("time is measured in the BACKGROUND, not since the last return", async () => {
    // 35 minutes of continuous use then a 3-second app switch is not a
    // session. Measuring "since the last foreground" would say it is.
    const { impl, calls } = stubFetch(["session_start"]);
    const life = manualLifecycle();
    const now = jest.spyOn(Date, "now");
    const t0 = 1_700_000_000_000;
    now.mockReturnValue(t0);
    makeClient(impl, {
      onImplicitPaywall: () => undefined,
      lifecycle: life.lifecycle,
    });
    await settle();
    const atLaunch = triggersIn(calls).length;

    now.mockReturnValue(t0 + 35 * 60_000);
    life.background();
    now.mockReturnValue(t0 + 35 * 60_000 + 3_000);
    life.foreground();
    await settle();
    expect(triggersIn(calls)).toHaveLength(atLaunch);

    // And the converse: 3 seconds of use then 35 minutes away IS a session.
    now.mockReturnValue(t0 + 35 * 60_000 + 6_000);
    life.background();
    now.mockReturnValue(t0 + 70 * 60_000 + 6_000);
    life.foreground();
    await settle();
    expect(triggersIn(calls)).toHaveLength(atLaunch + 1);
    now.mockRestore();
  });

  test("a foreground with no background before it is not a session", async () => {
    // The launch itself, or a platform that reports foreground twice.
    const { impl, calls } = stubFetch(["session_start"]);
    const life = manualLifecycle();
    makeClient(impl, {
      onImplicitPaywall: () => undefined,
      lifecycle: life.lifecycle,
      sessionTimeoutMs: 0,
    });
    await settle();
    const atLaunch = triggersIn(calls).length;

    life.foreground();
    life.foreground();
    await settle();
    expect(triggersIn(calls)).toHaveLength(atLaunch);
  });

  test("dispose unsubscribes, so a replaced client stops minting sessions", async () => {
    const { impl } = stubFetch(["session_start"]);
    const life = manualLifecycle();
    const client = makeClient(impl, {
      onImplicitPaywall: () => undefined,
      lifecycle: life.lifecycle,
    });
    await settle();
    expect(life.subscribed).toBe(true);

    client.dispose();
    expect(life.subscribed).toBe(false);
  });

  test("lifecycle:false keeps launch moments but never watches the foreground", async () => {
    const { impl, calls } = stubFetch(["app_launch", "session_start"]);
    makeClient(impl, {
      onImplicitPaywall: () => undefined,
      lifecycle: false,
    });
    await settle();
    expect(triggersIn(calls).map((c) => c.body?.placement)).toEqual([
      "app_launch",
      "session_start",
    ]);
  });

  test("browserLifecycle is null where there is no document", () => {
    // React Native, Node and SSR all land here; the host passes an AppState
    // adapter instead.
    const doc = (globalThis as { document?: unknown }).document;
    delete (globalThis as { document?: unknown }).document;
    try {
      expect(browserLifecycle()).toBeNull();
    } finally {
      if (doc !== undefined) {
        (globalThis as { document?: unknown }).document = doc;
      }
    }
  });
});

describe("deep links", () => {
  test("handleDeepLink sends the URL, bounded", async () => {
    const { impl, calls } = stubFetch(["deeplink_open"]);
    const client = makeClient(impl, { onImplicitPaywall: () => undefined });
    await settle();

    client.handleDeepLink(`https://example.com/?q=${"a".repeat(2000)}`);
    await settle();

    const trigger = triggersIn(calls)[0];
    expect(trigger?.body?.placement).toBe("deeplink_open");
    // The server bounds `url` at 1024 and 400s past it; trimming here keeps a
    // long campaign URL from losing the moment entirely.
    expect(String(trigger?.body?.url).length).toBe(1024);
  });

  test("every trigger carries a fresh occurrence id", async () => {
    const { impl, calls } = stubFetch(["deeplink_open"]);
    const client = makeClient(impl, { onImplicitPaywall: () => undefined });
    await settle();

    client.handleDeepLink("https://example.com/a");
    await settle();
    client.handleDeepLink("https://example.com/b");
    await settle();

    const ids = triggersIn(calls).map((c) => c.body?.occurrenceId);
    expect(ids).toHaveLength(2);
    // Idempotency keys on it: two genuine link opens must count twice.
    expect(new Set(ids).size).toBe(2);
  });

  test("no handler: still reports the link for attribution, resolve: false, no /v1/config", async () => {
    const { impl, calls } = stubFetch([]);
    const client = makeClient(impl);
    await settle();

    client.handleDeepLink("https://example.com/promo?utm_source=ig");
    await settle();

    expect(calls.map((c) => c.path)).not.toContain("/v1/config");
    const triggers = triggersIn(calls);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.body?.url).toBe("https://example.com/promo?utm_source=ig");
    expect(triggers[0]?.body?.resolve).toBe(false);
  });

  test("implicitPlacements: false with a handler: reports the link, never presents", async () => {
    const { impl, calls } = stubFetch([]);
    const seen: unknown[] = [];
    const client = makeClient(impl, {
      implicitPlacements: false,
      onImplicitPaywall: (t) => seen.push(t),
    });
    await settle();

    client.handleDeepLink("https://example.com/promo");
    await settle();

    const triggers = triggersIn(calls);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.body?.resolve).toBe(false);
    expect(seen).toEqual([]);
  });

  test("implicit on, configured: no resolve key, and the paywall is handed over", async () => {
    const { impl, calls } = stubFetch(["deeplink_open"]);
    const seen: string[] = [];
    const client = makeClient(impl, {
      onImplicitPaywall: (t) => seen.push(t.placement),
    });
    await settle();

    client.handleDeepLink("https://example.com/promo");
    await settle();

    const trigger = triggersIn(calls)[0];
    expect(trigger?.body).not.toHaveProperty("resolve");
    expect(seen).toEqual(["deeplink_open"]);
  });

  test("implicit on, NOT configured: resolve: false, handler never called", async () => {
    const { impl, calls } = stubFetch(["app_launch"]);
    const seen: string[] = [];
    const client = makeClient(impl, {
      onImplicitPaywall: (t) => seen.push(t.placement),
    });
    await settle();

    client.handleDeepLink("https://example.com/promo");
    await settle();

    const triggers = triggersIn(calls);
    const trigger = triggers[triggers.length - 1];
    expect(trigger?.body?.placement).toBe("deeplink_open");
    expect(trigger?.body?.resolve).toBe(false);
    expect(seen).not.toContain("deeplink_open");
  });

  test("a deep link on an ephemeral anonymous id sends no trigger", async () => {
    const { impl, calls } = stubFetch(["deeplink_open"]);
    const client = makeClient(impl, { customerId: undefined, storage: undefined });

    client.handleDeepLink("https://example.com/promo");
    await settle();

    expect(triggersIn(calls)).toHaveLength(0);
  });
});

describe("dashboard QR/link preview", () => {
  const TOKEN = "a".repeat(64);
  const PREVIEW_BODY = {
    placementKey: PREVIEW_PLACEMENT_KEY,
    revision: null,
    offering: null,
    paywall: { paywallId: "pw_preview", name: "Preview", config: {} },
    experiment: null,
    targeting: null,
    preview: true,
    expiresAt: 1_800_000_000_000,
  };

  function stubPreviewFetch(status = 200, body: unknown = PREVIEW_BODY) {
    const calls: RecordedCall[] = [];
    const impl = jest.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const reqBody =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      calls.push({ path, body: reqBody });
      if (path === `/v1/paywalls/preview/${TOKEN}`) {
        return jsonResponse(body, status);
      }
      if (path === "/v1/config") {
        return jsonResponse({ revision: 1, implicitPlacements: ["deeplink_open"] });
      }
      if (path === "/v1/placements/triggered") {
        return jsonResponse(RESOLUTION);
      }
      return jsonResponse({ ok: true }, 201);
    });
    return { impl, calls };
  }

  test("a preview link fetches the preview and hands it to onImplicitPaywall, never /v1/placements/triggered", async () => {
    const { impl, calls } = stubPreviewFetch();
    const seen: string[] = [];
    const resolutions: { status: string; revision: number }[] = [];
    const client = makeClient(impl, {
      onImplicitPaywall: (t) => {
        seen.push(t.placement);
        resolutions.push(t.resolution);
      },
    });
    await settle();

    client.handleDeepLink(`voigu://revnix-preview?revnix_preview=${TOKEN}`);
    await settle();

    expect(calls.map((c) => c.path)).toContain(`/v1/paywalls/preview/${TOKEN}`);
    expect(triggersIn(calls)).toHaveLength(0);
    expect(seen).toEqual([PREVIEW_PLACEMENT_KEY]);
    expect(resolutions[0]).toMatchObject({ status: "ok", revision: 0 });
  });

  test("a preview on the first frame waits for the launch batch, presenting after it", async () => {
    const { impl, calls } = stubFetch(["app_launch"]);
    const seen: string[] = [];
    const client = makeClient(impl, {
      onImplicitPaywall: (t) => seen.push(t.placement),
    });
    client.handleDeepLink(`voigu://revnix-preview?revnix_preview=${TOKEN}`);
    await settle();

    expect(triggersIn(calls).map((c) => c.body?.placement)).toEqual([
      "app_launch",
    ]);
    expect(seen).toEqual(["app_launch", PREVIEW_PLACEMENT_KEY]);
  });

  test("a malformed token falls through to the ordinary deep-link path", async () => {
    const { impl, calls } = stubFetch(["deeplink_open"]);
    const client = makeClient(impl, { onImplicitPaywall: () => undefined });
    await settle();

    client.handleDeepLink("voigu://revnix-preview?revnix_preview=not-hex");
    await settle();

    expect(triggersIn(calls).map((c) => c.body?.placement)).toEqual([
      "deeplink_open",
    ]);
  });

  test("an ordinary URL is unaffected", async () => {
    const { impl, calls } = stubFetch(["deeplink_open"]);
    const client = makeClient(impl, { onImplicitPaywall: () => undefined });
    await settle();

    client.handleDeepLink("https://example.com/promo");
    await settle();

    expect(triggersIn(calls).map((c) => c.body?.placement)).toEqual([
      "deeplink_open",
    ]);
  });

  test("a 404 preview never throws and never presents", async () => {
    const { impl } = stubPreviewFetch(404, { error: "not found" });
    const seen: unknown[] = [];
    const client = makeClient(impl, { onImplicitPaywall: (t) => seen.push(t) });
    await settle();

    expect(() =>
      client.handleDeepLink(`voigu://revnix-preview?revnix_preview=${TOKEN}`)
    ).not.toThrow();
    await settle();

    expect(seen).toEqual([]);
  });

  test("no onImplicitPaywall handler configured: nothing to present, reported via onDiagnostic", async () => {
    const { impl } = stubPreviewFetch();
    const diagnostics: string[] = [];
    const client = new RevnixClient({
      apiKey: "rvx_pk_test_abc",
      baseUrl: "https://demo.convex.site",
      storage: memoryStorage(),
      customerId: "cust-implicit",
      reportInstalls: false,
      fetch: impl,
      onDiagnostic: (event) => diagnostics.push(event.op),
    });
    await settle();

    client.handleDeepLink(`voigu://revnix-preview?revnix_preview=${TOKEN}`);
    await settle();

    expect(diagnostics).toContain("preview");
  });
});
