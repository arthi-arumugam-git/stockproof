# stockproof

**Reorder suggestions, purchase orders, barcode labels, stock counts and receiving for Shopify and WooCommerce — in your browser, from your CSV exports.**

Shopify retired **Stocky** on 31 August 2026. stockproof does the things the merchants it stranded said they missed most, and it does them without ever seeing your store. It reads the same CSV files WooCommerce exports too.

→ **[arthi-arumugam-git.github.io/stockproof](https://arthi-arumugam-git.github.io/stockproof)** · there is a sample dataset for each platform on the page, so you can watch the whole thing work before exporting anything real.

## Why it is a page and not an app

Three routes to Shopify merchants were checked against Shopify's own documentation on 2026-09-02:

| route | verdict |
|---|---|
| Merchant generates an Admin API token | Dead. *"You can no longer create new admin-created custom apps."* |
| Custom distribution app | *"Installed on a single Shopify store…"* — cannot be sold to many merchants. |
| Public app in the App Store | Works, but review is currently reported at 30 days to 4 months. |

Meanwhile the CSV exports every merchant already uses round-trip perfectly, and the inventory file is re-importable with Shopify's own safety validation intact. So stockproof reads those files locally. **Nothing is uploaded.** The only network request the page ever makes is a licence check, and it carries a licence key and nothing else.

That is not just a workaround — for inventory data it is the better answer. You are not granting a stranger's app permanent read-write access to your store.

## Platforms

A dropped file is recognised by its columns, whichever platform it came from, and the status line says which platform and which file it read. Every column name comes from the platform's own documentation, fetched on 2026-09-02.

| platform | stock levels | sales | product details | writeback |
|---|---|---|---|---|
| **Shopify** | Products → Inventory → Export | Orders → Export (the window is read from the dates in the file) | Products → Export: vendor, cost, price, barcode | inventory CSV with `On hand (new)` filled, `On hand (current)` kept |
| **WooCommerce** | Products → Export, or Analytics → Stock → Download | Analytics → Products (or Variations) → Download | the same Products → Export file: price only | product CSV with `ID, Type, SKU, Name, Parent` copied from the export and `Stock` set; import it with *Update existing products* ticked |

WooCommerce specifics, all from woocommerce.com's documentation:

- The Analytics → Products download gives **both** current stock and units sold in one file, but it does not say how long its date range was, and it lists only products that sold. A **Sales window (days)** field appears when a sales file cannot state its own window, and nothing is computed until it is filled in.
- Core WooCommerce's product CSV schema has **no cost, vendor or barcode column**. Purchase-order totals are marked partial, lines group under "(no vendor)", and labels print the SKU. If the Cost of Goods extension is installed and the export includes custom meta, its `meta:_wc_cog_cost` column is read as the cost.
- `N/A`, a blank, and `parent` in a stock column all read as **unknown**, never as zero.

**Etsy and Square: next.** Their help pages name the downloads but not the columns, and this codebase does not implement a format it could not verify. They will be added when the column documentation can be read.

## What it does

**Free**

- **Reorder suggestions.** Sales velocity, days of cover, reorder point and a suggested quantity per SKU, grouped by vendor. Hover any number to see the inputs that produced it.
- **Stock count with a variance preview.** Scan or type codes; see what differs from your platform before anything is committed.

**Licensed**

| | Standard · $39/month or $390/year | Plus · $79/month or $790/year |
|---|---|---|
| Purchase orders: one printable page per vendor with cost, quantity, extended cost and a total, and a CSV | ✓ | ✓ |
| Barcode labels: Code 128 SVG label sheets, 50 × 25 mm, from a purchase order or a selection | ✓ | ✓ |
| Writeback: the import file your platform accepts, with the count applied | ✓ | ✓ |
| **Receiving:** check a delivery in against a purchase order — per line, ordered, received so far, cost, price and margin (as money and as a share of price), with a running total; then the same writeback with each line raised by what arrived | | ✓ |
| **Per-vendor lead time and target cover**, overriding the global settings for that vendor's rows, kept in your browser | | ✓ |

Annual plans are the monthly price with two months free. The tier is read from the licence key, so a Standard key keeps everything it has today.

## The arithmetic, stated plainly

For each SKU with at least one sale in the loaded window:

```
velocity     = units sold in window / days in window
daysOfCover  = available / velocity
reorderPoint = velocity × (leadTime + safety)
suggestedQty = max(0, ceil(velocity × (leadTime + targetCover) − available − incoming))
```

`incoming` comes from the inventory export, so stock already on its way is never ordered twice. `leadTime` and `targetCover` are the global settings, or the vendor's own when a Plus licence has set them. A SKU with no sales, or with no readable quantity, gets a stated reason and is listed separately — it is never quietly treated as zero.

Receiving: `margin = price − cost`, `margin % = margin / price`, `cost received = cost × received`, and the writeback is `on hand (new) = on hand (current) + received`. Any of those with a missing input shows "—" and marks the total partial.

## Things it refuses to guess

This is the whole design principle, so it is worth listing:

- `not stocked`, `N/A`, `parent` or a blank in a stock column reads as **unknown**, not as 0.
- A sales file that does not say how many days it covers gets **no velocity** until the merchant types the window in.
- A product with no cost gets a blank extended cost, and its vendor total is marked as partial. A missing price gives a blank margin.
- A code it cannot encode as Code 128 is **skipped and reported**, never printed wrong.
- When "all locations" is selected, per-location rows are **added up first**, because sales figures are store-wide and matching them against one location's stock would order the same thing twice.
- If the sales file loads but nothing matches the stock levels, it says the join failed rather than reporting that everything has no sales.
- A received line whose current on-hand figure is unknown is **left out of the writeback**, not written as if it had started at zero.
- A file from a second platform clears the first platform's files rather than mixing them.
- Etsy and Square are not read at all, because their columns could not be verified.

## Development

```
npm install
npm test        # 118 tests, no browser needed
npm run serve   # http://localhost:8099
./release.sh 0.2.0   # bumps the cache-busting version on every asset, then runs the tests
```

No build step and no runtime dependencies. The same ES modules run in the browser and under vitest.

```
site/js/platforms/index.js       registry: detectFile(headers) loops over the platforms
site/js/platforms/columns.js     header matching shared by every reader
site/js/platforms/shopify.js     Shopify adapter over site/js/shopify.js
site/js/platforms/woocommerce.js WooCommerce readers and writeback, with the documentation quoted
site/js/receiving.js             receiving arithmetic
site/js/vendors.js               per-vendor overrides in localStorage
```

A platform module exports `id, name, hasLocations, guide, labels, detect(headers), read(parsed) → { inventory?, orders?, products?, windowDays?, notes }` and `writeback`. Adding a platform means adding one file and one line in the registry — after reading its documentation.

The Code 128 pattern table is verified structurally by its own tests (107 patterns, each six elements totalling 11 modules, stop seven totalling 13, all unique) because one wrong digit produces a barcode that looks right and will not scan. **Check one printed label against a real scanner before running a whole roll.**

## Author

Arthi Arumugam. Built after reading what merchants actually wrote in the Stocky sunset threads rather than guessing. Not affiliated with Shopify or WooCommerce.

MIT.
