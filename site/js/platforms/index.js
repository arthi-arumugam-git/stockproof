/**
 * The platform registry. A dropped file is recognised by its columns, whichever platform it came
 * from; each platform module says which of the three slots (stock levels, sales, product details)
 * the file fills, and how a count goes back.
 *
 * A module exports: id, name, hasLocations, guide, detect(headers) -> { kind, score } | null,
 * read(parsed) -> { inventory?, orders?, products?, windowDays?, notes }, and writeback.
 */

import * as shopify from "./shopify.js?v=0.2.0";
import * as woocommerce from "./woocommerce.js?v=0.2.0";

export const PLATFORMS = [shopify, woocommerce];

export function byId(id) {
  return PLATFORMS.find((p) => p.id === id) ?? null;
}

/** Best match across platforms, or null. Ties go to the earlier platform. */
export function detectFile(headers) {
  let best = null;
  for (const platform of PLATFORMS) {
    const d = platform.detect(headers);
    if (d && (!best || d.score > best.score)) best = { platform, kind: d.kind, score: d.score };
  }
  return best;
}

/** Detect and read in one step; null when no platform recognises the headers. */
export function readFile(parsed) {
  const d = detectFile(parsed.headers);
  if (!d) return null;
  return { ...d, result: d.platform.read(parsed) };
}
