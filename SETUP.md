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

## 2. Create the Dodo Payments products (about 30 minutes)

Gumroad did not work, so both products sell through **Dodo Payments**. It is an Indian company, it is the merchant of record so EU and UK VAT is handled for you, and its FAQ says *"You can onboard as an individual and start receiving international payments without any hassle"*.

Its licence endpoints are public, need no API key, and were verified working **from a browser** on 2026-09-02, which is why this page needs no server of its own.

There are two tiers and two billing periods, so **four products** and **two entitlements**. The tier is carried by the key prefix, not by the product, so a monthly and an annual product of the same tier share one entitlement.

### 2a. Two entitlements

In Dodo, **Entitlements** → **+** → **License Key**, twice:

| | Standard | Plus |
|---|---|---|
| **Prefix** | `STOCKPROOF-` | `STOCKPROOFPLUS-` |
| **Activations limit** | `2` (the shop's back-office machine and a laptop) | `2` |
| **Duration** | blank for a subscription; keys stay valid while it is active and are revoked when it ends | blank |
| **Activation instructions** | `Paste the key into the Licence tab at arthi-arumugam-git.github.io/stockproof` | same |

The prefixes matter. Validate takes only the key, so the prefix is what stops another Dodo merchant's key unlocking this tool, and it is also how the page tells Standard from Plus: `site/js/licence.js` reads `STOCKPROOFPLUS-` as Plus and `STOCKPROOF-` as Standard. Note that `STOCKPROOFPLUS-` does not start with `STOCKPROOF-`, which is deliberate: a Standard key can never be mistaken for Plus.

### 2b. Four products

| product | price | entitlement |
|---|---|---|
| `stockproof Standard` | **$39/month** | Standard |
| `stockproof Standard, annual` | **$390/year** | Standard |
| `stockproof Plus` | **$79/month** | Plus |
| `stockproof Plus, annual` | **$790/year** | Plus |

Annual is the monthly price with two months free, which is the usual shape and is what the README and the Licence tab say.

On the Standard price, read the evidence carefully, because an earlier draft of this file got it wrong. A merchant who describes themselves as a *"tiny business"* wrote: *"We are unable to print labels after receiving products... So we have to pay $35/month for an additional app to do this."* That is money actually being spent, on **labels alone**. stockproof does labels, reorder suggestions, purchase orders and a stock count. Thrive/Shopventory, the nearest full alternative, starts at **$59/month** and has 105 reviews, so merchants do pay it. The *"$9.99"* figure in the research is a labels-only app, and the *"$30-$50 a month"* complaint was about **currency conversion**, not inventory — neither is a ceiling for this. $39 asks about what one merchant already pays for a quarter of the job, and a third less than the obvious alternative.

Plus at $79 is priced above Thrive's entry tier because it carries the thing a merchant asked for by name — receiving against a purchase order, with margin per line — and per-vendor lead times. It is still below Thrive's second tier.

### 2c. Wire the checkout links

Publish, then send Claude the **checkout URLs**. Two constants in `site/js/app.js` take them, one line each:

- `BUY_URL` — the Standard monthly checkout. Until it is set, the button points at the README.
- `PLUS_BUY_URL` — the Plus monthly checkout. Same fallback.

The annual checkouts can be linked from the same buttons' surroundings once they exist; the page currently shows the annual price as text only.

### Test it once

Buy your own Standard licence, paste the key into the **Licence** tab, and check that Print and the CSV downloads unlock, the Licence tab says *Standard licence active*, and the **Receiving** tab still shows the Plus notice. Then buy a Plus licence and check that Receiving and the per-vendor inputs on the Reorder tab unlock. Click **Remove licence** and confirm everything locks again.

---

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
