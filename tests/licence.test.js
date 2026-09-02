import { describe, expect, it } from "vitest";
import { _internal, activate, forget, looksLikeKey, status, verify } from "../site/js/licence.js";

const jsonRes = (body, statusCode = 200) => ({ status: statusCode, ok: statusCode < 400, json: async () => body });

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

const routed = (validBody, activateBody) => async (url) =>
  String(url).endsWith("/validate") ? jsonRes(validBody) : jsonRes(activateBody);

describe("key shape", () => {
  it("accepts the product's prefix in any case and rejects other keys", () => {
    expect(looksLikeKey("STOCKPROOF-AAAA-BBBB")).toBe(true);
    expect(looksLikeKey("stockproof-aaaa-bbbb")).toBe(true);
    expect(looksLikeKey("  STOCKPROOF-AAAA-BBBB  ")).toBe(true);
    expect(looksLikeKey("BILLPROOF-AAAA-BBBB")).toBe(false);
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
  it("stores the key and its activation instance", async () => {
    const storage = memStore();
    const r = await activate("STOCKPROOF-K", { storage, now: 1000, fetchImpl: routed({ valid: true }, { id: "inst_1" }) });
    expect(r.ok).toBe(true);
    expect(JSON.parse(storage.getItem(_internal.STORAGE_KEY))).toMatchObject({ key: "STOCKPROOF-K", checkedAt: 1000, instanceId: "inst_1" });
  });

  it("still licenses the browser when the activation limit is reached, because the key is valid", async () => {
    const storage = memStore();
    const r = await activate("STOCKPROOF-K", { storage, fetchImpl: routed({ valid: true }, { message: "activation limit reached" }) });
    expect(r.ok).toBe(true);
    expect(JSON.parse(storage.getItem(_internal.STORAGE_KEY)).instanceId).toBeNull();
  });

  it("refuses an empty key and a key for a different product without calling out", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return jsonRes({ valid: true });
    };
    expect((await activate("", { storage: memStore(), fetchImpl })).ok).toBe(false);
    expect((await activate("BILLPROOF-K", { storage: memStore(), fetchImpl })).ok).toBe(false);
    expect(called).toBe(false);
  });

  it("does not store anything when the key is rejected", async () => {
    const storage = memStore();
    const r = await activate("STOCKPROOF-K", { storage, fetchImpl: async () => jsonRes({ valid: false }) });
    expect(r.ok).toBe(false);
    expect(storage.getItem(_internal.STORAGE_KEY)).toBeNull();
  });
});

describe("status", () => {
  const primed = (checkedAt) => {
    const storage = memStore();
    storage.setItem(_internal.STORAGE_KEY, JSON.stringify({ key: "STOCKPROOF-K", checkedAt }));
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
    expect(r.licensed).toBe(true);
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
});

describe("private browsing", () => {
  it("never throws when storage is unavailable", async () => {
    const storage = throwingStore();
    await expect(status({ storage })).resolves.toMatchObject({ licensed: false });
    await expect(activate("STOCKPROOF-K", { storage, fetchImpl: routed({ valid: true }, { id: "i" }) })).resolves.toMatchObject({ ok: true });
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
