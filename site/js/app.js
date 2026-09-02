/**
 * stockproof — wiring.
 *
 * Everything happens in this tab. The only network request the page ever makes is a licence
 * check against Gumroad, and that carries a licence key and nothing else. No merchant data is
 * ever sent anywhere, which is the whole reason this is a page and not an app with Admin API
 * access to someone's store.
 */

import { parseCsv, toCsv } from "./csv.js?v=0.1.5";
import { aggregateLocations, attachProducts, detect, readInventory, readOrders, readProducts } from "./shopify.js?v=0.1.5";
import { DEFAULTS, groupByVendor, suggest, variance, writebackRecords } from "./forecast.js?v=0.1.5";
import { toSvg, encodable } from "./barcode.js?v=0.1.5";
import * as licence from "./licence.js?v=0.1.5";

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

const state = {
  files: { inventory: null, orders: null, products: null },
  inventory: null,
  orders: null,
  products: null,
  location: null,
  settings: { ...DEFAULTS },
  search: "",
  counts: new Map(),
  licensed: false,
  tab: "reorder",
};

/* ---------------- formatting ---------------- */
const fmtQty = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString());
const fmtMoney = (n) => (n === null || n === undefined ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmt1 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(1));
const todayIso = () => new Date().toISOString().slice(0, 10);
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many ?? one + "s"}`;

/* ---------------- file loading ---------------- */
async function loadFile(file) {
  const text = await file.text();
  const parsed = parseCsv(text);
  const det = detect(parsed.headers);
  if (det.kind === "unknown") {
    return { ok: false, reason: "this does not look like a Shopify inventory, orders or products export" };
  }
  return { ok: true, kind: det.kind, parsed, name: file.name };
}

function setSlotState(kind, message, isError) {
  const slot = $(`slot-${kind}`);
  const state_ = $(`state-${kind}`);
  if (!slot || !state_) return;
  state_.textContent = message;
  state_.classList.toggle("err", Boolean(isError));
  slot.classList.toggle("loaded", Boolean(message) && !isError);
}

async function acceptFile(file) {
  const r = await loadFile(file);
  if (!r.ok) {
    // report against whichever slot the user was aiming at; the header sniff is the truth
    setSlotState("inventory", `${file.name}: ${r.reason}`, true);
    return;
  }
  state.files[r.kind] = r.name;
  if (r.kind === "inventory") {
    state.inventory = readInventory(r.parsed);
    const n = state.inventory.rows.length;
    setSlotState("inventory", `${r.name} · ${plural(n, "row")} · ${plural(state.inventory.locations.length, "location")}`);
  } else if (r.kind === "orders") {
    state.orders = readOrders(r.parsed);
    const o = state.orders;
    setSlotState("orders", `${r.name} · ${o.bySku.size.toLocaleString()} SKUs · ${o.days ?? "?"} day window`);
  } else if (r.kind === "products") {
    state.products = readProducts(r.parsed);
    setSlotState("products", `${r.name} · ${state.products.byHandle.size.toLocaleString()} products`);
  }
  render();
}

function wireFiles() {
  for (const kind of ["inventory", "orders", "products"]) {
    $(`file-${kind}`).addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) acceptFile(f);
    });
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
  const loc = state.location;
  if (loc === null || loc === "__all__") return aggregateLocations(enriched);
  return enriched.filter((r) => r.location === loc);
}

function compute() {
  const rows = currentRows();
  const result = suggest({
    inventory: rows,
    salesBySku: state.orders?.bySku ?? new Map(),
    windowDays: state.orders?.days ?? null,
    productsByHandle: state.products?.byHandle ?? new Map(),
    productsBySku: state.products?.bySku ?? new Map(),
    productsByTitle: state.products?.byTitle ?? new Map(),
    settings: state.settings,
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

/* ---------------- reorder panel ---------------- */
function renderReorder(host) {
  const { suggestions, noSales, noData, settings, joinFailed } = compute();
  host.replaceChildren();

  if (joinFailed) {
    host.append(
      el("div", {
        class: "warnbox errbox",
        html:
          "The orders export loaded, but none of its SKUs could be matched to a row in the inventory export. " +
          "Shopify's inventory file has no SKU column, so the two are joined through the <strong>products</strong> " +
          "export. Load that as well and the suggestions will appear. Nothing below is a claim that these products " +
          "have no sales.",
      }),
    );
  }

  if (!state.orders) {
    host.append(
      el("div", {
        class: "warnbox",
        html:
          "Load an <strong>orders</strong> export to get reorder suggestions. Without it stockproof can still " +
          "print labels and run a stock count, but it has no sales history to work from and will not invent one.",
      }),
    );
  }

  const toOrder = suggestions.filter((s) => s.suggestedQty > 0);
  const bar = el("div", { class: "rowbar" }, [
    el("span", { class: "note", text: `${toOrder.length} to order · ${suggestions.length} with sales · ${noSales.length} without · ${noData.length} unreadable` }),
  ]);
  host.append(bar);

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
    const why =
      `${s.unitsSold} sold over ${s.windowDays} days = ${s.velocity.toFixed(3)}/day. ` +
      `Target ${settings.leadTimeDays} lead + ${settings.targetCoverDays} cover = ` +
      `${(s.velocity * (settings.leadTimeDays + settings.targetCoverDays)).toFixed(1)} units, ` +
      `minus ${s.available} available and ${s.incoming} incoming.`;
    body.append(
      el("tr", {}, [
        el("td", { class: "sku", text: s.sku || "—" }),
        el("td", { text: s.title || s.handle }),
        el("td", { class: s.vendor ? "" : "muted", text: s.vendor || "no vendor" }),
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
          `Giving each product a distinct title in Shopify fixes it.`,
      }),
    );
  }

  if (noData.length) {
    host.append(el("div", { class: "warnbox errbox", text: `${plural(noData.length, "row")} had no readable available quantity and ${noData.length === 1 ? "was" : "were"} left out of every calculation.` }));
  }
}

/* ---------------- purchase orders ---------------- */
function poCsv(group) {
  const headers = ["Vendor", "SKU", "Barcode", "Product", "Order quantity", "Unit cost", "Extended cost"];
  const records = group.lines.map((l) => ({
    Vendor: group.vendor,
    SKU: l.sku,
    Barcode: l.barcode,
    Product: l.title || l.handle,
    "Order quantity": l.suggestedQty,
    "Unit cost": l.unitCost ?? "",
    "Extended cost": l.extendedCost ?? "",
  }));
  return toCsv(headers, records);
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
        const all = groups.flatMap((g) => g.lines.map((l) => ({ g, l })));
        const headers = ["Vendor", "SKU", "Barcode", "Product", "Order quantity", "Unit cost", "Extended cost"];
        const records = all.map(({ g, l }) => ({
          Vendor: g.vendor, SKU: l.sku, Barcode: l.barcode, Product: l.title || l.handle,
          "Order quantity": l.suggestedQty, "Unit cost": l.unitCost ?? "", "Extended cost": l.extendedCost ?? "",
        }));
        download(`purchase-orders-${todayIso()}.csv`, toCsv(headers, records));
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

    const po = el("div", { class: "po" }, [
      el("h3", { text: g.vendor }),
      el("div", { class: "meta", text: `Purchase order · ${todayIso()} · ${state.location === "__all__" ? "all locations" : state.location ?? ""}` }),
      el("div", { class: "tablewrap" }, table),
      g.costKnown ? null : el("div", { class: "warnbox noprint", text: "Some lines have no cost in the products export, so this total is only the part that is known." }),
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
    host.append(el("div", { class: "empty", text: "No printable barcodes. Load a products export so each SKU has a barcode, or select 'everything shown'." }));
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
  host.append(
    el("div", { class: "rowbar" }, [
      el("span", { class: "note", text: `${v.rows.length} matched · ${v.changed} changed · net ${v.net >= 0 ? "+" : ""}${v.net}` }),
      paidBtn(
        "Download inventory CSV for Shopify",
        () => {
          try {
            if (v.rows.some((r) => r.aggregated)) {
              alert("Pick a single location before downloading. Shopify's import needs one row per location, and an aggregated count cannot be split back out.");
              return;
            }
            const recs = writebackRecords(v.rows, state.inventory.columns);
            if (recs.length === 0) {
              alert("Nothing differs from Shopify's current quantities, so there is nothing to import.");
              return;
            }
            download(`inventory-count-${todayIso()}.csv`, toCsv(Object.keys(recs[0]), recs));
          } catch (e) {
            alert(String(e.message || e));
          }
        },
        { primary: true },
      ),
    ]),
  );
  if (v.unmatchedKeys.length) {
    host.append(el("div", { class: "warnbox errbox", text: `Not found in this location's inventory: ${v.unmatchedKeys.slice(0, 25).join(", ")}${v.unmatchedKeys.length > 25 ? ` and ${v.unmatchedKeys.length - 25} more` : ""}` }));
  }
  host.append(
    el("div", { class: "warnbox", html: "The download keeps the <code>On hand (current)</code> column, so Shopify's own safety validation still compares against what it believes before applying anything. Only rows that differ are included." }),
  );

  const t = el("table", { class: "data" });
  t.append(el("thead", {}, el("tr", {}, [
    el("th", { text: "Code" }), el("th", { text: "Product" }), el("th", { text: "Bin" }),
    el("th", { class: "n", text: "Shopify" }), el("th", { class: "n", text: "Counted" }), el("th", { class: "n", text: "Delta" }),
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

/* ---------------- licence ---------------- */
function renderLicence(host) {
  host.replaceChildren();
  const input = el("input", { type: "text", id: "licenceKey", placeholder: "paste your licence key", style: "min-width:320px" });
  const msg = el("p", { class: "note" });
  host.append(
    el("div", { class: "panel" }, [
      el("h2", { text: state.licensed ? "Licence active" : "Licence" }),
      state.licensed
        ? el("p", { class: "note", text: "Exports and printing are unlocked on this device. The key is stored in this browser only." })
        : el("p", {
            html:
              "Reorder suggestions, the stock count and the variance table are free and always will be. " +
              "A licence unlocks the three things that leave the screen: printing and exporting purchase orders, " +
              "printing barcode labels, and downloading the inventory CSV that goes back into Shopify.",
          }),
      state.licensed
        ? el("div", { class: "rowbar" }, [
            el("button", {
              class: "btn", type: "button", text: "Remove licence from this browser",
              onclick: () => { licence.forget(); state.licensed = false; render(); },
            }),
          ])
        : el("div", { class: "rowbar" }, [
            input,
            el("button", {
              class: "btn primary", type: "button", text: "Activate",
              onclick: async () => {
                msg.textContent = "checking…";
                const r = await licence.activate(input.value);
                if (r.ok) { state.licensed = true; render(); }
                else msg.textContent = r.reason;
              },
            }),
            el("a", { class: "btn", href: "https://gumroad.com/l/stockproof", target: "_blank", rel: "noopener", text: "Buy a licence" }),
          ]),
      msg,
      el("p", { class: "note", html: "The key is checked with Gumroad once a day. If you are offline the last check stands for 30 days, so a count in a stockroom with no signal is never blocked." }),
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
  if (!sel || !state.inventory) return;
  const locs = state.inventory.locations;
  if (sel.dataset.filled === String(locs.length) && sel.value) return;
  sel.replaceChildren();
  if (locs.length > 1) sel.append(el("option", { value: "__all__", text: "All locations" }));
  for (const l of locs) sel.append(el("option", { value: l, text: l || "(unnamed)" }));
  sel.dataset.filled = String(locs.length);
  state.location = sel.value || locs[0] || null;
}

function render() {
  const ready = Boolean(state.inventory);
  $("settingsPanel").hidden = !ready;
  $("tabs").hidden = !ready;
  if (!ready) {
    for (const p of document.querySelectorAll(".tabpanel")) p.hidden = true;
    return;
  }
  renderLocations();

  const o = state.orders;
  $("windowNote").textContent = o
    ? `Sales window: ${o.days} days${o.from ? `, ${new Date(o.from).toISOString().slice(0, 10)} to ${new Date(o.to).toISOString().slice(0, 10)}` : ""}. ` +
      `${o.skippedUnpaid ? `${plural(o.skippedUnpaid, "refunded or voided line")} excluded. ` : ""}Every suggestion below is scaled from this window.`
    : "No orders export loaded, so there are no reorder suggestions yet.";

  const host = $(`panel-${state.tab}`);
  host.hidden = false;
  if (state.tab === "reorder") renderReorder(host);
  else if (state.tab === "po") renderPo(host);
  else if (state.tab === "labels") renderLabels(host);
  else if (state.tab === "count") renderCount(host);
  else if (state.tab === "licence") renderLicence(host);
}

async function loadSample() {
  const btn = $("sampleBtn");
  btn.disabled = true;
  btn.textContent = "loading…";
  try {
    for (const name of ["inventory.csv", "orders.csv", "products.csv"]) {
      const res = await fetch(`sample/${name}`);
      if (!res.ok) throw new Error(`sample/${name} returned ${res.status}`);
      const text = await res.text();
      await acceptFile(new File([text], `sample-${name}`, { type: "text/csv" }));
    }
    btn.textContent = "sample data loaded";
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Try it with sample data";
    setSlotState("inventory", `could not load the sample: ${e.message}`, true);
  }
}

function wireControls() {
  $("sampleBtn").addEventListener("click", loadSample);
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
  const st = await licence.status().catch(() => ({ licensed: false }));
  state.licensed = Boolean(st.licensed);
  render();
}

init();
