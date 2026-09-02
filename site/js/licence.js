/**
 * Licence check against Gumroad.
 *
 * Gumroad issues one licence key per sale and emails it to the buyer, so nothing of ours is
 * involved in delivery. Verified against the live endpoint on 2026-09-02:
 *   POST https://api.gumroad.com/v2/licenses/verify   product_id, license_key
 * needs no access token and answers
 *   {"success":false,"message":"That license does not exist for the provided product."}
 * for an unknown key.
 *
 * The key is kept in localStorage and re-checked once a day. If the network is unavailable the
 * last good result stands for 30 days, so a merchant counting stock in a stockroom with no
 * signal is never locked out of a tool they have paid for.
 */

const VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify";
const STORAGE_KEY = "stockproof.licence";
const RECHECK_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** Set at build time by editing this line; empty means the paid features stay locked. */
export const PRODUCT_ID = "";

const KEY_SHAPE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}$|^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export function looksLikeKey(key) {
  return KEY_SHAPE.test(String(key ?? "").trim());
}

function readStore(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStore(storage, value) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* private browsing; the licence simply will not persist */
  }
}

/**
 * Ask Gumroad about a key.
 * `increment_uses_count=false` keeps the counter meaningful as a device count rather than a
 * page-load count, since this runs on every visit.
 */
export async function verify(key, { productId = PRODUCT_ID, fetchImpl = fetch } = {}) {
  if (!productId) return { ok: false, reason: "no product configured in this build" };
  let res;
  try {
    res = await fetchImpl(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ product_id: productId, license_key: String(key).trim(), increment_uses_count: "false" }).toString(),
    });
  } catch (e) {
    return { ok: false, reason: `network: ${e instanceof Error ? e.message : String(e)}`, network: true };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: `Gumroad returned ${res.status}`, network: res.status >= 500 };
  }
  if (!data.success) return { ok: false, reason: data.message || `Gumroad returned ${res.status}` };
  const p = data.purchase || {};
  if (p.refunded) return { ok: false, reason: "this purchase was refunded" };
  if (p.disputed || p.chargebacked) return { ok: false, reason: "this purchase was disputed" };
  if (p.subscription_cancelled_at || p.subscription_failed_at) return { ok: false, reason: "this subscription is no longer active" };
  return { ok: true, customer: p.email };
}

/** Verify and store. Returns the same shape as verify(). */
export async function activate(key, opts = {}) {
  const storage = opts.storage ?? globalThis.localStorage;
  const trimmed = String(key ?? "").trim();
  if (!trimmed) return { ok: false, reason: "enter a licence key" };
  if (!looksLikeKey(trimmed)) return { ok: false, reason: "that does not look like a Gumroad licence key" };
  const r = await verify(trimmed, opts);
  if (r.ok) writeStore(storage, { key: trimmed, checkedAt: Date.now(), customer: r.customer ?? null });
  return r;
}

/**
 * Current licence state, re-checking with Gumroad at most once a day.
 * Returns { licensed, customer, reason, stale }.
 */
export async function status(opts = {}) {
  const storage = opts.storage ?? globalThis.localStorage;
  const now = opts.now ?? Date.now();
  const saved = readStore(storage);
  if (!saved || !saved.key) return { licensed: false, reason: "no licence key" };
  const age = now - (saved.checkedAt ?? 0);
  if (age < RECHECK_MS) return { licensed: true, customer: saved.customer ?? undefined };
  const r = await verify(saved.key, opts);
  if (r.ok) {
    writeStore(storage, { ...saved, checkedAt: now, customer: r.customer ?? null });
    return { licensed: true, customer: r.customer };
  }
  if (r.network && age < GRACE_MS) return { licensed: true, customer: saved.customer ?? undefined, stale: true, reason: "offline; within grace" };
  return { licensed: false, reason: r.reason };
}

export function forget(opts = {}) {
  const storage = opts.storage ?? globalThis.localStorage;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

export const _internal = { STORAGE_KEY, RECHECK_MS, GRACE_MS };
