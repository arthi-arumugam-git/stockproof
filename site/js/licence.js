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
 * Dodo's validate endpoint takes only the key, so a key from any Dodo merchant would validate.
 * Setting a licence-key prefix on the product in the Dodo dashboard and checking it here stops an
 * unrelated key unlocking this tool. Empty means "accept any shape".
 */
export const KEY_PREFIX = "STOCKPROOF-";
/** The Plus product is a second Dodo product with its own prefix; the prefix is what carries the tier. */
export const PLUS_PREFIX = "STOCKPROOFPLUS-";

/** "plus" or "standard" from the key's prefix; null when it is neither. */
export function tier(key) {
  const k = String(key ?? "").trim().toUpperCase();
  if (PLUS_PREFIX && k.startsWith(PLUS_PREFIX.toUpperCase())) return "plus";
  if (KEY_PREFIX && k.startsWith(KEY_PREFIX.toUpperCase())) return "standard";
  return null;
}

export function looksLikeKey(key) {
  const k = String(key ?? "").trim();
  if (k.length < 8) return false;
  return KEY_PREFIX ? tier(k) !== null : true;
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

/** Claim one of the key's activation slots for this browser. */
export async function claim(key, name, { fetchImpl = fetch } = {}) {
  const r = await post("/licenses/activate", { license_key: String(key).trim(), name }, fetchImpl);
  if (!r.ok) return r;
  const id = r.data?.id ?? r.data?.license_key_instance_id;
  if (id) return { ok: true, instanceId: id };
  return { ok: false, reason: r.data?.message || "no activation slot was returned; the activation limit may be reached" };
}

function deviceName() {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return `stockproof · ${browser}${os ? " on " + os : ""}`;
}

/** Verify and store. */
export async function activate(key, opts = {}) {
  const storage = opts.storage ?? globalThis.localStorage;
  const trimmed = String(key ?? "").trim();
  if (!trimmed) return { ok: false, reason: "enter a licence key" };
  if (!looksLikeKey(trimmed)) return { ok: false, reason: `that does not look like a stockproof licence key (they start with ${KEY_PREFIX} or ${PLUS_PREFIX})` };
  const v = await verify(trimmed, opts);
  if (!v.ok) return v;
  // an activation-limit refusal does not invalidate the licence; the key still validates, this
  // browser simply does not hold a slot
  const a = await claim(trimmed, deviceName(), opts);
  writeStore(storage, { key: trimmed, checkedAt: opts.now ?? Date.now(), instanceId: a.ok ? a.instanceId : null });
  return { ok: true };
}

/** Current state, re-checking at most once a day. */
export async function status(opts = {}) {
  const storage = opts.storage ?? globalThis.localStorage;
  const now = opts.now ?? Date.now();
  const saved = readStore(storage);
  if (!saved || !saved.key) return { licensed: false, tier: null, reason: "no licence key" };
  const t = tier(saved.key);
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

export function forget(opts = {}) {
  const storage = opts.storage ?? globalThis.localStorage;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

export const _internal = { STORAGE_KEY, RECHECK_MS, GRACE_MS, HOST, deviceName };
