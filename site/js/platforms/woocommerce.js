/**
 * WooCommerce: three files a merchant can download from core WooCommerce, no extension needed.
 *
 * Every column name below was read from WooCommerce's own documentation on 2026-09-02; the raw
 * pages are kept under D:\money-scout\research\raw\.
 *
 *  1. Analytics → Products (or Variations) report, downloaded with the "Download" link above the
 *     table. woocommerce.com/document/woocommerce-analytics/products-report/ lists the columns:
 *       "Product Title, SKU, Items Sold (count), Net Sales, Orders (count), Category,
 *        Variations (count), Status (in/out stock), Stock (inventory quantity)"
 *     and woocommerce.com/document/woocommerce-analytics/variations-report/ lists:
 *       "Product or variation title, SKU, Items sold, Net sales, Orders, Status, Stock"
 *     woocommerce.com/document/woocommerce-analytics/ says the link downloads "a CSV copy of the
 *     data used in the report", so the CSV carries the table's columns. One file therefore gives
 *     both current stock and units sold — but not the date range it covers, and only "products
 *     that have had sales in the specified date range". The window has to be typed in, and a
 *     product with no sales is simply absent from this file.
 *
 *  2. Analytics → Stock report. woocommerce.com/document/woocommerce-analytics/stock-report/:
 *       "Product or variation, SKU, Status, Stock"
 *     "Products that do not track inventory can still appear in the report. Their stock quantity
 *     is shown as N/A" — so N/A reads as unknown, never as zero.
 *
 *  3. Products → All Products → Export. woocommerce.com/document/product-csv-importer-exporter/
 *     schema: ID, Type, SKU (Required), Name (Required), Published, ..., "In stock?"
 *     (stock_status), Stock ("manage_stock / stock_quantity ... A numeric stock level enables
 *     stock management. Use parent for a variation that inherits stock settings. Leave blank to
 *     disable stock management."), "Regular price", "Sale price", Parent, ...
 *     The same file is the import format: "Select Update existing products. Existing products
 *     that match by ID or SKU are updated. Products that do not exist are skipped." That is what
 *     the count writeback produces.
 *
 *     The schema has no cost column and no vendor or barcode column. Cost is read only when the
 *     Cost of Goods extension's meta column is present — woocommerce.com/document/cost-of-goods-sold/
 *     documents "Meta: _wc_cog_cost — The cost of the simple product" for the built-in importer,
 *     and the exporter writes custom meta as "meta:<key>" when "export all custom meta" is ticked.
 *     Without it, costs are blank and vendor totals are marked partial, exactly as for a Shopify
 *     product with no cost.
 */

import { count, findHeader, makeReader } from "./columns.js?v=0.2.4";

export const id = "woocommerce";
export const name = "WooCommerce";
/** Core WooCommerce holds one stock figure per product; there are no locations to choose between. */
export const hasLocations = false;

export const guide = {
  inventory: "Products → All Products → Export (this is also the file a count is written back to), or Analytics → Stock → Download.",
  orders: "Analytics → Products → Download, over the date range you want; Analytics → Variations for variable products. The file does not say how long the range was, so you type it in.",
  products: "The same Products → Export file. It carries the price; core WooCommerce has no cost, vendor or barcode column.",
};

const REPORT = {
  title: ["Product Title", "Product or variation title", "Product"],
  sku: ["SKU"],
  itemsSold: ["Items Sold"],
  netSales: ["Net Sales"],
  orders: ["Orders"],
  status: ["Status"],
  stock: ["Stock"],
  variations: ["Variations"],
};

const STOCK = {
  title: ["Product or variation"],
  sku: ["SKU"],
  status: ["Status"],
  stock: ["Stock"],
};

const EXPORT = {
  id: ["ID"],
  type: ["Type"],
  sku: ["SKU"],
  name: ["Name"],
  published: ["Published"],
  inStock: ["In stock?"],
  stock: ["Stock"],
  regularPrice: ["Regular price"],
  salePrice: ["Sale price"],
  parent: ["Parent"],
  cost: ["Meta: _wc_cog_cost", "meta:_wc_cog_cost"],
};

const has = (headers, n) => findHeader(headers, [n]) !== null;

/**
 * { kind, score } for a WooCommerce file, else null. Each kind needs at least two of its
 * distinctive columns, and the analytics report is tested first because the stock report's
 * columns are a subset of it.
 */
export function detect(headers) {
  if (has(headers, "Items Sold") && has(headers, "Stock")) {
    return { kind: "report", score: count(headers, ["Items Sold", "Stock", "SKU", "Net Sales"]).score };
  }
  if (has(headers, "Regular price") && has(headers, "Name")) {
    const c = count(headers, ["Regular price", "Name", "SKU", "Type", "Stock", "Published"]);
    if (c.score >= 3) return { kind: "export", score: c.score };
  }
  if (has(headers, "Product or variation") && has(headers, "Stock")) {
    return { kind: "stock", score: count(headers, ["Product or variation", "Stock", "Status", "SKU"]).score };
  }
  return null;
}

/** A stock row in the shape the forecast expects. WooCommerce has no locations, bins, incoming or committed. */
function stockRow({ sku, title, stock, raw, extra }) {
  return {
    handle: sku,
    title,
    location: "",
    bin: "",
    sku,
    incoming: 0,
    committed: 0,
    available: stock,
    onHandCurrent: stock,
    raw,
    ...(extra ?? {}),
  };
}

function readReport(parsed) {
  const r = makeReader(REPORT, parsed.headers);
  const rows = [];
  const bySku = new Map();
  let unreadableStock = 0;
  for (const rec of parsed.records) {
    const sku = r.get(rec, "sku").trim();
    const title = r.get(rec, "title").trim();
    if (!sku && !title) continue;
    // "N/A" for a product that does not track inventory parses as null, which is what it means
    const stock = r.getNum(rec, "stock");
    if (stock === null) unreadableStock += 1;
    rows.push(stockRow({ sku, title, stock, raw: rec }));
    const key = sku || title;
    const units = r.getNum(rec, "itemsSold") ?? 0;
    const cur = bySku.get(key) ?? { key, units: 0, lines: 0, name: title };
    cur.units += units;
    cur.lines += 1;
    bySku.set(key, cur);
  }
  const notes = ["This report lists only products that sold in its date range, and does not carry the range itself: type its length in days."];
  if (unreadableStock) {
    notes.push(`${unreadableStock} row${unreadableStock === 1 ? "" : "s"} show N/A or blank stock and ${unreadableStock === 1 ? "is" : "are"} left out rather than counted as zero.`);
  }
  return {
    inventory: { rows, locations: [""], missing: r.missing, columns: r.columns, meta: { platform: id, kind: "report", writeback: false, secondary: true } },
    orders: { bySku, from: null, to: null, days: null, skippedUnpaid: 0, undated: 0, missing: r.missing },
    windowDays: null,
    notes,
  };
}

function readStock(parsed) {
  const r = makeReader(STOCK, parsed.headers);
  const rows = [];
  for (const rec of parsed.records) {
    const sku = r.get(rec, "sku").trim();
    const title = r.get(rec, "title").trim();
    if (!sku && !title) continue;
    rows.push(stockRow({ sku, title, stock: r.getNum(rec, "stock"), raw: rec, extra: { status: r.get(rec, "status").trim() } }));
  }
  return {
    inventory: { rows, locations: [""], missing: r.missing, columns: r.columns, meta: { platform: id, kind: "stock", writeback: false, secondary: false } },
    notes: ["The Stock report cannot be imported back; load the Products → Export file when you want to write a count back."],
  };
}

function readExport(parsed) {
  const r = makeReader(EXPORT, parsed.headers);
  const rows = [];
  const byHandle = new Map();
  const bySku = new Map();
  const byTitle = new Map();
  const variantsByHandle = new Map();
  const titleCount = new Map();
  for (const rec of parsed.records) {
    const sku = r.get(rec, "sku").trim();
    const name = r.get(rec, "name").trim();
    if (!sku && !name) continue;
    const entry = {
      handle: sku,
      title: name,
      vendor: "",
      sku,
      barcode: "",
      cost: r.getNum(rec, "cost"),
      price: r.getNum(rec, "regularPrice"),
      type: r.get(rec, "type").trim(),
      parent: r.get(rec, "parent").trim(),
      id: r.get(rec, "id").trim(),
    };
    if (sku) {
      if (!bySku.has(sku)) bySku.set(sku, entry);
      if (!byHandle.has(sku)) byHandle.set(sku, entry);
      variantsByHandle.set(sku, [entry]);
    }
    if (name) titleCount.set(name, (titleCount.get(name) ?? 0) + 1);
    if (name && !byTitle.has(name)) byTitle.set(name, entry);
    // "parent" means the variation inherits the parent's stock and blank means stock is not
    // managed; both parse as null and are reported, never treated as zero
    rows.push(stockRow({ sku, title: name, stock: r.getNum(rec, "stock"), raw: rec, extra: { price: entry.price, cost: entry.cost, type: entry.type, parent: entry.parent } }));
  }
  const ambiguousTitles = new Set();
  for (const [title, n] of titleCount) {
    if (n > 1) {
      ambiguousTitles.add(title);
      byTitle.delete(title);
    }
  }
  const notes = [];
  if (r.columns.cost === null) notes.push("No cost column (core WooCommerce exports none), so purchase-order totals will be partial.");
  return {
    inventory: { rows, locations: [""], missing: r.missing, columns: r.columns, meta: { platform: id, kind: "export", writeback: true, secondary: false } },
    products: { byHandle, bySku, byTitle, variantsByHandle, ambiguousTitles, missing: r.missing },
    notes,
  };
}

export function read(parsed) {
  const d = detect(parsed.headers);
  if (!d) throw new Error("not a WooCommerce file");
  if (d.kind === "report") return readReport(parsed);
  if (d.kind === "stock") return readStock(parsed);
  return readExport(parsed);
}

export const writeback = {
  label: "Download product CSV for WooCommerce",
  importNote:
    "Import it at Products → All Products → Import and tick “Update existing products”; the importer matches rows by ID or SKU. " +
    "The file carries only ID, Type, SKU, Name, Parent and Stock, so nothing else on the product is touched. Only rows that differ are included.",
  filename: (date) => `woocommerce-stock-${date}.csv`,
  /**
   * An update import for the product CSV importer. Per the schema, SKU and Name are required and
   * matching is by ID or SKU, so those identity columns are copied from the export as they were,
   * and Stock is set to the new quantity.
   */
  build(varianceRows, inventory) {
    if (!inventory?.meta?.writeback) {
      return {
        ok: false,
        reason:
          "Load the Products → Export CSV to write a count back. WooCommerce's importer matches products by ID or SKU and needs the SKU and Name columns, which the Analytics downloads do not carry.",
      };
    }
    const c = inventory.columns ?? {};
    if (!c.stock) return { ok: false, reason: 'the export has no "Stock" column' };
    const keep = ["id", "type", "sku", "name", "parent"].map((f) => c[f]).filter(Boolean);
    const headers = [...new Set([...keep, c.stock])];
    const records = [];
    for (const r of varianceRows) {
      if (r.delta === null || r.delta === 0) continue;
      const out = {};
      for (const h of keep) out[h] = r.raw?.[h] ?? "";
      out[c.stock] = String(r.countedQty);
      records.push(out);
    }
    if (records.length === 0) return { ok: false, reason: "Nothing differs from WooCommerce's current quantities, so there is nothing to import." };
    return { ok: true, headers, records };
  },
};

/** What to call each file in the status line. */
export const labels = { report: "analytics report", stock: "stock report", export: "product export" };
