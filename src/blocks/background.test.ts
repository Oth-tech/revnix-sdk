import { describe, expect, test } from "@jest/globals";
import {
  backgroundBaseColor,
  backgroundLayers,
  coverPlacement,
} from "./background.js";
import { resolveColor } from "./color.js";
import type { PaywallBlockDoc } from "./types.js";
import type { PaywallBackground } from "./background.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The SDK is the second interpreter of a document the dashboard authored, so
// these mirror revnix-app/tests/paywall-backgrounds/background.test.ts case
// for case. A divergence here is a paywall that looks one way in the builder
// and another on the phone.

const DOC: PaywallBlockDoc = {
  version: 1,
  layout: "canvas",
  background: "#150E33",
  textColor: "#FFFFFF",
  accent: "#D6FF3F",
  accentInk: "#14160A",
  blocks: [],
};

const IMG = "https://cdn.example.com/gym.jpg";

describe("legacy string backgrounds", () => {
  test("a plain colour resolves to a single ground layer", () => {
    expect(backgroundLayers("#0A0B0D")).toEqual({ ground: "#0A0B0D" });
  });

  test("a gradient string passes through untouched", () => {
    const css = "linear-gradient(180deg, #111820 0%, #07090C 100%)";
    expect(backgroundLayers(css)).toEqual({ ground: css });
  });

  test("@bg still reads the string itself", () => {
    expect(resolveColor("@bg", DOC)).toBe("#150E33");
    expect(backgroundBaseColor("#0A0B0D")).toBe("#0A0B0D");
  });

  test("@bg on a layered background reads the ground", () => {
    const doc: PaywallBlockDoc = {
      ...DOC,
      background: { color: "#101418", image: { url: IMG } },
    };
    expect(resolveColor("@bg", doc)).toBe("#101418");
    expect(resolveColor("@bg/50", doc)).toBe("rgba(16, 20, 24, 0.5)");
  });

  test("a photo-only background falls back to black for @bg", () => {
    expect(backgroundBaseColor({ image: { url: IMG } })).toBe("#000000");
    expect(backgroundBaseColor(undefined)).toBe("#000000");
  });
});

describe("layer composition matches the dashboard", () => {
  test("a photo defaults to a centred cover at full opacity", () => {
    expect(backgroundLayers({ color: "#000", image: { url: IMG } }).image).toEqual(
      { url: IMG, fit: "cover", focalX: 50, focalY: 50, opacity: 1 },
    );
  });

  test("percentages convert to 0–1 and clamp", () => {
    expect(
      backgroundLayers({ image: { url: IMG, opacity: 55 } }).image?.opacity,
    ).toBe(0.55);
    expect(
      backgroundLayers({ image: { url: IMG, opacity: -8 } }).image,
    ).toBeUndefined();
    const clamped = backgroundLayers({
      image: { url: IMG, focalX: -20, focalY: 400 },
    }).image;
    expect(clamped?.focalX).toBe(0);
    expect(clamped?.focalY).toBe(100);
  });

  test("layers that paint nothing are dropped", () => {
    expect(
      backgroundLayers({
        color: "#000",
        image: { url: IMG },
        overlay: { fill: "#000000", opacity: 0 },
      }).overlay,
    ).toBeUndefined();
    expect(backgroundLayers({ image: { url: "" } }).image).toBeUndefined();
  });

  test("ground and overlay fills resolve palette tokens; the url does not", () => {
    const layers = backgroundLayers(
      {
        color: "@bg",
        image: { url: IMG },
        overlay: { fill: "@accent", opacity: 30 },
      },
      (v) => resolveColor(v, DOC) ?? v,
    );
    expect(layers.ground).toBe("#150E33");
    expect(layers.overlay).toEqual({ fill: "#D6FF3F", opacity: 0.3 });
    expect(layers.image?.url).toBe(IMG);
  });

  test("the full stack resolves bottom-up in one pass", () => {
    expect(
      backgroundLayers({
        color: "#07090C",
        image: { url: IMG, fit: "contain", focalX: 30, focalY: 10, opacity: 80, blur: 12 },
        overlay: { fill: "#000000", opacity: 40 },
      }),
    ).toEqual({
      ground: "#07090C",
      image: {
        url: IMG,
        fit: "contain",
        focalX: 30,
        focalY: 10,
        opacity: 0.8,
        blur: 12,
      },
      overlay: { fill: "#000000", opacity: 0.4 },
    });
  });
});

describe("coverPlacement — the stand-in for CSS object-position", () => {
  const BOX = { width: 393, height: 852 };

  test("a wide photo is scaled to fill the tall box", () => {
    const p = coverPlacement(BOX, { width: 1600, height: 900 }, 50, 50);
    // Height is the binding dimension, so it matches the box exactly.
    expect(Math.round(p.height)).toBe(852);
    expect(p.width).toBeGreaterThan(BOX.width);
  });

  test("a centred focal point centres the overflow", () => {
    const p = coverPlacement(BOX, { width: 1600, height: 900 }, 50, 50);
    expect(p.left).toBeCloseTo((BOX.width - p.width) / 2, 5);
    expect(p.top).toBe(0);
  });

  test("the focal point moves the crop, and both extremes pin an edge", () => {
    const left = coverPlacement(BOX, { width: 1600, height: 900 }, 0, 50);
    expect(left.left).toBe(0);
    const right = coverPlacement(BOX, { width: 1600, height: 900 }, 100, 50);
    expect(right.left).toBeCloseTo(BOX.width - right.width, 5);
    // A focal point at 25% sits between the two.
    const quarter = coverPlacement(BOX, { width: 1600, height: 900 }, 25, 50);
    expect(quarter.left).toBeLessThan(0);
    expect(quarter.left).toBeGreaterThan(right.left);
  });

  test("an edge is never pulled inside the box, whatever the focal point", () => {
    for (const focal of [0, 12, 50, 88, 100]) {
      const p = coverPlacement(BOX, { width: 900, height: 1600 }, focal, focal);
      expect(p.left).toBeLessThanOrEqual(0);
      expect(p.top).toBeLessThanOrEqual(0);
      expect(p.left + p.width).toBeGreaterThanOrEqual(BOX.width - 0.0001);
      expect(p.top + p.height).toBeGreaterThanOrEqual(BOX.height - 0.0001);
    }
  });

  test("a photo the same shape as the box has no overflow to place", () => {
    const p = coverPlacement(BOX, { width: 786, height: 1704 }, 20, 90);
    expect(p.left).toBeCloseTo(0, 5);
    expect(p.top).toBeCloseTo(0, 5);
  });

  test("a degenerate measurement falls back to filling the box", () => {
    expect(coverPlacement(BOX, { width: 0, height: 0 }, 50, 50)).toEqual({
      width: 393,
      height: 852,
      left: 0,
      top: 0,
    });
  });
});

// ——— the cross-repo wire contract ———
//
// This SDK reads the ground under `color` and always has. The five native SDKs
// read `ground` — the name of the RESOLVED layer, a key the dashboard has
// never written — so every paywall whose background had been edited rendered
// pure black on iOS, Android, Flutter, Unity and Capacitor while looking
// correct here.
//
// `paywall-background-wire.json` is a real document the dashboard published
// from its background library, and a byte-identical copy of it now lives in
// each of the other five repos' suites. This is the reference case they are
// all measured against.

describe("published wire contract", () => {
  const golden = JSON.parse(
    readFileSync(join(__dirname, "paywall-background-wire.json"), "utf8"),
  ) as { background: PaywallBackground };

  const GOLDEN_GROUND =
    "radial-gradient(120% 85% at 50% 0%, #D6FF3F38 0%, #D6FF3F00 58%), " +
    "linear-gradient(180deg, #111820 0%, #07090C 100%)";

  test("a real published document resolves to its gradient ground, not black", () => {
    expect(backgroundLayers(golden.background).ground).toBe(GOLDEN_GROUND);
    expect(backgroundLayers(golden.background).ground).not.toBe("#000000");
  });

  test("the ground key is `color`", () => {
    expect(backgroundLayers({ color: "#0B0D10" }).ground).toBe("#0B0D10");
    expect(backgroundBaseColor({ color: "#0B0D10" })).toBe("#0B0D10");
  });

  test("a background with no ground at all falls back to black, and only then", () => {
    expect(backgroundBaseColor({ image: { url: "https://x/y.jpg" } })).toBe("#000000");
    expect(backgroundBaseColor(undefined)).toBe("#000000");
  });
});
