/**
 * RFC 4180 CSV parsing and writing.
 *
 * Shopify exports routinely contain quoted fields with embedded commas and newlines (product
 * titles and descriptions), CRLF line endings, and a UTF-8 BOM. A split(",") parser corrupts
 * those rows silently, which is the failure this whole tool exists to avoid, so the parser is
 * a character scanner and it is unit-tested against those exact shapes.
 */

/**
 * Parse CSV text into an array of rows, each an array of strings.
 * Quotes are only special at the start of a field; "" inside a quoted field is a literal quote.
 */
export function parseRows(text) {
  if (typeof text !== "string") throw new TypeError("parseRows expects a string");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  let fieldWasQuoted = false;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      fieldWasQuoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      fieldWasQuoted = false;
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      // a lone \r, a lone \n, or \r\n all end the record
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldWasQuoted = false;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // a trailing newline should not produce a phantom empty record, but a final unterminated
  // field should still be kept
  if (field !== "" || fieldWasQuoted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse CSV into objects keyed by the header row. Duplicate headers keep the first column,
 * because Shopify exports repeat some names and the first is the one merchants mean.
 * Rows shorter than the header are padded; longer rows keep their extra cells under "" keys
 * being dropped, which is deliberate: a ragged row is a sign of a hand-edited file and the
 * caller is told about it through `ragged`.
 */
export function parseCsv(text) {
  const rows = parseRows(text);
  if (rows.length === 0) return { headers: [], records: [], ragged: 0 };
  const headers = rows[0].map((h) => h.trim());
  const seen = new Set();
  const keep = headers.map((h) => {
    if (seen.has(h)) return null;
    seen.add(h);
    return h;
  });
  const records = [];
  let ragged = 0;
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // skip a completely empty trailing line
    if (cells.length === 1 && cells[0] === "") continue;
    if (cells.length !== headers.length) ragged += 1;
    const obj = {};
    for (let c = 0; c < keep.length; c++) {
      if (keep[c] === null) continue;
      obj[keep[c]] = cells[c] === undefined ? "" : cells[c];
    }
    records.push(obj);
  }
  return { headers, records, ragged };
}

/** Quote a single field only when it needs it, the way Shopify's own exports do. */
export function quoteField(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Serialise records back to CSV using an explicit column order, so a file written here can be
 * re-imported by Shopify. CRLF is used because that is what Shopify emits.
 */
export function toCsv(headers, records) {
  const lines = [headers.map(quoteField).join(",")];
  for (const rec of records) {
    lines.push(headers.map((h) => quoteField(rec[h])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Parse a number the way a spreadsheet would, tolerating currency symbols, spaces and thousands separators. */
export function num(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === "") return null;
  const cleaned = s.replace(/[^0-9.,+-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === "+") return null;
  // "1,234.56" -> thousands separator; "1234,56" -> decimal comma
  let normalised = cleaned;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    normalised = lastComma > lastDot ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  } else if (lastComma > -1) {
    // only commas: "1,234" and "1,234,567" are thousands groups; "12,5" is a decimal comma
    normalised = /^[+-]?\d{1,3}(,\d{3})+$/.test(cleaned) ? cleaned.replace(/,/g, "") : cleaned.replace(/,/g, ".");
  }
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}
