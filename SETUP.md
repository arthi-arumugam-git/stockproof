# Going live: what only Arthi can do

The tool is built, tested and deployed at **https://arthi-arumugam-git.github.io/stockproof**. These are the steps that need her accounts, her judgement, or a physical device.

---

## 1. Check one barcode against a real scanner (15 minutes) — do this first

Everything else can be undone. A barcode that does not scan wastes a merchant's roll of labels and their trust, and it is the one thing in this codebase that cannot be verified from a test.

1. Open the site, click **Try it with sample data**, go to **Labels**.
2. Print one page at **100% scale**, no "fit to page", no "shrink to fit".
3. Scan any label with a real barcode scanner, or a phone barcode app.
4. It should read back exactly the number printed under the bars, e.g. `5012345670001`.

The Code 128 pattern table is verified structurally by the tests (107 patterns, six elements each totalling 11 modules, stop seven totalling 13, all unique), which catches a mistyped digit. It cannot catch a wrong pattern that happens to still total 11. A single real scan closes that gap.

**If it does not scan, stop and say so** — do not sell the label feature until it does.

---

## 2. Create the Gumroad product (10 minutes)

Same rail as billproof, so this is the second sale on infrastructure that already exists.

1. In Gumroad, new product → **Digital product** (or **Membership** if selling monthly).
   - Name: `stockproof licence`
   - Price: the research says merchants name **$9.99–$50/month** as their ceiling, against Thrive/Shopventory at $59–$559. **$19/month, or $149 once**, sits where they said they would pay.
2. Turn **ON** *Generate a unique licence key per sale*.
3. Copy the **product ID** and the **short URL**.
4. Give both to Claude. Two one-line changes go in: `PRODUCT_ID` in `site/js/licence.js`, and the Buy link in `renderLicence`. Until then the paid buttons say "· licence" and lead to a placeholder.

The licence code already handles refunds, disputes and cancelled subscriptions, and it keeps working offline for 30 days so a count in a stockroom with no signal is never blocked.

---

## 3. Post where the stranded merchants actually are (30 minutes)

These threads are real, were read during the research, and are the reason this product exists. Reply as yourself, one at a time, with what the tool does rather than a pitch.

- `community.shopify.com/t/stocky-app-going-away-after-august-31-2026/587292` — the main thread. The top post (18 likes) says Shopify's native purchase orders are not a substitute.
- `community.shopify.com/t/why-stocky-should-remain-an-executive-position/587146` — 29 likes.
- `community.shopify.com/t/replacement-to-stocky/587141` — people asking directly for a replacement.
- `community.shopify.com/t/stocky-sunset-why-doesnt-shopify-native-po-have-the-same-functionality/638123`

What to lead with, because it is what they asked for and what nobody else offers: **it prints barcode labels straight from a purchase order, and it never sees your store.** One merchant specifically wrote that printing Dymo labels directly from a Stocky purchase order was one of its best features.

Do not post the same text four times. Read each thread and answer the actual question in it.

---

## 4. Later, if it gets traction

- **A Shopify App Store listing.** Public distribution means review, currently reported at 30 days to 4 months, but it is the only route to the store's own search traffic. Worth starting once a few merchants are paying, not before.
- **Receiving workflow**, partial deliveries, and supplier email. Deliberately left out of v0.1; each is a reason to buy the next version.
- **A domain**, if the GitHub Pages URL starts to look like a limitation.

---

## The one thing not to do

Do not add a "connect your Shopify store" button. The moment this tool holds an Admin API token it becomes a thing merchants have to trust with write access to their inventory, it needs a server, it needs App Store review, and it loses the sentence that makes it different: **nothing leaves this tab.**
