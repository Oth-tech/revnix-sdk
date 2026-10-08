import Foundation
import React
import StoreKit

@available(iOS 15.0, *)
@objc(RevnixStore)
class RevnixStore: RCTEventEmitter {
  private var updates: Task<Void, Never>?

  @objc override static func requiresMainQueueSetup() -> Bool {
    false
  }

  override func supportedEvents() -> [String]! {
    ["revnixStoreTransaction"]
  }

  override func startObserving() {
    updates?.cancel()
    updates = Task { [weak self] in
      for await update in Transaction.updates where update.unsafePayloadValue.revocationDate == nil {
        self?.sendEvent(withName: "revnixStoreTransaction", body: RevnixStore.payload(update))
      }
    }
  }

  override func stopObserving() {
    updates?.cancel()
    updates = nil
  }

  @objc(purchase:customerId:resolver:rejecter:)
  func purchase(
    _ productId: String,
    customerId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      do {
        guard let product = try await Product.products(for: [productId]).first else {
          reject("product_not_found", "No App Store product with id \(productId)", nil)
          return
        }
        switch try await product.purchase() {
        case .success(let verification):
          resolve(RevnixStore.payload(verification))
        default:
          resolve(nil)
        }
      } catch {
        reject("store_error", error.localizedDescription, error)
      }
    }
  }

  @objc(restore:rejecter:)
  func restore(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      try? await AppStore.sync()
      var transactions: [[String: Any]] = []
      for await entitlement in Transaction.currentEntitlements
      where entitlement.unsafePayloadValue.revocationDate == nil {
        transactions.append(RevnixStore.payload(entitlement))
      }
      resolve(transactions)
    }
  }

  @objc(finish:resolver:rejecter:)
  func finish(
    _ transactionId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      for await unfinished in Transaction.unfinished {
        let transaction = unfinished.unsafePayloadValue
        if String(transaction.id) == transactionId {
          await transaction.finish()
          break
        }
      }
      resolve(nil)
    }
  }

  private static func payload(_ verification: VerificationResult<Transaction>) -> [String: Any] {
    let transaction = verification.unsafePayloadValue
    var payload: [String: Any] = [
      "store": "apple",
      "productId": transaction.productID,
      "transactionId": String(transaction.id),
      "token": String(transaction.originalID),
      "occurredAt": Int(transaction.purchaseDate.timeIntervalSince1970 * 1000),
      "signedTransactionInfo": verification.jwsRepresentation,
    ]
    if let expiresAt = transaction.expirationDate {
      payload["expiresAt"] = Int(expiresAt.timeIntervalSince1970 * 1000)
    }
    return payload
  }
}
