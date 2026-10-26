import { CSV_BOM, csvCell, neutralizeFormula, toCsv } from './cohort-csv';

describe('csv', () => {
  it('neutralizes cells that a spreadsheet would run as a formula', () => {
    for (const bad of ['=1+1', '+1', '-1', '@SUM(A1)', '\t=1', '\r=1', ' =1', '\n@x', '=HYPERLINK("http://evil","x")']) {
      expect(neutralizeFormula(bad)).toBe(`'${bad}`);
    }
    for (const ok of ['hello', 'a=1', '한글', '', '1+1', 'x-y']) expect(neutralizeFormula(ok)).toBe(ok);
  });

  it('quotes every cell and doubles embedded quotes; newlines stay inside the quotes', () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(['A', 'B'])).toBe('"A;B"');
    expect(csvCell(new Date('2026-10-26T00:00:00Z'))).toBe('"2026-10-26T00:00:00.000Z"');
    expect(csvCell(7)).toBe('"7"');
  });

  it('combines both: a formula with quotes is prefixed then escaped', () => {
    expect(csvCell('=A1&"x"')).toBe(`"'=A1&""x"""`);
  });

  it('starts with a UTF-8 BOM, uses CRLF and runs headers through the same escaping', () => {
    const out = toCsv(['a', '=h'], [['1', '=2'], ['x', '한글']]);
    expect(out.startsWith(CSV_BOM)).toBe(true);
    expect(out).toBe(`${CSV_BOM}"a","'=h"\r\n"1","'=2"\r\n"x","한글"\r\n`);
  });
});
