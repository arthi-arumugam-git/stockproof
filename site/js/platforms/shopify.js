/**
 * Shopify, presented in the shape the platform registry expects.
 *
 * The column knowledge itself lives in ../shopify.js: it predates the registry, its tests pin its
 * behaviour, and nothing about how a Shopify file is read changes here. This file only says which
 * of the three slots a recognised file fills and how a count is written back.
 */

import { detect as detectKind, readInventory, readOrders, readProducts } from "../shopify.js?v=0.2.0";
import { writebackRecords } from "../forecast.js?v=0.2.0";

export const id = "shopify";
export const name = "Shopify";
/** Shopify's inventory export carries one row per variant per location. */
export const hasLocations = true;

/** Where each file comes from, in the merchant's own admin (help.shopify.com, fetched 2026-09-02). */
export const guide = {
  inventory: "Products → Inventory → Export, choose All states.",
  orders: "Orders → Export over a recent window; 30 to 90 days works well. The window is read from the dates in the file.",
  products: "Products → Export. Adds vendor, cost, price and barcode to each line.",
};

/** { kind, score } when the headers are a Shopify export, else null. */
export function detect(headers) {
  const d = detectKind(headers);
  return d.kind === "unknown" ? null : { kind: d.kind, score: d.score };
}

/** Fill whichever slots this file can. */
export function read(parsed) {
  const d = detectKind(parsed.headers);
  const notes = [];
  if (d.kind === "inventory") {
    const inventory = readInventory(parsed);
    return { inventory: { ...inventory, meta: { platform: id, kind: d.kind, writeback: true, secondary: false } }, notes };
  }
  if (d.kind === "orders") {
    const orders = readOrders(parsed);
    if (orders.skippedUnpaid) notes.push(`${orders.skippedUnpaid} refunded or voided line${orders.skippedUnpaid === 1 ? "" : "s"} excluded`);
    return { orders, windowDays: orders.days, notes };
  }
  if (d.kind === "products") return { products: readProducts(parsed), notes };
  throw new Error("not a Shopify export");
}

export const writeback = {
  label: "Download inventory CSV for Shopify",
  importNote:
    "The download keeps the On hand (current) column, so Shopify's own safety validation still compares against " +
    "what it believes before applying anything. Only rows that differ are included.",
  filename: (date) => `inventory-count-${date}.csv`,
  /** Variance-shaped rows in, { ok, headers, records } or { ok: false, reason } out. */
  build(varianceRows, inventory) {
    if (varianceRows.some((r) => r.aggregated)) {
      return { ok: false, reason: "Pick a single location before downloading. Shopify's import needs one row per location, and an aggregated count cannot be split back out." };
    }
    let records;
    try {
      records = writebackRecords(varianceRows, inventory?.columns ?? {});
    } catch (e) {
      return { ok: false, reason: String(e.message || e) };
    }
    if (records.length === 0) return { ok: false, reason: "Nothing differs from Shopify's current quantities, so there is nothing to import." };
    return { ok: true, headers: Object.keys(records[0]), records };
  },
};

/** What to call each file in the status line. */
export const labels = { inventory: "inventory export", orders: "orders export", products: "products export" };
