import { describe, expect, test } from "@jest/globals";
import {
  gradientFallbackColor,
  isGradient,
  parseGradient,
  resolveColor,
  withAlpha,
} from "./color.js";
import {
  hairlineColor,
  inherit,
  inheritedTextStyle,
  resolveFontFamily,
  toTextStyle,
  toViewStyle,
} from "./style.js";
import { resolveTags } from "./tags.js";
import type { PaywallBlockDoc } from "./types.js";
import type { RevnixPaywallPackage } from "../ui/RevnixPaywall.js";

// Designed paywalls: the SDK is the second interpreter of a document the
// dashboard authored. These cover the translations the web renderer gets from
// CSS for free — palette tokens, gradients, and CSS units — because that is
// where the two renderers can silently drift apart.

const DOC: PaywallBlockDoc = {
  version: 1,
  layout: "canvas",
  background: "#150E33",
  textColor: "#FFFFFF",
  accent: "#3B2C8F",
  accentInk: "#FFFFFF",
  blocks: [],
};

const ctx = { doc: DOC, fontSize: 15 };

describe("palette tokens", () => {
  test("expands the four screen tokens", () => {
    expect(resolveColor("@accent", DOC)).toBe("#3B2C8F");
    expect(resolveColor("@accentInk", DOC)).toBe("#FFFFFF");
    expect(resolveColor("@bg", DOC)).toBe("#150E33");
    expect(resolveColor("@text", DOC)).toBe("#FFFFFF");
  });

  test("a percentage token becomes rgba, not color-mix", () => {
    // The web renderer emits color-mix(); RN understands neither that nor a
    // bare percentage, so the alpha has to be computed here.
    expect(resolveColor("@text/12", DOC)).toBe("rgba(255, 255, 255, 0.12)");
    expect(resolveColor("@accent/50", DOC)).toBe("rgba(59, 44, 143, 0.5)");
  });

  test("plain colors and unknown formats pass through untouched", () => {
    expect(resolveColor("rgba(255,255,255,0.16)", DOC)).toBe(
      "rgba(255,255,255,0.16)",
    );
    expect(resolveColor(undefined, DOC)).toBeUndefined();
    // A named color cannot be given an alpha without guessing at its channels.
    expect(withAlpha("rebeccapurple", 0.5)).toBe("rebeccapurple");
  });

  test("withAlpha understands short hex, long hex and rgba", () => {
    expect(withAlpha("#fff", 0.5)).toBe("rgba(255, 255, 255, 0.5)");
    expect(withAlpha("#3B2C8F", 1)).toBe("rgba(59, 44, 143, 1)");
    // Existing alpha multiplies rather than being replaced.
    expect(withAlpha("rgba(0, 0, 0, 0.5)", 0.5)).toBe("rgba(0, 0, 0, 0.25)");
  });
});

describe("gradients", () => {
  const BACKGROUND =
    "radial-gradient(120% 90% at 85% 5%,#2E8FA8 0%,rgba(46,143,168,0) 52%)," +
    "linear-gradient(180deg,#1B1147 0%,#150E33 68%,#0F0A26 100%)";

  test("splits layers without breaking on commas inside parens", () => {
    expect(isGradient(BACKGROUND)).toBe(true);
    const layers = parseGradient(BACKGROUND);
    expect(layers).toHaveLength(2);
    expect(layers[0]!.kind).toBe("radial");
    expect(layers[1]).toMatchObject({
      kind: "linear",
      angle: 180,
      colors: ["#1B1147", "#150E33", "#0F0A26"],
      locations: [0, 0.68, 1],
    });
  });

  test("drops a radial's shape prelude but keeps its stops", () => {
    const [radial] = parseGradient(BACKGROUND);
    expect(radial!.colors).toEqual(["#2E8FA8", "rgba(46,143,168,0)"]);
  });

  test("reads keyword directions and bare stops", () => {
    const [layer] = parseGradient("linear-gradient(to right, #000, #fff)");
    expect(layer).toMatchObject({ angle: 90, colors: ["#000", "#fff"] });
    // Partly-positioned stops would place wrongly, so no locations at all.
    expect(layer!.locations).toBeUndefined();
  });

  test("the no-gradient-component fallback is the base layer's ground color", () => {
    // CSS paints the LAST layer at the bottom — that is the design's ground.
    expect(gradientFallbackColor(BACKGROUND)).toBe("#1B1147");
  });

  test("a plain color among the layers is kept as the ground", () => {
    // Dropping it would leave a translucent glow painting the whole screen —
    // a dark design rendering near-white under its own white text.
    const mixed =
      "radial-gradient(80% 60% at 50% 0%,rgba(255,255,255,0.14) 0%,rgba(255,255,255,0) 60%), #05070d";
    const layers = parseGradient(mixed);
    expect(layers.map((l) => l.kind)).toEqual(["radial", "solid"]);
    expect(gradientFallbackColor(mixed)).toBe("#05070d");
  });

  test("radial layers fade downwards, the direction the renderer assumes", () => {
    // The center of a radial is dropped (RN has no radial gradient); a 0deg
    // default would put the opaque stop at the BOTTOM of the screen.
    const [radial] = parseGradient(
      "radial-gradient(120% 90% at 85% 5%,#2E8FA8 0%,rgba(46,143,168,0) 52%)",
    );
    expect(radial!.angle).toBe(180);
  });

  test("malformed hex degrades to the literal instead of NaN channels", () => {
    // "rgba(NaN, NaN, NaN, …)" is not a color RN can paint.
    expect(withAlpha("#zzz", 0.5)).toBe("#zzz");
    expect(withAlpha("#12", 0.5)).toBe("#12");
  });

  test("a plain color is not mistaken for a gradient", () => {
    // `isGradient` is the guard every caller checks first; a plain color that
    // reaches the parser is simply its own solid layer.
    expect(isGradient("#150E33")).toBe(false);
    expect(parseGradient("#150E33")).toEqual([
      { kind: "solid", angle: 180, colors: ["#150E33"], locations: undefined },
    ]);
  });
});

describe("style mapping", () => {
  test("per-side padding wins over the shorthands", () => {
    const style = toViewStyle(
      { padding: 4, paddingX: 10, paddingY: 8, paddingTop: 70 },
      ctx,
    );
    expect(style).toMatchObject({
      padding: 4,
      paddingHorizontal: 10,
      paddingVertical: 8,
      paddingTop: 70,
    });
  });

  test("a border shorthand becomes RN width + color, tokens resolved", () => {
    const style = toViewStyle({ borderBottom: "1.5px solid @text/12" }, ctx);
    expect(style).toMatchObject({
      borderBottomWidth: 1.5,
      borderBottomColor: "rgba(255, 255, 255, 0.12)",
    });
  });

  test("inset and edge offsets both imply absolute positioning", () => {
    expect(toViewStyle({ inset: true }, ctx)).toMatchObject({
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    });
    expect(toViewStyle({ top: 62, right: 16 }, ctx)).toMatchObject({
      position: "absolute",
      top: 62,
      right: 16,
    });
    // A style with neither stays in flow.
    expect(toViewStyle({ gap: 8 }, ctx).position).toBeUndefined();
  });

  test("aspect ratio accepts both a number and a CSS ratio string", () => {
    expect(toViewStyle({ aspectRatio: 1.5 }, ctx).aspectRatio).toBe(1.5);
    expect(toViewStyle({ aspectRatio: "16/9" }, ctx).aspectRatio).toBeCloseTo(
      16 / 9,
    );
  });

  test("a gradient fill degrades to its ground color, never a raw CSS string", () => {
    // RN paints nothing at all for an unparseable backgroundColor, so a card
    // designed with a gradient would lose its background entirely.
    const style = toViewStyle(
      { fill: "linear-gradient(180deg,#1B1147 0%,#0F0A26 100%)" },
      ctx,
    );
    expect(style.backgroundColor).toBe("#1B1147");
    expect(toViewStyle({ fill: "@accent" }, ctx).backgroundColor).toBe(
      "#3B2C8F",
    );
  });

  test("properties RN cannot express are dropped, not faked", () => {
    const style = toViewStyle(
      {
        blur: 14,
        filter: "blur(2px)",
        fillSize: "24px 24px",
        clipPath: "polygon(50% 0,100% 100%,0 100%)",
      },
      ctx,
    ) as Record<string, unknown>;
    expect(style.blur).toBeUndefined();
    expect(style.filter).toBeUndefined();
    expect(style.backdropFilter).toBeUndefined();
    expect(style.backgroundSize).toBeUndefined();
    expect(style.clipPath).toBeUndefined();
  });

  // The converted designs size carousel cards and side rails with
  // `flex: 0 0 250px`; without a basis they collapse to nothing on device.
  test("flex basis and self-alignment survive the trip", () => {
    const style = toViewStyle(
      { flex: 0, shrink: 0, basis: 250, selfAlign: "start" },
      ctx,
    );
    expect(style.flexBasis).toBe(250);
    expect(style.flexGrow).toBe(0);
    expect(style.flexShrink).toBe(0);
    expect(style.alignSelf).toBe("flex-start");
  });

  test("proportional sizes and auto margins pass through as RN accepts them", () => {
    const style = toViewStyle(
      { height: "78%", top: "50%", marginTop: "auto", marginLeft: 12 },
      ctx,
    );
    expect(style.height).toBe("78%");
    expect(style.top).toBe("50%");
    expect(style.marginTop).toBe("auto");
    expect(style.marginLeft).toBe(12);
  });

  test("a px translate applies; a percentage one is dropped, never guessed", () => {
    // RN transforms take points. A badge centred with left:50% +
    // translate:"-50% 0" cannot be corrected here, so the percentage is
    // dropped rather than approximated at some arbitrary width.
    expect(toViewStyle({ translate: "-8px 4px" }, ctx).transform).toEqual([
      { translateX: -8 },
      { translateY: 4 },
    ]);
    expect(toViewStyle({ translate: "-50% 0" }, ctx).transform).toBeUndefined();
    expect(toViewStyle({ translate: "-50% -50%" }, ctx).transform).toBeUndefined();
  });

  test("rotate and translate compose into one transform list", () => {
    expect(
      toViewStyle({ rotate: 45, translate: "0 -8px" }, ctx).transform,
    ).toEqual([{ rotate: "45deg" }, { translateY: -8 }]);
  });

  test("CSS text units convert to points against the block's own size", () => {
    const style = toTextStyle(
      { fontSize: 42, letterSpacing: 0.26, lineHeight: 1.06 },
      ctx,
    );
    expect(style.letterSpacing).toBeCloseTo(42 * 0.26);
    expect(style.lineHeight).toBeCloseTo(42 * 1.06);
  });

  test("text units fall back to the inherited size", () => {
    const style = toTextStyle({ letterSpacing: 0.5 }, { doc: DOC, fontSize: 20 });
    expect(style.letterSpacing).toBe(10);
  });

  test("a design font renders only through the host's font map", () => {
    // RN cannot load a family by name; an unmapped face must degrade to the
    // system font rather than fail to render on Android.
    expect(resolveFontFamily("Newsreader", ctx)).toBeUndefined();
    expect(
      resolveFontFamily("Newsreader", {
        ...ctx,
        fontFamilyMap: { Newsreader: "Newsreader-Regular" },
      }),
    ).toBe("Newsreader-Regular");
    // Mapped to undefined = "I did not bundle this one".
    expect(
      resolveFontFamily("DM Mono", {
        ...ctx,
        fontFamilyMap: { "DM Mono": undefined },
      }),
    ).toBeUndefined();
  });

  test("a weight table picks the nearest registered face", () => {
    // RN selects a face by family NAME, so weight 800 of a family registered
    // only at 400/700 has to resolve to the 700 file — asking for 800 by
    // fontWeight alone would get a synthesised bold instead of the real one.
    const map = {
      "Plus Jakarta Sans": {
        400: "PlusJakartaSans_400Regular",
        700: "PlusJakartaSans_700Bold",
      },
    };
    const withMap = { ...ctx, fontFamilyMap: map };
    expect(resolveFontFamily("Plus Jakarta Sans", withMap, "800")).toBe(
      "PlusJakartaSans_700Bold",
    );
    expect(resolveFontFamily("Plus Jakarta Sans", withMap, "500")).toBe(
      "PlusJakartaSans_400Regular",
    );
    // No weight stated = CSS's default 400.
    expect(resolveFontFamily("Plus Jakarta Sans", withMap)).toBe(
      "PlusJakartaSans_400Regular",
    );
  });

  test("font weight becomes an RN string weight", () => {
    expect(toTextStyle({ fontWeight: 800 }, ctx).fontWeight).toBe("800");
  });

  test("hairlines derive from the colour in force, not the screen default", () => {
    // The web rule paints in `currentColor`, so a card that recoloured its
    // subtree recolours the rule inside it too.
    expect(hairlineColor(DOC.textColor)).toBe("rgba(255, 255, 255, 0.16)");
    expect(hairlineColor("#000000")).toBe("rgba(0, 0, 0, 0.16)");
  });
});

describe("text inheritance", () => {
  // CSS inherits colour, font and alignment down the tree; React Native
  // inherits none of it through Views. A design that recolours a whole
  // section by styling its container — which is how the templates are
  // authored — renders in the wrong colour without this.
  const root = { color: DOC.textColor, fontSize: 16 };

  test("a container's typography flows to its descendants", () => {
    const card = inherit(root, { textColor: "#EDEAFB", fontSize: 15 }, ctx);
    expect(card).toMatchObject({ color: "#EDEAFB", fontSize: 15 });
    // A leaf that sets nothing keeps what the card handed down.
    expect(inherit(card, undefined, ctx)).toEqual(card);
    // One that sets its own colour overrides only that.
    expect(inherit(card, { textColor: "@accent" }, ctx)).toMatchObject({
      color: "#3B2C8F",
      fontSize: 15,
    });
  });

  test("alignment and transform inherit too", () => {
    const card = inherit(root, { align: "center", textTransform: "uppercase" }, ctx);
    const style = inheritedTextStyle(inherit(card, undefined, ctx), ctx);
    expect(style.textAlign).toBe("center");
    expect(style.textTransform).toBe("uppercase");
  });

  test("em and unitless units resolve against the size in force", () => {
    // CSS resolves an inherited unitless line-height per element, so a child
    // with a bigger font gets a proportionally bigger line box.
    const card = inherit(root, { lineHeight: 1.5, letterSpacing: 0.1 }, ctx);
    expect(inheritedTextStyle(card, ctx).lineHeight).toBe(24);
    const bigger = inherit(card, { fontSize: 40 }, ctx);
    expect(inheritedTextStyle(bigger, ctx).lineHeight).toBe(60);
    expect(inheritedTextStyle(bigger, ctx).letterSpacing).toBeCloseTo(4);
  });
});

describe("tag variables", () => {
  const monthly: RevnixPaywallPackage = {
    packageId: "monthly",
    title: "Monthly",
    priceLabel: "$12.99",
    period: "monthly",
    amountMinor: 1299,
    currency: "USD",
  };
  const yearly: RevnixPaywallPackage = {
    packageId: "yearly",
    title: "Yearly",
    priceLabel: "$59.99",
    period: "annual",
    amountMinor: 5999,
    currency: "USD",
  };
  const all = [monthly, yearly];

  test("resolves the package vocabulary", () => {
    expect(resolveTags("{title} — {price}/{period_short}", yearly, all)).toBe(
      "Yearly — $59.99/yr",
    );
    expect(resolveTags("Billed {period}ly", monthly, all)).toBe(
      "Billed monthly",
    );
  });

  test("per-month and saving maths compare across the offering", () => {
    // 5999/12 rounds to 500 minor units a month; a whole-unit amount drops
    // its decimals, exactly as the dashboard preview formats it.
    expect(resolveTags("{price_per_month}", yearly, all)).toBe("$5");
    expect(resolveTags("{price_per_month}", monthly, all)).toBe("$12.99");
    expect(resolveTags("SAVE {save_percent}", yearly, all)).toBe("SAVE 62%");
    // The dearest plan has nothing to beat, so the tag stays visible.
    expect(resolveTags("SAVE {save_percent}", monthly, all)).toBe(
      "SAVE {save_percent}",
    );
  });

  test("zero-decimal currencies are not divided by 100", () => {
    // JPY has no minor unit: ¥12,000/yr is 12000, not 1,200,000. Assuming
    // hundredths would understate the monthly equivalent 100×.
    const jpy: RevnixPaywallPackage = {
      packageId: "yearly",
      title: "Yearly",
      priceLabel: "¥12,000",
      period: "annual",
      amountMinor: 12000,
      currency: "JPY",
    };
    expect(resolveTags("{price_per_month}", jpy, [jpy])).toContain("1,000");
  });

  test("a tag with no data behind it is left visible rather than guessed", () => {
    const noPeriod: RevnixPaywallPackage = {
      packageId: "m",
      title: "Monthly",
      priceLabel: "$12.99",
    };
    expect(resolveTags("{price}/{period_short}", noPeriod, [noPeriod])).toBe(
      "$12.99/{period_short}",
    );
    expect(resolveTags("{price_per_month}", noPeriod, [noPeriod])).toBe(
      "{price_per_month}",
    );
    expect(resolveTags("{nonsense}", monthly, all)).toBe("{nonsense}");
  });

  test("copy with no packages behind it renders as written", () => {
    expect(resolveTags("{price}", undefined, [])).toBe("{price}");
    expect(resolveTags("No tags here", monthly, all)).toBe("No tags here");
  });
});
