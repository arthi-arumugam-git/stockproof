import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "../site/js/csv.js";
import { PLATFORMS, byId, detectFile, readFile } from "../site/js/platforms/index.js";
import * as woo from "../site/js/platforms/woocommerce.js";
import * as shopifyAdapter from "../site/js/platforms/shopify.js";
import { detect as detectShopify, attachProducts, readInventory } from "../site/js/shopify.js";
import { suggest, variance } from "../site/js/forecast.js";

/* Anonymised fixtures. Column names come from the WooCommerce documentation quoted in
   site/js/platforms/woocommerce.js; the values are made up. */

// Analytics → Products report, as the Download link writes it (report-table columns)
const WOO_REPORT = [
  "Product Title,SKU,Items Sold,Net Sales,Orders,Category,Variations,Status,Stock",
  "Mug,MUG-L,24,240.00,20,Kitchen,0,In stock,12",
  "Bowl,BOWL,6,60.00,5,Kitchen,0,In stock,N/A",
  "Plate Set,,3,90.00,3,Kitchen,2,In stock,",
].join("\r\n");

// Analytics → Variations report
const WOO_VARIATIONS = [
  "Product or variation title,SKU,Items sold,Net sales,Orders,Status,Stock",
  "Tee - Small,TEE-S,10,100.00,8,In stock,4",
].join("\r\n");

// Analytics → Stock report
const WOO_STOCK = [
  "Product or variation,SKU,Status,Stock",
  "Mug,MUG-L,In stock,12",
  "Bowl,BOWL,In stock,N/A",
].join("\r\n");

// Products → All Products → Export (a subset of the schema's columns, in schema order)
const WOO_EXPORT_HEADER = "ID,Type,SKU,Name,Published,Is featured?,Visibility in catalog,Short description,Description,Tax status,In stock?,Stock,Low stock amount,Backorders allowed?,Sale price,Regular price,Categories,Parent";
const WOO_EXPORT = [
  WOO_EXPORT_HEADER,
  "101,simple,MUG-L,Mug,1,0,visible,,,taxable,1,12,,0,,10.00,Kitchen,",
  "102,variable,TEE,Tee,1,0,visible,,,taxable,1,,,0,,,Clothing,",
  "103,variation,TEE-S,Tee - Small,1,0,visible,,,taxable,1,4,,0,,12.50,,TEE",
  "104,variation,TEE-M,Tee - Medium,1,0,visible,,,taxable,1,parent,,0,,12.50,,TEE",
].join("\r\n");

// the same export with the Cost of Goods extension's meta column, as "export all custom meta" writes it
const WOO_EXPORT_COGS = [
  WOO_EXPORT_HEADER + ",meta:_wc_cog_cost",
  "101,simple,MUG-L,Mug,1,0,visible,,,taxable,1,12,,0,,10.00,Kitchen,,4.20",
].join("\r\n");

const SHOPIFY_INVENTORY = [
  "Handle,Title,Location,Bin name,Incoming (not editable),Unavailable (not editable),Committed (not editable),Available (not editable),On hand (current),On hand (new)",
  "mug,Mug,Ottawa,A1,0,0,0,5,5,",
  "mug,Mug,New York,B2,0,0,0,3,3,",
].join("\r\n");
const SHOPIFY_ORDERS = "Name,Created at,Financial Status,Lineitem quantity,Lineitem name,Lineitem price,Lineitem sku\r\n#1,2026-08-01 10:00:00 +0000,paid,3,Mug,20.00,MUG-L";
const SHOPIFY_PRODUCTS = "URL handle,Title,Vendor,Type,Variant SKU,Variant Barcode,Cost per item,Variant Price\r\nmug,Mug,Acme,Kitchen,MUG-L,500,4.20,20.00";

describe("registry", () => {
  it("lists Shopify first and finds a platform by id", () => {
    expect(PLATFORMS.map((p) => p.id)).toEqual(["shopify", "woocommerce"]);
    expect(byId("woocommerce").name).toBe("WooCommerce");
    expect(byId("etsy")).toBeNull();
  });

  it("recognises every Shopify export exactly as shopify.detect does", () => {
    for (const text of [SHOPIFY_INVENTORY, SHOPIFY_ORDERS, SHOPIFY_PRODUCTS]) {
      const headers = parseCsv(text).headers;
      const d = detectFile(headers);
      expect(d.platform.id).toBe("shopify");
      expect(d.kind).toBe(detectShopify(headers).kind);
    }
  });

  it("recognises each WooCommerce file by its columns", () => {
    expect(detectFile(parseCsv(WOO_REPORT).headers)).toMatchObject({ kind: "report" });
    expect(detectFile(parseCsv(WOO_VARIATIONS).headers)).toMatchObject({ kind: "report" });
    expect(detectFile(parseCsv(WOO_STOCK).headers)).toMatchObject({ kind: "stock" });
    expect(detectFile(parseCsv(WOO_EXPORT).headers)).toMatchObject({ kind: "export" });
    for (const text of [WOO_REPORT, WOO_VARIATIONS, WOO_STOCK, WOO_EXPORT]) {
      expect(detectFile(parseCsv(text).headers).platform.id).toBe("woocommerce");
    }
  });

  it("says nothing rather than guessing from a coincidental column", () => {
    expect(detectFile(["Title"])).toBeNull();
    expect(detectFile(["Name", "Email"])).toBeNull();
    expect(detectFile(["SKU", "Stock"])).toBeNull(); // two shared columns, no distinctive one
    // a Shopify products export has a Type column too, and must not read as a WooCommerce export
    expect(woo.detect(parseCsv(SHOPIFY_PRODUCTS).headers)).toBeNull();
  });
});

describe("WooCommerce analytics report", () => {
  const r = readFile(parseCsv(WOO_REPORT)).result;

  it("fills both stock and sales from the one file, and cannot know the window", () => {
    expect(r.inventory.rows).toHaveLength(3);
    expect(r.orders.bySku.get("MUG-L").units).toBe(24);
    expect(r.windowDays).toBeNull();
    expect(r.orders.days).toBeNull();
    expect(r.notes.some((n) => /days/.test(n))).toBe(true);
  });

  it("reads N/A and blank stock as unknown, never as zero", () => {
    const bowl = r.inventory.rows.find((x) => x.sku === "BOWL");
    expect(bowl.available).toBeNull();
    expect(bowl.onHandCurrent).toBeNull();
    const plate = r.inventory.rows.find((x) => x.title === "Plate Set");
    expect(plate.available).toBeNull();
    expect(r.inventory.rows.find((x) => x.sku === "MUG-L").available).toBe(12);
  });

  it("keys a row with no SKU by its title so the join still works", () => {
    expect(r.orders.bySku.get("Plate Set").units).toBe(3);
  });

  it("is a secondary source of stock and cannot be written back", () => {
    expect(r.inventory.meta).toMatchObject({ platform: "woocommerce", kind: "report", writeback: false, secondary: true });
    expect(r.inventory.locations).toEqual([""]);
  });

  it("reads the Variations report's title column", () => {
    const v = readFile(parseCsv(WOO_VARIATIONS)).result;
    expect(v.inventory.rows[0]).toMatchObject({ sku: "TEE-S", title: "Tee - Small", available: 4 });
    expect(v.orders.bySku.get("TEE-S").units).toBe(10);
  });
});

describe("WooCommerce stock report", () => {
  it("gives stock rows only, with N/A as unknown", () => {
    const r = readFile(parseCsv(WOO_STOCK)).result;
    expect(r.orders).toBeUndefined();
    expect(r.products).toBeUndefined();
    expect(r.inventory.rows.map((x) => x.available)).toEqual([12, null]);
    expect(r.inventory.meta.writeback).toBe(false);
  });
});

describe("WooCommerce product export", () => {
  const r = readFile(parseCsv(WOO_EXPORT)).result;

  it("gives product details with price and no cost, and says the total will be partial", () => {
    expect(r.products.bySku.get("MUG-L").price).toBe(10);
    expect(r.products.bySku.get("MUG-L").cost).toBeNull();
    expect(r.products.bySku.get("MUG-L").vendor).toBe("");
    expect(r.notes.some((n) => /cost/i.test(n))).toBe(true);
  });

  it("gives stock for every row, with blank and 'parent' as unknown", () => {
    const by = Object.fromEntries(r.inventory.rows.map((x) => [x.sku, x.available]));
    expect(by).toEqual({ "MUG-L": 12, TEE: null, "TEE-S": 4, "TEE-M": null });
    expect(r.inventory.meta).toMatchObject({ kind: "export", writeback: true, secondary: false });
  });

  it("reads the Cost of Goods extension's meta column when it is present", () => {
    const c = readFile(parseCsv(WOO_EXPORT_COGS)).result;
    expect(c.products.bySku.get("MUG-L").cost).toBe(4.2);
    expect(c.notes.some((n) => /cost/i.test(n))).toBe(false);
  });

  it("does not present a shared name as identifying", () => {
    const dup = readFile(parseCsv([WOO_EXPORT_HEADER, "1,simple,A,Same,1,0,visible,,,taxable,1,1,,0,,1,,", "2,simple,B,Same,1,0,visible,,,taxable,1,1,,0,,1,,"].join("\r\n"))).result;
    expect(dup.products.byTitle.has("Same")).toBe(false);
    expect([...dup.products.ambiguousTitles]).toEqual(["Same"]);
  });
});

describe("WooCommerce writeback", () => {
  const exp = readFile(parseCsv(WOO_EXPORT)).result;

  it("emits an update import with the identity columns and the new Stock, for changed rows only", () => {
    const rows = attachProducts(exp.inventory.rows, exp.products);
    const v = variance(rows, new Map([["MUG-L", 15], ["TEE-S", 4]]));
    const w = woo.writeback.build(v.rows, exp.inventory);
    expect(w.ok).toBe(true);
    expect(w.headers).toEqual(["ID", "Type", "SKU", "Name", "Parent", "Stock"]);
    expect(w.records).toEqual([{ ID: "101", Type: "simple", SKU: "MUG-L", Name: "Mug", Parent: "", Stock: "15" }]);
    expect(toCsv(w.headers, w.records)).toBe("ID,Type,SKU,Name,Parent,Stock\r\n101,simple,MUG-L,Mug,,15\r\n");
  });

  it("keeps a variation's Parent so the importer can place it", () => {
    const v = variance(exp.inventory.rows, new Map([["TEE-S", 9]]));
    const w = woo.writeback.build(v.rows, exp.inventory);
    expect(w.records[0]).toMatchObject({ Type: "variation", SKU: "TEE-S", Parent: "TEE", Stock: "9" });
  });

  it("cannot add to a row whose stock is inherited from the parent", () => {
    const v = variance(exp.inventory.rows, new Map([["TEE-M", 3]]));
    expect(v.rows[0].delta).toBeNull();
    expect(woo.writeback.build(v.rows, exp.inventory).ok).toBe(false);
  });

  it("refuses to build from an analytics download and says which file to load", () => {
    const rep = readFile(parseCsv(WOO_REPORT)).result;
    const v = variance(rep.inventory.rows, new Map([["MUG-L", 15]]));
    const w = woo.writeback.build(v.rows, rep.inventory);
    expect(w.ok).toBe(false);
    expect(w.reason).toMatch(/Products → Export/);
  });

  it("says so when nothing changed", () => {
    const v = variance(exp.inventory.rows, new Map([["MUG-L", 12]]));
    expect(woo.writeback.build(v.rows, exp.inventory)).toMatchObject({ ok: false, reason: /nothing to import/i });
  });
});

describe("WooCommerce end to end", () => {
  it("produces a suggestion from the export plus the report once the window is typed in", () => {
    const exp = readFile(parseCsv(WOO_EXPORT)).result;
    const rep = readFile(parseCsv(WOO_REPORT)).result;
    const rows = attachProducts(exp.inventory.rows, exp.products);
    const blocked = suggest({ inventory: rows, salesBySku: rep.orders.bySku, windowDays: null, productsBySku: exp.products.bySku, productsByHandle: exp.products.byHandle, productsByTitle: exp.products.byTitle });
    expect(blocked.suggestions).toHaveLength(0);
    expect(blocked.noSales.find((x) => x.sku === "MUG-L").reason).toMatch(/window is not set/);

    const r = suggest({ inventory: rows, salesBySku: rep.orders.bySku, windowDays: 30, productsBySku: exp.products.bySku, productsByHandle: exp.products.byHandle, productsByTitle: exp.products.byTitle });
    const mug = r.suggestions.find((x) => x.sku === "MUG-L");
    // 24 sold over 30 days = 0.8/day; (14 + 30) days = 35.2 units; minus 12 on hand = 24
    expect(mug.velocity).toBeCloseTo(0.8);
    expect(mug.suggestedQty).toBe(24);
    expect(mug.unitPrice).toBe(10);
    expect(mug.unitCost).toBeNull();
    expect(mug.extendedCost).toBeNull();
  });
});

describe("Shopify adapter", () => {
  it("reads the same three exports and reports the window from the orders file", () => {
    const inv = readFile(parseCsv(SHOPIFY_INVENTORY)).result;
    expect(inv.inventory.rows).toHaveLength(2);
    expect(inv.inventory.locations).toEqual(["New York", "Ottawa"]);
    expect(inv.inventory.meta).toMatchObject({ platform: "shopify", writeback: true });
    const ord = readFile(parseCsv(SHOPIFY_ORDERS)).result;
    expect(ord.windowDays).toBe(1);
    const prod = readFile(parseCsv(SHOPIFY_PRODUCTS)).result;
    expect(prod.products.bySku.get("MUG-L").cost).toBe(4.2);
  });

  it("writes back exactly what the count wrote before: the raw row with On hand (new) filled", () => {
    const inv = readInventory(parseCsv(SHOPIFY_INVENTORY));
    const ottawa = inv.rows.filter((r) => r.location === "Ottawa");
    const v = variance(ottawa, new Map([["mug", 7]]));
    const w = shopifyAdapter.writeback.build(v.rows, inv);
    expect(w.ok).toBe(true);
    expect(w.headers).toEqual(parseCsv(SHOPIFY_INVENTORY).headers);
    expect(w.records[0]["On hand (new)"]).toBe("7");
    expect(w.records[0]["On hand (current)"]).toBe("5");
  });

  it("refuses an aggregated row, as the count always has", () => {
    const w = shopifyAdapter.writeback.build([{ aggregated: true, delta: 1 }], { columns: { onHandNew: "On hand (new)" } });
    expect(w.ok).toBe(false);
    expect(w.reason).toMatch(/single location/);
  });
});
