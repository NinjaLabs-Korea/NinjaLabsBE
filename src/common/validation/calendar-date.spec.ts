import { isCalendarDate } from './calendar-date';

describe('isCalendarDate', () => {
  it('accepts real dates incl. leap day', () => {
    for (const ok of ['2026-10-26', '2028-02-29', '2000-01-01', '2100-12-31']) expect(isCalendarDate(ok)).toBe(true);
  });
  it('rejects impossible, malformed and out-of-range values', () => {
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-5', '26-01-01', '2026-01-01T00:00:00Z', ' 2026-01-01', '0000-01-01', '1999-12-31', '2101-01-01', '', 'tomorrow'])
      expect(isCalendarDate(bad)).toBe(false);
    for (const bad of [null, undefined, 20261026, {}, []]) expect(isCalendarDate(bad)).toBe(false);
  });
});
