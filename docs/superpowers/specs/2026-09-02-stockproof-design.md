# stockproof — design spec

Date: 2026-09-02. Owner: Arthi Arumugam. Status: direction chosen by Arthi from four evidence-backed options.

## One sentence

Shopify killed Stocky on 31 August 2026; stockproof gives the merchants it stranded the three things they said they miss — reorder suggestions, a real purchase order, and barcode labels — as a browser page that never uploads their data.

## Why this, and why now

Evidence with URLs in `D:\money-scout\research\shopify-pain-points.md` and `willingness-to-pay.md`.

- Shopify's free Stocky app sunset **2026-08-31**, two days before this was written. Community threads about it total over 16,000 views.
- Shopify's native purchase orders are called "a minimal ledger interface"; a merchant writes: *"The banner in Stocky just suggests to utilize Shopify for purchase orders but Shopify does not offer all that Stocky does so that is not an option!"* (18 likes).
- What they name specifically: *"One of the best features of stocky is that you can print dymo barcode labels DIRECTLY from the Purchase orders in stocky"* (6 likes).
- Willingness to pay is explicit: *"Pros- Stocky is free. Cons- Apparently that means they aren't ever going to improve it. I would HAPPILY pay money to use an improved version."*
- Pricing evidence, read carefully: Thrive/Shopventory, the nearest full alternative, is "$59/month" to "$559/month" **and has 105 reviews**, so it is being paid for. A merchant describing a *"tiny business"* already pays *"$35/month for an additional app"* to print labels alone. The "$9.99/month" figure in the research is a labels-only app, and the "$30-$50 a month" complaint was about **currency conversion**, not inventory; neither is a ceiling for a tool that does labels, reorder, purchase orders and stock counts.

## The architectural decision that makes this shippable

Three routes were checked against Shopify's own docs on 2026-09-02:

| route | verdict |
|---|---|
| Admin-created custom app (merchant generates a token) | Dead. *"You can no longer create new admin-created custom apps."* |
| Custom distribution app | *"Installed on a single Shopify store, on multiple stores that belong to the same Plus organization"*. Cannot be sold to many merchants. |
| Public distribution app | Works, but goes through App Store review, currently reported at 30 days to 4 months. |

So an app cannot reach these merchants quickly. But **the CSV exports they already use can**, and they round-trip:

- **Inventory export** columns: `Handle, Title, Location, Bin name, Incoming (not editable), Unavailable (not editable), Committed (not editable), Available (not editable), On hand (current), On hand (new)`. Shopify re-imports this file and *"uses safety validation to prevent accidental overwrites. Your expected inventory levels are compared with current levels before making changes."*
- **Orders export** columns: `Created at, Lineitem quantity, Lineitem name, Lineitem SKU, Lineitem price`.
- **Products export** columns: `URL handle, Title, Vendor, Cost per item` plus the variant SKU and barcode columns.

That is everything a purchase order needs. So stockproof is a **static browser page**: the merchant drags their exports in, the maths runs locally, and they download a purchase order, a sheet of barcode labels, or an inventory CSV that Shopify will accept back. No app review, no OAuth, no server, and — the honest selling point for inventory data — **nothing is uploaded anywhere**.

The `On hand (current)` versus `On hand (new)` pair is the same property that makes this safe to automate at all: the count has to tie out against what Shopify already believes, and any row that does not is shown as a variance before the merchant commits.

## What it does

### Free
- Load inventory, orders and products exports. Everything stays in the tab.
- **Reorder suggestions.** Per SKU: sales velocity over the loaded window, days of cover remaining, suggested order quantity to reach a target cover, grouped by vendor. Rows where the data cannot support a suggestion are labelled, never guessed.
- **Variance preview** for a stock count, on screen.

### Paid, $39/month
- **Purchase order export**: per vendor, with cost, quantity, extended cost and a total, as a printable page and a CSV.
- **Barcode labels**: Code 128 SVG label sheets sized for common label stock, printed from a purchase order or from a selection.
- **Inventory CSV writeback**: a valid Shopify inventory file with `On hand (new)` filled from the count, keeping `On hand (current)` so Shopify's safety validation stays on.

Licence keys come from Dodo Payments, verified through its public endpoint, which needs no API key and works from the browser. The page holds the key in localStorage. Everything paid still runs locally; the key gates the export buttons, not the maths.

## Reorder maths, stated plainly

For each SKU with at least one sale in the window:

```
velocity        = units sold in window / days in window
daysOfCover     = available / velocity
reorderPoint    = velocity * (leadTimeDays + safetyDays)
suggestedQty    = max(0, ceil(velocity * (leadTimeDays + targetCoverDays) - available - incoming))
```

`leadTimeDays`, `safetyDays` and `targetCoverDays` are per-vendor inputs with visible defaults (14, 7, 30). `incoming` comes from the inventory export's `Incoming` column, so stock already on its way is never double-ordered. A SKU with no sales in the window gets no suggestion and is listed separately as "no sales in window" rather than being silently dropped.

Every number displayed shows the inputs that produced it on hover, for the same reason billproof shows its evidence: a merchant ordering stock on this number needs to be able to check it.

## Architecture

Static, no build step, no runtime dependencies. ES modules so the same files are unit-tested in Node and loaded by the browser.

```
site/
  index.html          the app; drag targets, tables, print views
  css/app.css         one stylesheet, light and dark, plus @media print
  js/csv.js           RFC 4180 parser and writer (quoted fields, embedded commas and newlines, CRLF, BOM)
  js/shopify.js       column mapping and detection for the three export types
  js/forecast.js      velocity, cover, reorder point, suggested quantity
  js/barcode.js       Code 128 subset B encoder to SVG (checksum, quiet zones)
  js/licence.js       licence key verification and activation, localStorage, offline grace
  js/app.js           wiring, rendering, print and download
tests/                vitest over js/*.js with fixture CSVs
```

## What it will not do in v0.1

No live Shopify connection, no multi-location transfers, no supplier email, no receiving workflow beyond the count, no forecasting beyond a moving average. Each of those is a reason to buy the next version, and none of them is what the stranded Stocky merchants named first.

## Success criteria

- A Shopify inventory export goes in, a modified inventory CSV comes out, and Shopify accepts it back with safety validation intact.
- A purchase order prints on one page per vendor and its arithmetic is checkable by hand.
- Barcode output scans with a real scanner.
- The page works with no network after first load, and no request carries merchant data.
