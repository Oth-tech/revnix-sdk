export class RevnixError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RevnixError";
    this.status = status;
  }

  /** Transient failures worth retrying (network, timeout, rate limit, 5xx).
   *  4xx other than 429 are the caller's fault and won't fix themselves. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** POST /v1/purchases returned 409: the store token belongs to another
 *  customer and the app's transfer behavior is "block". Surface this to the
 *  user as "this subscription is linked to a different account". */
export class PurchaseBlockedError extends RevnixError {
  constructor(message: string) {
    super(409, message);
    this.name = "PurchaseBlockedError";
  }
}

/** purchase() found an earlier Google Play consumable of this product still
 *  owned. It was registered and consumed instead of charging again; ask the
 *  customer to buy again. */
export class PurchaseAlreadyOwnedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseAlreadyOwnedError";
  }
}

/** C7: the request didn't complete within the configured timeout (default
 *  10s). `fetch` has no default timeout on React Native / browsers, so without
 *  this a slow or dead backend would hang the app until the OS TCP timeout. */
export class RevnixTimeoutError extends RevnixError {
  constructor(message = "Revnix request timed out") {
    super(0, message);
    this.name = "RevnixTimeoutError";
  }
}

/** C7: the request never reached the server (offline, DNS/TLS failure, captive
 *  portal). Distinct from an HTTP error so callers can show an offline state
 *  instead of treating it as a bug. */
export class RevnixNetworkError extends RevnixError {
  constructor(message = "Revnix request failed to reach the server") {
    super(0, message);
    this.name = "RevnixNetworkError";
  }
}

/** L4: the API returned 401/403 — the key is missing, revoked, or the wrong
 *  kind (e.g. a secret key where a public key is required) — or the SDK
 *  refused locally before the network for the same reason (identify()/alias()
 *  on a publishable key). Retrying is pointless; the fix is reconfiguration,
 *  so surface this to the developer. */
export class RevnixAuthError extends RevnixError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "RevnixAuthError";
  }
}

/** C7: the API returned 429 (rate limited). `retryAfterMs` mirrors the
 *  server's Retry-After header when present — back off at least that long. */
export class RevnixRateLimitError extends RevnixError {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(429, message);
    this.name = "RevnixRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}
