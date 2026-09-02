/**
 * Receiving: items arriving against a purchase order.
 *
 * The lines come from the purchase order the reorder tab produced; the counts come from the same
 * scan box the stock count uses. Per line the merchant sees what was ordered, what has arrived so
 * far, and the cost, price and margin of the line — with "—" wherever the products export carried
 * no figure, never a zero — and when the delivery is checked off, the received quantities become
 * the same kind of writeback the stock count produces: on hand (new) = on hand (current) + received.
 */

function codesFor(line) {
  return [...new Set([line.sku, line.barcode, line.key, line.handle, line.title, ...(line.aliases ?? [])].filter(Boolean))];
}

/**
 * @param {Array} lines   purchase-order lines: { key, sku, barcode, title, handle, vendor,
 *                        suggestedQty (ordered), unitCost, unitPrice }
 * @param {Map}   counts  code -> quantity received
 */
export function receive(lines, counts) {
  const rows = [];
  const seen = new Set();
  for (const line of lines) {
    let found = null;
    for (const c of codesFor(line)) {
      if (counts.has(c)) {
        found = c;
        break;
      }
    }
    if (found !== null) seen.add(found);
    const received = found === null ? 0 : counts.get(found);
    const ordered = line.ordered ?? line.suggestedQty ?? 0;
    const unitCost = line.unitCost ?? null;
    const unitPrice = line.unitPrice ?? null;
    const margin = unitCost !== null && unitPrice !== null ? +(unitPrice - unitCost).toFixed(2) : null;
    const marginPct = margin !== null && unitPrice > 0 ? +((margin / unitPrice) * 100).toFixed(1) : null;
    rows.push({
      ...line,
      code: found ?? line.sku ?? "",
      ordered,
      received,
      remaining: Math.max(0, ordered - received),
      over: Math.max(0, received - ordered),
      unitCost,
      unitPrice,
      margin,
      marginPct,
      extendedCost: unitCost !== null ? +(unitCost * received).toFixed(2) : null,
    });
  }
  const unmatchedKeys = [...counts.keys()].filter((k) => !seen.has(k));
  const totals = { units: 0, cost: 0, costKnown: true, linesReceived: 0, linesComplete: 0 };
  for (const r of rows) {
    if (r.received <= 0) continue;
    totals.units += r.received;
    totals.linesReceived += 1;
    if (r.ordered > 0 && r.received >= r.ordered) totals.linesComplete += 1;
    if (r.extendedCost === null) totals.costKnown = false;
    else totals.cost += r.extendedCost;
  }
  totals.cost = +totals.cost.toFixed(2);
  return { rows, totals, unmatchedKeys };
}

/**
 * Received rows as count-shaped rows, so the platform's writeback builder can produce the import.
 * A row whose current on-hand figure is unknown cannot be added to, and is returned separately
 * rather than written as if it had started at zero.
 */
export function receivingVariance(rows, inventoryRows) {
  const index = new Map();
  for (const inv of inventoryRows ?? []) {
    const keys = (inv.aliases?.length ? inv.aliases : [inv.sku, inv.handle, inv.title]).filter(Boolean);
    for (const k of keys) if (!index.has(k)) index.set(k, inv);
  }
  const out = [];
  const noRow = [];
  const noCurrent = [];
  for (const r of rows) {
    if (!r.received) continue;
    let inv = null;
    for (const c of codesFor(r)) {
      if (index.has(c)) {
        inv = index.get(c);
        break;
      }
    }
    if (!inv) {
      noRow.push(r);
      continue;
    }
    const current = inv.onHandCurrent;
    if (current === null || current === undefined) {
      noCurrent.push(r);
      continue;
    }
    out.push({
      key: r.code,
      handle: inv.handle,
      sku: inv.sku,
      title: inv.title,
      location: inv.location,
      bin: inv.bin,
      aggregated: Boolean(inv.aggregated),
      onHandCurrent: current,
      received: r.received,
      countedQty: current + r.received,
      delta: r.received,
      raw: inv.raw,
    });
  }
  return { rows: out, noRow, noCurrent };
}
