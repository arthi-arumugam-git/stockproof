import { describe, expect, it } from "vitest";
import { _internal, activate, forget, looksLikeKey, PRODUCTS, status, tierOf, verify } from "../site/js/licence.js";

const jsonRes = (body, statusCode = 200) => ({ status: statusCode, ok: statusCode < 400, json: async () => body });

const STANDARD = "pdt_0NmijLgj2xavrtNCK6Kst";
const STANDARD_YEAR = "pdt_0NmijjvKgOb6aqo05nKJo";
const PLUS = "pdt_0NmikQUVcKrpEPiNOqzIt";
const PLUS_YEAR = "pdt_0NmilBOPh4sl8jtT8ThpE";

/** A localStorage stand-in, plus one that throws the way private browsing does. */
const memStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
};
const throwingStore = () => ({
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
});

/** The shape the live activate endpoint answers with: an instance id and the product the key was sold for. */
const activated = (productId, id = "inst_1") => ({ id, product: { product_id: productId, name: null } });

const routed = (validBody, activateBody, deactivateBody = {}) => async (url) => {
  const u = String(url);
  if (u.endsWith("/validate")) return jsonRes(validBody);
  if (u.endsWith("/deactivate")) return jsonRes(deactivateBody);
  return jsonRes(activateBody);
};

describe("key shape", () => {
  it("only refuses keys that are obviously not keys; Dodo keys carry no prefix", () => {
    expect(looksLikeKey("ABCD-EFGH-IJKL")).toBe(true);
    expect(looksLikeKey("  ABCD-EFGH-IJKL  ")).toBe(true);
    expect(looksLikeKey("short")).toBe(false);
    expect(looksLikeKey("")).toBe(false);
    expect(looksLikeKey(null)).toBe(false);
  });
});

describe("verify", () => {
  it("accepts a valid key", async () => {
    await expect(verify("K", { fetchImpl: async () => jsonRes({ valid: true }) })).resolves.toEqual({ ok: true });
  });

  it("rejects an invalid one with a message a shopkeeper can act on", async () => {
    // the exact body the live endpoint returned on 2026-09-02 for an unknown key
    const r = await verify("K", { fetchImpl: async () => jsonRes({ valid: false }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not valid|no longer active/);
  });

  it("posts only the key, to the validate endpoint", async () => {
    let seen = {};
    await verify("MY-KEY", {
      fetchImpl: async (url, init) => {
        seen = { url: String(url), body: JSON.parse(init.body) };
        return jsonRes({ valid: true });
      },
    });
    expect(seen.url).toBe(_internal.HOST + "/licenses/validate");
    expect(seen.body).toEqual({ license_key: "MY-KEY" });
  });

  it("marks a blocked or failed request as retryable so the grace period can apply", async () => {
    const blocked = await verify("K", {
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.network).toBe(true);
    const down = await verify("K", { fetchImpl: async () => jsonRes({}, 503) });
    expect(down.network).toBe(true);
  });
});

describe("activate", () => {
  it("stores the key, its activation instance, and the tier read from the product", async () => {
    const storage = memStore();
    const r = await activate("ABCD-EFGH-IJKL", { storage, now: 1000, fetchImpl: routed({ valid: true }, activated(STANDARD)) });
    expect(r).toEqual({ ok: true, tier: "standard" });
    expect(JSON.parse(storage.getItem(_internal.STORAGE_KEY))).toMatchObject({ key: "ABCD-EFGH-IJKL", checkedAt: 1000, instanceId: "inst_1", productId: STANDARD, tier: "standard" });
  });

  it("refuses when no slot is granted, because the tier comes from the activation", async () => {
    const storage = memStore();
    const r = await activate("ABCD-EFGH-IJKL", { storage, fetchImpl: routed({ valid: true }, { message: "activation limit reached" }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/activation limit reached/);
    expect(r.reason).toMatch(/Forget/);
    expect(storage.getItem(_internal.STORAGE_KEY)).toBeNull();
  });

  it("refuses a key sold for someone else's product and hands the slot straight back", async () => {
    const storage = memStore();
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(String(url).split("/").pop());
      const u = String(url);
      if (u.endsWith("/validate")) return jsonRes({ valid: true });
      if (u.endsWith("/activate")) return jsonRes(activated("pdt_someone_else", "inst_9"));
      expect(JSON.parse(init.body)).toEqual({ license_key: "ABCD-EFGH-IJKL", license_key_instance_id: "inst_9" });
      return jsonRes({});
    };
    const r = await activate("ABCD-EFGH-IJKL", { storage, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/different product/);
    expect(calls).toEqual(["validate", "activate", "deactivate"]);
    expect(storage.getItem(_internal.STORAGE_KEY)).toBeNull();
  });

  it("refuses an empty or too-short key without calling out", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return jsonRes({ valid: true });
    };
    expect((await activate("", { storage: memStore(), fetchImpl })).ok).toBe(false);
    expect((await activate("abc", { storage: memStore(), fetchImpl })).ok).toBe(false);
    expect(called).toBe(false);
  });

  it("does not store anything when the key is rejected", async () => {
    const storage = memStore();
    const r = await activate("ABCD-EFGH-IJKL", { storage, fetchImpl: async () => jsonRes({ valid: false }) });
    expect(r.ok).toBe(false);
    expect(storage.getItem(_internal.STORAGE_KEY)).toBeNull();
  });
});

describe("status", () => {
  const primed = (checkedAt, extra = { productId: STANDARD, tier: "standard" }) => {
    const storage = memStore();
    storage.setItem(_internal.STORAGE_KEY, JSON.stringify({ key: "ABCD-EFGH-IJKL", checkedAt, ...extra }));
    return storage;
  };

  it("is unlicensed with nothing stored, and does not call out", async () => {
    let called = false;
    const r = await status({
      storage: memStore(),
      fetchImpl: async () => {
        called = true;
        return jsonRes({ valid: true });
      },
    });
    expect(r.licensed).toBe(false);
    expect(called).toBe(false);
  });

  it("trusts a recent check without asking again", async () => {
    let called = false;
    const r = await status({
      storage: primed(1_000_000),
      now: 1_000_000 + 60_000,
      fetchImpl: async () => {
        called = true;
        return jsonRes({ valid: true });
      },
    });
    expect(r).toEqual({ licensed: true, tier: "standard" });
    expect(called).toBe(false);
  });

  it("re-checks after a day and records the new time", async () => {
    const storage = primed(0);
    const now = _internal.RECHECK_MS + 1;
    const r = await status({ storage, now, fetchImpl: async () => jsonRes({ valid: true }) });
    expect(r.licensed).toBe(true);
    expect(JSON.parse(storage.getItem(_internal.STORAGE_KEY)).checkedAt).toBe(now);
  });

  it("keeps working offline for thirty days, then stops", async () => {
    const offline = async () => {
      throw new TypeError("Failed to fetch");
    };
    const inGrace = await status({ storage: primed(0), now: _internal.GRACE_MS - 1, fetchImpl: offline });
    expect(inGrace.licensed).toBe(true);
    expect(inGrace.stale).toBe(true);
    const expired = await status({ storage: primed(0), now: _internal.GRACE_MS + 1, fetchImpl: offline });
    expect(expired.licensed).toBe(false);
  });

  it("a revoked key stops working immediately, grace or not", async () => {
    const r = await status({ storage: primed(0), now: _internal.RECHECK_MS + 1, fetchImpl: async () => jsonRes({ valid: false }) });
    expect(r.licensed).toBe(false);
  });

  it("a stored key with no product (from before tiers) asks to be entered again rather than guessing a tier", async () => {
    const r = await status({ storage: primed(1, {}), now: 2 });
    expect(r).toMatchObject({ licensed: false, tier: null });
    expect(r.reason).toMatch(/enter it again/);
  });
});

describe("forget", () => {
  it("drops the key and hands the slot back", async () => {
    const storage = memStore();
    await activate("ABCD-EFGH-IJKL", { storage, fetchImpl: routed({ valid: true }, activated(PLUS, "inst_7")) });
    let released = null;
    forget({
      storage,
      fetchImpl: async (url, init) => {
        released = { url: String(url), body: JSON.parse(init.body) };
        return jsonRes({});
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(storage.getItem(_internal.STORAGE_KEY)).toBeNull();
    expect(released).toEqual({ url: _internal.HOST + "/licenses/deactivate", body: { license_key: "ABCD-EFGH-IJKL", license_key_instance_id: "inst_7" } });
  });
});

describe("private browsing", () => {
  it("never throws when storage is unavailable", async () => {
    const storage = throwingStore();
    await expect(status({ storage })).resolves.toMatchObject({ licensed: false });
    await expect(activate("ABCD-EFGH-IJKL", { storage, fetchImpl: routed({ valid: true }, activated(STANDARD)) })).resolves.toMatchObject({ ok: true });
    expect(() => forget({ storage })).not.toThrow();
  });
});

describe("device name", () => {
  it("describes the browser without collecting anything identifying", () => {
    const name = _internal.deviceName();
    expect(name.startsWith("stockproof · ")).toBe(true);
    expect(name.length).toBeLessThan(60);
  });
});

describe("tiers", () => {
  it("maps each of the four live products to its tier and nothing else to anything", () => {
    expect(Object.keys(PRODUCTS)).toHaveLength(4);
    expect(tierOf(STANDARD)).toBe("standard");
    expect(tierOf(STANDARD_YEAR)).toBe("standard");
    expect(tierOf(PLUS)).toBe("plus");
    expect(tierOf(PLUS_YEAR)).toBe("plus");
    expect(tierOf("pdt_someone_else")).toBeNull();
    expect(tierOf(undefined)).toBeNull();
  });

  it("reports the tier from status, for a fresh check and for a cached one", async () => {
    const storage = memStore();
    await activate("ABCD-EFGH-IJKL", { storage, now: 1000, fetchImpl: routed({ valid: true }, activated(PLUS_YEAR)) });
    expect(await status({ storage, now: 2000 })).toEqual({ licensed: true, tier: "plus" });
    const later = await status({ storage, now: 2000 + _internal.RECHECK_MS, fetchImpl: async () => jsonRes({ valid: true }) });
    expect(later).toEqual({ licensed: true, tier: "plus" });
    expect((await status({ storage: memStore() })).tier).toBeNull();
  });
});
