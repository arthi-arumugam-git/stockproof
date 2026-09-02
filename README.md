# stockproof

**Reorder suggestions, purchase orders and barcode labels for Shopify — in your browser, from your CSV exports.**

Shopify retired **Stocky** on 31 August 2026. stockproof does the three things the merchants it stranded said they missed most, and it does them without ever seeing your store.

→ **[arthi-arumugam-git.github.io/stockproof](https://arthi-arumugam-git.github.io/stockproof)** · there is a sample dataset on the page, so you can watch the whole thing work before exporting anything real.

## Why it is a page and not an app

Three routes to Shopify merchants were checked against Shopify's own documentation on 2026-09-02:

| route | verdict |
|---|---|
| Merchant generates an Admin API token | Dead. *"You can no longer create new admin-created custom apps."* |
| Custom distribution app | *"Installed on a single Shopify store…"* — cannot be sold to many merchants. |
| Public app in the App Store | Works, but review is currently reported at 30 days to 4 months. |

Meanwhile the CSV exports every merchant already uses round-trip perfectly, and the inventory file is re-importable with Shopify's own safety validation intact. So stockproof reads those files locally. **Nothing is uploaded.** The only network request the page ever makes is a licence check, and it carries a licence key and nothing else.

That is not just a workaround — for inventory data it is the better answer. You are not granting a stranger's app permanent read-write access to your store.

## What it does

**Free**

- **Reorder suggestions.** Sales velocity, days of cover, reorder point and a suggested quantity per SKU, grouped by vendor. Hover any number to see the inputs that produced it.
- **Stock count with a variance preview.** Scan or type codes; see what differs from Shopify before anything is committed.

**Licensed — $39/month**

- **Purchase orders.** One printable page per vendor with cost, quantity, extended cost and a total. Also a CSV.
- **Barcode labels.** Code 128 SVG label sheets, 50 × 25 mm, printed from a purchase order or from a selection.
- **Inventory writeback.** A valid Shopify inventory CSV with `On hand (new)` filled from your count.

## The arithmetic, stated plainly

For each SKU with at least one sale in the loaded window:

```
velocity     = units sold in window / days in window
daysOfCover  = available / velocity
reorderPoint = velocity × (leadTime + safety)
suggestedQty = max(0, ceil(velocity × (leadTime + targetCover) − available − incoming))
```

`incoming` comes from the inventory export, so stock already on its way is never ordered twice. A SKU with no sales, or with no readable quantity, gets a stated reason and is listed separately — it is never quietly treated as zero.

## Things it refuses to guess

This is the whole design principle, so it is worth listing:

- `not stocked` in the available column reads as **unknown**, not as 0.
- A product with no cost gets a blank extended cost, and its vendor total is marked as partial.
- A code it cannot encode as Code 128 is **skipped and reported**, never printed wrong.
- When "all locations" is selected, per-location rows are **added up first**, because sales figures are store-wide and matching them against one location's stock would order the same thing twice.
- If the orders export loads but nothing matches the inventory, it says the join failed rather than reporting that everything has no sales.

## Development

```
npm install
npm test        # 77 tests, no browser needed
npm run serve   # http://localhost:8099
./release.sh 0.1.8   # bumps the cache-busting version on every asset, then runs the tests
```

No build step and no runtime dependencies. The same ES modules run in the browser and under vitest.

The Code 128 pattern table is verified structurally by its own tests (107 patterns, each six elements totalling 11 modules, stop seven totalling 13, all unique) because one wrong digit produces a barcode that looks right and will not scan. **Check one printed label against a real scanner before running a whole roll.**

## Author

Arthi Arumugam. Built after reading what merchants actually wrote in the Stocky sunset threads rather than guessing. Not affiliated with Shopify.

MIT.
