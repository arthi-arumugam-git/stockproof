import { describe, expect, it } from "vitest";
import { parseCsv } from "../site/js/csv.js";
import { aggregateLocations, attachProducts, detect, readInventory, readOrders, readProducts } from "../site/js/shopify.js";

const INVENTORY = [
  "Handle,Title,Location,Bin name,Incoming (not editable),Unavailable (not editable),Committed (not editable),Available (not editable),On hand (current),On hand (new)",
  'mug,"Mug, Large",Ottawa,A1,10,0,2,5,7,',
  "bowl,Bowl,Ottawa,,0,0,0,40,40,",
  "mug,\"Mug, Large\",New York,B2,0,0,0,3,3,",
  "plate,Plate,Ottawa,,0,0,0,not stocked,,",
].join("\r\n");

const ORDERS = [
  "Name,Created at,Financial Status,Lineitem quantity,Lineitem name,Lineitem price,Lineitem sku",
  "#1001,2026-08-01 10:00:00 +0000,paid,3,Mug Large,20.00,MUG-L",
  ",,,2,Bowl,10.00,BOWL",
  "#1002,2026-08-31 10:00:00 +0000,paid,5,Mug Large,20.00,MUG-L",
  "#1003,2026-08-15 10:00:00 +0000,refunded,9,Mug Large,20.00,MUG-L",
].join("\r\n");

const PRODUCTS = [
  "URL handle,Title,Vendor,Variant SKU,Variant Barcode,Cost per item,Variant Price",
  'mug,"Mug, Large",Acme Pottery,MUG-L,5012345678900,4.20,20.00',
  "mug,,,MUG-S,5012345678917,3.10,15.00",
  "bowl,Bowl,Acme Pottery,BOWL,5012345678924,2.00,10.00",
].join("\r\n");

describe("detect", () => {
  it("recognises each export from its distinctive columns", () => {
    expect(detect(parseCsv(INVENTORY).headers).kind).toBe("inventory");
    expect(detect(parseCsv(ORDERS).headers).kind).toBe("orders");
    expect(detect(parseCsv(PRODUCTS).headers).kind).toBe("products");
  });

  it("says unknown rather than guessing from a single coincidental column", () => {
    expect(detect(["Title"]).kind).toBe("unknown");
    expect(detect(["Name", "Email"]).kind).toBe("unknown");
  });
});

describe("readInventory", () => {
  const inv = readInventory(parseCsv(INVENTORY));

  it("keeps one row per variant per location and lists the locations", () => {
    expect(inv.rows).toHaveLength(4);
    expect(inv.locations).toEqual(["New York", "Ottawa"]);
  });

  it("reads incoming and available, and leaves an unreadable available as null", () => {
    const mugOttawa = inv.rows.find((r) => r.handle === "mug" && r.location === "Ottawa");
    expect(mugOttawa.incoming).toBe(10);
    expect(mugOttawa.available).toBe(5);
    expect(mugOttawa.onHandCurrent).toBe(7);
    const plate = inv.rows.find((r) => r.handle === "plate");
    expect(plate.available).toBeNull(); // "not stocked" must not read as 0
  });

  it("finds every column it needs in a real export header", () => {
    expect(inv.missing.filter((m) => m !== "SKU")).toEqual([]);
  });
});

describe("readOrders", () => {
  const ord = readOrders(parseCsv(ORDERS));

  it("sums units per SKU and ignores refunded lines", () => {
    expect(ord.bySku.get("MUG-L").units).toBe(8); // 3 + 5; the refunded 9 is excluded
    expect(ord.skippedUnpaid).toBe(1);
    expect(ord.bySku.get("BOWL").units).toBe(2);
  });

  it("derives the window from the dates present, counting both endpoints", () => {
    expect(ord.days).toBe(31); // 1 Aug to 31 Aug inclusive
  });

  it("tolerates Shopify blanking repeated order fields on continuation lines", () => {
    expect(ord.undated).toBe(1);
    expect(ord.bySku.has("BOWL")).toBe(true);
  });
});

describe("readProducts", () => {
  const prod = readProducts(parseCsv(PRODUCTS));

  it("carries the vendor from the product row down to variant rows of the same handle", () => {
    expect(prod.byHandle.get("mug").vendor).toBe("Acme Pottery");
    expect(prod.byHandle.get("mug").cost).toBe(4.2);
  });

  it("indexes variants by SKU with their own cost and barcode", () => {
    expect(prod.bySku.get("MUG-S").cost).toBe(3.1);
    expect(prod.bySku.get("MUG-S").barcode).toBe("5012345678917");
    expect(prod.bySku.get("BOWL").vendor).toBe("Acme Pottery");
  });
});

describe("aggregateLocations", () => {
  it("sums stock across locations so a store-wide sales figure is not counted twice", () => {
    const inv = readInventory(parseCsv(INVENTORY));
    const agg = aggregateLocations(inv.rows);
    // mug appears at two locations; after aggregation it is one row
    expect(inv.rows.filter((r) => r.handle === "mug")).toHaveLength(2);
    const mug = agg.find((r) => r.handle === "mug");
    expect(mug.available).toBe(8); // 5 + 3
    expect(mug.incoming).toBe(10);
    expect(mug.onHandCurrent).toBe(10); // 7 + 3
    expect(mug.aggregated).toBe(true);
    expect(mug.locations.sort()).toEqual(["New York", "Ottawa"]);
    expect(agg).toHaveLength(3); // mug, bowl, plate
  });

  it("leaves a single-location row untouched and unmarked", () => {
    const inv = readInventory(parseCsv(INVENTORY));
    const bowl = aggregateLocations(inv.rows).find((r) => r.handle === "bowl");
    expect(bowl.aggregated).toBe(false);
    expect(bowl.available).toBe(40);
  });

  it("keeps an unreadable available as null rather than treating it as zero", () => {
    const inv = readInventory(parseCsv(INVENTORY));
    const plate = aggregateLocations(inv.rows).find((r) => r.handle === "plate");
    expect(plate.available).toBeNull();
  });
});

describe("attachProducts", () => {
  const inv = readInventory(parseCsv(INVENTORY));
  const prod = readProducts(parseCsv(PRODUCTS));

  it("fills the SKU and barcode the inventory export does not carry", () => {
    const rows = attachProducts(inv.rows, prod);
    const mug = rows.find((r) => r.handle === "mug");
    expect(inv.rows[0].sku).toBe(""); // the export really has no SKU column
    // "mug" has two variants; the inventory row's title matches the product row, so it resolves
    // to that variant rather than being refused
    expect(mug.sku).toBe("MUG-L");
    expect(mug.barcode).toBe("5012345678900");
    expect(mug.vendor).toBe("Acme Pottery");
    expect(mug.cost).toBe(4.2);
  });

  it("lists every code that should match the row when scanned or typed", () => {
    const mug = attachProducts(inv.rows, prod).find((r) => r.handle === "mug");
    expect(mug.aliases).toContain("MUG-L");
    expect(mug.aliases).toContain("5012345678900");
    expect(mug.aliases).toContain("mug");
    expect(mug.aliases).toContain("Mug, Large");
  });

  it("leaves rows alone when there is no products export", () => {
    const rows = attachProducts(inv.rows, null);
    expect(rows[0].sku).toBe("");
    expect(rows[0].aliases).toEqual(["mug", "Mug, Large"]);
  });
});

describe("ambiguous titles are refused, not guessed", () => {
  const DUPES = [
    "URL handle,Title,Vendor,Variant SKU,Variant Barcode,Cost per item",
    "alpha,Shared Name,Acme,SKU-A,111,1.00",
    "beta,Shared Name,Beta Co,SKU-B,222,2.00",
    "gamma,Unique Name,Acme,SKU-G,333,3.00",
  ].join("\r\n");
  const INV2 = [
    "Handle,Title,Location,Bin name,Incoming (not editable),Unavailable (not editable),Committed (not editable),Available (not editable),On hand (current),On hand (new)",
    "alpha,Shared Name,Ottawa,,0,0,0,5,5,",
    "beta,Shared Name,Ottawa,,0,0,0,7,7,",
    "gamma,Unique Name,Ottawa,,0,0,0,9,9,",
  ].join("\r\n");

  it("drops a title shared by two products from the index and reports it", () => {
    const prod = readProducts(parseCsv(DUPES));
    expect(prod.byTitle.has("Shared Name")).toBe(false);
    expect(prod.byTitle.has("Unique Name")).toBe(true);
    expect([...prod.ambiguousTitles]).toEqual(["Shared Name"]);
  });

  it("still resolves a shared title through its handle when that handle has one variant", () => {
    const prod = readProducts(parseCsv(DUPES));
    const rows = attachProducts(readInventory(parseCsv(INV2)).rows, prod);
    expect(rows.find((r) => r.handle === "alpha").sku).toBe("SKU-A");
    expect(rows.find((r) => r.handle === "beta").sku).toBe("SKU-B");
    expect(rows.find((r) => r.handle === "gamma").sku).toBe("SKU-G");
  });

  it("does not merge two different products that share a title", () => {
    const prod = readProducts(parseCsv(DUPES));
    const rows = aggregateLocations(attachProducts(readInventory(parseCsv(INV2)).rows, prod));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.available).sort((a, b) => a - b)).toEqual([5, 7, 9]);
  });

  it("leaves SKU blank and marks the row when nothing can identify it", () => {
    const prodOnlyDupes = readProducts(parseCsv([
      "URL handle,Title,Vendor,Variant SKU,Cost per item",
      "alpha,Shared Name,Acme,SKU-A,1.00",
      "alpha,Shared Name,Acme,SKU-A2,1.00",
      "beta,Shared Name,Beta Co,SKU-B,2.00",
    ].join("\r\n")));
    const rows = attachProducts(readInventory(parseCsv(INV2)).rows, prodOnlyDupes);
    const alpha = rows.find((r) => r.handle === "alpha");
    expect(alpha.sku).toBe(""); // two variants under this handle, and the title is shared
    expect(alpha.ambiguous).toBe(true);
  });
});
