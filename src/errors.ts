export class RevnixError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RevnixError";
    this.status = status;
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
