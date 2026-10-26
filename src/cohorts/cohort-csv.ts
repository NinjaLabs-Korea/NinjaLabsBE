/**
 * 기수 지원서 CSV (운영자 내보내기).
 *
 * - UTF-8 BOM(U+FEFF)으로 시작: 한국어 Excel 이 UTF-8 로 연다.
 * - RFC 4180: 모든 셀을 큰따옴표로 감싸고 `"` 는 `""`, 행 구분은 CRLF. 셀 안의 줄바꿈은 그대로 둔다(따옴표 안).
 * - 스프레드시트 수식 주입 차단: 셀이 `= + - @` (또는 탭/CR) 로 시작하면 (앞 공백 뒤 첫 글자 포함) 작은따옴표를 앞에 붙여 텍스트로 만든다.
 *   지원자 입력(이름, 자기소개, 기타 상세 등)이 모두 이 경로를 지난다. 헤더·고정 값도 같은 함수를 지난다 (예외 없음).
 */
export const CSV_BOM = '﻿';

const FORMULA_START = /^[\s]*[=+\-@]|^[\t\r]/;

export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join(';') : String(value);
  return `"${neutralizeFormula(text).replace(/"/g, '""')}"`;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return CSV_BOM + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
