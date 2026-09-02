import { describe, expect, it } from "vitest";
import { DEFAULTS, groupByVendor, suggest, variance, writebackRecords } from "../site/js/forecast.js";

const inv = (over = {}) => ({
  handle: "mug",
  title: "Mug",
  location: "Ottawa",
  bin: "",
  sku: "MUG-L",
  incoming: 0,
  committed: 0,
  available: 10,
  onHandCurrent: 10,
  raw: { Handle: "mug", "On hand (current)": "10", "On hand (new)": "" },
  ...over,
});

const productsBySku = new Map([["MUG-L", { sku: "MUG-L", vendor: "Acme", cost: 4, barcode: "500", title: "Mug" }]]);

describe("suggest", () => {
  it("computes velocity, cover and order quantity from the stated formula", () => {
    // 60 units over 30 days = 2/day. Target cover 30 + lead 14 = 44 days = 88 units.
    // 88 - 10 available - 0 incoming = 78.
    const { suggestions } = suggest({
      inventory: [inv()],
      salesBySku: new Map([["MUG-L", { units: 60 }]]),
      windowDays: 30,
      productsBySku,
      productsByHandle: new Map(),
      settings: DEFAULTS,
    });
    const s = suggestions[0];
    expect(s.velocity).toBe(2);
    expect(s.daysOfCover).toBe(5);
    expect(s.reorderPoint).toBe(2 * (14 + 7));
    expect(s.suggestedQty).toBe(78);
    expect(s.belowReorderPoint).toBe(true);
    expect(s.extendedCost).toBe(312);
  });

  it("subtracts stock already on its way, so incoming is never double-ordered", () => {
    const { suggestions } = suggest({
      inventory: [inv({ incoming: 50 })],
      salesBySku: new Map([["MUG-L", { units: 60 }]]),
      windowDays: 30,
      productsBySku,
      productsByHandle: new Map(),
    });
    expect(suggestions[0].suggestedQty).toBe(28); // 88 - 10 - 50
  });

  it("never suggests a negative quantity when stock already exceeds the target", () => {
    const { suggestions } = suggest({
      inventory: [inv({ available: 500 })],
      salesBySku: new Map([["MUG-L", { units: 60 }]]),
      windowDays: 30,
      productsBySku,
      productsByHandle: new Map(),
    });
    expect(suggestions[0].suggestedQty).toBe(0);
    expect(suggestions[0].belowReorderPoint).toBe(false);
  });

  it("separates rows it cannot advise on instead of guessing a number", () => {
    const r = suggest({
      inventory: [inv({ sku: "NOSALE" }), inv({ sku: "NOQTY", available: null })],
      salesBySku: new Map(),
      windowDays: 30,
      productsBySku: new Map(),
      productsByHandle: new Map(),
    });
    expect(r.suggestions).toHaveLength(0);
    expect(r.noSales.map((x) => x.sku)).toEqual(["NOSALE"]);
    expect(r.noData.map((x) => x.sku)).toEqual(["NOQTY"]);
    expect(r.noData[0].reason).toMatch(/no available quantity/);
  });

  it("says so when there is no orders export rather than treating it as no sales", () => {
    const r = suggest({
      inventory: [inv()],
      salesBySku: new Map(),
      windowDays: null,
      productsBySku,
      productsByHandle: new Map(),
    });
    expect(r.noSales[0].reason).toMatch(/no orders export/);
  });

  it("leaves extended cost null when the product has no cost, rather than costing it at zero", () => {
    const { suggestions } = suggest({
      inventory: [inv()],
      salesBySku: new Map([["MUG-L", { units: 60 }]]),
      windowDays: 30,
      productsBySku: new Map([["MUG-L", { sku: "MUG-L", vendor: "Acme", cost: null }]]),
      productsByHandle: new Map(),
    });
    expect(suggestions[0].extendedCost).toBeNull();
  });

  it("orders the most urgent first, by least cover remaining", () => {
    const { suggestions } = suggest({
      inventory: [inv({ sku: "A", available: 100 }), inv({ sku: "B", available: 2 })],
      salesBySku: new Map([
        ["A", { units: 30 }],
        ["B", { units: 30 }],
      ]),
      windowDays: 30,
      productsBySku: new Map(),
      productsByHandle: new Map(),
    });
    expect(suggestions.map((s) => s.sku)).toEqual(["B", "A"]);
  });
});

describe("groupByVendor", () => {
  it("groups, totals and drops zero-quantity lines", () => {
    const rows = [
      { vendor: "Acme", suggestedQty: 10, extendedCost: 40 },
      { vendor: "Acme", suggestedQty: 5, extendedCost: 20 },
      { vendor: "Beta", suggestedQty: 1, extendedCost: 3 },
      { vendor: "Beta", suggestedQty: 0, extendedCost: 0 },
    ];
    const groups = groupByVendor(rows);
    expect(groups.map((g) => g.vendor)).toEqual(["Acme", "Beta"]);
    expect(groups[0].totalUnits).toBe(15);
    expect(groups[0].totalCost).toBe(60);
    expect(groups[1].lines).toHaveLength(1);
  });

  it("flags a group whose total cost cannot be trusted because a cost is missing", () => {
    const groups = groupByVendor([
      { vendor: "Acme", suggestedQty: 10, extendedCost: 40 },
      { vendor: "Acme", suggestedQty: 5, extendedCost: null },
    ]);
    expect(groups[0].costKnown).toBe(false);
  });

  it("labels rows with no vendor rather than dropping them from the order", () => {
    const groups = groupByVendor([{ vendor: "", suggestedQty: 3, extendedCost: 1 }]);
    expect(groups[0].vendor).toBe("(no vendor)");
  });
});

describe("variance", () => {
  const rows = [inv({ sku: "A", onHandCurrent: 10 }), inv({ sku: "B", onHandCurrent: 4 }), inv({ sku: "C", onHandCurrent: 7 })];

  it("computes deltas, sorts by size and reports what was not matched", () => {
    const v = variance(rows, new Map([["A", 12], ["B", 4], ["ZZ", 9]]));
    expect(v.rows.map((r) => r.key)).toEqual(["A", "B"]);
    expect(v.rows[0].delta).toBe(2);
    expect(v.rows[1].delta).toBe(0);
    expect(v.changed).toBe(1);
    expect(v.net).toBe(2);
    expect(v.unmatchedKeys).toEqual(["ZZ"]);
  });

  it("matches on sku, then handle, then title", () => {
    const v = variance([inv({ sku: "", handle: "mug", onHandCurrent: 3 })], new Map([["mug", 5]]));
    expect(v.rows[0].delta).toBe(2);
  });
});

describe("writebackRecords", () => {
  const columns = { onHandNew: "On hand (new)", onHandCurrent: "On hand (current)" };

  it("emits only changed rows and preserves On hand (current) so Shopify's safety check still runs", () => {
    const v = variance([inv({ sku: "A", onHandCurrent: 10 }), inv({ sku: "B", onHandCurrent: 4 })], new Map([["A", 12], ["B", 4]]));
    const out = writebackRecords(v.rows, columns);
    expect(out).toHaveLength(1);
    expect(out[0]["On hand (new)"]).toBe("12");
    expect(out[0]["On hand (current)"]).toBe("10");
  });

  it("refuses to build a file when the export has no On hand (new) column", () => {
    expect(() => writebackRecords([], { onHandNew: null })).toThrow(/On hand \(new\)/);
  });
});

describe("variance matches scanned codes through aliases", () => {
  it("finds a row by its barcode even though the inventory export has no barcode column", () => {
    const row = { ...inv({ sku: "" }), aliases: ["MUG-L", "5012345678900", "mug", "Mug"] };
    const v = variance([row], new Map([["5012345678900", 9]]));
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].key).toBe("5012345678900");
    expect(v.rows[0].delta).toBe(-1);
    expect(v.unmatchedKeys).toEqual([]);
  });

  it("still works with no aliases, falling back to sku, handle and title", () => {
    const v = variance([inv({ sku: "MUG-L" })], new Map([["MUG-L", 12]]));
    expect(v.rows[0].delta).toBe(2);
  });
});
