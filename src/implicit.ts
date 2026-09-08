// REV-272: implicit placements — the six moments the SDK reports on its own.
//
// A placement is normally a location the HOST resolves by name, so every new
// place a paywall could appear costs a code change and a release. Six moments
// are the same in every app and visible to the SDK without the host saying
// anything, so an operator can attach a paywall to them from the dashboard
// alone. This module owns the vocabulary and the platform-lifecycle seam;
// client.ts owns the firing.
//
// Mirrors convex/lib/implicitPlacements.ts in revnix-app — the backend is the
// source of truth for the key spellings, and a mismatch here is silent (the
// server 400s a key it does not know, and the moment is simply never
// configured), so the two lists are checked against each other in the tests.

/** The six reserved keys. Lowercase throughout: a placement key must match
 *  `^[a-z0-9][a-z0-9._-]{0,63}$` server-side, which is why this is
 *  `deeplink_open` and not Superwall's `deepLink_open`. */
export const IMPLICIT_PLACEMENTS = [
  "app_install",
  "app_launch",
  "session_start",
  "deeplink_open",
  "paywall_decline",
  "transaction_abandon",
] as const;

export type ImplicitPlacement = (typeof IMPLICIT_PLACEMENTS)[number];

/** Why a trigger came back with no paywall — as opposed to a placement that
 *  resolved fine and simply has none attached, which is `null`. */
export type ImplicitSkipReason = "not_configured" | "same_paywall";

/** The one moment the SDK cannot see unaided: the URL that opened the app is
 *  delivered to the host's own entry point, and an SDK trying to intercept it
 *  would be fighting the host's router. Call `handleDeepLink(url)`. */
export const HOST_CALL_PLACEMENT: ImplicitPlacement = "deeplink_open";

/** How long the app must have been backgrounded for the return to count as a
 *  new session rather than an app switch. Matches Superwall's own definition
 *  so a team moving over gets the same numbers. */
export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60_000;

/** How long after a FAILED /v1/config read the SDK waits before asking again.
 *  See RevnixClient.implicitConfigRetryAt. */
export const IMPLICIT_CONFIG_RETRY_MS = 60_000;

/** Where the app is. Both transitions matter: a session is defined by how
 *  long the app was in the BACKGROUND, which cannot be known from foreground
 *  events alone — "time since the last return" would mint a session after 35
 *  minutes of continuous use plus a three-second app switch. */
export type RevnixAppState = "foreground" | "background";

/** The platform seam. The SDK ships a browser implementation (see
 *  `browserLifecycle`); React Native passes an adapter over `AppState`, which
 *  is a few lines and keeps `react-native` out of this package's dependencies:
 *
 *      lifecycle: {
 *        onStateChange: (handler) => {
 *          const sub = AppState.addEventListener("change", (s) => {
 *            handler(s === "active" ? "foreground" : "background");
 *          });
 *          return () => sub.remove();
 *        },
 *      }
 */
export interface RevnixLifecycle {
  /** Subscribe to app state transitions. Returns an unsubscribe. Called at
   *  most once per client; the client calls the unsubscribe from dispose().
   *  Repeated reports of the same state are harmless. */
  onStateChange(handler: (state: RevnixAppState) => void): () => void;
}

/** Foreground detection in a browser tab. `visibilitychange` rather than
 *  `focus`: switching windows fires focus without the page ever having been
 *  hidden, which would mint sessions for someone alt-tabbing. Returns null
 *  where there is no document (React Native, Node, SSR) — the host passes its
 *  own adapter there. */
export function browserLifecycle(): RevnixLifecycle | null {
  // Structurally typed rather than leaning on the DOM lib: this package
  // compiles without `lib: dom` (it has to run under React Native and Node),
  // the same reason device.ts reaches for `navigator` through a cast.
  interface VisibilityDocument {
    visibilityState?: string;
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  }
  const doc = (globalThis as { document?: VisibilityDocument }).document;
  if (
    !doc ||
    typeof doc.addEventListener !== "function" ||
    typeof doc.removeEventListener !== "function"
  ) {
    return null;
  }
  const add = doc.addEventListener.bind(doc);
  const remove = doc.removeEventListener.bind(doc);
  return {
    onStateChange(handler) {
      const listener = () => {
        handler(doc.visibilityState === "visible" ? "foreground" : "background");
      };
      add("visibilitychange", listener);
      return () => remove("visibilitychange", listener);
    },
  };
}

/** What the host is handed when a moment resolved to a paywall. */
export interface ImplicitTrigger<TResolution> {
  /** Which of the six fired. */
  placement: ImplicitPlacement;
  /** The resolution, exactly as `resolvePlacement` would have returned it —
   *  offering, paywall, experiment and targeting all included. */
  resolution: TResolution;
}

/** The trigger response body. The resolve shape plus the two fields the
 *  trigger route adds. */
export interface ImplicitTriggerResponse {
  skipReason: ImplicitSkipReason | null;
  /** True when this call appended a NEW ledger event (false for a duplicate,
   *  and for the three moments that reuse an event reported elsewhere). */
  recorded: boolean;
}
