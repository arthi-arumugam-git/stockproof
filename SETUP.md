# Going live: what only Arthi can do

The tool is built, tested and deployed at **https://arthi-arumugam-git.github.io/stockproof**. These are the steps that need her accounts, her judgement, or a physical device.

---

## 1. Check one barcode against a real scanner (15 minutes) — do this first

Everything else can be undone. A barcode that does not scan wastes a merchant's roll of labels and their trust, and it is the one thing in this codebase that cannot be verified from a test.

1. Open the site, click **Try the Shopify sample**, go to **Labels**.
2. Print one page at **100% scale**, no "fit to page", no "shrink to fit".
3. Scan any label with a real barcode scanner, or a phone barcode app.
4. It should read back exactly the number printed under the bars, e.g. `5012345670001`.

The Code 128 pattern table is verified structurally by the tests (107 patterns, six elements each totalling 11 modules, stop seven totalling 13, all unique), which catches a mistyped digit. It cannot catch a wrong pattern that happens to still total 11. A single real scan closes that gap.

**If it does not scan, stop and say so** — do not sell the label feature until it does.

---

## 2. Dodo Payments: done on 2026-09-02, one thing left

All four products and both licence-key entitlements exist in **Live Mode** on the `wrong-numbers` Dodo account:

| product | price | product id | entitlement (activations) | checkout |
|---|---|---|---|---|
| stockproof Standard | $39 a month | `pdt_0NmijLgj2xavrtNCK6Kst` | `ent_0NmihTDpEjrjAmgU0BpUl` (2) | https://checkout.dodopayments.com/buy/pdt_0NmijLgj2xavrtNCK6Kst?quantity=1 |
| stockproof Standard, annual | $390 a year | `pdt_0NmijjvKgOb6aqo05nKJo` | same | https://checkout.dodopayments.com/buy/pdt_0NmijjvKgOb6aqo05nKJo?quantity=1 |
| stockproof Plus | $79 a month | `pdt_0NmikQUVcKrpEPiNOqzIt` | `ent_0NmihY0MOiSBwB5LiiJ47` (2) | https://checkout.dodopayments.com/buy/pdt_0NmikQUVcKrpEPiNOqzIt?quantity=1 |
| stockproof Plus, annual | $790 a year | `pdt_0NmilBOPh4sl8jtT8ThpE` | same | https://checkout.dodopayments.com/buy/pdt_0NmilBOPh4sl8jtT8ThpE?quantity=1 |

The Licence tab's four Buy buttons point at those links (`BUY_URL`, `BUY_URL_ANNUAL`, `PLUS_BUY_URL`, `PLUS_BUY_URL_ANNUAL` in `site/js/app.js`). The page reads the tier from the product id that Dodo's activate call returns (`site/js/licence.js`, `PRODUCTS`), because Dodo's licence keys carry **no prefix**; an earlier draft of this file assumed one, and that assumption is gone from the code. A key that is valid but was sold for some other product is refused and its slot handed straight back.

**The one thing left is verification.** Dodo's dashboard says *"Complete verification to activate live payments and payouts. Most reviews finish within 72 hours."* Until it is approved, a merchant can reach the checkout page but the payment will not settle and nothing pays out. Go to **Verification** in the dashboard, choose **Individual**, and finish the identity, PAN and bank steps. This needs your documents and your bank account, so it is yours alone.

## 3. Post where the stranded merchants actually are (30 minutes)

These threads are real, were read during the research, and are the reason this product exists. Reply as yourself, one at a time, with what the tool does rather than a pitch.

- `community.shopify.com/t/stocky-app-going-away-after-august-31-2026/587292` — the main thread. The top post (18 likes) says Shopify's native purchase orders are not a substitute.
- `community.shopify.com/t/why-stocky-should-remain-an-executive-position/587146` — 29 likes.
- `community.shopify.com/t/replacement-to-stocky/587141` — people asking directly for a replacement.
- `community.shopify.com/t/stocky-sunset-why-doesnt-shopify-native-po-have-the-same-functionality/638123`

What to lead with, because it is what they asked for and what nobody else offers: **it prints barcode labels straight from a purchase order, and it never sees your store.** One merchant specifically wrote that printing Dymo labels directly from a Stocky purchase order was one of its best features. The receiving workflow in Plus is the other thing a merchant asked for by name.

Do not post the same text four times. Read each thread and answer the actual question in it.

---

## 4. The WooCommerce path: get one real export through it

The WooCommerce readers were built from woocommerce.com's documentation of the Products report, Variations report, Stock report and the product CSV importer/exporter, and every column name in `site/js/platforms/woocommerce.js` is quoted from those pages. No file from a live WooCommerce store has been through it yet. The first WooCommerce merchant's files are the real test; ask them for the three downloads and, if anything is not recognised, the status line will say what was looked for.

Two things to confirm on a live store, because the documentation describes the report table and says the download is "a CSV copy of the data used in the report":

- that the downloaded CSV's header row matches the table's column names (the readers match case- and punctuation-insensitively, so *Items sold* and *Items Sold* both work);
- that an update import of `ID, Type, SKU, Name, Parent, Stock` with *Update existing products* ticked changes only the stock quantity. The documentation's own partial-column update example is what this relies on.

---

## 5. Later, if it gets traction

- **A Shopify App Store listing.** Public distribution means review, currently reported at 30 days to 4 months, but it is the only route to the store's own search traffic. Worth starting once a few merchants are paying, not before.
- **Etsy and Square.** Their help pages were read on 2026-09-02 and name the downloads without listing the columns, so they were not built. When a real export from either can be read, each is one file under `site/js/platforms/`.
- **Partial deliveries across sessions, and supplier email.** Receiving currently lives in the tab; closing it forgets what has arrived.
- **A domain**, if the GitHub Pages URL starts to look like a limitation.

---

## The one thing not to do

Do not add a "connect your store" button. The moment this tool holds an API token it becomes a thing merchants have to trust with write access to their inventory, it needs a server, it needs App Store review, and it loses the sentence that makes it different: **nothing leaves this tab.**
