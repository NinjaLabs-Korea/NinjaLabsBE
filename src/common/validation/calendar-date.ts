import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

/** 연도 범위: 행사 날짜로 상식적인 값만 (2000-2100). `0000-01-01` 같은 값이 Postgres 22008 500 이 되지 않게 한다 */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** `YYYY-MM-DD` 이고 달력에 실제로 있는 날짜인가 (`2026-02-30`, `2026-13-01`, `2026-2-3` 거부). 시각·시간대 없음 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** DATE 컬럼(공지 event_date 등)에 저장되는 문자열 필드용. null/undefined 는 `@IsOptional()` 이 통과시킨다 */
export const IsCalendarDate = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isCalendarDate',
      validator: {
        validate: (value: unknown) => isCalendarDate(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must be a real calendar date in YYYY-MM-DD format`, options),
      },
    },
    options,
  );
