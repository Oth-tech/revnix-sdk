// RevnixPaywall — renders a published PaywallConfig exactly as the dashboard
// paywall-builder previews it (PaywallPhonePreview.tsx in revnix-app is the
// reference renderer; keep the two in lockstep). The config decides template,
// copy, accent, badge, highlight, and hero image; the app supplies package
// titles/prices (from StoreKit / Play Billing) and the purchase handlers, so
// the display never disagrees with the charge.
//
// `template` is a LAYOUT id. "focus" | "feature-list" | "minimal" are the
// original three and render byte-identically to earlier SDK versions; the
// newer layouts (hero, timeline, plans, feature-grid, offer, reveal) are
// distinct screen structures the dashboard's template gallery presets over.
// An unrecognized template (config published by a newer dashboard) falls
// back to the classic structure instead of rendering nothing.
//
// Import from "react-native-revnix/ui" — the core entrypoint stays free of
// react / react-native so non-RN consumers are unaffected.

import * as React from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import type {
  PaywallConfig,
  PaywallInteraction,
  PaywallPurchaseOutcome,
} from "../types.js";
import { PREVIEW_PLACEMENT_KEY } from "../implicit.js";
import type { PaywallBlockDoc } from "../blocks/types.js";
import type { FontFamilyMap } from "../blocks/style.js";
import { withAlpha } from "../blocks/color.js";
import {
  RevnixBlockPaywall,
  type RevnixBlurComponent,
  type RevnixGradientComponent,
} from "./RevnixBlockPaywall.js";

/** `config.blocks` is opaque on the core config (the non-UI entrypoint must
 *  not carry renderer types), and it arrives straight off the wire — so it is
 *  checked here rather than trusted. A malformed doc falls through to the
 *  classic layouts instead of rendering a broken screen. */
function asBlockDoc(value: unknown): PaywallBlockDoc | null {
  if (typeof value !== "object" || value === null) return null;
  const doc = value as Partial<PaywallBlockDoc>;
  return Array.isArray(doc.blocks) &&
    // A background is the legacy CSS string OR the layered spec (ground /
    // photo / scrim). Both are valid documents; only a missing or wrongly
    // typed one falls through to the classic layouts.
    (typeof doc.background === "string" ||
      (typeof doc.background === "object" && doc.background !== null)) &&
    typeof doc.textColor === "string" &&
    typeof doc.accent === "string" &&
    typeof doc.accentInk === "string"
    ? (doc as PaywallBlockDoc)
    : null;
}

/** One purchasable row. `priceLabel` must come from the store (localized). */
export interface RevnixPaywallPackage {
  packageId: string;
  title: string;
  priceLabel: string;
  /** Renewal cycle ("monthly", "annual", …) from the catalog product. Only
   *  designed (block) paywalls read it, to resolve the {period},
   *  {period_short}, {price_per_month} and {save_percent} tags — a tag with
   *  no cycle behind it renders as written rather than guessed. */
  period?: string;
  /** Price in minor units, for the same per-month and saving maths. */
  amountMinor?: number;
  /** ISO currency of `amountMinor`. */
  currency?: string;
  /** REV-263: the catalog product behind this package. Only telemetry reads
   *  it — a `selected` or `purchase_started` report names the plan the way
   *  the rest of the ledger does. Optional: without it the interaction is
   *  still reported, just with no plan attached (the package id would be
   *  worse — it would look like a product that does not exist). */
  productId?: string;
}

/** Colors the paywall renders with. Defaults mirror the dashboard preview
 *  chrome (a fixed dark screen) — override to match the host app's theme. */
export interface RevnixPaywallTheme {
  background: string;
  textPrimary: string;
  textSecondary: string;
  textFaint: string;
  border: string;
  /** Text color on accent-filled surfaces (CTA, badge). */
  accentInk: string;
}

export const DEFAULT_PAYWALL_THEME: RevnixPaywallTheme = {
  background: "#0f1116",
  textPrimary: "#ffffff",
  textSecondary: "#9aa0a8",
  textFaint: "#6b7078",
  border: "#2a2e36",
  accentInk: "#0a0b0d",
};

/** Base theme when the dashboard config sets `mode: "light"`. Keep in
 *  lockstep with the builder preview (PaywallPhonePreview SCREEN_PALETTES). */
export const LIGHT_PAYWALL_THEME: RevnixPaywallTheme = {
  background: "#ffffff",
  textPrimary: "#16181d",
  textSecondary: "#5b6068",
  textFaint: "#9aa0a8",
  border: "#e2e5ea",
  accentInk: "#ffffff",
};

const DEFAULT_ACCENT = "#6478ff";

// Currency symbols the anchor-price guard recognizes (majors; a symbol-less
// anchor can't be judged and renders as entered).
const CURRENCY_SYMBOL = /[$€£¥₹₩₽₺₫₪฿₴₦₱]/;

// Soft card surface used by the feature-grid / reveal / review blocks. Not
// part of the public theme — derived from the config's mode, in lockstep
// with the dashboard preview's SCREEN_PALETTES.card.
const CARD_BG = { dark: "#181b22", light: "#f4f5f7" } as const;

export interface RevnixPaywallProps {
  config: PaywallConfig;
  packages: RevnixPaywallPackage[];
  /** Called with the selected packageId when the CTA is pressed.
   *
   *  REV-263: passing `client` reports `paywall.purchase_started` the moment
   *  this fires. The OUTCOME is yours — only the host performs the store
   *  call — so to have the paywall report it too, return it (or a promise of
   *  it): `cancelled` becomes `paywall.purchase_abandoned`, `failed` becomes
   *  `paywall.purchase_failed`, and a promise that REJECTS is reported as a
   *  failure carrying the error's message. Returning nothing keeps today's
   *  behavior exactly — the start is reported, the outcome is not, and you
   *  can still report it yourself with `client.logPaywallEvent`. */
  onPurchase: (
    packageId: string
  ) => void | PaywallPurchaseOutcome | Promise<PaywallPurchaseOutcome | void>;
  /** Controlled selection; omit to let the paywall manage it (initial
   *  selection is the config's highlight package, else the first package). */
  selectedPackageId?: string;
  onSelectPackage?: (packageId: string) => void;
  /** Renders a spinner in the CTA and disables purchasing. */
  loading?: boolean;
  onRestore?: () => void;
  onTerms?: () => void;
  onPrivacy?: () => void;
  /** Called when the customer dismisses the paywall (REV-252) — either by
   *  tapping an element the design marks as the close, or by the close button
   *  the renderer supplies when the design authors none.
   *
   *  Dismissal is the HOST's to perform: the paywall does not unmount itself,
   *  because only the host knows whether that means popping a screen, closing
   *  a modal, or advancing onboarding. Omit it and no close is drawn at all —
   *  a paywall with a dead close button is worse than one without.
   *
   *  Passing `client` as well reports `paywall.closed` against this display's
   *  own view id, so the close pairs with its paywall.viewed. */
  onClose?: () => void;
  theme?: Partial<RevnixPaywallTheme>;
  style?: StyleProp<ViewStyle>;
  /** When given, the paywall reports one paywall.viewed per mount (REV-094)
   *  — the analytics funnel's "Paywall displayed" stage. Structural typing
   *  keeps this entrypoint free of a hard client import. */
  client?: {
    logPaywallShown: (options?: {
      placementKey?: string;
      paywallId?: string;
    }) => string | void;
    /** Older clients predate close reporting; the paywall still closes. */
    logPaywallClosed?: (
      viewId: string,
      options?: { placementKey?: string; paywallId?: string }
    ) => void;
    /** Where a designed paywall reports a paint string it could not read.
     *  Optional for the same reason: a client that predates it still renders,
     *  it just reports nothing. */
    reportRenderDiagnostic?: (message: string) => void;
    /** REV-263: the interaction vocabulary. Optional so a host on an older
     *  client still renders and still reports views — it just reports none of
     *  the six. */
    logPaywallEvent?: (
      event: PaywallInteraction,
      viewId: string,
      options?: {
        placementKey?: string;
        paywallId?: string;
        productId?: string;
        code?: string;
        message?: string;
        eventId?: string;
      }
    ) => void;
  };
  /** Placement/paywall attribution attached to the view report. */
  placementKey?: string;
  paywallId?: string;
  /** Opt out of the automatic view report while still passing `client`. */
  disableViewTracking?: boolean;
  /** Renders the CSS gradients a designed (block) paywall may use. Pass the
   *  app's own `LinearGradient` (expo-linear-gradient or
   *  react-native-linear-gradient). Without it a gradient paints as the
   *  design's ground color. Ignored by the classic layouts. */
  gradient?: RevnixGradientComponent;
  /** Renders a blurred background photo on a designed paywall. RN has no
   *  blur primitive, so pass the app's own (`expo-blur`'s `BlurView`, or
   *  `@react-native-community/blur`). Without it a blurred background photo
   *  renders sharp. Ignored by the classic layouts. */
  blur?: RevnixBlurComponent;
  /** Design font family → the face(s) the app has registered, for designed
   *  paywalls. Either one family for every weight, or a weight → family table.
   *  RN cannot load a font by name at runtime, so an unmapped face renders in
   *  the system font. */
  fontFamilyMap?: FontFamilyMap;
  /** Reports a paint string the designed renderer could not read, or a
   *  gradient it flattened for want of a `gradient` component.
   *
   *  Local only: nothing is sent anywhere. Passing `client` routes the same
   *  reports to that client's own `onDiagnostic`, so most apps need neither —
   *  this is for a host that renders a paywall without a client. */
  onDiagnostic?: (message: string) => void;
  /** REV-271: which language to draw a DESIGNED paywall's copy in. Omitted,
   *  the device's own is detected — which is what makes the paywall match the
   *  rest of the app on a phone with no in-app language switch. Pass one when
   *  the app HAS such a switch, so the paywall follows the app rather than the
   *  OS: a user reading the app in Spanish on an English phone must not be
   *  handed an English paywall. A paywall with no translations ignores this,
   *  and any string the chosen language does not translate falls back to the
   *  authored copy rather than rendering blank.
   *
   *  Only designed (block) paywalls are localized; the classic template
   *  layouts below render `config`'s own copy whatever this says. */
  locale?: string;
}

export function RevnixPaywall(props: RevnixPaywallProps) {
  // One view per mount: remounting (a re-shown paywall) is a genuine new
  // display; re-renders are not.
  const { client, placementKey, paywallId, disableViewTracking } = props;
  // Held in a ref, not state: the close report reads it, and re-rendering the
  // paywall the instant its view is recorded would be a pointless frame.
  const viewIdRef = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (!client || disableViewTracking) return;
    const id = client.logPaywallShown({ placementKey, paywallId });
    // Pre-REV-252 clients return void; the close then still fires the host
    // callback, it just cannot be paired with this display.
    if (typeof id === "string") viewIdRef.current = id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ——— REV-263: the interaction vocabulary ———
  //
  // Everything below reports what this component genuinely OBSERVES and
  // nothing it would have to guess. It sees the selection change, the CTA
  // press, the restore press, and an offering that arrived with no packages
  // to sell. It does NOT see the store sheet — the host owns that call — so
  // the purchase outcome is only reported when the host hands it back from
  // `onPurchase`.
  //
  // Every report is wrapped: a telemetry failure must never break the paywall
  // the customer is standing on, the same rule REV-252 set for the close.
  const report = React.useCallback(
    (
      event: PaywallInteraction,
      options?: {
        productId?: string;
        code?: string;
        message?: string;
        eventId?: string;
      }
    ) => {
      const viewId = viewIdRef.current;
      if (!client?.logPaywallEvent || !viewId || disableViewTracking) return;
      try {
        client.logPaywallEvent(event, viewId, {
          placementKey,
          paywallId,
          ...options,
        });
      } catch {
        // Best-effort, exactly like the close beacon.
      }
    },
    [client, placementKey, paywallId, disableViewTracking]
  );

  // packageId → productId, so a report names the plan the way the rest of the
  // ledger does. A package whose product is unknown reports no productId
  // rather than the package id, which would look like a product that does not
  // exist.
  const { packages } = props;
  const productOf = React.useCallback(
    (packageId: string) =>
      packages.find((p) => p.packageId === packageId)?.productId,
    [packages]
  );

  // An offering with nothing to sell is the one failure the component can see
  // by itself, and the one most worth knowing about: the paywall painted, the
  // customer could not buy. Reported once per display, after the view report
  // so the two arrive in order.
  const emptyOnMount = props.packages.length === 0;
  React.useEffect(() => {
    if (emptyOnMount) {
      report("error", {
        code: "no_products",
        message: "paywall displayed with no packages",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { onSelectPackage } = props;
  const handleSelect = React.useMemo(
    () => (packageId: string) => {
      report("selected", {
        productId: productOf(packageId),
        // One `selected` per (display, package): a customer toggling
        // monthly → yearly → monthly considered two plans, not three, and the
        // server's default (key on viewId alone) would have recorded only the
        // first. Analytics counts stages per display anyway, so this is about
        // WHICH plans were weighed.
        eventId: `${viewIdRef.current ?? ""}:sel:${packageId}`,
      });
      onSelectPackage?.(packageId);
    },
    [onSelectPackage, report, productOf]
  );

  const { onPurchase } = props;
  // Rises per attempt so a retry after a failure is its own occurrence rather
  // than being absorbed as a duplicate of the first try.
  const attemptRef = React.useRef(0);
  const handlePurchase = React.useMemo(
    () => (packageId: string) => {
      if (placementKey === PREVIEW_PLACEMENT_KEY) {
        Alert.alert("Preview", "Purchases are disabled in preview.");
        return;
      }
      const attempt = ++attemptRef.current;
      const productId = productOf(packageId);
      const occurrence = `${viewIdRef.current ?? ""}:buy:${attempt}`;
      report("purchase_started", { productId, eventId: occurrence });
      const settle = (outcome: PaywallPurchaseOutcome | void) => {
        // `completed` lands as purchase.completed through registerPurchase —
        // reporting it here too would double-count the sale.
        if (!outcome || outcome.status === "completed") return;
        report(
          outcome.status === "cancelled"
            ? "purchase_abandoned"
            : "purchase_failed",
          {
            productId,
            code: outcome.code,
            message: outcome.message,
            eventId: occurrence,
          }
        );
      };
      let returned: ReturnType<RevnixPaywallProps["onPurchase"]>;
      try {
        returned = onPurchase(packageId);
      } catch (err) {
        // A host that throws synchronously has failed the purchase as surely
        // as one whose promise rejects.
        settle({ status: "failed", message: messageOf(err) });
        throw err;
      }
      if (returned && typeof (returned as Promise<unknown>).then === "function") {
        void (returned as Promise<PaywallPurchaseOutcome | void>).then(
          settle,
          (err: unknown) => settle({ status: "failed", message: messageOf(err) })
        );
        return;
      }
      settle(returned as PaywallPurchaseOutcome | void);
    },
    [onPurchase, report, productOf, placementKey]
  );

  const { onRestore } = props;
  const handleRestore = React.useMemo(
    () =>
      onRestore
        ? () => {
            report("restore");
            onRestore();
          }
        : undefined,
    [onRestore, report]
  );

  // The host's dismissal runs whatever happens to the beacon — an analytics
  // failure must never trap the customer on the screen (REV-252).
  const { onClose } = props;
  const handleClose = React.useMemo(
    () =>
      onClose
        ? () => {
            const viewId = viewIdRef.current;
            if (client?.logPaywallClosed && viewId && !disableViewTracking) {
              try {
                client.logPaywallClosed(viewId, { placementKey, paywallId });
              } catch {
                // Reporting is best-effort; dismissal is not.
              }
            }
            onClose();
          }
        : undefined,
    [onClose, client, placementKey, paywallId, disableViewTracking]
  );

  // A designed paywall wins over the classic layouts — same precedence the
  // dashboard preview applies, so what was approved is what ships. The view
  // report above still runs, so analytics does not care which renderer won.
  //
  // Each renderer is its OWN component, so this switch mounts and unmounts
  // rather than changing one component's hook count: a paywall whose config
  // arrives after a placeholder (or is swapped by an A/B assignment) would
  // otherwise crash on "rendered more hooks than during the previous render".
  const { config } = props;
  const blocks = asBlockDoc(config.blocks);
  // Both sinks fire when both are wired; nil when neither is, which is what
  // stops the renderer building a message nobody will read.
  const renderDiagnostic =
    client?.reportRenderDiagnostic || props.onDiagnostic
      ? (message: string) => {
          client?.reportRenderDiagnostic?.(message);
          props.onDiagnostic?.(message);
        }
      : undefined;

  if (blocks) {
    return (
      <RevnixBlockPaywall
        doc={blocks}
        packages={props.packages}
        onPurchase={handlePurchase}
        selectedPackageId={props.selectedPackageId}
        onSelectPackage={handleSelect}
        highlightPackageId={config.highlightPackageId}
        heroImageUrl={config.heroImageUrl}
        onRestore={handleRestore}
        onTerms={props.onTerms}
        onPrivacy={props.onPrivacy}
        onClose={handleClose}
        footer={config.footer}
        gradient={props.gradient}
        blur={props.blur}
        fontFamilyMap={props.fontFamilyMap}
        locale={props.locale}
        onDiagnostic={renderDiagnostic}
        style={props.style}
        loading={props.loading}
      />
    );
  }
  return (
    <ClassicPaywall
      {...props}
      onPurchase={handlePurchase}
      onSelectPackage={handleSelect}
      onRestore={handleRestore}
      onClose={handleClose}
    />
  );
}

/** REV-263: the text an interaction report carries for a thrown error. Kept
 *  short — the server bounds `message` at 1024 chars and nothing groups by
 *  it; the CODE is the field that gets aggregated. */
function messageOf(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return undefined;
}

/** The dismiss affordance the classic layouts get (REV-252).
 *
 *  The nine `template` layouts have the same problem the designed ones had —
 *  nothing on the screen closes them — and `onClose` is a prop of the shared
 *  RevnixPaywall, so a host that wires it must get a close on either path
 *  rather than silently nothing. Classic layouts author no elements of their
 *  own, so there is never a design chip to suppress: the rule reduces to
 *  "draw it whenever the host wired a handler".
 *
 *  Tinted from the theme's own ink so it works in the light scheme too. */
function ClassicClose({
  theme,
  onPress,
}: {
  theme: RevnixPaywallTheme;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Close"
      hitSlop={10}
      onPress={onPress}
      style={{
        position: "absolute",
        top: 14,
        right: 14,
        zIndex: 50,
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: withAlpha(theme.textPrimary, 0.14),
      }}
    >
      <Text style={{ color: theme.textPrimary, fontSize: 17, lineHeight: 20 }}>
        ×
      </Text>
    </Pressable>
  );
}

/** The nine `template` layouts — every paywall published before the block
 *  builder, and the fallback for any config that carries no block tree. */
function ClassicPaywall(props: RevnixPaywallProps) {
  const { config, packages, loading } = props;
  // Base scheme comes from the dashboard config (mode: dark|light, absent =
  // dark for legacy configs); the host app's explicit theme prop wins on top.
  const baseTheme =
    config.mode === "light" ? LIGHT_PAYWALL_THEME : DEFAULT_PAYWALL_THEME;
  const theme = { ...baseTheme, ...props.theme };
  const accent = config.accent ?? DEFAULT_ACCENT;
  const cardBg = CARD_BG[config.mode === "light" ? "light" : "dark"];
  const layout = config.template;

  // Same template semantics as the dashboard preview: "minimal" shows only
  // the highlighted package; feature bullets render on the feature layouts.
  const shown =
    layout === "minimal" && config.highlightPackageId
      ? packages.filter((p) => p.packageId === config.highlightPackageId)
      : packages;

  const [internalSelected, setInternalSelected] = React.useState<
    string | undefined
  >(undefined);
  const fallbackSelected =
    shown.find((p) => p.packageId === config.highlightPackageId)?.packageId ??
    shown[0]?.packageId;
  const selectedId =
    props.selectedPackageId ??
    (internalSelected !== undefined &&
    shown.some((p) => p.packageId === internalSelected)
      ? internalSelected
      : fallbackSelected);

  const select = (packageId: string) => {
    setInternalSelected(packageId);
    props.onSelectPackage?.(packageId);
  };

  // Footer links are dashboard-configured (config.footer); a legacy config
  // without the field keeps the original always-on footer. Explicit host
  // handlers win over config URLs — the app knows best how to open its own
  // legal pages (in-app browser etc.); the URL is the no-handler fallback.
  const footer = config.footer;
  const openUrl = (url?: string) =>
    url ? () => void Linking.openURL(url) : undefined;
  const footerItems = (
    [
      {
        show: footer?.showRestore ?? true,
        label: "Restore",
        onPress: props.onRestore,
      },
      {
        show: footer?.showTerms ?? true,
        label: "Terms",
        onPress: props.onTerms ?? openUrl(footer?.termsUrl),
      },
      {
        show: footer?.showPrivacy ?? true,
        label: "Privacy",
        onPress: props.onPrivacy ?? openUrl(footer?.privacyUrl),
      },
    ] as const
  ).filter((item) => item.show);

  // ——— shared blocks (each layout composes a subset; keep every block in
  // lockstep with the same-named block in PaywallPhonePreview.tsx) ———

  // Classic header: hero image card (or accent icon tile) + centered
  // headline/subheadline. Byte-identical to the pre-layout renderer.
  const heroOrIcon = config.heroImageUrl ? (
    <Image
      source={{ uri: config.heroImageUrl }}
      style={styles.heroImage}
      resizeMode="cover"
      accessibilityIgnoresInvertColors
    />
  ) : (
    <View style={[styles.iconTile, { backgroundColor: `${accent}26` }]}>
      <Text style={[styles.iconGlyph, { color: accent }]}>◆</Text>
    </View>
  );

  const headlineBlock = (
    <>
      <Text style={[styles.headline, { color: theme.textPrimary }]}>
        {config.headline}
      </Text>
      {config.subheadline ? (
        <Text style={[styles.subheadline, { color: theme.textSecondary }]}>
          {config.subheadline}
        </Text>
      ) : null}
    </>
  );

  // Hero layout banner: full-width media with a content-safe scrim overlay
  // carrying the headline/subheadline (always light-on-scrim). Falls back to
  // an accent field with the brand glyph when no hero image is set.
  const heroBanner = (
    <View style={styles.heroBanner}>
      {config.heroImageUrl ? (
        <Image
          source={{ uri: config.heroImageUrl }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View
          style={[StyleSheet.absoluteFill, { backgroundColor: accent }]}
        />
      )}
      {!config.heroImageUrl ? (
        <View style={styles.heroBannerGlyphWrap} pointerEvents="none">
          <Text style={styles.heroBannerGlyph}>◆</Text>
        </View>
      ) : null}
      <View style={styles.heroBannerScrim}>
        <Text style={styles.heroBannerHeadline}>{config.headline}</Text>
        {config.subheadline ? (
          <Text style={styles.heroBannerSub}>{config.subheadline}</Text>
        ) : null}
      </View>
    </View>
  );

  // Legacy feature bullets (feature-list layout).
  const featureBullets =
    config.features.length > 0 ? (
      <View style={styles.features}>
        {config.features.map((f, i) => (
          <View key={i} style={styles.featureRow}>
            <Text style={[styles.featureIcon, { color: accent }]}>
              {f.icon || "✓"}
            </Text>
            <View style={styles.featureBody}>
              <Text style={[styles.featureTitle, { color: theme.textPrimary }]}>
                {f.title}
              </Text>
              {f.description ? (
                <Text
                  style={[
                    styles.featureDescription,
                    { color: theme.textSecondary },
                  ]}
                >
                  {f.description}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    ) : null;

  // Compact single-line checks (hero banner body, plans checklist).
  const featureChecks =
    config.features.length > 0 ? (
      <View style={styles.checks}>
        {config.features.map((f, i) => (
          <View key={i} style={styles.checkRow}>
            <Text style={[styles.checkIcon, { color: accent }]}>
              {f.icon || "✓"}
            </Text>
            <Text
              style={[styles.checkTitle, { color: theme.textPrimary }]}
            >
              {f.title}
            </Text>
          </View>
        ))}
      </View>
    ) : null;

  // Trial timeline: icon dots joined by an accent rail; the first step is
  // filled solid ("you are here"), later steps are tinted.
  const timelineBlock =
    config.features.length > 0 ? (
      <View style={styles.timeline}>
        {config.features.map((f, i) => {
          const last = i === config.features.length - 1;
          return (
            <View key={i} style={styles.timelineRow}>
              <View style={styles.timelineRail}>
                <View
                  style={[
                    styles.timelineDot,
                    i === 0
                      ? { backgroundColor: accent }
                      : { backgroundColor: `${accent}26` },
                  ]}
                >
                  <Text
                    style={[
                      styles.timelineDotIcon,
                      { color: i === 0 ? theme.accentInk : accent },
                    ]}
                  >
                    {f.icon || "✓"}
                  </Text>
                </View>
                {!last ? (
                  <View
                    style={[
                      styles.timelineLine,
                      { backgroundColor: `${accent}40` },
                    ]}
                  />
                ) : null}
              </View>
              <View style={[styles.timelineBody, !last && styles.timelineGap]}>
                <Text
                  style={[styles.featureTitle, { color: theme.textPrimary }]}
                >
                  {f.title}
                </Text>
                {f.description ? (
                  <Text
                    style={[
                      styles.featureDescription,
                      { color: theme.textSecondary },
                    ]}
                  >
                    {f.description}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    ) : null;

  // Feature grid: two-column soft cards with an accent icon tile each.
  const featureGrid =
    config.features.length > 0 ? (
      <View style={styles.grid}>
        {config.features.map((f, i) => (
          <View key={i} style={[styles.gridCard, { backgroundColor: cardBg }]}>
            <View
              style={[styles.gridIconTile, { backgroundColor: `${accent}26` }]}
            >
              <Text style={[styles.gridIcon, { color: accent }]}>
                {f.icon || "✓"}
              </Text>
            </View>
            <Text style={[styles.gridTitle, { color: theme.textPrimary }]}>
              {f.title}
            </Text>
            {f.description ? (
              <Text
                style={[styles.gridDescription, { color: theme.textSecondary }]}
              >
                {f.description}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    ) : null;

  // Reveal: onboarding-style numbered benefit cards + progress dots.
  const progressDots = (
    <View style={styles.dots}>
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          style={[
            styles.dot,
            { backgroundColor: i === 0 ? accent : `${accent}40` },
          ]}
        />
      ))}
    </View>
  );
  const revealCards =
    config.features.length > 0 ? (
      <View style={styles.reveal}>
        {config.features.map((f, i) => (
          <View
            key={i}
            style={[styles.revealCard, { backgroundColor: cardBg }]}
          >
            <View
              style={[styles.revealChip, { backgroundColor: `${accent}26` }]}
            >
              <Text style={[styles.revealNumber, { color: accent }]}>
                {i + 1}
              </Text>
            </View>
            <View style={styles.featureBody}>
              <Text
                style={[styles.revealTitle, { color: theme.textPrimary }]}
              >
                {f.title}
              </Text>
              {f.description ? (
                <Text
                  style={[
                    styles.featureDescription,
                    { color: theme.textSecondary },
                  ]}
                >
                  {f.description}
                </Text>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    ) : null;

  // Social proof card: star row (+ numeric rating), quote, attribution.
  const review = config.review;
  const hasReviewCard =
    review !== undefined &&
    (review.rating !== undefined || Boolean(review.quote));
  const reviewCard = hasReviewCard ? (
    <View style={[styles.reviewCard, { backgroundColor: cardBg }]}>
      {review?.rating !== undefined ? (
        <View style={styles.starsRow}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Text
              key={n}
              style={[
                styles.star,
                {
                  color:
                    n <= Math.round(review.rating ?? 0)
                      ? accent
                      : theme.border,
                },
              ]}
            >
              ★
            </Text>
          ))}
          <Text style={[styles.starRating, { color: theme.textPrimary }]}>
            {String(review.rating)}
          </Text>
        </View>
      ) : null}
      {review?.quote ? (
        <Text style={[styles.reviewQuote, { color: theme.textPrimary }]}>
          “{review.quote}”
        </Text>
      ) : null}
      {review?.author ? (
        <Text style={[styles.reviewAuthor, { color: theme.textSecondary }]}>
          {review.author}
        </Text>
      ) : null}
    </View>
  ) : null;
  const countLine = review?.count ? (
    <Text style={[styles.countLine, { color: theme.textSecondary }]}>
      {review.count}
    </Text>
  ) : null;

  // Offer bits: urgency line above the CTA; anchor price struck through on
  // the highlighted package.
  const urgencyLine = config.offer?.urgencyText ? (
    <Text style={[styles.urgency, { color: accent }]}>
      {config.offer.urgencyText}
    </Text>
  ) : null;
  // The anchor is dashboard free text while priceLabel is the store's
  // localized price — never pair them when their currency symbols disagree,
  // or a EUR customer would see a struck-through USD anchor next to the real
  // charge (this file's "display never disagrees with the charge" rule;
  // kept in lockstep with the preview's anchorPriceFor). Symbol-less
  // anchors can't be judged and pass through.
  const anchorPriceFor = (priceLabel: string): string | undefined => {
    const anchor = config.offer?.strikethroughPrice;
    if (!anchor) return undefined;
    const symbol = anchor.match(CURRENCY_SYMBOL)?.[0];
    return symbol === undefined || priceLabel.includes(symbol)
      ? anchor
      : undefined;
  };

  const priceLine = (pkg: RevnixPaywallPackage, highlighted: boolean) => {
    const anchorPrice = highlighted
      ? anchorPriceFor(pkg.priceLabel)
      : undefined;
    return anchorPrice ? (
      <View style={styles.priceRow}>
        <Text style={[styles.anchorPrice, { color: theme.textFaint }]}>
          {anchorPrice}
        </Text>
        <Text style={[styles.packagePrice, { color: theme.textSecondary }]}>
          {pkg.priceLabel}
        </Text>
      </View>
    ) : (
      <Text style={[styles.packagePrice, { color: theme.textSecondary }]}>
        {pkg.priceLabel}
      </Text>
    );
  };

  // Standard package rows (all layouts except plans columns / offer
  // spotlight). `withBadge=false` suppresses the row badge where the layout
  // already presents the badge elsewhere (offer pill).
  const packageRows = (list: RevnixPaywallPackage[], withBadge = true) => (
    <View style={styles.packages}>
      {list.map((pkg) => {
        const selected = pkg.packageId === selectedId;
        const highlighted = pkg.packageId === config.highlightPackageId;
        const badged = withBadge && highlighted && Boolean(config.badgeText);
        return (
          <Pressable
            key={pkg.packageId}
            onPress={() => select(pkg.packageId)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            style={[
              styles.packageRow,
              selected
                ? { borderColor: accent, borderWidth: 2 }
                : { borderColor: theme.border, borderWidth: 1 },
            ]}
          >
            {badged ? (
              <View style={[styles.badge, { backgroundColor: accent }]}>
                <Text
                  numberOfLines={1}
                  style={[styles.badgeText, { color: theme.accentInk }]}
                >
                  {config.badgeText}
                </Text>
              </View>
            ) : null}
            <Text style={[styles.packageTitle, { color: theme.textPrimary }]}>
              {pkg.title}
            </Text>
            {priceLine(pkg, highlighted)}
          </Pressable>
        );
      })}
    </View>
  );

  // Plans layout: packages side by side as tier columns; the highlighted
  // tier carries the badge pill inside the column. Columns stay readable up
  // to 3 — beyond that the layout falls back to stacked rows (never drop a
  // purchasable package), same rule as the dashboard preview.
  const usePlanColumns = shown.length <= 3;
  const planColumns = (
    <View style={styles.planRow}>
      {shown.map((pkg) => {
        const selected = pkg.packageId === selectedId;
        const highlighted = pkg.packageId === config.highlightPackageId;
        const anchorPrice = highlighted
          ? anchorPriceFor(pkg.priceLabel)
          : undefined;
        return (
          <Pressable
            key={pkg.packageId}
            onPress={() => select(pkg.packageId)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            style={[
              styles.planColumn,
              selected
                ? { borderColor: accent, borderWidth: 2 }
                : { borderColor: theme.border, borderWidth: 1 },
            ]}
          >
            {highlighted && config.badgeText ? (
              <View style={[styles.planBadge, { backgroundColor: accent }]}>
                <Text
                  numberOfLines={1}
                  style={[styles.badgeText, { color: theme.accentInk }]}
                >
                  {config.badgeText}
                </Text>
              </View>
            ) : null}
            <Text
              style={[styles.planTitle, { color: theme.textPrimary }]}
            >
              {pkg.title}
            </Text>
            {anchorPrice ? (
              <Text style={[styles.anchorPrice, { color: theme.textFaint }]}>
                {anchorPrice}
              </Text>
            ) : null}
            <Text style={[styles.planPrice, { color: theme.textPrimary }]}>
              {pkg.priceLabel}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  // Offer layout: the badge becomes a large centered pill; the highlighted
  // (else first) package renders as a spotlight card with the anchor price.
  const spotlightPkg =
    shown.find((p) => p.packageId === config.highlightPackageId) ?? shown[0];
  const offerPill = config.badgeText ? (
    <View style={[styles.offerPill, { backgroundColor: accent }]}>
      <Text
        numberOfLines={1}
        style={[styles.offerPillText, { color: theme.accentInk }]}
      >
        {config.badgeText}
      </Text>
    </View>
  ) : null;
  const spotlightAnchor = spotlightPkg
    ? anchorPriceFor(spotlightPkg.priceLabel)
    : undefined;
  const offerSpotlight = spotlightPkg ? (
    <>
      <Pressable
        onPress={() => select(spotlightPkg.packageId)}
        accessibilityRole="radio"
        accessibilityState={{
          selected: spotlightPkg.packageId === selectedId,
        }}
        style={[
          styles.spotlight,
          {
            borderColor:
              spotlightPkg.packageId === selectedId ? accent : theme.border,
          },
        ]}
      >
        <Text style={[styles.spotlightTitle, { color: theme.textPrimary }]}>
          {spotlightPkg.title}
        </Text>
        <View style={styles.priceRowCenter}>
          {spotlightAnchor ? (
            <Text
              style={[styles.spotlightAnchor, { color: theme.textFaint }]}
            >
              {spotlightAnchor}
            </Text>
          ) : null}
          <Text
            style={[styles.spotlightPrice, { color: theme.textPrimary }]}
          >
            {spotlightPkg.priceLabel}
          </Text>
        </View>
      </Pressable>
      {shown.length > 1
        ? packageRows(
            shown.filter((p) => p.packageId !== spotlightPkg.packageId),
            false
          )
        : null}
    </>
  ) : null;

  const cta = (
    <Pressable
      onPress={() => {
        if (!loading && selectedId) props.onPurchase(selectedId);
      }}
      disabled={loading || !selectedId}
      accessibilityRole="button"
      style={[styles.cta, { backgroundColor: accent }]}
    >
      {loading ? (
        <ActivityIndicator color={theme.accentInk} />
      ) : (
        <Text style={[styles.ctaLabel, { color: theme.accentInk }]}>
          {config.ctaLabel}
        </Text>
      )}
    </Pressable>
  );

  const footerBlock =
    footerItems.length > 0 ? (
      <View style={styles.footer}>
        {footerItems.map((item, i) => (
          <React.Fragment key={item.label}>
            {i > 0 ? (
              <Text style={[styles.footerDot, { color: theme.textFaint }]}>
                {" · "}
              </Text>
            ) : null}
            <Text
              onPress={item.onPress}
              style={[styles.footerLink, { color: theme.textFaint }]}
            >
              {item.label}
            </Text>
          </React.Fragment>
        ))}
      </View>
    ) : null;

  // Tail shared by every layout: urgency → CTA → count → footer.
  const tail = (
    <>
      {urgencyLine}
      {cta}
      {countLine}
      {footerBlock}
    </>
  );

  let body: React.ReactNode;
  switch (layout) {
    case "hero":
      body = (
        <>
          {heroBanner}
          {featureChecks}
          {reviewCard}
          {packageRows(shown)}
          {tail}
        </>
      );
      break;
    case "timeline":
      body = (
        <>
          {heroOrIcon}
          {headlineBlock}
          {timelineBlock}
          {reviewCard}
          {packageRows(shown)}
          {tail}
        </>
      );
      break;
    case "plans":
      body = (
        <>
          {heroOrIcon}
          {headlineBlock}
          {usePlanColumns ? planColumns : packageRows(shown)}
          {featureChecks}
          {reviewCard}
          {tail}
        </>
      );
      break;
    case "feature-grid":
      body = (
        <>
          {heroOrIcon}
          {headlineBlock}
          {featureGrid}
          {reviewCard}
          {packageRows(shown)}
          {tail}
        </>
      );
      break;
    case "offer":
      body = (
        <>
          {heroOrIcon}
          {offerPill}
          {headlineBlock}
          {offerSpotlight}
          {reviewCard}
          {tail}
        </>
      );
      break;
    case "reveal":
      body = (
        <>
          {progressDots}
          {heroOrIcon}
          {headlineBlock}
          {revealCards}
          {packageRows(shown)}
          {tail}
        </>
      );
      break;
    default:
      // focus | feature-list | minimal — the original structure, unchanged
      // for legacy configs (review/offer blocks only exist when configured).
      body = (
        <>
          {heroOrIcon}
          {headlineBlock}
          {layout === "feature-list" ? featureBullets : null}
          {reviewCard}
          {packageRows(shown)}
          {tail}
        </>
      );
      break;
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.background }, props.style]}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={styles.content}>{body}</View>
      </ScrollView>
      {props.onClose ? (
        <ClassicClose theme={theme} onPress={props.onClose} />
      ) : null}
    </View>
  );
}

// PROPORTIONS mirror PaywallPhonePreview.tsx (the dashboard's miniature phone
// mock); SIZES are scaled up to native-device typography — the preview is a
// scaled-down mock, so copying its pixel values verbatim rendered a paywall
// that read ~30% too small on a real screen.
//
// Responsive rules:
//  · scrollContent flexGrow+center — content sits vertically centered on tall
//    screens (no dead bottom half) and scrolls normally when it overflows.
//  · content maxWidth — on tablets/wide screens the column stays a readable
//    width, horizontally centered, instead of stretching edge to edge.
const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingTop: 28,
    paddingBottom: 32,
  },
  content: {
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
  },
  heroImage: {
    alignSelf: "stretch",
    height: 180,
    borderRadius: 16,
    marginTop: 8,
    marginBottom: 22,
  },
  iconTile: {
    alignSelf: "center",
    width: 64,
    height: 64,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
    marginBottom: 22,
  },
  iconGlyph: { fontSize: 27 },
  headline: {
    fontSize: 26,
    fontWeight: "800",
    textAlign: "center",
    marginBottom: 10,
  },
  subheadline: {
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
    marginBottom: 26,
  },
  // hero layout banner
  heroBanner: {
    alignSelf: "stretch",
    minHeight: 260,
    borderRadius: 20,
    overflow: "hidden",
    justifyContent: "flex-end",
    marginTop: 8,
    marginBottom: 22,
  },
  heroBannerGlyphWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 72,
  },
  heroBannerGlyph: { fontSize: 64, color: "rgba(255,255,255,0.35)" },
  heroBannerScrim: {
    backgroundColor: "rgba(0,0,0,0.45)",
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  heroBannerHeadline: { fontSize: 24, fontWeight: "800", color: "#ffffff" },
  heroBannerSub: {
    fontSize: 13.5,
    lineHeight: 19,
    color: "rgba(255,255,255,0.85)",
    marginTop: 4,
  },
  features: { marginBottom: 26, gap: 14 },
  featureRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  featureIcon: { width: 24, fontSize: 15, lineHeight: 21 },
  featureBody: { flex: 1 },
  featureTitle: { fontSize: 15.5, fontWeight: "600", lineHeight: 21 },
  featureDescription: { fontSize: 13, lineHeight: 18, marginTop: 1 },
  // compact single-line checks
  checks: { marginBottom: 24, gap: 10 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  checkIcon: { width: 20, fontSize: 14 },
  checkTitle: { flex: 1, fontSize: 14.5, fontWeight: "500", lineHeight: 20 },
  // trial timeline
  timeline: { marginBottom: 26 },
  timelineRow: { flexDirection: "row", gap: 12 },
  timelineRail: { width: 34, alignItems: "center" },
  timelineDot: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  timelineDotIcon: { fontSize: 14 },
  timelineLine: { flex: 1, width: 2, marginVertical: 4 },
  timelineBody: { flex: 1, paddingTop: 6 },
  timelineGap: { paddingBottom: 22 },
  // feature grid
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 24,
  },
  gridCard: {
    width: "47.5%",
    flexGrow: 1,
    borderRadius: 14,
    padding: 13,
  },
  gridIconTile: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 9,
  },
  gridIcon: { fontSize: 15 },
  gridTitle: { fontSize: 13.5, fontWeight: "600", lineHeight: 18 },
  gridDescription: { fontSize: 12, lineHeight: 16, marginTop: 3 },
  // reveal (onboarding-style)
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    marginBottom: 18,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  reveal: { gap: 10, marginBottom: 24 },
  revealCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    borderRadius: 14,
    padding: 14,
  },
  revealChip: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  revealNumber: { fontSize: 13, fontWeight: "700" },
  revealTitle: { fontSize: 15, fontWeight: "600", lineHeight: 20 },
  // social proof
  reviewCard: {
    borderRadius: 14,
    padding: 14,
    alignItems: "center",
    marginBottom: 22,
  },
  starsRow: { flexDirection: "row", alignItems: "center" },
  star: { fontSize: 15, marginHorizontal: 1 },
  starRating: { fontSize: 13, fontWeight: "600", marginLeft: 6 },
  reviewQuote: {
    fontSize: 13.5,
    lineHeight: 19,
    fontStyle: "italic",
    textAlign: "center",
    marginTop: 8,
  },
  reviewAuthor: { fontSize: 12, marginTop: 6 },
  countLine: { fontSize: 12.5, textAlign: "center", marginBottom: 14 },
  // offer
  urgency: {
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 10,
  },
  offerPill: {
    alignSelf: "center",
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: 14,
    maxWidth: "80%",
  },
  offerPillText: { fontSize: 12, fontWeight: "700" },
  spotlight: {
    borderWidth: 2,
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 18,
    alignItems: "center",
    marginBottom: 12,
  },
  spotlightTitle: { fontSize: 16, fontWeight: "600" },
  priceRowCenter: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: 8,
    marginTop: 6,
  },
  spotlightAnchor: {
    fontSize: 15,
    textDecorationLine: "line-through",
    fontVariant: ["tabular-nums"],
  },
  spotlightPrice: {
    fontSize: 24,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
  },
  // plans columns
  planRow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 8,
    marginBottom: 22,
  },
  planColumn: {
    flex: 1,
    borderRadius: 14,
    paddingHorizontal: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  planBadge: {
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginBottom: 7,
    maxWidth: "100%",
  },
  planTitle: {
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 19,
  },
  planPrice: {
    fontSize: 15,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    marginTop: 4,
  },
  packages: { gap: 12, marginBottom: 22 },
  packageRow: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 15,
  },
  badge: {
    position: "absolute",
    top: -11,
    right: 14,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 3,
    // Absolute views take no width constraint from the card — a long badge
    // string used to grow past the card edge (kept in lockstep with the
    // dashboard preview, which truncates the same way).
    maxWidth: "80%",
  },
  badgeText: { fontSize: 11, fontWeight: "700" },
  packageTitle: { fontSize: 16, fontWeight: "600" },
  packagePrice: { fontSize: 14, fontVariant: ["tabular-nums"], marginTop: 2 },
  priceRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    marginTop: 2,
  },
  anchorPrice: {
    fontSize: 13,
    textDecorationLine: "line-through",
    fontVariant: ["tabular-nums"],
  },
  cta: {
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    marginBottom: 14,
  },
  ctaLabel: { fontSize: 16.5, fontWeight: "700" },
  footer: { flexDirection: "row", justifyContent: "center" },
  footerLink: { fontSize: 13, padding: 4 },
  footerDot: { fontSize: 13, paddingVertical: 4 },
});
