/**
 * Reorder arithmetic.
 *
 * Every number a merchant might place an order on is returned with the inputs that produced it,
 * so the interface can show its working and a person can check it by hand. Nothing here guesses:
 * a SKU with no sales in the window, or no available quantity, gets a stated reason instead of a
 * number.
 */

export const DEFAULTS = Object.freeze({
  leadTimeDays: 14,
  safetyDays: 7,
  targetCoverDays: 30,
});

/**
 * @param {object} args
 * @param {Array} args.inventory  rows from readInventory, already filtered to one location
 * @param {Map}   args.salesBySku units sold, keyed by SKU or line item name
 * @param {number|null} args.windowDays  days covered by the orders export
 * @param {Map}   args.productsByHandle  vendor and cost lookup
 * @param {Map}   args.productsBySku
 * @param {object} args.settings  leadTimeDays, safetyDays, targetCoverDays
 * @param {Map|object} [args.vendorSettings]  per-vendor overrides of any of those three, keyed by vendor
 */
export function suggest({ inventory, salesBySku, windowDays, productsByHandle, productsBySku, productsByTitle, settings, vendorSettings }) {
  const s = { ...DEFAULTS, ...(settings ?? {}) };
  const suggestions = [];
  const noSales = [];
  const noData = [];
  // a vendor's own lead time and cover, when the merchant has set them, win over the globals
  const forVendor = (vendor) => {
    const o = !vendorSettings ? null : vendorSettings instanceof Map ? vendorSettings.get(vendor) : vendorSettings[vendor];
    if (!o) return s;
    const out = { ...s };
    for (const k of ["leadTimeDays", "safetyDays", "targetCoverDays"]) if (Number.isFinite(o[k]) && o[k] >= 0) out[k] = o[k];
    return out;
  };

  for (const row of inventory) {
    // Shopify's inventory export carries no SKU column, so the join to orders (which are keyed
    // by SKU) has to go through the products export: title first, because the inventory Title
    // is the variant title, then handle. Without a products export only a title match can work.
    const product =
      (row.sku && productsBySku?.get(row.sku)) ||
      (row.title && productsByTitle?.get(row.title)) ||
      (row.handle && productsByHandle?.get(row.handle)) ||
      null;
    const sku = row.sku || product?.sku || "";
    const key = sku || row.handle || row.title;
    const sale =
      (sku && salesBySku?.get(sku)) ||
      (row.title && salesBySku?.get(row.title)) ||
      (product?.title && salesBySku?.get(product.title)) ||
      null;

    const base = {
      key,
      handle: row.handle,
      sku,
      title: row.title || product?.title || "",
      vendor: product?.vendor || "",
      barcode: product?.barcode || "",
      unitCost: product?.cost ?? row.cost ?? null,
      unitPrice: product?.price ?? row.price ?? null,
      available: row.available,
      incoming: row.incoming ?? 0,
      committed: row.committed ?? 0,
      location: row.location,
      bin: row.bin,
      aggregated: Boolean(row.aggregated),
    };

    if (row.available === null) {
      noData.push({ ...base, reason: "no available quantity in the inventory export" });
      continue;
    }
    if (!windowDays || !sale || sale.units <= 0) {
      // a sales file whose window is not known yet is a different situation from no sales file
      const reason = windowDays ? "no sales in the window" : salesBySku?.size ? "sales loaded, but the window is not set" : "no orders export loaded";
      noSales.push({ ...base, unitsSold: sale?.units ?? 0, reason });
      continue;
    }

    const rs = forVendor(base.vendor);
    const unitsSold = sale.units;
    const velocity = unitsSold / windowDays;
    const daysOfCover = velocity > 0 ? base.available / velocity : null;
    const reorderPoint = velocity * (rs.leadTimeDays + rs.safetyDays);
    const target = velocity * (rs.leadTimeDays + rs.targetCoverDays);
    const suggestedQty = Math.max(0, Math.ceil(target - base.available - base.incoming));

    suggestions.push({
      ...base,
      unitsSold,
      windowDays,
      velocity,
      daysOfCover,
      reorderPoint,
      suggestedQty,
      belowReorderPoint: base.available + base.incoming < reorderPoint,
      extendedCost: base.unitCost !== null ? +(base.unitCost * suggestedQty).toFixed(2) : null,
      settings: rs,
      vendorOverride: rs !== s,
    });
  }

  // most urgent first: least cover remaining, then largest order
  suggestions.sort((a, b) => {
    const ac = a.daysOfCover ?? Infinity;
    const bc = b.daysOfCover ?? Infinity;
    if (ac !== bc) return ac - bc;
    return b.suggestedQty - a.suggestedQty;
  });
  // a join that matched nothing is a setup problem, not a business fact, and must be visible
  const unitsInWindow = salesBySku
    ? Array.from(salesBySku.values()).reduce((total, entry) => total + Number(entry?.units || 0), 0)
    : 0;
  const joinFailed = Boolean(windowDays) && suggestions.length === 0 && noSales.length > 0 && unitsInWindow > 0;
  return { suggestions, noSales, noData, settings: s, joinFailed };
}

/** Group suggestions into one purchase order per vendor, dropping zero-quantity lines. */
export function groupByVendor(suggestions, { includeZero = false } = {}) {
  const byVendor = new Map();
  for (const row of suggestions) {
    if (!includeZero && row.suggestedQty <= 0) continue;
    const vendor = row.vendor || "(no vendor)";
    const g = byVendor.get(vendor) ?? { vendor, lines: [], totalUnits: 0, totalCost: 0, costKnown: true };
    g.lines.push(row);
    g.totalUnits += row.suggestedQty;
    if (row.extendedCost === null) g.costKnown = false;
    else g.totalCost += row.extendedCost;
    byVendor.set(vendor, g);
  }
  const groups = [...byVendor.values()];
  for (const g of groups) {
    g.totalCost = +g.totalCost.toFixed(2);
    g.lines.sort((a, b) => b.suggestedQty - a.suggestedQty);
  }
  groups.sort((a, b) => b.totalUnits - a.totalUnits);
  return groups;
}

/**
 * Compare counted quantities against what Shopify currently believes.
 * `counts` is a Map from key (sku, handle or title) to counted number.
 * Rows are returned in variance order so the biggest discrepancies are seen first.
 */
export function variance(inventory, counts) {
  const rows = [];
  let counted = 0;
  let matched = 0;
  const unmatchedKeys = [];
  const seen = new Set();

  for (const row of inventory) {
    // aliases carry the SKU and barcode that the inventory export itself does not include, so a
    // scanned barcode finds its row
    const keys = (row.aliases?.length ? row.aliases : [row.sku, row.handle, row.title]).filter(Boolean);
    let found = null;
    for (const k of keys) {
      if (counts.has(k)) {
        found = k;
        break;
      }
    }
    if (found === null) continue;
    seen.add(found);
    const countedQty = counts.get(found);
    const current = row.onHandCurrent;
    counted += 1;
    if (current !== null) matched += 1;
    rows.push({
      key: found,
      handle: row.handle,
      sku: row.sku,
      title: row.title,
      location: row.location,
      bin: row.bin,
      aggregated: Boolean(row.aggregated),
      onHandCurrent: current,
      countedQty,
      delta: current === null ? null : countedQty - current,
      raw: row.raw,
    });
  }
  for (const k of counts.keys()) if (!seen.has(k)) unmatchedKeys.push(k);

  rows.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  const net = rows.reduce((sum, r) => sum + (r.delta ?? 0), 0);
  const changed = rows.filter((r) => r.delta !== null && r.delta !== 0).length;
  return { rows, counted, matched, changed, net, unmatchedKeys };
}

/**
 * Build the records for a Shopify inventory import that applies a count.
 *
 * `On hand (current)` is deliberately preserved so Shopify's own safety validation still runs:
 * "Your expected inventory levels are compared with current levels before making changes."
 * Only rows whose count differs are emitted, so an import cannot disturb anything untouched.
 */
export function writebackRecords(varianceRows, columns) {
  const out = [];
  const newCol = columns.onHandNew;
  if (!newCol) throw new Error('the inventory export has no "On hand (new)" column');
  for (const r of varianceRows) {
    if (r.delta === null || r.delta === 0) continue;
    out.push({ ...r.raw, [newCol]: String(r.countedQty) });
  }
  return out;
}
