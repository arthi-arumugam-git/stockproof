/**
 * Licence check against Dodo Payments.
 *
 * Dodo issues a licence key on payment and emails it to the buyer, revokes it automatically on
 * refund, dispute or a cancelled subscription, and enforces an activation limit per key. Its
 * activate, deactivate and validate endpoints are public: the docs say "The activate, deactivate,
 * and validate license endpoints are public and do not require an API key. Call them directly from
 * your client applications without exposing your API credentials." Verified 2026-09-02:
 *   POST https://live.dodopayments.com/licenses/validate  {license_key}  ->  {"valid":false}
 * for an unknown key.
 *
 * The key is kept in this browser and re-checked once a day. If the network is unavailable the
 * last good result stands for 30 days, so counting stock in a stockroom with no signal is never
 * blocked by a licence check.
 */

const HOST = "https://live.dodopayments.com";
const STORAGE_KEY = "stockproof.licence";
const RECHECK_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Dodo's validate endpoint takes only the key, so a key from any Dodo merchant would validate. The
 * activate endpoint answers with the product the key was sold for (its response carries
 * `product.product_id`), and that is the check: only a key sold for one of these products unlocks
 * the page, and the product says which tier. Dodo keys carry no prefix, so nothing about the key's
 * shape is trusted.
 */
export const PRODUCTS = Object.freeze({
  pdt_0NmijLgj2xavrtNCK6Kst: "standard", // stockproof Standard, $39 a month
  pdt_0NmijjvKgOb6aqo05nKJo: "standard", // stockproof Standard, $390 a year
  pdt_0NmikQUVcKrpEPiNOqzIt: "plus", // stockproof Plus, $79 a month
  pdt_0NmilBOPh4sl8jtT8ThpE: "plus", // stockproof Plus, $790 a year
});

/** "plus" or "standard" for one of this page's products; null for anything else. */
export function tierOf(productId) {
  return PRODUCTS[String(productId ?? "")] ?? null;
}

export function looksLikeKey(key) {
  return String(key ?? "").trim().length >= 8;
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
    /* private browsing: the licence simply will not persist */
  }
}

async function post(path, body, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(HOST + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // a blocked cross-origin request lands here too, and is not the customer's fault
    return { ok: false, reason: `could not reach the licence server: ${e instanceof Error ? e.message : String(e)}`, network: true };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: `licence server returned ${res.status}`, network: res.status >= 500 };
  }
  if (res.status >= 500) return { ok: false, reason: `licence server returned ${res.status}`, network: true };
  return { ok: true, data };
}

/** Is this key currently valid? */
export async function verify(key, { fetchImpl = fetch } = {}) {
  const r = await post("/licenses/validate", { license_key: String(key).trim() }, fetchImpl);
  if (!r.ok) return r;
  if (r.data?.valid === true) return { ok: true };
  return { ok: false, reason: r.data?.message || "that licence key is not valid, or is no longer active" };
}

/** Claim one of the key's activation slots for this browser; the answer names the product the key was sold for. */
export async function claim(key, name, { fetchImpl = fetch } = {}) {
  const r = await post("/licenses/activate", { license_key: String(key).trim(), name }, fetchImpl);
  if (!r.ok) return r;
  const id = r.data?.id ?? r.data?.license_key_instance_id;
  if (id) return { ok: true, instanceId: id, productId: r.data?.product?.product_id ?? null };
  return { ok: false, reason: r.data?.message || "no activation slot was returned; the activation limit may be reached" };
}

/** Give a slot back, so the key can be used on another device. */
export async function release(key, instanceId, { fetchImpl = fetch } = {}) {
  if (!instanceId) return { ok: false, reason: "nothing to release" };
  const r = await post("/licenses/deactivate", { license_key: String(key).trim(), license_key_instance_id: instanceId }, fetchImpl);
  return r.ok ? { ok: true } : r;
}

function deviceName() {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return `stockproof · ${browser}${os ? " on " + os : ""}`;
}

/** Verify, claim a slot, learn the tier from the product, store. */
export async function activate(key, opts = {}) {
  const storage = opts.storage ?? globalThis.localStorage;
  const trimmed = String(key ?? "").trim();
  if (!trimmed) return { ok: false, reason: "enter a licence key" };
  if (!looksLikeKey(trimmed)) return { ok: false, reason: "that does not look like a licence key" };
  const v = await verify(trimmed, opts);
  if (!v.ok) return v;
  const a = await claim(trimmed, deviceName(), opts);
  if (!a.ok) {
    return a.network ? a : { ok: false, reason: `${a.reason}. On a device that no longer needs it, open the Licence tab and choose Forget to free the slot.` };
  }
  const t = tierOf(a.productId);
  if (!t) {
    await release(trimmed, a.instanceId, opts);
    return { ok: false, reason: "that key was sold for a different product" };
  }
  writeStore(storage, { key: trimmed, checkedAt: opts.now ?? Date.now(), instanceId: a.instanceId, productId: a.productId, tier: t });
  return { ok: true, tier: t };
}

/** Current state, re-checking at most once a day. */
export async function status(opts = {}) {
  const storage = opts.storage ?? globalThis.localStorage;
  const now = opts.now ?? Date.now();
  const saved = readStore(storage);
  if (!saved || !saved.key) return { licensed: false, tier: null, reason: "no licence key" };
  const t = saved.tier ?? tierOf(saved.productId);
  if (!t) return { licensed: false, tier: null, reason: "the stored key predates tiers; enter it again" };
  const age = now - (saved.checkedAt ?? 0);
  if (age < RECHECK_MS) return { licensed: true, tier: t };
  const v = await verify(saved.key, opts);
  if (v.ok) {
    writeStore(storage, { ...saved, checkedAt: now });
    return { licensed: true, tier: t };
  }
  if (v.network && age < GRACE_MS) return { licensed: true, tier: t, stale: true, reason: "offline; within grace" };
  return { licensed: false, tier: null, reason: v.reason };
}

/** Drop the key from this browser and hand its slot back (best effort; the slot also frees on its own). */
export function forget(opts = {}) {
  const storage = opts.storage ?? globalThis.localStorage;
  const saved = readStore(storage);
  if (saved?.key && saved?.instanceId) release(saved.key, saved.instanceId, opts).catch(() => {});
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

export const _internal = { STORAGE_KEY, RECHECK_MS, GRACE_MS, HOST, deviceName };
