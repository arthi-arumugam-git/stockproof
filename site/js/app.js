/**
 * stockproof — wiring.
 *
 * Everything happens in this tab. The only network request the page ever makes is a licence
 * check against the payment provider, and that carries a licence key and nothing else. No merchant data is
 * ever sent anywhere, which is the whole reason this is a page and not an app with Admin API
 * access to someone's store.
 */

import { parseCsv, toCsv } from "./csv.js?v=0.2.1";
import { aggregateLocations, attachProducts } from "./shopify.js?v=0.2.1";
import { DEFAULTS, groupByVendor, suggest, variance } from "./forecast.js?v=0.2.1";
import { toSvg, encodable } from "./barcode.js?v=0.2.1";
import * as licence from "./licence.js?v=0.2.1";
import { PLATFORMS, byId, detectFile } from "./platforms/index.js?v=0.2.1";
import { receive, receivingVariance } from "./receiving.js?v=0.2.1";
import * as vendors from "./vendors.js?v=0.2.1";

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) n.append(c);
  return n;
};

/** Set once the Dodo products exist; until then the buy buttons point at the README. */
const BUY_URL = "https://github.com/arthi-arumugam-git/stockproof#licensed";
/** The Plus product needs its own Dodo product with the STOCKPROOFPLUS- prefix (see SETUP.md). */
const PLUS_BUY_URL = "https://github.com/arthi-arumugam-git/stockproof#licensed";

const state = {
  files: { inventory: null, orders: null, products: null },
  /** id of the platform the loaded files came from; files from two platforms are never mixed */
  platform: null,
  inventory: null,
  orders: null,
  products: null,
  /** typed in when the sales file cannot say how many days it covers */
  windowOverride: null,
  notes: [],
  location: null,
  settings: { ...DEFAULTS },
  vendorSettings: vendors.load(),
  search: "",
  counts: new Map(),
  receiving: { vendor: "__all__", counts: new Map() },
  licensed: false,
  tier: null,
  tab: "reorder",
};

/* ---------------- formatting ---------------- */
const fmtQty = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString());
const fmtMoney = (n) => (n === null || n === undefined ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmt1 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(1));
const todayIso = () => new Date().toISOString().slice(0, 10);
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many ?? one + "s"}`;
const platform = () => byId(state.platform);
const platformName = () => platform()?.name ?? "the platform";
const isPlus = () => state.licensed && state.tier === "plus";
/** Days the sales figures cover: read from the file when it says, typed in when it cannot. */
const effectiveWindow = () => state.orders?.days ?? state.windowOverride ?? null;

/* ---------------- file loading ---------------- */
async function loadFile(file) {
  const text = await file.text();
  const parsed = parseCsv(text);
  const d = detectFile(parsed.headers);
  if (!d) {
    return { ok: false, reason: `this is not a ${PLATFORMS.map((p) => p.name).join(" or ")} file this page knows; see the list under each slot` };
  }
  let result;
  try {
    result = d.platform.read(parsed);
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
  return { ok: true, platform: d.platform, kind: d.kind, result, name: file.name };
}

function setSlotState(kind, message, isError) {
  const slot = $(`slot-${kind}`);
  const state_ = $(`state-${kind}`);
  if (!slot || !state_) return;
  state_.textContent = message;
  state_.classList.toggle("err", Boolean(isError));
  slot.classList.toggle("loaded", Boolean(message) && !isError);
}

function resetData() {
  state.files = { inventory: null, orders: null, products: null };
  state.inventory = null;
  state.orders = null;
  state.products = null;
  state.windowOverride = null;
  state.notes = [];
  state.location = null;
  state.counts = new Map();
  state.receiving = { vendor: "__all__", counts: new Map() };
  for (const k of ["inventory", "orders", "products"]) setSlotState(k, "");
  const sel = $("location");
  if (sel) {
    sel.replaceChildren();
    delete sel.dataset.filled;
  }
  const w = $("windowDays");
  if (w) w.value = "";
}

async function acceptFile(file) {
  const r = await loadFile(file);
  if (!r.ok) {
    // report against whichever slot the user was aiming at; the header sniff is the truth
    setSlotState("inventory", `${file.name}: ${r.reason}`, true);
    return;
  }
  const { platform: p, kind, result } = r;
  const notes = [...(result.notes ?? [])];
  if (state.platform && state.platform !== p.id) {
    // the three slots must agree on where their numbers come from
    resetData();
    notes.unshift(`Switched to ${p.name}; the ${byId(state.platform)?.name ?? "previous"} files were cleared.`);
  }
  state.platform = p.id;
  const label = `${p.name} ${p.labels?.[kind] ?? kind}`;

  if (result.inventory) {
    const cur = state.inventory;
    // an analytics report carries stock only for what sold; it must not displace a full stock list
    if (result.inventory.meta?.secondary && cur && !cur.meta?.secondary) {
      notes.push(`Stock levels kept from ${state.files.inventory}; this report's stock column was not used.`);
    } else {
      state.inventory = result.inventory;
      state.files.inventory = r.name;
      const n = result.inventory.rows.length;
      const locs = result.inventory.locations.filter(Boolean).length;
      setSlotState("inventory", `${label} · ${r.name} · ${plural(n, "row")}${locs ? ` · ${plural(locs, "location")}` : ""}`);
    }
  }
  if (result.orders) {
    state.orders = result.orders;
    state.files.orders = r.name;
    if (result.orders.days !== null) state.windowOverride = null;
    const o = result.orders;
    setSlotState("orders", `${label} · ${r.name} · ${o.bySku.size.toLocaleString()} SKUs · ${o.days !== null ? `${o.days} day window` : "window not in file"}`);
  }
  if (result.products) {
    state.products = result.products;
    state.files.products = r.name;
    setSlotState("products", `${label} · ${r.name} · ${result.products.bySku.size.toLocaleString()} products`);
  }
  // notes accumulate across the files of one load, so the product export's "no cost column"
  // is still on screen after the analytics report lands; a platform switch clears them
  state.notes = [...state.notes.filter((n) => !notes.includes(n)), ...notes].slice(-8);
  render();
}

function wireFiles() {
  for (const kind of ["inventory", "orders", "products"]) {
    $(`file-${kind}`).addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) acceptFile(f);
    });
    // where each platform keeps the file, from the platform modules, so the page and the code agree
    const guide = $(`guide-${kind}`);
    if (guide) {
      guide.replaceChildren();
      PLATFORMS.forEach((p, i) => {
        if (i) guide.append(el("br"));
        guide.append(el("b", { text: `${p.name}: ` }), document.createTextNode(p.guide[kind]));
      });
    }
  }
  // drag anywhere: the header sniff decides which slot a file belongs to
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener("dragover", (e) => {
    stop(e);
    document.querySelectorAll(".slot").forEach((s) => s.classList.add("over"));
  });
  document.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) document.querySelectorAll(".slot").forEach((s) => s.classList.remove("over"));
  });
  document.addEventListener("drop", async (e) => {
    stop(e);
    document.querySelectorAll(".slot").forEach((s) => s.classList.remove("over"));
    for (const f of e.dataTransfer?.files ?? []) if (f.name.toLowerCase().endsWith(".csv")) await acceptFile(f);
  });
}

/* ---------------- computation ---------------- */
function currentRows() {
  if (!state.inventory) return [];
  const enriched = attachProducts(state.inventory.rows, state.products);
  // a platform with one stock figure per product has nothing to filter or add up
  if (!platform()?.hasLocations) return enriched;
  const loc = state.location;
  if (loc === null || loc === "__all__") return aggregateLocations(enriched);
  return enriched.filter((r) => r.location === loc);
}

function compute() {
  const rows = currentRows();
  const result = suggest({
    inventory: rows,
    salesBySku: state.orders?.bySku ?? new Map(),
    windowDays: effectiveWindow(),
    productsByHandle: state.products?.byHandle ?? new Map(),
    productsBySku: state.products?.bySku ?? new Map(),
    productsByTitle: state.products?.byTitle ?? new Map(),
    settings: state.settings,
    vendorSettings: isPlus() ? state.vendorSettings : null,
  });
  const q = state.search.trim().toLowerCase();
  if (!q) return result;
  const match = (r) => [r.sku, r.title, r.vendor, r.handle].some((v) => String(v ?? "").toLowerCase().includes(q));
  return {
    ...result,
    suggestions: result.suggestions.filter(match),
    noSales: result.noSales.filter(match),
    noData: result.noData.filter(match),
  };
}

/* ---------------- download ---------------- */
function download(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function paidGuard(action) {
  if (state.licensed) return action();
  showTab("licence");
}

function paidBtn(label, onClick, opts = {}) {
  const locked = !state.licensed;
  return el("button", {
    class: "btn" + (opts.primary && !locked ? " primary" : ""),
    type: "button",
    title: locked ? "Included with a licence" : "",
    onclick: () => paidGuard(onClick),
    text: locked ? `${label} · licence` : label,
  });
}

/** Build the platform's import file from count-shaped rows and hand it over, or say why not. */
function downloadWriteback(varianceRows) {
  const wb = platform()?.writeback;
  if (!wb) {
    alert("No platform is loaded.");
    return;
  }
  const w = wb.build(varianceRows, state.inventory);
  if (!w.ok) {
    alert(w.reason);
    return;
  }
  download(wb.filename(todayIso()), toCsv(w.headers, w.records));
}

/* ---------------- reorder panel ---------------- */
function vendorsInView(result) {
  return [...new Set([...result.suggestions, ...result.noSales].map((r) => r.vendor).filter(Boolean))].sort();
}

function renderVendorSettings(host, result) {
  const list = vendorsInView(result);
  if (list.length === 0) return;
  const plus = isPlus();
  const d = el("details", { class: "paid", open: state.vendorSettings.size > 0 && plus ? "" : null }, [
    el("summary", { text: `Per-vendor lead time and target cover${plus ? "" : " · Plus"}` }),
  ]);
  d.append(
    el("p", {
      class: "note",
      text: plus
        ? "Blank means the global setting applies. A vendor's own figures are used for that vendor's rows only, and are kept in this browser."
        : "With a Plus licence each vendor can carry its own lead time and target cover, overriding the global settings for that vendor's rows. Kept in this browser.",
    }),
  );
  const t = el("table", { class: "data vendors" });
  t.append(el("thead", {}, el("tr", {}, [el("th", { text: "Vendor" }), el("th", { class: "n", text: "Lead time (days)" }), el("th", { class: "n", text: "Target cover (days)" })])));
  const tb = el("tbody");
  for (const vendor of list) {
    const cur = state.vendorSettings.get(vendor) ?? {};
    const input = (field, globalValue) =>
      el("input", {
        type: "number",
        min: "0",
        max: "365",
        disabled: plus ? null : "",
        placeholder: String(globalValue),
        value: cur[field] ?? "",
        oninput: (e) => {
          state.vendorSettings = vendors.setVendor(state.vendorSettings, vendor, field, e.target.value);
          vendors.save(state.vendorSettings);
          // re-render the tables without rebuilding the input the merchant is typing in
          renderReorderTables($("reorderTables"), compute());
        },
      });
    tb.append(el("tr", {}, [
      el("td", { text: vendor }),
      el("td", { class: "n" }, input("leadTimeDays", state.settings.leadTimeDays)),
      el("td", { class: "n" }, input("targetCoverDays", state.settings.targetCoverDays)),
    ]));
  }
  t.append(tb);
  d.append(el("div", { class: "tablewrap" }, t));
  if (!plus) d.append(el("div", { class: "rowbar" }, [el("button", { class: "btn", type: "button", text: "Plus licence", onclick: () => showTab("licence") })]));
  host.append(d);
}

function renderReorderTables(host, result) {
  const { suggestions, noSales, noData } = result;
  host.replaceChildren();
  const toOrder = suggestions.filter((s) => s.suggestedQty > 0);
  host.append(
    el("div", { class: "rowbar" }, [
      el("span", { class: "note", text: `${toOrder.length} to order · ${suggestions.length} with sales · ${noSales.length} without · ${noData.length} unreadable` }),
    ]),
  );

  if (suggestions.length === 0 && noSales.length === 0) {
    host.append(el("div", { class: "empty", text: "Nothing to show for this location and filter." }));
    return;
  }

  const table = el("table", { class: "data" });
  table.append(
    el("thead", {}, el("tr", {}, [
      el("th", { text: "SKU" }),
      el("th", { text: "Product" }),
      el("th", { text: "Vendor" }),
      el("th", { class: "n", text: "Sold" }),
      el("th", { class: "n", text: "Per day" }),
      el("th", { class: "n", text: "Available" }),
      el("th", { class: "n", text: "Incoming" }),
      el("th", { class: "n", text: "Cover (days)" }),
      el("th", { class: "n", text: "Reorder at" }),
      el("th", { class: "n", text: "Order" }),
      el("th", { class: "n", text: "Cost" }),
    ])),
  );
  const body = el("tbody");
  for (const s of suggestions) {
    const st = s.settings;
    const why =
      `${s.unitsSold} sold over ${s.windowDays} days = ${s.velocity.toFixed(3)}/day. ` +
      `Target ${st.leadTimeDays} lead + ${st.targetCoverDays} cover = ` +
      `${(s.velocity * (st.leadTimeDays + st.targetCoverDays)).toFixed(1)} units, ` +
      `minus ${s.available} available and ${s.incoming} incoming.` +
      (s.vendorOverride ? ` Lead time and cover are this vendor's own settings.` : "");
    body.append(
      el("tr", {}, [
        el("td", { class: "sku", text: s.sku || "—" }),
        el("td", { text: s.title || s.handle }),
        el("td", { class: s.vendor ? "" : "muted", text: s.vendor || "no vendor", title: s.vendorOverride ? `lead ${st.leadTimeDays} d, cover ${st.targetCoverDays} d (vendor setting)` : null }),
        el("td", { class: "n", text: fmtQty(s.unitsSold) }),
        el("td", { class: "n", text: s.velocity.toFixed(2) }),
        el("td", { class: "n" + (s.belowReorderPoint ? " low" : ""), text: fmtQty(s.available) }),
        el("td", { class: "n muted", text: s.incoming ? fmtQty(s.incoming) : "—" }),
        el("td", { class: "n" + (s.belowReorderPoint ? " low" : "") }, el("span", { class: "why", title: why, text: fmt1(s.daysOfCover) })),
        el("td", { class: "n muted", text: fmt1(s.reorderPoint) }),
        el("td", { class: "n", text: s.suggestedQty ? String(s.suggestedQty) : "—" }),
        el("td", { class: "n", text: s.suggestedQty <= 0 || s.extendedCost === null ? "—" : fmtMoney(s.extendedCost) }),
      ]),
    );
  }
  table.append(body);
  host.append(el("div", { class: "tablewrap" }, table));

  if (noSales.length) {
    const d = el("details", { class: "paid" }, [
      el("summary", { text: `${plural(noSales.length, "SKU")} with no sales in the window — listed, not dropped` }),
    ]);
    const t = el("table", { class: "data" });
    t.append(el("thead", {}, el("tr", {}, [el("th", { text: "SKU" }), el("th", { text: "Product" }), el("th", { class: "n", text: "Available" }), el("th", { text: "Why" })])));
    const tb = el("tbody");
    for (const r of noSales.slice(0, 300)) {
      tb.append(el("tr", {}, [
        el("td", { class: "sku", text: r.sku || "—" }),
        el("td", { text: r.title || r.handle }),
        el("td", { class: "n", text: fmtQty(r.available) }),
        el("td", { class: "muted", text: r.reason }),
      ]));
    }
    t.append(tb);
    d.append(el("div", { class: "tablewrap" }, t));
    host.append(d);
  }
  const ambiguous = [...suggestions, ...noSales, ...noData].filter((r) => r.ambiguous).length;
  if (ambiguous) {
    host.append(
      el("div", {
        class: "warnbox",
        text:
          `${plural(ambiguous, "row")} share a product title with another product, so the SKU, cost and barcode ` +
          `could not be identified from the products export. They are shown without those, never with a guess. ` +
          `Giving each product a distinct title in ${platformName()} fixes it.`,
      }),
    );
  }

  if (noData.length) {
    host.append(el("div", { class: "warnbox errbox", text: `${plural(noData.length, "row")} had no readable available quantity and ${noData.length === 1 ? "was" : "were"} left out of every calculation.` }));
  }
}

function renderReorder(host) {
  const result = compute();
  host.replaceChildren();

  if (result.joinFailed) {
    host.append(
      el("div", {
        class: "warnbox errbox",
        html:
          "The sales file loaded, but none of its SKUs could be matched to a row in the stock levels. " +
          (state.platform === "shopify"
            ? "Shopify's inventory file has no SKU column, so the two are joined through the <strong>products</strong> export. Load that as well and the suggestions will appear. "
            : "Check that both files come from the same store and carry the same SKUs. ") +
          "Nothing below is a claim that these products have no sales.",
      }),
    );
  }

  if (!state.orders) {
    host.append(
      el("div", {
        class: "warnbox",
        html:
          "Load a <strong>sales</strong> file to get reorder suggestions. Without it stockproof can still " +
          "print labels and run a stock count, but it has no sales history to work from and will not invent one.",
      }),
    );
  } else if (effectiveWindow() === null) {
    host.append(
      el("div", {
        class: "warnbox errbox",
        html:
          `The ${platformName()} sales file does not say how many days it covers, and velocity cannot be computed without that. ` +
          "Type the length of the report's date range into <strong>Sales window (days)</strong> in Settings and the suggestions will appear.",
      }),
    );
  }

  const tables = el("div", { id: "reorderTables" });
  host.append(tables);
  renderReorderTables(tables, result);
  renderVendorSettings(host, result);
}

/* ---------------- purchase orders ---------------- */
const PO_HEADERS = ["Vendor", "SKU", "Barcode", "Product", "Order quantity", "Unit cost", "Extended cost"];
const poRecord = (vendor, l) => ({
  Vendor: vendor,
  SKU: l.sku,
  Barcode: l.barcode,
  Product: l.title || l.handle,
  "Order quantity": l.suggestedQty,
  "Unit cost": l.unitCost ?? "",
  "Extended cost": l.extendedCost ?? "",
});

function poCsv(group) {
  return toCsv(PO_HEADERS, group.lines.map((l) => poRecord(group.vendor, l)));
}

function locationLabel() {
  if (!platform()?.hasLocations) return "";
  return state.location === "__all__" ? "all locations" : state.location ?? "";
}

function renderPo(host) {
  const { suggestions } = compute();
  const groups = groupByVendor(suggestions);
  host.replaceChildren();
  if (groups.length === 0) {
    host.append(el("div", { class: "empty", text: "Nothing needs ordering with the current settings." }));
    return;
  }
  host.append(
    el("div", { class: "rowbar noprint" }, [
      paidBtn("Print all", () => window.print(), { primary: true }),
      paidBtn("Download all as CSV", () => {
        const records = groups.flatMap((g) => g.lines.map((l) => poRecord(g.vendor, l)));
        download(`purchase-orders-${todayIso()}.csv`, toCsv(PO_HEADERS, records));
      }),
      el("span", { class: "note", text: plural(groups.length, "vendor") }),
    ]),
  );

  for (const g of groups) {
    const table = el("table", { class: "data" });
    table.append(el("thead", {}, el("tr", {}, [
      el("th", { text: "SKU" }), el("th", { text: "Product" }),
      el("th", { class: "n", text: "Qty" }), el("th", { class: "n", text: "Unit cost" }), el("th", { class: "n", text: "Extended" }),
    ])));
    const tb = el("tbody");
    for (const l of g.lines) {
      tb.append(el("tr", {}, [
        el("td", { class: "sku", text: l.sku || "—" }),
        el("td", { text: l.title || l.handle }),
        el("td", { class: "n", text: String(l.suggestedQty) }),
        el("td", { class: "n", text: l.unitCost === null ? "—" : fmtMoney(l.unitCost) }),
        el("td", { class: "n", text: l.extendedCost === null ? "—" : fmtMoney(l.extendedCost) }),
      ]));
    }
    table.append(tb);
    table.append(el("tfoot", {}, el("tr", {}, [
      el("td", { colspan: "2", text: plural(g.lines.length, "line") }),
      el("td", { class: "n", text: String(g.totalUnits) }),
      el("td", { class: "n", text: "" }),
      el("td", { class: "n", text: g.costKnown ? fmtMoney(g.totalCost) : `${fmtMoney(g.totalCost)} + unknown` }),
    ])));

    const loc = locationLabel();
    const po = el("div", { class: "po" }, [
      el("h3", { text: g.vendor }),
      el("div", { class: "meta", text: `Purchase order · ${todayIso()}${loc ? ` · ${loc}` : ""}` }),
      el("div", { class: "tablewrap" }, table),
      g.costKnown ? null : el("div", { class: "warnbox noprint", text: "Some lines have no cost in the products file, so this total is only the part that is known." }),
      el("div", { class: "rowbar noprint" }, [paidBtn("Download this order as CSV", () => download(`po-${g.vendor.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${todayIso()}.csv`, poCsv(g)))]),
    ]);
    host.append(po);
  }
}

/* ---------------- labels ---------------- */
function renderLabels(host) {
  const { suggestions, noSales } = compute();
  host.replaceChildren();

  const all = [...suggestions, ...noSales];
  const source = $("labelSource")?.value ?? "order";
  const chosen = source === "order" ? suggestions.filter((s) => s.suggestedQty > 0) : all;
  const perItem = source === "order";

  const controls = el("div", { class: "panel controls noprint" }, [
    el("h2", { text: "Label sheet" }),
    el("div", { class: "settings" }, [
      el("div", { class: "field" }, [
        el("label", { for: "labelSource", text: "Print labels for" }),
        el("select", { id: "labelSource", onchange: () => render() }, [
          el("option", { value: "order", text: "what is on the purchase orders", selected: source === "order" }),
          el("option", { value: "all", text: "everything shown", selected: source === "all" }),
        ]),
      ]),
      el("div", { class: "field" }, [
        el("label", { for: "labelCopies", text: "Copies" }),
        el("select", { id: "labelCopies", onchange: () => render() }, [
          el("option", { value: "1", text: "one per product" }),
          el("option", { value: "qty", text: "one per unit ordered", selected: perItem }),
        ]),
      ]),
    ]),
    el("div", { class: "rowbar" }, [paidBtn("Print labels", () => window.print(), { primary: true })]),
    el("p", { class: "note", text: "Labels are 50 × 25 mm, Code 128. Print at 100% scale with no page scaling, then check one against a scanner before running a whole roll." }),
  ]);
  host.append(controls);

  const copiesMode = $("labelCopies")?.value ?? (perItem ? "qty" : "1");
  const sheet = el("div", { class: "labels" });
  let drawn = 0;
  let unprintable = 0;
  const CAP = 400;
  for (const row of chosen) {
    const code = row.barcode || row.sku;
    if (!code || !encodable(code)) {
      unprintable += 1;
      continue;
    }
    const copies = copiesMode === "qty" ? Math.max(1, row.suggestedQty || 1) : 1;
    for (let i = 0; i < copies && drawn < CAP; i++) {
      sheet.append(
        el("div", { class: "label" }, [
          el("div", { class: "lt", text: row.title || row.handle }),
          el("div", { html: toSvg(code, { moduleWidth: 1, height: 40 }) }),
          el("div", { class: "lb", text: code }),
        ]),
      );
      drawn += 1;
    }
    if (drawn >= CAP) break;
  }

  if (drawn === 0) {
    host.append(el("div", { class: "empty", text: "No printable barcodes. Load a products file so each SKU has a barcode, or select 'everything shown'." }));
    return;
  }
  if (drawn >= CAP) host.append(el("div", { class: "warnbox noprint", text: `Showing the first ${CAP} labels so the page stays responsive. Narrow the filter to print the rest.` }));
  if (unprintable) host.append(el("div", { class: "warnbox noprint", text: `${plural(unprintable, "item")} ${unprintable === 1 ? "has" : "have"} no barcode or SKU, or ${unprintable === 1 ? "contains" : "contain"} characters Code 128 subset B cannot encode, and ${unprintable === 1 ? "was" : "were"} skipped rather than printed wrong.` }));
  host.append(sheet);
}

/* ---------------- stock count ---------------- */
function parseCounts(text) {
  const counts = new Map();
  const bad = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // "SKU,12" or "SKU 12" or "SKU<tab>12"; a bare SKU counts as one scan and accumulates
    const m = /^(.*?)[\s,;\t]+(-?\d+(?:\.\d+)?)$/.exec(t);
    if (m) {
      const key = m[1].trim();
      if (!key) {
        bad.push(t);
        continue;
      }
      counts.set(key, (counts.get(key) ?? 0) + Number(m[2]));
    } else if (!/[\s,;\t]/.test(t)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    } else {
      bad.push(t);
    }
  }
  return { counts, bad };
}

function renderCount(host) {
  host.replaceChildren();
  host.append(
    el("div", { class: "panel controls noprint" }, [
      el("h2", { text: "Stock count" }),
      el("p", { class: "note", text: "Scan or type one item per line. A bare code counts as one and repeats add up; 'SKU 12' or 'SKU,12' sets a quantity directly." }),
      el("textarea", {
        id: "countpaste",
        placeholder: "MUG-L 12\nBOWL,4\n5012345678900",
        oninput: (e) => {
          const { counts } = parseCounts(e.target.value);
          state.counts = counts;
          renderVariance($("varianceHost"));
        },
      }),
    ]),
  );
  host.append(el("div", { id: "varianceHost" }));
  renderVariance($("varianceHost"));
}

function renderVariance(host) {
  if (!host) return;
  host.replaceChildren();
  if (state.counts.size === 0) {
    host.append(el("div", { class: "empty", text: "Nothing counted yet." }));
    return;
  }
  const v = variance(currentRows(), state.counts);
  const wb = platform()?.writeback;
  host.append(
    el("div", { class: "rowbar" }, [
      el("span", { class: "note", text: `${v.rows.length} matched · ${v.changed} changed · net ${v.net >= 0 ? "+" : ""}${v.net}` }),
      paidBtn(wb?.label ?? "Download writeback", () => downloadWriteback(v.rows), { primary: true }),
    ]),
  );
  if (v.unmatchedKeys.length) {
    host.append(el("div", { class: "warnbox errbox", text: `Not found in this location's stock levels: ${v.unmatchedKeys.slice(0, 25).join(", ")}${v.unmatchedKeys.length > 25 ? ` and ${v.unmatchedKeys.length - 25} more` : ""}` }));
  }
  if (wb?.importNote) host.append(el("div", { class: "warnbox", text: wb.importNote }));

  const t = el("table", { class: "data" });
  t.append(el("thead", {}, el("tr", {}, [
    el("th", { text: "Code" }), el("th", { text: "Product" }), el("th", { text: "Bin" }),
    el("th", { class: "n", text: platformName() }), el("th", { class: "n", text: "Counted" }), el("th", { class: "n", text: "Delta" }),
  ])));
  const tb = el("tbody");
  for (const r of v.rows) {
    tb.append(el("tr", {}, [
      el("td", { class: "sku", text: r.key }),
      el("td", { text: r.title || r.handle }),
      el("td", { class: "muted", text: r.bin || "—" }),
      el("td", { class: "n", text: fmtQty(r.onHandCurrent) }),
      el("td", { class: "n", text: fmtQty(r.countedQty) }),
      el("td", { class: "n" + (r.delta ? " low" : " muted"), text: r.delta === null ? "—" : `${r.delta > 0 ? "+" : ""}${r.delta}` }),
    ]));
  }
  t.append(tb);
  host.append(el("div", { class: "tablewrap" }, t));
}

/* ---------------- receiving (Plus) ---------------- */
function renderReceiving(host) {
  host.replaceChildren();
  if (!isPlus()) {
    host.append(
      el("div", { class: "panel" }, [
        el("h2", { text: "Receiving" }),
        el("p", {
          html:
            "When a delivery arrives, scan or type the items against the purchase order and see, line by line, what was ordered, " +
            "what has come so far, and the cost, price and margin of each line with a running total. When the delivery is checked off, " +
            `download the same ${platformName()} import the stock count produces, with each line's on-hand quantity raised by what arrived.`,
        }),
        el("p", { class: "note", text: "Part of the Plus licence, together with per-vendor lead time and target cover." }),
        el("div", { class: "rowbar" }, [el("button", { class: "btn primary", type: "button", text: "See the Plus licence", onclick: () => showTab("licence") })]),
      ]),
    );
    return;
  }

  const { suggestions } = compute();
  const groups = groupByVendor(suggestions);
  const chosenVendor = state.receiving.vendor;
  const lines = groups.filter((g) => chosenVendor === "__all__" || g.vendor === chosenVendor).flatMap((g) => g.lines);

  host.append(
    el("div", { class: "panel controls noprint" }, [
      el("h2", { text: "Receiving" }),
      el("div", { class: "settings" }, [
        el("div", { class: "field" }, [
          el("label", { for: "receivingVendor", text: "Purchase order" }),
          el("select", {
            id: "receivingVendor",
            onchange: (e) => {
              state.receiving.vendor = e.target.value;
              render();
            },
          }, [
            el("option", { value: "__all__", text: "all vendors", selected: chosenVendor === "__all__" }),
            ...groups.map((g) => el("option", { value: g.vendor, text: `${g.vendor} · ${plural(g.lines.length, "line")}`, selected: chosenVendor === g.vendor })),
          ]),
        ]),
      ]),
      el("p", { class: "note", text: "Scan or type one item per line as it comes off the pallet. A bare code counts as one and repeats add up; 'SKU 12' sets a quantity directly." }),
      el("textarea", {
        id: "receivingPaste",
        placeholder: "5012345678900\n5012345678900\nMUG-L 12",
        oninput: (e) => {
          state.receiving.counts = parseCounts(e.target.value).counts;
          renderReceivingTable($("receivingHost"), lines);
        },
      }),
    ]),
  );
  const textarea = host.querySelector("#receivingPaste");
  if (textarea && state.receiving.counts.size) {
    textarea.value = [...state.receiving.counts].map(([k, q]) => `${k} ${q}`).join("\n");
  }
  host.append(el("div", { id: "receivingHost" }));
  renderReceivingTable($("receivingHost"), lines);
}

function renderReceivingTable(host, lines) {
  if (!host) return;
  host.replaceChildren();
  if (lines.length === 0) {
    host.append(el("div", { class: "empty", text: "Nothing is on order with the current settings. The receiving list is built from the purchase orders on the Reorder tab." }));
    return;
  }
  const r = receive(lines, state.receiving.counts);
  const wb = platform()?.writeback;
  host.append(
    el("div", { class: "rowbar" }, [
      el("span", {
        class: "note",
        text:
          `${plural(r.totals.units, "unit")} received on ${r.totals.linesReceived} of ${plural(lines.length, "line")} · ${r.totals.linesComplete} complete · ` +
          `cost so far ${fmtMoney(r.totals.cost)}${r.totals.costKnown ? "" : " + unknown"}`,
      }),
      el("button", {
        class: "btn primary",
        type: "button",
        text: wb?.label ?? "Download writeback",
        onclick: () => {
          const rv = receivingVariance(r.rows, currentRows());
          if (rv.rows.length === 0) {
            alert("Nothing has been received yet, or none of the received lines could be matched to a stock row with a known quantity.");
            return;
          }
          downloadWriteback(rv.rows);
        },
      }),
    ]),
  );
  if (r.unmatchedKeys.length) {
    host.append(el("div", { class: "warnbox errbox", text: `Not on this purchase order: ${r.unmatchedKeys.slice(0, 25).join(", ")}${r.unmatchedKeys.length > 25 ? ` and ${r.unmatchedKeys.length - 25} more` : ""}` }));
  }
  if (r.totals.units > 0) {
    const rv = receivingVariance(r.rows, currentRows());
    if (rv.noCurrent.length) host.append(el("div", { class: "warnbox", text: `${plural(rv.noCurrent.length, "line")} ${rv.noCurrent.length === 1 ? "has" : "have"} no readable current quantity in the stock levels, so ${rv.noCurrent.length === 1 ? "it" : "they"} cannot be added to and will be left out of the download.` }));
    if (rv.noRow.length) host.append(el("div", { class: "warnbox", text: `${plural(rv.noRow.length, "line")} ${rv.noRow.length === 1 ? "is" : "are"} not in the stock levels for this location and will be left out of the download.` }));
  }
  host.append(el("div", { class: "warnbox", text: `The download raises each received line's quantity by what arrived: on hand (new) = on hand (current) + received. ${wb?.importNote ?? ""}` }));

  const t = el("table", { class: "data" });
  t.append(el("thead", {}, el("tr", {}, [
    el("th", { text: "Code" }), el("th", { text: "Product" }), el("th", { text: "Vendor" }),
    el("th", { class: "n", text: "Ordered" }), el("th", { class: "n", text: "Received" }), el("th", { class: "n", text: "To come" }),
    el("th", { class: "n", text: "Unit cost" }), el("th", { class: "n", text: "Price" }), el("th", { class: "n", text: "Margin" }), el("th", { class: "n", text: "Margin %" }),
    el("th", { class: "n", text: "Cost received" }),
  ])));
  const tb = el("tbody");
  for (const row of r.rows) {
    tb.append(el("tr", {}, [
      el("td", { class: "sku", text: row.code || "—" }),
      el("td", { text: row.title || row.handle }),
      el("td", { class: row.vendor ? "" : "muted", text: row.vendor || "no vendor" }),
      el("td", { class: "n", text: String(row.ordered) }),
      el("td", { class: "n" + (row.received ? " low" : " muted"), text: String(row.received) }),
      el("td", { class: "n" + (row.over ? " over" : " muted"), text: row.over ? `+${row.over} over` : String(row.remaining) }),
      el("td", { class: "n", text: row.unitCost === null ? "—" : fmtMoney(row.unitCost) }),
      el("td", { class: "n", text: row.unitPrice === null ? "—" : fmtMoney(row.unitPrice) }),
      el("td", { class: "n", text: row.margin === null ? "—" : fmtMoney(row.margin) }),
      el("td", { class: "n", text: row.marginPct === null ? "—" : `${row.marginPct.toFixed(1)}%` }),
      el("td", { class: "n", text: row.extendedCost === null ? "—" : fmtMoney(row.extendedCost) }),
    ]));
  }
  t.append(tb);
  t.append(el("tfoot", {}, el("tr", {}, [
    el("td", { colspan: "3", text: plural(lines.length, "line") }),
    el("td", { class: "n", text: String(lines.reduce((s, l) => s + (l.suggestedQty ?? 0), 0)) }),
    el("td", { class: "n", text: String(r.totals.units) }),
    el("td", { colspan: "5", text: "" }),
    el("td", { class: "n", text: r.totals.costKnown ? fmtMoney(r.totals.cost) : `${fmtMoney(r.totals.cost)} + unknown` }),
  ])));
  host.append(el("div", { class: "tablewrap" }, t));
  if (!r.totals.costKnown) host.append(el("div", { class: "warnbox noprint", text: "Some received lines have no cost in the products file, so the total is only the part that is known." }));
}

/* ---------------- licence ---------------- */
function renderLicence(host) {
  host.replaceChildren();
  const input = el("input", { type: "text", id: "licenceKey", placeholder: "paste your licence key", style: "min-width:320px" });
  const msg = el("p", { class: "note" });
  const tierName = state.tier === "plus" ? "Plus" : "Standard";
  const tiers = el("div", { class: "tiers" }, [
    el("div", { class: "tier" + (state.licensed && state.tier === "standard" ? " current" : "") }, [
      el("h3", { text: "Standard" }),
      el("div", { class: "price", text: "$39/month · $390/year" }),
      el("ul", {}, [
        el("li", { text: "Print and export purchase orders, one per vendor, with costs and totals" }),
        el("li", { text: "Print Code 128 barcode labels from an order or a selection" }),
        el("li", { text: "Download the stock-count writeback your platform imports" }),
      ]),
    ]),
    el("div", { class: "tier" + (state.licensed && state.tier === "plus" ? " current" : "") }, [
      el("h3", { text: "Plus" }),
      el("div", { class: "price", text: "$79/month · $790/year" }),
      el("ul", {}, [
        el("li", { text: "Everything in Standard" }),
        el("li", { text: "Receiving: check deliveries in against a purchase order, with cost, price and margin per line, and write the arrivals back" }),
        el("li", { text: "Per-vendor lead time and target cover, overriding the global settings" }),
      ]),
    ]),
  ]);
  host.append(
    el("div", { class: "panel" }, [
      el("h2", { text: state.licensed ? `${tierName} licence active` : "Licence" }),
      state.licensed
        ? el("p", { class: "note", text: `${tierName} features are unlocked on this device. The key is stored in this browser only.` })
        : el("p", {
            html:
              "Reorder suggestions, the stock count and the variance table are free and always will be. " +
              "A licence unlocks the things that leave the screen; the tier is read from the key.",
          }),
      tiers,
      state.licensed
        ? el("div", { class: "rowbar" }, [
            el("button", {
              class: "btn", type: "button", text: "Remove licence from this browser",
              onclick: () => { licence.forget(); state.licensed = false; state.tier = null; render(); },
            }),
            state.tier === "plus" ? null : el("a", { class: "btn", href: PLUS_BUY_URL, target: "_blank", rel: "noopener", text: "Upgrade to Plus" }),
          ])
        : el("div", { class: "rowbar" }, [
            input,
            el("button", {
              class: "btn primary", type: "button", text: "Activate",
              onclick: async () => {
                msg.textContent = "checking…";
                const r = await licence.activate(input.value);
                if (r.ok) { state.licensed = true; state.tier = licence.tier(input.value); render(); }
                else msg.textContent = r.reason;
              },
            }),
            el("a", { class: "btn", href: BUY_URL, target: "_blank", rel: "noopener", text: "Buy Standard" }),
            el("a", { class: "btn", href: PLUS_BUY_URL, target: "_blank", rel: "noopener", text: "Buy Plus" }),
          ]),
      msg,
      el("p", { class: "note", text: "The key is checked once a day. If you are offline the last check stands for 30 days, so a count in a stockroom with no signal is never blocked. One licence covers a set number of devices; remove it here to free a slot before moving to another machine. Annual plans are the monthly price with two months free." }),
    ]),
  );
}

/* ---------------- shell ---------------- */
function showTab(name) {
  state.tab = name;
  for (const btn of document.querySelectorAll("#tabs button")) {
    btn.setAttribute("aria-selected", String(btn.dataset.panel === name));
  }
  for (const p of document.querySelectorAll(".tabpanel")) p.hidden = p.id !== `panel-${name}`;
  render();
}

function renderLocations() {
  const sel = $("location");
  const field = $("locationField");
  if (!sel || !state.inventory) return;
  if (!platform()?.hasLocations) {
    if (field) field.hidden = true;
    state.location = null;
    return;
  }
  if (field) field.hidden = false;
  const locs = state.inventory.locations;
  if (sel.dataset.filled === String(locs.length) && sel.value) return;
  sel.replaceChildren();
  if (locs.length > 1) sel.append(el("option", { value: "__all__", text: "All locations" }));
  for (const l of locs) sel.append(el("option", { value: l, text: l || "(unnamed)" }));
  sel.dataset.filled = String(locs.length);
  state.location = sel.value || locs[0] || null;
}

function renderWindowNote() {
  const o = state.orders;
  const w = effectiveWindow();
  const field = $("windowField");
  if (field) field.hidden = !(o && o.days === null);
  const note = $("windowNote");
  if (!o) {
    note.textContent = "No sales file loaded, so there are no reorder suggestions yet.";
  } else if (o.days !== null) {
    note.textContent =
      `Sales window: ${o.days} days${o.from ? `, ${new Date(o.from).toISOString().slice(0, 10)} to ${new Date(o.to).toISOString().slice(0, 10)}` : ""}. ` +
      `${o.skippedUnpaid ? `${plural(o.skippedUnpaid, "refunded or voided line")} excluded. ` : ""}Every suggestion below is scaled from this window.`;
  } else if (w !== null) {
    note.textContent = `Sales window: ${w} days, typed in, because the ${platformName()} report does not carry its date range. Every suggestion below is scaled from it.`;
  } else {
    note.textContent = `The ${platformName()} report does not say how many days it covers. Type the length of its date range into Sales window (days) above; nothing is computed until then.`;
  }
  const notes = $("fileNotes");
  if (notes) {
    notes.replaceChildren();
    for (const n of state.notes) notes.append(el("div", { text: n }));
    notes.hidden = state.notes.length === 0;
  }
}

function render() {
  const ready = Boolean(state.inventory);
  $("settingsPanel").hidden = !ready;
  $("tabs").hidden = !ready;
  if (!ready) {
    for (const p of document.querySelectorAll(".tabpanel")) p.hidden = true;
    const notes = $("fileNotes");
    if (notes) {
      notes.replaceChildren(...state.notes.map((n) => el("div", { text: n })));
      notes.hidden = state.notes.length === 0;
    }
    return;
  }
  renderLocations();
  renderWindowNote();

  const host = $(`panel-${state.tab}`);
  host.hidden = false;
  if (state.tab === "reorder") renderReorder(host);
  else if (state.tab === "po") renderPo(host);
  else if (state.tab === "labels") renderLabels(host);
  else if (state.tab === "count") renderCount(host);
  else if (state.tab === "receiving") renderReceiving(host);
  else if (state.tab === "licence") renderLicence(host);
}

const SAMPLES = {
  shopify: { button: "sampleBtn", files: ["inventory.csv", "orders.csv", "products.csv"], windowDays: null },
  // the WooCommerce analytics report does not carry its range; the sample was generated over 60 days
  woocommerce: { button: "sampleWooBtn", files: ["woo-products-export.csv", "woo-products-report.csv"], windowDays: 60 },
};

async function loadSample(which) {
  const s = SAMPLES[which];
  const btn = $(s.button);
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "loading…";
  try {
    for (const name of s.files) {
      const res = await fetch(`sample/${name}`);
      if (!res.ok) throw new Error(`sample/${name} returned ${res.status}`);
      const text = await res.text();
      await acceptFile(new File([text], `sample-${name}`, { type: "text/csv" }));
    }
    if (s.windowDays && state.orders && state.orders.days === null) {
      state.windowOverride = s.windowDays;
      $("windowDays").value = String(s.windowDays);
      state.notes = [...state.notes, `Sales window set to ${s.windowDays} days for the sample; a real report needs you to type its range.`];
      render();
    }
    btn.textContent = "sample loaded";
    for (const other of Object.values(SAMPLES)) {
      if (other.button !== s.button) {
        const b = $(other.button);
        b.disabled = false;
        b.textContent = b.dataset.label ?? b.textContent;
      }
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    setSlotState("inventory", `could not load the sample: ${e.message}`, true);
  }
}

function wireControls() {
  for (const [which, s] of Object.entries(SAMPLES)) {
    const b = $(s.button);
    b.dataset.label = b.textContent;
    b.addEventListener("click", () => loadSample(which));
  }
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-panel]");
    if (b) showTab(b.dataset.panel);
  });
  $("location").addEventListener("change", (e) => {
    state.location = e.target.value;
    render();
  });
  for (const [id, key] of [["leadTime", "leadTimeDays"], ["safetyDays", "safetyDays"], ["targetCover", "targetCoverDays"]]) {
    $(id).addEventListener("input", (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v >= 0) {
        state.settings = { ...state.settings, [key]: v };
        render();
      }
    });
  }
  $("windowDays").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    state.windowOverride = e.target.value !== "" && Number.isFinite(v) && v >= 1 ? Math.round(v) : null;
    render();
  });
  let t;
  $("search").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.search = e.target.value;
      render();
    }, 120);
  });
  $("themeBtn").addEventListener("click", () => {
    const r = document.documentElement;
    const cur = r.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : cur === "light" ? "dark" : matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark";
    r.setAttribute("data-theme", next);
    try {
      localStorage.setItem("stockproof.theme", next);
    } catch {
      /* private browsing */
    }
  });
}

async function init() {
  wireFiles();
  wireControls();
  const st = await licence.status().catch(() => ({ licensed: false, tier: null }));
  state.licensed = Boolean(st.licensed);
  state.tier = st.tier ?? null;
  render();
}

init();
