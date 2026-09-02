import { describe, expect, it } from "vitest";
import { receive, receivingVariance } from "../site/js/receiving.js";
import { writebackRecords } from "../site/js/forecast.js";
import * as woo from "../site/js/platforms/woocommerce.js";

const line = (over = {}) => ({
  key: "MUG-L",
  sku: "MUG-L",
  barcode: "5012345678900",
  title: "Mug",
  handle: "mug",
  vendor: "Acme",
  suggestedQty: 10,
  unitCost: 4,
  unitPrice: 10,
  ...over,
});

describe("receive", () => {
  it("matches scans by SKU or barcode and shows ordered, received and what is still to come", () => {
    const { rows, totals, unmatchedKeys } = receive([line(), line({ key: "BOWL", sku: "BOWL", barcode: "", suggestedQty: 4, unitCost: 2, unitPrice: 6 })], new Map([["5012345678900", 6], ["BOWL", 4], ["ZZ", 1]]));
    expect(rows[0]).toMatchObject({ code: "5012345678900", ordered: 10, received: 6, remaining: 4, over: 0 });
    expect(rows[1]).toMatchObject({ received: 4, remaining: 0 });
    expect(totals).toEqual({ units: 10, cost: 32, costKnown: true, linesReceived: 2, linesComplete: 1 });
    expect(unmatchedKeys).toEqual(["ZZ"]);
  });

  it("states margin as money and as a share of price, from the products export", () => {
    const { rows } = receive([line()], new Map([["MUG-L", 1]]));
    expect(rows[0].margin).toBe(6);
    expect(rows[0].marginPct).toBe(60);
    expect(rows[0].extendedCost).toBe(4);
  });

  it("shows nothing rather than zero when cost or price is missing, and marks the total partial", () => {
    const { rows, totals } = receive([line({ unitCost: null }), line({ key: "B", sku: "B", barcode: "", unitPrice: null, unitCost: 3 })], new Map([["MUG-L", 2], ["B", 1]]));
    expect(rows[0].margin).toBeNull();
    expect(rows[0].marginPct).toBeNull();
    expect(rows[0].extendedCost).toBeNull();
    expect(rows[1].margin).toBeNull();
    expect(rows[1].extendedCost).toBe(3);
    expect(totals.costKnown).toBe(false);
    expect(totals.cost).toBe(3);
  });

  it("flags an over-delivery instead of hiding it", () => {
    const { rows } = receive([line({ suggestedQty: 2 })], new Map([["MUG-L", 5]]));
    expect(rows[0].over).toBe(3);
    expect(rows[0].remaining).toBe(0);
  });

  it("leaves untouched lines at zero received and out of the totals", () => {
    const { rows, totals } = receive([line()], new Map());
    expect(rows[0].received).toBe(0);
    expect(totals.units).toBe(0);
    expect(totals.costKnown).toBe(true);
  });
});

describe("receivingVariance", () => {
  const inventory = [
    { handle: "mug", sku: "", title: "Mug", location: "Ottawa", bin: "A1", onHandCurrent: 5, aliases: ["MUG-L", "5012345678900", "mug", "Mug"], raw: { Handle: "mug", "On hand (current)": "5", "On hand (new)": "" } },
    { handle: "plate", sku: "PLATE", title: "Plate", location: "Ottawa", bin: "", onHandCurrent: null, raw: {} },
  ];

  it("adds what arrived to what the platform currently believes", () => {
    const { rows: received } = receive([line()], new Map([["5012345678900", 6]]));
    const v = receivingVariance(received, inventory);
    expect(v.rows[0]).toMatchObject({ onHandCurrent: 5, received: 6, countedQty: 11, delta: 6 });
    const out = writebackRecords(v.rows, { onHandNew: "On hand (new)" });
    expect(out[0]["On hand (new)"]).toBe("11");
    expect(out[0]["On hand (current)"]).toBe("5");
  });

  it("will not add to an unknown quantity, and says which lines it left out", () => {
    const { rows: received } = receive([line({ key: "PLATE", sku: "PLATE", barcode: "" }), line({ key: "NEW", sku: "NEW", barcode: "", title: "New thing", handle: "new" })], new Map([["PLATE", 3], ["NEW", 2]]));
    const v = receivingVariance(received, inventory);
    expect(v.rows).toHaveLength(0);
    expect(v.noCurrent.map((r) => r.sku)).toEqual(["PLATE"]);
    expect(v.noRow.map((r) => r.sku)).toEqual(["NEW"]);
  });

  it("feeds the WooCommerce writeback the same way the count does", () => {
    const wooInventory = {
      columns: { id: "ID", type: "Type", sku: "SKU", name: "Name", parent: "Parent", stock: "Stock" },
      meta: { writeback: true },
      rows: [{ handle: "MUG-L", sku: "MUG-L", title: "Mug", location: "", bin: "", onHandCurrent: 12, raw: { ID: "101", Type: "simple", SKU: "MUG-L", Name: "Mug", Parent: "", Stock: "12" } }],
    };
    const { rows: received } = receive([line({ barcode: "" })], new Map([["MUG-L", 8]]));
    const v = receivingVariance(received, wooInventory.rows);
    const w = woo.writeback.build(v.rows, wooInventory);
    expect(w.ok).toBe(true);
    expect(w.records[0].Stock).toBe("20");
  });
});
