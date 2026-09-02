/**
 * Code 128 subset B encoder, rendered as SVG.
 *
 * Subset B covers ASCII 32-126, which is every character a Shopify SKU or barcode field can
 * hold in practice. Subset C (numeric pairs, half the width) is deliberately not implemented in
 * v0.1: it doubles the state machine and the width saving does not matter on a 50mm label.
 *
 * Structure: start code, data, checksum, stop. The checksum is
 *   (startValue + sum over data of position * value) mod 103, position starting at 1.
 * Every pattern is six alternating bar/space widths totalling 11 modules; the stop pattern is
 * seven elements totalling 13. Those two invariants are asserted in the tests, because a wrong
 * digit in the table below produces a barcode that looks plausible and will not scan.
 */

/** Widths of the 107 patterns, bar-space alternating, starting with a bar. */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
];

export const START_B = 104;
export const STOP = 106;
/** Minimum quiet zone either side, in modules, per the Code 128 specification. */
export const QUIET_MODULES = 10;

/** True when every character can be encoded in subset B. */
export function encodable(text) {
  return typeof text === "string" && [...text].every((c) => {
    const code = c.codePointAt(0);
    return code >= 32 && code <= 126;
  });
}

/**
 * Encode text to the sequence of pattern values, including start, checksum and stop.
 * Throws on characters outside subset B rather than substituting them, because a silently
 * altered barcode is worse than a refused one.
 */
export function encodeValues(text) {
  if (!encodable(text)) throw new Error(`Code 128 subset B cannot encode: ${JSON.stringify(text)}`);
  const data = [...text].map((c) => c.codePointAt(0) - 32);
  let sum = START_B;
  data.forEach((v, i) => {
    sum += (i + 1) * v;
  });
  const checksum = sum % 103;
  return [START_B, ...data, checksum, STOP];
}

/** Module widths for the whole symbol, alternating bar, space, bar, space... */
export function encodeModules(text) {
  const widths = [];
  for (const value of encodeValues(text)) {
    for (const ch of PATTERNS[value]) widths.push(Number(ch));
  }
  return widths;
}

/** Total width in modules, excluding quiet zones. */
export function moduleWidth(text) {
  return encodeModules(text).reduce((a, b) => a + b, 0);
}

/**
 * Render to an SVG string.
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.moduleWidth=1]  width of one module in user units
 * @param {number} [opts.height=40]      bar height in user units
 * @param {boolean} [opts.quiet=true]    include the mandatory quiet zones
 * @param {string} [opts.color="#000"]
 */
export function toSvg(text, opts = {}) {
  const mw = opts.moduleWidth ?? 1;
  const height = opts.height ?? 40;
  const quiet = opts.quiet === false ? 0 : QUIET_MODULES;
  const color = opts.color ?? "#000";
  const widths = encodeModules(text);
  const totalModules = widths.reduce((a, b) => a + b, 0) + quiet * 2;
  const rects = [];
  let x = quiet;
  widths.forEach((w, i) => {
    if (i % 2 === 0) {
      // even index is a bar; round to whole modules so bars stay crisp at any scale
      rects.push(`<rect x="${(x * mw).toFixed(3)}" y="0" width="${(w * mw).toFixed(3)}" height="${height}" fill="${color}"/>`);
    }
    x += w;
  });
  const width = totalModules * mw;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(3)} ${height}" ` +
    `width="${width.toFixed(3)}" height="${height}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="barcode ${escapeXml(text)}">${rects.join("")}</svg>`
  );
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

export const _internal = { PATTERNS };
