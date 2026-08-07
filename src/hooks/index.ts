// React hooks layer (`revnix-react/hooks`) — ergonomic bindings over the
// imperative RevnixClient. Lives in its own subpath entry (like ./ui) so the
// core index stays free of the react peer for pure-JS/Node consumers.
//
// Design constraints these hooks inherit from the client and must not undo:
// - getEntitlements() already serves the offline cache (stale: true) on
//   TRANSIENT failures and rethrows DELIBERATE rejections (401/403/404/409)
//   so a kill-switch cannot be defeated by cache. The hooks therefore never
//   fall back to the cache on error — an error here is one the app must see.
// - resolvePlacement() has the same stale/deliberate split; `stale` is
//   surfaced, not hidden.
// - A screen of gates must stay one fetch: the client coalesces in-flight
//   requests and applies a soft TTL, so mounting many hooks is safe.
import * as React from "react";
import { RevnixClient } from "../client.js";
import { Revnix } from "../index.js";
import type {
  CustomerEntitlements,
  PlacementResolution,
  RevnixConfig,
} from "../types.js";

const RevnixContext = React.createContext<RevnixClient | null>(null);

export interface RevnixProviderProps {
  /** An existing client (preferred in tests). The provider never disposes a
   *  client it was handed. */
  client?: RevnixClient;
  /** Or a config — the provider constructs the client and disposes it on
   *  unmount. Exactly one of `client`/`config` is required; whichever was
   *  present on FIRST render wins (swap-after-mount is not supported, same
   *  as Revnix.configure()'s replace-on-reconfigure semantics). */
  config?: RevnixConfig;
  children?: React.ReactNode;
}

export function RevnixProvider(
  props: RevnixProviderProps
): React.ReactElement {
  const { client, config, children } = props;
  // First-render decision, held for the provider's lifetime.
  const [owned] = React.useState<RevnixClient | null>(() =>
    client ? null : config ? new RevnixClient(config) : null
  );
  React.useEffect(() => {
    return () => {
      owned?.dispose();
    };
  }, [owned]);
  const value = client ?? owned;
  if (!value) {
    throw new Error(
      "RevnixProvider requires a `client` or `config` prop"
    );
  }
  return React.createElement(RevnixContext.Provider, { value }, children);
}

/** The client from the nearest <RevnixProvider>, falling back to the
 *  Revnix.configure() singleton — so hooks work in apps that configure at
 *  startup without a provider. */
export function useRevnix(): RevnixClient {
  const fromContext = React.useContext(RevnixContext);
  if (fromContext) return fromContext;
  try {
    return Revnix.client;
  } catch {
    throw new Error(
      "No Revnix client found: wrap your tree in <RevnixProvider> or call Revnix.configure() at app start"
    );
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

/** Shared load-into-state plumbing for the data hooks. `key` re-runs the
 *  load when it changes (placement key, customer switch after identify). */
function useClientData<T>(
  client: RevnixClient,
  key: string,
  load: () => Promise<T>
): AsyncState<T> & { refresh: () => Promise<void> } {
  const [state, setState] = React.useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
  });
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const loadRef = React.useRef(load);
  loadRef.current = load;

  const refresh = React.useCallback(async () => {
    if (alive.current) {
      setState((s) => ({ ...s, loading: true }));
    }
    try {
      const data = await loadRef.current();
      if (alive.current) setState({ data, loading: false, error: null });
    } catch (err) {
      // Deliberate rejection (or a bug) — keep whatever was already shown,
      // surface the error. Never a silent cache fallback (see header).
      if (alive.current) {
        setState((s) => ({ ...s, loading: false, error: toError(err) }));
      }
    }
    // client + key identify the data source; the load body rides loadRef.
  }, [client, key]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}

export interface UseEntitlementsResult {
  /** Latest snapshot (server-fresh or client-cached), null before first load. */
  entitlements: CustomerEntitlements | null;
  loading: boolean;
  /** Deliberate rejections only — transient failures serve the cache instead. */
  error: Error | null;
  /** True when the snapshot came from the offline cache. */
  stale: boolean;
  /** Convenience gate over the CURRENT snapshot (false while loading —
   *  render locked until proven, the same default the client uses). */
  isEntitled: (entitlementId: string) => boolean;
  refresh: () => Promise<void>;
}

export function useEntitlements(): UseEntitlementsResult {
  const client = useRevnix();
  const { data, loading, error, refresh } = useClientData(
    client,
    "entitlements",
    () => client.getEntitlements()
  );
  const isEntitled = React.useCallback(
    (entitlementId: string) =>
      data?.entitlements.some(
        (e) => e.entitlementId === entitlementId && e.isActive
      ) ?? false,
    [data]
  );
  return {
    entitlements: data,
    loading,
    error,
    stale: data?.stale === true,
    isEntitled,
    refresh,
  };
}

/** One-gate shorthand. `undefined` while the first load is in flight —
 *  lets callers distinguish "locked" from "not yet known". */
export function useIsEntitled(entitlementId: string): boolean | undefined {
  const { entitlements, loading, isEntitled } = useEntitlements();
  if (entitlements === null && loading) return undefined;
  return isEntitled(entitlementId);
}

export interface UsePlacementResult {
  /** Offering + remote paywall config for the placement, null before load. */
  placement: PlacementResolution | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export function usePlacement(placementKey: string): UsePlacementResult {
  const client = useRevnix();
  const { data, loading, error, refresh } = useClientData(
    client,
    `placement:${placementKey}`,
    () => client.resolvePlacement(placementKey)
  );
  return { placement: data, loading, error, refresh };
}

/** The device's current customer id (anonymous or identified); null before
 *  the client's storage read resolves. */
export function useCustomerId(): string | null {
  const client = useRevnix();
  const { data } = useClientData(client, "customerId", () =>
    client.getCustomerId()
  );
  return data;
}
