// parseLeadFile must retain the first 5,000 nonblank data rows while reporting
// the full count. Changing intermediate allocations must not change CSV semantics.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let parseLeadFile: typeof import('../../server/leadImportRoutes')['parseLeadFile'];
beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'hf-lead-import-rows-'));
  process.env.NODE_ENV = 'test';
  ({ parseLeadFile } = await import('../../server/leadImportRoutes'));
});
const parse = (text: string) => parseLeadFile(Buffer.from(text, 'utf8'));

describe('lead import retained rows and total count', () => {
  it.each(['', '\n\r\n,,\n', '\uFEFF\r\n,\r\n'])('returns empty columns and rows for blank input %j', text => {
    expect(parse(text)).toEqual({ columns: [], rows: [], rowCount: 0, truncated: false });
  });

  it('uses the first nonblank header, trims headers only, and preserves field whitespace', () => {
    expect(parse('\uFEFF\r\n,,\n Address , City \r\n 10 Oak , Example \r\n,,\n')).toEqual({
      columns: ['Address', 'City'], rows: [[' 10 Oak ', ' Example ']], rowCount: 1, truncated: false,
    });
  });

  it('preserves quoted commas, embedded newlines, escaped quotes, and CRLF boundaries', () => {
    expect(parse('Address,Note\r\n"10, Oak","line one\nline two with ""quotes"""\r\n')).toEqual({
      columns: ['Address', 'Note'], rows: [['10, Oak', 'line one\nline two with "quotes"']], rowCount: 1, truncated: false,
    });
  });

  it('does not redefine whitespace-only fields as blank rows', () => {
    expect(parse(' \nAddress,City\n10 Oak,Example\n')).toEqual({
      columns: [''], rows: [['Address', 'City'], ['10 Oak', 'Example']], rowCount: 2, truncated: false,
    });
  });

  it.each([5_000, 5_001, 6_000])('retains the first 5,000 of %i data rows and counts all nonblank rows', count => {
    const input = 'Address,City\n' + Array.from({ length: count }, (_, i) => `${i} Oak,Example\n\n,\r\n`).join('');
    const output = parse(input);
    expect(output.columns).toEqual(['Address', 'City']);
    expect(output.rowCount).toBe(count);
    expect(output.truncated).toBe(count > 5_000);
    expect(output.rows).toHaveLength(Math.min(count, 5_000));
    expect(output.rows[0]).toEqual(['0 Oak', 'Example']);
    expect(output.rows.at(-1)).toEqual(['4999 Oak', 'Example']);
    expect(output.rows.some(([address]) => address === '5000 Oak')).toBe(false);
  });
});
