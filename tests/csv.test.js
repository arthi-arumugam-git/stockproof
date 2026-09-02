import { describe, expect, it } from "vitest";
import { num, parseCsv, parseRows, quoteField, toCsv } from "../site/js/csv.js";

describe("parseRows", () => {
  it("handles quoted fields containing commas, quotes and newlines", () => {
    const text = 'a,"b,with comma","he said ""hi""","line1\nline2"\r\n1,2,3,4';
    expect(parseRows(text)).toEqual([
      ["a", "b,with comma", 'he said "hi"', "line1\nline2"],
      ["1", "2", "3", "4"],
    ]);
  });

  it("accepts CRLF, LF and a lone CR as record separators", () => {
    expect(parseRows("a,b\r\nc,d\ne,f\rg,h")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
    ]);
  });

  it("strips a UTF-8 BOM, which Shopify exports carry", () => {
    expect(parseRows("﻿Handle,Title\r\nmug,Mug")).toEqual([
      ["Handle", "Title"],
      ["mug", "Mug"],
    ]);
  });

  it("keeps empty fields and does not invent a trailing record", () => {
    expect(parseRows("a,,c\r\n")).toEqual([["a", "", "c"]]);
    expect(parseRows('a,"",c')).toEqual([["a", "", "c"]]);
  });

  it("a naive split would corrupt this row; the parser does not", () => {
    const line = 'gift-set,"Mug, Large",12';
    const naive = line.split(",");
    expect(naive).toHaveLength(4); // the bug this parser exists to avoid
    expect(parseRows(line)[0]).toEqual(["gift-set", "Mug, Large", "12"]);
  });
});

describe("parseCsv", () => {
  it("maps records by header and counts ragged rows", () => {
    const { headers, records, ragged } = parseCsv("Handle,Title,Qty\r\nmug,Mug,3\r\nbowl,Bowl");
    expect(headers).toEqual(["Handle", "Title", "Qty"]);
    expect(records[0]).toEqual({ Handle: "mug", Title: "Mug", Qty: "3" });
    expect(records[1]).toEqual({ Handle: "bowl", Title: "Bowl", Qty: "" });
    expect(ragged).toBe(1);
  });

  it("skips a blank trailing line rather than emitting an empty record", () => {
    const { records } = parseCsv("A,B\r\n1,2\r\n");
    expect(records).toHaveLength(1);
  });

  it("keeps the first of duplicate headers", () => {
    const { records } = parseCsv("A,A\r\nfirst,second");
    expect(records[0]).toEqual({ A: "first" });
  });
});

describe("toCsv and quoteField", () => {
  it("quotes only what needs quoting and round-trips", () => {
    expect(quoteField("plain")).toBe("plain");
    expect(quoteField("has,comma")).toBe('"has,comma"');
    expect(quoteField('has"quote')).toBe('"has""quote"');
    expect(quoteField("has\nnewline")).toBe('"has\nnewline"');
    const headers = ["Handle", "Title"];
    const records = [{ Handle: "mug", Title: 'Mug, "Large"' }];
    const round = parseCsv(toCsv(headers, records));
    expect(round.records).toEqual([{ Handle: "mug", Title: 'Mug, "Large"' }]);
  });

  it("writes CRLF, matching Shopify's own exports", () => {
    expect(toCsv(["A"], [{ A: "1" }])).toBe("A\r\n1\r\n");
  });
});

describe("num", () => {
  it("reads plain, currency, thousands and decimal-comma forms", () => {
    expect(num("12")).toBe(12);
    expect(num("12.50")).toBe(12.5);
    expect(num("$1,234.56")).toBe(1234.56);
    expect(num("1.234,56")).toBe(1234.56);
    expect(num("12,5")).toBe(12.5);
    expect(num("1,234")).toBe(1234);
    expect(num("1,234,567")).toBe(1234567);
    expect(num("-3")).toBe(-3);
    expect(num(7)).toBe(7);
  });

  it("returns null rather than zero for blanks and junk, so 'unknown' never reads as 'none'", () => {
    expect(num("")).toBeNull();
    expect(num("   ")).toBeNull();
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num("not stocked")).toBeNull();
    expect(num(NaN)).toBeNull();
  });
});
