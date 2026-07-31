// RevnixPaywall — renders a published PaywallConfig exactly as the dashboard
// paywall-builder previews it (PaywallPhonePreview.tsx in revnix-app is the
// reference renderer; keep the two in lockstep). The config decides template,
// copy, accent, badge, highlight, and hero image; the app supplies package
// titles/prices (from StoreKit / Play Billing) and the purchase handlers, so
// the display never disagrees with the charge.
//
// Import from "revnix-react/ui" — the core entrypoint stays free of
// react / react-native so non-RN consumers are unaffected.

import * as React from "react";
import {
  ActivityIndicator,
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

import type { PaywallConfig } from "../types.js";

/** One purchasable row. `priceLabel` must come from the store (localized). */
export interface RevnixPaywallPackage {
  packageId: string;
  title: string;
  priceLabel: string;
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

export interface RevnixPaywallProps {
  config: PaywallConfig;
  packages: RevnixPaywallPackage[];
  /** Called with the selected packageId when the CTA is pressed. */
  onPurchase: (packageId: string) => void;
  /** Controlled selection; omit to let the paywall manage it (initial
   *  selection is the config's highlight package, else the first package). */
  selectedPackageId?: string;
  onSelectPackage?: (packageId: string) => void;
  /** Renders a spinner in the CTA and disables purchasing. */
  loading?: boolean;
  onRestore?: () => void;
  onTerms?: () => void;
  onPrivacy?: () => void;
  theme?: Partial<RevnixPaywallTheme>;
  style?: StyleProp<ViewStyle>;
  /** When given, the paywall reports one paywall.viewed per mount (REV-094)
   *  — the analytics funnel's "Paywall displayed" stage. Structural typing
   *  keeps this entrypoint free of a hard client import. */
  client?: { logPaywallShown: (options?: { placementKey?: string; paywallId?: string }) => void };
  /** Placement/paywall attribution attached to the view report. */
  placementKey?: string;
  paywallId?: string;
  /** Opt out of the automatic view report while still passing `client`. */
  disableViewTracking?: boolean;
}

export function RevnixPaywall(props: RevnixPaywallProps) {
  const { config, packages, loading } = props;

  // One view per mount: remounting (a re-shown paywall) is a genuine new
  // display; re-renders are not.
  const { client, placementKey, paywallId, disableViewTracking } = props;
  React.useEffect(() => {
    if (!client || disableViewTracking) return;
    client.logPaywallShown({ placementKey, paywallId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Base scheme comes from the dashboard config (mode: dark|light, absent =
  // dark for legacy configs); the host app's explicit theme prop wins on top.
  const baseTheme =
    config.mode === "light" ? LIGHT_PAYWALL_THEME : DEFAULT_PAYWALL_THEME;
  const theme = { ...baseTheme, ...props.theme };
  const accent = config.accent ?? DEFAULT_ACCENT;

  // Same template semantics as the dashboard preview: "minimal" shows only
  // the highlighted package; only "feature-list" renders feature bullets.
  const shown =
    config.template === "minimal" && config.highlightPackageId
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

  return (
    <View style={[styles.root, { backgroundColor: theme.background }, props.style]}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={styles.content}>
        {config.heroImageUrl ? (
          <Image
            source={{ uri: config.heroImageUrl }}
            style={styles.heroImage}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View
            style={[styles.iconTile, { backgroundColor: `${accent}26` }]}
          >
            <Text style={[styles.iconGlyph, { color: accent }]}>◆</Text>
          </View>
        )}

        <Text style={[styles.headline, { color: theme.textPrimary }]}>
          {config.headline}
        </Text>
        {config.subheadline ? (
          <Text style={[styles.subheadline, { color: theme.textSecondary }]}>
            {config.subheadline}
          </Text>
        ) : null}

        {config.template === "feature-list" && config.features.length > 0 ? (
          <View style={styles.features}>
            {config.features.map((f, i) => (
              <View key={i} style={styles.featureRow}>
                <Text style={[styles.featureIcon, { color: accent }]}>
                  {f.icon || "✓"}
                </Text>
                <View style={styles.featureBody}>
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
            ))}
          </View>
        ) : null}

        <View style={styles.packages}>
          {shown.map((pkg) => {
            const selected = pkg.packageId === selectedId;
            const badged =
              pkg.packageId === config.highlightPackageId &&
              Boolean(config.badgeText);
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
                <Text
                  style={[styles.packageTitle, { color: theme.textPrimary }]}
                >
                  {pkg.title}
                </Text>
                <Text
                  style={[styles.packagePrice, { color: theme.textSecondary }]}
                >
                  {pkg.priceLabel}
                </Text>
              </Pressable>
            );
          })}
        </View>

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

        {footerItems.length > 0 ? (
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
        ) : null}
        </View>
      </ScrollView>
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
  features: { marginBottom: 26, gap: 14 },
  featureRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  featureIcon: { width: 24, fontSize: 15, lineHeight: 21 },
  featureBody: { flex: 1 },
  featureTitle: { fontSize: 15.5, fontWeight: "600", lineHeight: 21 },
  featureDescription: { fontSize: 13, lineHeight: 18, marginTop: 1 },
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
