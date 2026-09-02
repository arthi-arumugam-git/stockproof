/**
 * Per-vendor lead time and target cover, kept in this browser.
 *
 * A pottery supplier that takes six weeks and a local printer that takes two should not share one
 * lead time. These override the global settings for that vendor's rows only; a vendor with no
 * entry uses the globals. Stored under one localStorage key, as plain numbers.
 */

const STORAGE_KEY = "stockproof.vendors";
export const FIELDS = Object.freeze(["leadTimeDays", "targetCoverDays"]);

function clean(entry) {
  const out = {};
  for (const f of FIELDS) {
    const raw = entry?.[f];
    if (raw === "" || raw === null || raw === undefined) continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) out[f] = v;
  }
  return out;
}

/** Map vendor -> { leadTimeDays?, targetCoverDays? }, never throwing when storage is unavailable. */
export function load(storage = globalThis.localStorage) {
  const map = new Map();
  let raw = null;
  try {
    raw = storage?.getItem(STORAGE_KEY);
  } catch {
    return map;
  }
  if (!raw) return map;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return map;
  }
  if (!obj || typeof obj !== "object") return map;
  for (const [vendor, entry] of Object.entries(obj)) {
    const c = clean(entry);
    if (Object.keys(c).length) map.set(vendor, c);
  }
  return map;
}

export function save(map, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(toObject(map)));
  } catch {
    /* private browsing: the overrides last for this visit only */
  }
}

export function toObject(map) {
  const obj = {};
  for (const [vendor, entry] of map) obj[vendor] = { ...entry };
  return obj;
}

/** A new map with one field changed; an empty value removes the override, and a vendor with none is dropped. */
export function setVendor(map, vendor, field, value) {
  if (!FIELDS.includes(field)) throw new Error(`unknown vendor setting: ${field}`);
  const next = new Map(map);
  const entry = { ...(next.get(vendor) ?? {}) };
  const v = value === "" || value === null || value === undefined ? NaN : Number(value);
  if (Number.isFinite(v) && v >= 0) entry[field] = v;
  else delete entry[field];
  if (Object.keys(entry).length) next.set(vendor, entry);
  else next.delete(vendor);
  return next;
}

export const _internal = { STORAGE_KEY };
