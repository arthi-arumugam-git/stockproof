/**
 * Column lookup shared by every platform reader.
 *
 * Platforms rename columns between versions and locales ("Handle" became "URL handle" on Shopify;
 * WooCommerce's report tables say "Items Sold" on one page and "Items sold" on another), so every
 * lookup accepts several spellings, compares them case-insensitively and ignoring punctuation, and
 * reports what it could not find rather than silently reading undefined.
 */

import { num } from "../csv.js?v=0.2.1";

/** First header that matches any candidate, compared case-insensitively and ignoring punctuation. */
export function findHeader(headers, candidates) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const map = new Map();
  for (const h of headers) if (!map.has(norm(h))) map.set(norm(h), h);
  for (const c of candidates) {
    const hit = map.get(norm(c));
    if (hit !== undefined) return hit;
  }
  return null;
}

/** True when every one of `names` is present in `headers`. */
export function hasAll(headers, names) {
  return names.every((n) => findHeader(headers, [n]) !== null);
}

/** How many of `names` are present in `headers`, and which are not. */
export function count(headers, names) {
  const found = names.filter((n) => findHeader(headers, [n]) !== null);
  return { score: found.length, missing: names.filter((n) => !found.includes(n)) };
}

/**
 * Build a reader from a spec of { field: [candidate headers...] }: `get` returns the cell as a
 * string ("" when the column is absent), `getNum` parses it, `columns` maps each field to the
 * header actually used (null when absent) and `missing` lists the first candidate of each field
 * that was not found.
 */
export function makeReader(spec, headers) {
  const resolved = {};
  const missing = [];
  for (const [field, candidates] of Object.entries(spec)) {
    const h = findHeader(headers, candidates);
    if (h === null) missing.push(candidates[0]);
    resolved[field] = h;
  }
  const get = (rec, field) => {
    const h = resolved[field];
    return h === null || h === undefined ? "" : (rec[h] ?? "");
  };
  return { get, getNum: (rec, field) => num(get(rec, field)), columns: resolved, missing };
}
