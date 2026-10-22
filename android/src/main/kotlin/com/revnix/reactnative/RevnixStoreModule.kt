package com.revnix.reactnative

import android.util.Base64
import android.util.Log
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.BillingClient.ProductType
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.ads.identifier.AdvertisingIdClient
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityTokenRequest
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

class RevnixStoreModule(context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context), PurchasesUpdatedListener {

  private class PendingPurchase(val productId: String, val promise: Promise)

  private val pending = AtomicReference<PendingPurchase?>(null)
  private val acknowledged = ConcurrentHashMap.newKeySet<String>()
  private val waitingForSetup = mutableListOf<(BillingResult) -> Unit>()

  private val billing: BillingClient = BillingClient.newBuilder(context)
    .setListener(this)
    .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
    .enableAutoServiceReconnection()
    .build()

  override fun getName() = "RevnixStore"

  override fun invalidate() {
    billing.endConnection()
  }

  @ReactMethod
  fun addListener(eventName: String) {
    withBilling {}
  }

  @ReactMethod
  fun removeListeners(count: Int) {}

  @ReactMethod
  fun purchase(productId: String, customerId: String, promise: Promise) {
    withBilling { setup ->
      if (setup.responseCode != BillingResponseCode.OK) {
        promise.reject("store_error", setup.debugMessage)
        return@withBilling
      }
      queryProduct(productId, ProductType.SUBS) { subs ->
        if (subs != null) {
          launch(subs, customerId, promise)
          return@queryProduct
        }
        queryProduct(productId, ProductType.INAPP) { inapp ->
          if (inapp != null) launch(inapp, customerId, promise)
          else promise.reject("product_not_found", "No Play product with id $productId")
        }
      }
    }
  }

  @ReactMethod
  fun restore(promise: Promise) {
    withBilling { setup ->
      if (setup.responseCode != BillingResponseCode.OK) {
        promise.reject("store_error", setup.debugMessage)
        return@withBilling
      }
      val restored = Arguments.createArray()
      queryPurchases(ProductType.SUBS) { subs ->
        subs.forEach { restored.pushMap(toMap(it)) }
        queryPurchases(ProductType.INAPP) { inapp ->
          inapp.forEach { restored.pushMap(toMap(it)) }
          promise.resolve(restored)
        }
      }
    }
  }

  @ReactMethod
  fun finish(purchaseToken: String, consume: Boolean, promise: Promise) {
    if (!consume && purchaseToken in acknowledged) {
      promise.resolve(null)
      return
    }
    withBilling { setup ->
      if (setup.responseCode != BillingResponseCode.OK) {
        promise.reject("store_error", "${setup.responseCode} ${setup.debugMessage}")
        return@withBilling
      }
      val acknowledge = { onResult: (BillingResult) -> Unit ->
        val params = AcknowledgePurchaseParams.newBuilder().setPurchaseToken(purchaseToken).build()
        billing.acknowledgePurchase(params) { result ->
          if (result.responseCode == BillingResponseCode.OK) acknowledged.add(purchaseToken)
          onResult(result)
        }
      }
      if (!consume) {
        acknowledge { result ->
          if (result.responseCode == BillingResponseCode.OK) promise.resolve(null)
          else promise.reject("store_error", "acknowledgePurchase failed: ${result.responseCode} ${result.debugMessage}")
        }
        return@withBilling
      }
      val params = ConsumeParams.newBuilder().setPurchaseToken(purchaseToken).build()
      billing.consumeAsync(params) { consumed, _ ->
        if (consumed.responseCode == BillingResponseCode.OK) {
          acknowledged.add(purchaseToken)
          promise.resolve(null)
        } else {
          acknowledge { acked ->
            promise.reject(
              "store_error",
              "consumeAsync failed: ${consumed.responseCode} ${consumed.debugMessage}; acknowledgePurchase fallback: ${acked.responseCode} ${acked.debugMessage}",
            )
          }
        }
      }
    }
  }

  @ReactMethod
  fun deviceIntegrity(customerId: String, promise: Promise) {
    val nonce = Base64.encodeToString(
      MessageDigest.getInstance("SHA-256").digest(customerId.toByteArray(Charsets.UTF_8)),
      Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
    )
    try {
      IntegrityManagerFactory.create(reactApplicationContext.applicationContext)
        .requestIntegrityToken(IntegrityTokenRequest.builder().setNonce(nonce).build())
        .addOnSuccessListener { response ->
          promise.resolve(
            Arguments.createMap().apply {
              putString("platform", "android")
              putString("token", response.token())
            },
          )
        }
        .addOnFailureListener { promise.resolve(null) }
        .addOnCanceledListener { promise.resolve(null) }
    } catch (err: Exception) {
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun advertisingId(promise: Promise) {
    Thread {
      try {
        val info = AdvertisingIdClient.getAdvertisingIdInfo(reactApplicationContext.applicationContext)
        promise.resolve(
          info.id.takeUnless { info.isLimitAdTrackingEnabled || it == "00000000-0000-0000-0000-000000000000" },
        )
      } catch (err: Throwable) {
        promise.reject("advertising_id_unavailable", err.message, err)
      }
    }.start()
  }

  override fun onPurchasesUpdated(result: BillingResult, purchases: List<Purchase>?) {
    if (result.responseCode != BillingResponseCode.OK) {
      settle(pending.getAndSet(null) ?: return, result)
      return
    }
    for (purchase in purchases.orEmpty()) {
      val waiting = pending.get()
      if (waiting != null && purchase.products.contains(waiting.productId) &&
        pending.compareAndSet(waiting, null)
      ) {
        val purchased = purchase.purchaseState == Purchase.PurchaseState.PURCHASED
        waiting.promise.resolve(if (purchased) toMap(purchase) else null)
      } else if (purchase.purchaseState == Purchase.PurchaseState.PURCHASED) {
        emit(toMap(purchase))
      }
    }
  }

  private fun withBilling(onReady: (BillingResult) -> Unit) {
    if (billing.isReady) {
      onReady(BillingResult.newBuilder().setResponseCode(BillingResponseCode.OK).build())
      return
    }
    synchronized(waitingForSetup) {
      waitingForSetup.add(onReady)
      if (waitingForSetup.size > 1) return
    }
    billing.startConnection(object : BillingClientStateListener {
      override fun onBillingSetupFinished(result: BillingResult) {
        val ready = synchronized(waitingForSetup) {
          waitingForSetup.toList().also { waitingForSetup.clear() }
        }
        if (result.responseCode == BillingResponseCode.OK) {
          queryPurchases(ProductType.SUBS) { subs ->
            queryPurchases(ProductType.INAPP) { inapp ->
              (subs.filterNot { it.isAcknowledged } + inapp).forEach { emit(toMap(it)) }
            }
          }
        }
        ready.forEach { it(result) }
      }

      override fun onBillingServiceDisconnected() {}
    })
  }

  private fun settle(waiting: PendingPurchase, result: BillingResult) {
    when (result.responseCode) {
      BillingResponseCode.USER_CANCELED -> waiting.promise.resolve(null)
      BillingResponseCode.ITEM_ALREADY_OWNED -> queryPurchases(ProductType.SUBS) { subs ->
        queryPurchases(ProductType.INAPP) { inapp ->
          val owned = (subs + inapp).firstOrNull { waiting.productId in it.products }
          if (owned != null) waiting.promise.resolve(toMap(owned).apply { putBoolean("alreadyOwned", true) })
          else waiting.promise.reject("store_error", "${result.responseCode} ${result.debugMessage}")
        }
      }
      else -> waiting.promise.reject("store_error", "${result.responseCode} ${result.debugMessage}")
    }
  }

  private fun queryProduct(productId: String, type: String, then: (ProductDetails?) -> Unit) {
    val product = QueryProductDetailsParams.Product.newBuilder()
      .setProductId(productId)
      .setProductType(type)
      .build()
    val params = QueryProductDetailsParams.newBuilder().setProductList(listOf(product)).build()
    billing.queryProductDetailsAsync(params) { _, details ->
      then(details.productDetailsList.firstOrNull())
    }
  }

  private fun queryPurchases(type: String, then: (List<Purchase>) -> Unit) {
    val params = QueryPurchasesParams.newBuilder().setProductType(type).build()
    billing.queryPurchasesAsync(params) { result, purchases ->
      if (result.responseCode != BillingResponseCode.OK) {
        Log.w(TAG, "queryPurchases($type) failed: ${result.responseCode} ${result.debugMessage}")
      }
      then(purchases.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED })
    }
  }

  private fun launch(details: ProductDetails, customerId: String, promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("no_activity", "No foreground Activity to show Google Play billing")
      return
    }
    val productParams = BillingFlowParams.ProductDetailsParams.newBuilder()
      .setProductDetails(details)
      .apply {
        // ponytail: first base plan/offer wins; products with several base plans need a basePlanId/offerId selector passed through purchase()
        details.subscriptionOfferDetails?.firstOrNull()?.let { setOfferToken(it.offerToken) }
      }
      .build()
    val params = BillingFlowParams.newBuilder()
      .setProductDetailsParamsList(listOf(productParams))
      .setObfuscatedAccountId(customerId)
      .build()
    activity.runOnUiThread {
      val waiting = PendingPurchase(details.productId, promise)
      pending.getAndSet(waiting)?.promise?.resolve(null)
      val result = billing.launchBillingFlow(activity, params)
      if (result.responseCode != BillingResponseCode.OK && pending.compareAndSet(waiting, null)) {
        settle(waiting, result)
      }
    }
  }

  private fun toMap(purchase: Purchase): WritableMap {
    if (purchase.isAcknowledged) acknowledged.add(purchase.purchaseToken)
    return Arguments.createMap().apply {
      putString("store", "google")
      putString("productId", purchase.products.firstOrNull())
      putString("transactionId", purchase.purchaseToken)
      putString("token", purchase.purchaseToken)
      putDouble("occurredAt", purchase.purchaseTime.toDouble())
      putBoolean("acknowledged", purchase.isAcknowledged)
    }
  }

  private fun emit(transaction: WritableMap) {
    if (!reactApplicationContext.hasActiveReactInstance()) return
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("revnixStoreTransaction", transaction)
  }

  private companion object {
    const val TAG = "RevnixStore"
  }
}
