import { describe, expect, jest, test } from "@jest/globals";
import {
  flatColor,
  gradientFallbackColor,
  isGradient,
  isRepeatingPattern,
  parseGradient,
  resolveColor,
} from "./color.js";
import { toTextStyle, toViewStyle } from "./style.js";
import type { PaywallBlockDoc } from "./types.js";

// Block fills: the half of a paint string that is NOT a plain color.
//
// A `fill` is handed straight to CSS `background` by the dashboard, so it may
// be a color, a gradient, or a stack of them. 113 of the 250 shipped gallery
// presets use a gradient somewhere, and the native SDKs painted nothing for
// every one of them. React Native degrades a gradient to its ground stop and
// paints the real thing when the host supplies a gradient component — these
// pin both halves of that, plus the two parser defects the fix uncovered:
//
//   * `@bg` resolving to the RAW ground, so a `@bg` stop inside a gradient was
//     dropped — and a gradient left with one stop does not parse either;
//   * a stop may carry TWO positions (`@accent 0 22%`), and reading only the
//     last one turned every hard edge in the library into a smooth fade.

const DOC: PaywallBlockDoc = {
  version: 1,
  layout: "canvas",
  background: "#150E33",
  textColor: "#FFFFFF",
  accent: "#6478ff",
  accentInk: "#FFFFFF",
  blocks: [],
};

const gradientDoc: PaywallBlockDoc = {
  ...DOC,
  background: "linear-gradient(180deg, #231646 0%, #0C0C13 100%)",
};

describe("a gradient fill degrades to a color from the design", () => {
  test("a gradient fill paints its ground stop, never black", () => {
    const style = toViewStyle(
      { fill: "linear-gradient(135deg, #112233 0%, #445566 100%)" },
      { doc: DOC, fontSize: 15 },
    );
    expect(style.backgroundColor).toBe("#112233");
    expect(style.backgroundColor).not.toBe("#000000");
  });

  test("a gradient the host CAN paint leaves the box transparent under it", () => {
    // 83 of the library's 139 gradient fills fade through a translucent stop:
    // they sit over the screen's photo so it shows through. The ground stop is
    // a stand-in for a gradient that will NOT be drawn — under one that will,
    // it is an opaque backing that flattens every one of those.
    const style = toViewStyle(
      { fill: "linear-gradient(180deg, rgba(15,16,19,0.72) 0%, #0F1013 100%)" },
      { doc: DOC, fontSize: 15, paintsGradients: true },
    );
    expect(style.backgroundColor).toBe("transparent");
  });

  test("a gradient the host cannot paint still degrades to a colour", () => {
    // No `gradient` component: the layers are never rendered, so the ground
    // stop is all the paint this box will ever get.
    const style = toViewStyle(
      { fill: "linear-gradient(180deg, rgba(15,16,19,0.72) 0%, #0F1013 100%)" },
      { doc: DOC, fontSize: 15, paintsGradients: false },
    );
    expect(style.backgroundColor).toBe("rgba(15,16,19,0.72)");
  });

  test("an unparseable gradient degrades even when the host can paint", () => {
    // `paintsGradients` says the renderer WOULD paint layers — but there are
    // none to paint, so leaving the box transparent would paint nothing at all.
    const style = toViewStyle(
      { fill: "repeating-linear-gradient(180deg, transparent 0 33px, #E2D2B6 33px 34px)" },
      { doc: DOC, fontSize: 15, paintsGradients: true },
    );
    expect(style.backgroundColor).not.toBe("transparent");
  });

  test("a plain color fill is untouched", () => {
    const style = toViewStyle({ fill: "#FF0000" }, { doc: DOC, fontSize: 15 });
    expect(style.backgroundColor).toBe("#FF0000");
  });

  test("the ground stop of a stack is the BOTTOM layer's, not the glow's", () => {
    // CSS paints the first-listed layer on top, so the translucent accent glow
    // must not be mistaken for the base the card sits on.
    const css =
      "radial-gradient(120% 90% at 86% 4%, #FF3D7F 0%, rgba(255,61,127,0) 48%)," +
      "linear-gradient(180deg, #1C1046 0%, #0E0722 100%)";
    expect(gradientFallbackColor(css)).toBe("#1C1046");
    expect(parseGradient(css)).toHaveLength(2);
  });
});

describe("color-only fields", () => {
  test("a gradient border collapses rather than reaching RN as a bad color", () => {
    const onDiagnostic = jest.fn();
    const style = toViewStyle(
      { borderColor: "linear-gradient(90deg, #00FF00 0%, #0000FF 100%)" },
      { doc: DOC, fontSize: 15, onDiagnostic },
    );
    expect(style.borderColor).toBe("#00FF00");
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic.mock.calls[0]![0]).toContain("flattened");
  });

  test("a gradient text color collapses too", () => {
    const style = toTextStyle(
      { textColor: "linear-gradient(90deg, #00FF00 0%, #0000FF 100%)" },
      { doc: DOC, fontSize: 15 },
    );
    expect(style.color).toBe("#00FF00");
  });

  test("a plain color reports nothing", () => {
    const onDiagnostic = jest.fn();
    expect(flatColor("@accent", DOC, onDiagnostic)).toBe("#6478ff");
    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  test("an absent value stays absent", () => {
    expect(flatColor(undefined, DOC)).toBeUndefined();
  });
});

describe("@bg over a gradient ground", () => {
  test("resolves to the ground's flat base, not the raw gradient", () => {
    // The dashboard answers `@bg` with backgroundBaseColor(...) because it
    // feeds the token into color-mix(), which cannot take a gradient.
    expect(resolveColor("@bg", gradientDoc)).toBe("#231646");
    expect(isGradient(resolveColor("@bg", gradientDoc)!)).toBe(false);
  });

  test("a @bg stop inside a gradient keeps its own stop", () => {
    const layers = parseGradient(
      resolveColor(
        "linear-gradient(180deg, rgba(12,16,19,0.5) 0%, @bg 100%)",
        gradientDoc,
      )!,
    );
    expect(layers).toHaveLength(1);
    expect(layers[0]!.colors).toHaveLength(2);
    expect(layers[0]!.colors[1]).toBe("#231646");
  });
});

describe("stop syntax the library actually ships", () => {
  test("a stop may carry two positions, which is a hard edge", () => {
    // "@accent 0 22%" is the accent at BOTH 0 and 22%, then the next color
    // starts at 22% — the progress-bar idiom, and a hard edge rather than the
    // smooth fade that reading one position produced.
    const layers = parseGradient(
      resolveColor("linear-gradient(90deg, @accent 0 22%, #16203C 22%)", DOC)!,
    );
    expect(layers).toHaveLength(1);
    expect(layers[0]!.colors).toEqual(["#6478ff", "#6478ff", "#16203C"]);
    expect(layers[0]!.locations).toEqual([0, 0.22, 0.22]);
  });

  test("transparent survives as a stop", () => {
    const layers = parseGradient(
      resolveColor("linear-gradient(90deg, @accent 0 60%, transparent 60%)", DOC)!,
    );
    expect(layers[0]!.colors).toEqual(["#6478ff", "#6478ff", "transparent"]);
  });

  test("a color with spaces inside it is not torn apart", () => {
    const layers = parseGradient(
      "linear-gradient(180deg, rgba(0, 0, 0, 0.5) 0%, #FFFFFF 100%)",
    );
    expect(layers[0]!.colors[0]).toBe("rgba(0, 0, 0, 0.5)");
  });

  test("a malformed position costs the position, not the stop", () => {
    // The token comes off the color either way. Leaving it attached would make
    // the color unparseable, dropping the stop — and a gradient left with one
    // stop does not parse at all, so one typo would lose the whole fill.
    const layers = parseGradient("linear-gradient(180deg, #112233 1.2.3%, #445566 100%)");
    expect(layers).toHaveLength(1);
    expect(layers[0]!.colors).toEqual(["#112233", "#445566"]);
  });

  test("a repeating pattern paints nothing rather than a stripe color", () => {
    // The colors inside a pattern are STRIPE colors. The library's hairline
    // grid is `#0E1B21` once every 26px; as a solid fill it is a slab, which is
    // a wrong answer rather than a degraded one.
    const pattern = "repeating-linear-gradient(180deg, #0E1B21 0 1px, @bg 1px 26px)";
    expect(isRepeatingPattern(pattern)).toBe(true);
    expect(gradientFallbackColor(pattern)).toBeUndefined();
    const style = toViewStyle({ fill: pattern }, { doc: DOC, fontSize: 15 });
    expect(style.backgroundColor).toBeUndefined();
  });

  test("a pattern stacked over a ground still falls back to that ground", () => {
    // The BOTTOM layer decides: here it is a plain color, and a plain color is
    // exactly the surface color the box should take.
    const css =
      "repeating-linear-gradient(180deg, transparent 0 33px, #E2D2B6 33px 34px), #FBF3E4";
    expect(isRepeatingPattern(css)).toBe(false);
    expect(gradientFallbackColor(css)).toBe("#FBF3E4");
  });

  test("a unitless position is read rather than swallowing the stop", () => {
    // CSS allows a unitless zero. Requiring a `%` made the whole "#112233 0"
    // argument the COLOR, which failed to parse and dropped the stop.
    const layers = parseGradient("linear-gradient(180deg, #112233 0, #445566 100%)");
    expect(layers[0]!.colors).toEqual(["#112233", "#445566"]);
    expect(layers[0]!.locations).toEqual([0, 1]);
  });

  test("an unpositioned stop list still spans the whole box", () => {
    const layers = parseGradient("linear-gradient(180deg, #000, #fff)");
    expect(layers[0]!.locations).toBeUndefined();
    expect(layers[0]!.colors).toHaveLength(2);
  });
});
