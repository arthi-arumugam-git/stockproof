import { describe, expect, it } from "vitest";
import { _internal, encodable, encodeModules, encodeValues, moduleWidth, START_B, STOP, toSvg } from "../site/js/barcode.js";

const { PATTERNS } = _internal;

describe("the Code 128 pattern table", () => {
  it("has 107 patterns", () => {
    expect(PATTERNS).toHaveLength(107);
  });

  it("every data pattern is six elements totalling 11 modules; stop is seven totalling 13", () => {
    // A single wrong digit here yields a barcode that looks right and will not scan, so this
    // invariant is the table's own checksum.
    PATTERNS.slice(0, 106).forEach((p, i) => {
      expect(p, `pattern ${i}`).toHaveLength(6);
      expect([...p].reduce((a, c) => a + Number(c), 0), `pattern ${i} module sum`).toBe(11);
    });
    expect(PATTERNS[106]).toHaveLength(7);
    expect([...PATTERNS[106]].reduce((a, c) => a + Number(c), 0)).toBe(13);
  });

  it("has no duplicate patterns", () => {
    expect(new Set(PATTERNS).size).toBe(PATTERNS.length);
  });

  it("uses only widths 1 to 4", () => {
    for (const p of PATTERNS) for (const c of p) expect(Number(c)).toBeGreaterThanOrEqual(1), expect(Number(c)).toBeLessThanOrEqual(4);
  });
});

describe("encodeValues", () => {
  it("wraps data in start B, checksum and stop", () => {
    const v = encodeValues("A");
    expect(v[0]).toBe(START_B);
    expect(v[v.length - 1]).toBe(STOP);
    expect(v).toHaveLength(4);
  });

  it("computes the checksum as (start + sum(position * value)) mod 103", () => {
    // "A" is ASCII 65, subset B value 33. 104 + 1*33 = 137; 137 mod 103 = 34.
    expect(encodeValues("A")).toEqual([104, 33, 34, 106]);
    // "AB": 104 + 1*33 + 2*34 = 205; 205 mod 103 = 102.
    expect(encodeValues("AB")).toEqual([104, 33, 34, 102, 106]);
    // a space is value 0, the lowest encodable character
    expect(encodeValues(" ")).toEqual([104, 0, 104 % 103, 106]);
  });

  it("encodes digits, letters and punctuation found in SKUs", () => {
    expect(() => encodeValues("SKU-123_ABC/9")).not.toThrow();
    expect(encodable("SKU-123_ABC/9")).toBe(true);
  });

  it("refuses characters it cannot encode rather than substituting them", () => {
    expect(encodable("café")).toBe(false);
    expect(() => encodeValues("café")).toThrow(/cannot encode/);
    expect(() => encodeValues("tab\there")).toThrow();
  });
});

describe("encodeModules and width", () => {
  it("total modules is 11 per symbol plus 13 for stop", () => {
    // start + 3 data + checksum = 5 symbols at 11, plus stop at 13
    expect(moduleWidth("abc")).toBe(5 * 11 + 13);
    expect(moduleWidth("")).toBe(2 * 11 + 13);
  });

  it("alternates bar and space starting and ending with a bar", () => {
    const w = encodeModules("HELLO");
    expect(w.length % 2).toBe(1); // odd: the stop pattern's trailing bar
    expect(w).toHaveLength(6 * (5 + 2) + 7);
  });
});

describe("toSvg", () => {
  it("draws only the bars, includes quiet zones, and scales with moduleWidth", () => {
    const svg = toSvg("A1", { moduleWidth: 2, height: 30 });
    const bars = svg.match(/<rect /g) ?? [];
    // one rect per even-indexed element
    const widths = encodeModules("A1");
    expect(bars).toHaveLength(Math.ceil(widths.length / 2));
    const total = (moduleWidth("A1") + 20) * 2;
    expect(svg).toContain(`viewBox="0 0 ${total.toFixed(3)} 30"`);
    expect(svg).toContain('shape-rendering="crispEdges"');
  });

  it("escapes the label text", () => {
    expect(toSvg("a<b&c")).toContain("barcode a&lt;b&amp;c");
  });

  it("omits quiet zones only when explicitly asked", () => {
    const withQuiet = toSvg("A", { moduleWidth: 1 });
    const without = toSvg("A", { moduleWidth: 1, quiet: false });
    expect(withQuiet).toContain(`0 0 ${(moduleWidth("A") + 20).toFixed(3)}`);
    expect(without).toContain(`0 0 ${moduleWidth("A").toFixed(3)}`);
  });
});
