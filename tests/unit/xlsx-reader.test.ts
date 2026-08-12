// ── The dependency-free XLSX reader, pinned ──────────────────────────────────
//
// Half the admins who export a Salesforce report will pick XLSX, so refusing it
// would push a manual conversion into the middle of a compliance-sensitive
// workflow. That makes this reader load-bearing, and these are the four things
// it has to get right or an import is silently wrong:
//
//   1. THE FIRST SHEET MEANS THE FIRST TAB, not sheet1.xml. A report with a
//      summary tab in front is the normal case, and reading the wrong one
//      imports nothing while looking successful.
//   2. AN EMPTY CELL DOES NOT SHIFT THE ROW. Empty cells are absent from the
//      XML entirely; placing each value at the index its reference names is the
//      difference between a correct row and every column after the gap being
//      off by one.
//   3. A DATE CELL IS A DATE, not 46248.
//   4. SHARED STRINGS WITH FORMATTING RUNS ARE ONE VALUE, not the first run.
//
// The fixtures below are built by hand rather than checked in as binaries: a
// binary fixture cannot be read in a code review, and the point of each test is
// the SHAPE of the XML it exercises.

import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { looksLikeXlsx, readXlsxFirstSheet, XlsxError } from "../../server/xlsx";

// ── A minimal ZIP writer ─────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function zip(entries: { name: string; content: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.from(entry.content, "utf8");
    const deflated = deflateRawSync(raw);
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, deflated);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + deflated.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ── Workbook fixtures ────────────────────────────────────────────────────────

interface SheetSpec { name: string; relId: string; path: string; xml: string }

function workbook(sheets: SheetSpec[], sharedStrings: string[] = [], stylesXml?: string): Buffer {
  const entries = [
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0"?><workbook><sheets>${
        sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="${s.relId}"/>`).join("")
      }</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0"?><Relationships>${
        sheets.map((s) => `<Relationship Id="${s.relId}" Target="${s.path.replace(/^xl\//, "")}"/>`).join("")
      }</Relationships>`,
    },
    ...sheets.map((s) => ({ name: s.path, content: s.xml })),
  ];
  if (sharedStrings.length > 0) {
    entries.push({
      name: "xl/sharedStrings.xml",
      content: `<?xml version="1.0"?><sst>${sharedStrings.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`,
    });
  }
  if (stylesXml) entries.push({ name: "xl/styles.xml", content: stylesXml });
  return zip(entries);
}

const sheetXml = (rows: string) => `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
const inline = (ref: string, value: string) => `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;

describe("looksLikeXlsx", () => {
  it("recognises the ZIP signature and nothing else", () => {
    expect(looksLikeXlsx(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(looksLikeXlsx(Buffer.from("Order Number,Status", "utf8"))).toBe(false);
    expect(looksLikeXlsx(Buffer.alloc(0))).toBe(false);
  });
});

describe("readXlsxFirstSheet", () => {
  it("reads inline strings into a grid", () => {
    const buf = workbook([{
      name: "Report", relId: "rId1", path: "xl/worksheets/sheet1.xml",
      xml: sheetXml(
        `<row r="1">${inline("A1", "Order Number")}${inline("B1", "Order Status")}</row>` +
        `<row r="2">${inline("A2", "PV-1001")}${inline("B2", "Install Scheduled")}</row>`,
      ),
    }]);
    const sheet = readXlsxFirstSheet(buf);
    expect(sheet.name).toBe("Report");
    expect(sheet.rows).toEqual([["Order Number", "Order Status"], ["PV-1001", "Install Scheduled"]]);
  });

  it("reads the workbook's FIRST TAB, not the file called sheet1", () => {
    // The data tab is sheet2.xml on disk but first in the workbook's own order,
    // which is what an admin sees and what the import must read.
    const buf = workbook([
      {
        name: "Orders", relId: "rId7", path: "xl/worksheets/sheet2.xml",
        xml: sheetXml(`<row r="1">${inline("A1", "Order Number")}</row><row r="2">${inline("A2", "PV-1001")}</row>`),
      },
      {
        name: "Summary", relId: "rId1", path: "xl/worksheets/sheet1.xml",
        xml: sheetXml(`<row r="1">${inline("A1", "Total")}</row>`),
      },
    ]);
    const sheet = readXlsxFirstSheet(buf);
    expect(sheet.name).toBe("Orders");
    expect(sheet.rows[0]).toEqual(["Order Number"]);
  });

  it("keeps an empty cell in place instead of shifting the row left", () => {
    // No <c r="B2"> at all - which is how Excel writes an empty cell.
    const buf = workbook([{
      name: "Report", relId: "rId1", path: "xl/worksheets/sheet1.xml",
      xml: sheetXml(
        `<row r="1">${inline("A1", "Order")}${inline("B1", "Install Date")}${inline("C1", "Status")}</row>` +
        `<row r="2">${inline("A2", "PV-1001")}${inline("C2", "Submitted")}</row>`,
      ),
    }]);
    const sheet = readXlsxFirstSheet(buf);
    expect(sheet.rows[1]).toEqual(["PV-1001", "", "Submitted"]);
  });

  it("joins the formatting runs of a shared string into one value", () => {
    const entries = [
      {
        name: "xl/workbook.xml",
        content: `<?xml version="1.0"?><workbook><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        content: `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      },
      {
        name: "xl/sharedStrings.xml",
        content: `<?xml version="1.0"?><sst><si><r><t>Install </t></r><r><t>Scheduled</t></r><rPh><t>ignored</t></rPh></si></sst>`,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        content: sheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`),
      },
    ];
    expect(readXlsxFirstSheet(zip(entries)).rows[0][0]).toBe("Install Scheduled");
  });

  it("decodes XML entities in cell text", () => {
    const buf = workbook([{
      name: "Report", relId: "rId1", path: "xl/worksheets/sheet1.xml",
      xml: sheetXml(`<row r="1">${inline("A1", "Smith &amp; Sons &lt;unit 2&gt;")}</row>`),
    }]);
    expect(readXlsxFirstSheet(buf).rows[0][0]).toBe("Smith & Sons <unit 2>");
  });

  it("renders a date-styled number as a date, not a serial", () => {
    const styles = `<?xml version="1.0"?><styleSheet><cellXfs count="2">` +
      `<xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;
    const buf = workbook(
      [{
        name: "Report", relId: "rId1", path: "xl/worksheets/sheet1.xml",
        // A1 uses style 1 (a built-in date format); B1 uses style 0 (general).
        xml: sheetXml(`<row r="1"><c r="A1" s="1"><v>46248</v></c><c r="B1" s="0"><v>46248</v></c></row>`),
      }],
      [], styles,
    );
    const [a, b] = readXlsxFirstSheet(buf).rows[0];
    expect(a).toBe("2026-08-14");
    expect(b).toBe("46248");
  });

  it("respects a custom date format and leaves a currency format alone", () => {
    const styles = `<?xml version="1.0"?><styleSheet>` +
      `<numFmts><numFmt numFmtId="170" formatCode="m/d/yyyy"/><numFmt numFmtId="171" formatCode="[$-409]#,##0.00"/></numFmts>` +
      `<cellXfs count="2"><xf numFmtId="170"/><xf numFmtId="171"/></cellXfs></styleSheet>`;
    const buf = workbook(
      [{
        name: "Report", relId: "rId1", path: "xl/worksheets/sheet1.xml",
        xml: sheetXml(`<row r="1"><c r="A1" s="0"><v>46248</v></c><c r="B1" s="1"><v>46248</v></c></row>`),
      }],
      [], styles,
    );
    const [a, b] = readXlsxFirstSheet(buf).rows[0];
    expect(a).toBe("2026-08-14");
    expect(b).toBe("46248");
  });

  it("reads a boolean and a formula's cached string", () => {
    const buf = workbook([{
      name: "Report", relId: "rId1", path: "xl/worksheets/sheet1.xml",
      xml: sheetXml(`<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="str"><f>A1</f><v>Kinetic</v></c></row>`),
    }]);
    expect(readXlsxFirstSheet(buf).rows[0]).toEqual(["TRUE", "Kinetic"]);
  });

  it("falls back to the lowest-numbered worksheet when the relationships are broken", () => {
    const entries = [
      {
        name: "xl/workbook.xml",
        content: `<?xml version="1.0"?><workbook><sheets><sheet name="Report" sheetId="1" r:id="rIdMissing"/></sheets></workbook>`,
      },
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(`<row r="1">${inline("A1", "Order")}</row>`) },
    ];
    expect(readXlsxFirstSheet(zip(entries)).rows[0][0]).toBe("Order");
  });

  it("refuses a file that is not a workbook, with a message an admin can act on", () => {
    expect(() => readXlsxFirstSheet(Buffer.from("Order Number,Status\n1,2", "utf8")))
      .toThrow(XlsxError);
    expect(() => readXlsxFirstSheet(zip([{ name: "hello.txt", content: "hi" }])))
      .toThrow(/not an Excel workbook/i);
  });
});
