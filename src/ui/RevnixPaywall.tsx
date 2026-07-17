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
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import type { PaywallConfig } from "../types";

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
  const theme = { ...DEFAULT_PAYWALL_THEME, ...props.theme };
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

  return (
    <View style={[styles.root, { backgroundColor: theme.background }, props.style]}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
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
                    <Text style={[styles.badgeText, { color: theme.accentInk }]}>
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

        <View style={styles.footer}>
          <Text
            onPress={props.onRestore}
            style={[styles.footerLink, { color: theme.textFaint }]}
          >
            Restore
          </Text>
          <Text style={[styles.footerDot, { color: theme.textFaint }]}> · </Text>
          <Text
            onPress={props.onTerms}
            style={[styles.footerLink, { color: theme.textFaint }]}
          >
            Terms
          </Text>
          <Text style={[styles.footerDot, { color: theme.textFaint }]}> · </Text>
          <Text
            onPress={props.onPrivacy}
            style={[styles.footerLink, { color: theme.textFaint }]}
          >
            Privacy
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

// Dimensions mirror PaywallPhonePreview.tsx (Tailwind spacing × 4px).
const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 22,
    paddingTop: 24,
    paddingBottom: 30,
    alignItems: "stretch",
  },
  heroImage: {
    alignSelf: "stretch",
    height: 160,
    borderRadius: 14,
    marginTop: 8,
    marginBottom: 18,
  },
  iconTile: {
    alignSelf: "center",
    width: 52,
    height: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
    marginBottom: 18,
  },
  iconGlyph: { fontSize: 22 },
  headline: {
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 8,
  },
  subheadline: {
    fontSize: 12.5,
    lineHeight: 19,
    textAlign: "center",
    marginBottom: 20,
  },
  features: { marginBottom: 20, gap: 10 },
  featureRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  featureIcon: { width: 20, fontSize: 13 },
  featureBody: { flex: 1 },
  featureTitle: { fontSize: 12.5, fontWeight: "600" },
  featureDescription: { fontSize: 11, lineHeight: 15.5 },
  packages: { gap: 10, marginBottom: 18 },
  packageRow: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  badge: {
    position: "absolute",
    top: -9,
    right: 12,
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: { fontSize: 9, fontWeight: "700" },
  packageTitle: { fontSize: 13, fontWeight: "600" },
  packagePrice: { fontSize: 11.5, fontVariant: ["tabular-nums"] },
  cta: {
    borderRadius: 8,
    padding: 13,
    alignItems: "center",
    marginBottom: 12,
  },
  ctaLabel: { fontSize: 14, fontWeight: "700" },
  footer: { flexDirection: "row", justifyContent: "center" },
  footerLink: { fontSize: 10.5 },
  footerDot: { fontSize: 10.5 },
});
