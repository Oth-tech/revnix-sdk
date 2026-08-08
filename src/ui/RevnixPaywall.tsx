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
          — {review.author}
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
