import { describe, expect, it } from "vitest";
import { FIELDS, _internal, load, save, setVendor, toObject } from "../site/js/vendors.js";
import { DEFAULTS, suggest } from "../site/js/forecast.js";

const memStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
};

describe("per-vendor settings", () => {
  it("round-trips through storage and drops anything that is not a non-negative number", () => {
    const storage = memStore();
    let map = new Map();
    map = setVendor(map, "Acme", "leadTimeDays", 42);
    map = setVendor(map, "Acme", "targetCoverDays", "60");
    map = setVendor(map, "Beta", "leadTimeDays", -3); // refused, so Beta has nothing and is dropped
    save(map, storage);
    expect(JSON.parse(storage.getItem(_internal.STORAGE_KEY))).toEqual({ Acme: { leadTimeDays: 42, targetCoverDays: 60 } });
    expect(toObject(load(storage))).toEqual({ Acme: { leadTimeDays: 42, targetCoverDays: 60 } });
  });

  it("removes an override when the field is cleared, and the vendor when nothing is left", () => {
    let map = setVendor(new Map(), "Acme", "leadTimeDays", 42);
    map = setVendor(map, "Acme", "leadTimeDays", "");
    expect(map.size).toBe(0);
  });

  it("only knows lead time and target cover", () => {
    expect([...FIELDS]).toEqual(["leadTimeDays", "targetCoverDays"]);
    expect(() => setVendor(new Map(), "Acme", "safetyDays", 1)).toThrow(/unknown/);
  });

  it("never throws on garbage or unavailable storage", () => {
    const bad = memStore();
    bad.setItem(_internal.STORAGE_KEY, "{not json");
    expect(load(bad).size).toBe(0);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(load(throwing).size).toBe(0);
    expect(() => save(new Map([["A", { leadTimeDays: 1 }]]), throwing)).not.toThrow();
    const stale = memStore();
    stale.setItem(_internal.STORAGE_KEY, JSON.stringify({ A: { leadTimeDays: "abc", targetCoverDays: 5 }, B: {} }));
    expect(toObject(load(stale))).toEqual({ A: { targetCoverDays: 5 } });
  });
});

describe("suggest with per-vendor overrides", () => {
  const inv = (sku) => ({ handle: sku.toLowerCase(), title: sku, location: "", bin: "", sku, incoming: 0, committed: 0, available: 10, onHandCurrent: 10, raw: {} });
  const products = new Map([
    ["A", { sku: "A", vendor: "Slow Co", cost: 1 }],
    ["B", { sku: "B", vendor: "Fast Co", cost: 1 }],
  ]);
  const sales = new Map([["A", { units: 30 }], ["B", { units: 30 }]]);

  it("uses the vendor's own lead time and cover for that vendor's rows only", () => {
    const vendorSettings = new Map([["Slow Co", { leadTimeDays: 42 }]]);
    const { suggestions } = suggest({ inventory: [inv("A"), inv("B")], salesBySku: sales, windowDays: 30, productsBySku: products, productsByHandle: new Map(), settings: DEFAULTS, vendorSettings });
    const a = suggestions.find((s) => s.sku === "A");
    const b = suggestions.find((s) => s.sku === "B");
    // 1/day; Slow Co: 42 + 30 = 72 - 10 = 62; Fast Co keeps the global 14 + 30 = 44 - 10 = 34
    expect(a.suggestedQty).toBe(62);
    expect(a.reorderPoint).toBe(42 + 7);
    expect(a.settings.leadTimeDays).toBe(42);
    expect(a.vendorOverride).toBe(true);
    expect(b.suggestedQty).toBe(34);
    expect(b.vendorOverride).toBe(false);
  });

  it("accepts a plain object as well as a Map, and ignores a bad value", () => {
    const { suggestions } = suggest({ inventory: [inv("A")], salesBySku: sales, windowDays: 30, productsBySku: products, productsByHandle: new Map(), vendorSettings: { "Slow Co": { targetCoverDays: 60, leadTimeDays: NaN } } });
    // 14 + 60 = 74 - 10 = 64
    expect(suggestions[0].suggestedQty).toBe(64);
    expect(suggestions[0].settings.leadTimeDays).toBe(14);
  });
});
