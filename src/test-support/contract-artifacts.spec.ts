import { readFileSync } from 'fs';
import { join } from 'path';
import { ERROR_CODES } from '../common/http/error-codes';

/**
 * 커밋된 계약 산출물(contract/*.json, `npm run contract:export`)의 모양 검사.
 * 산출물이 소스와 같은지(신선도)는 CI verify 잡이 다시 생성해 `git diff`로 본다. 여기서는 ts-jest가 swagger 플러그인을 돌리지 않으므로
 * 생성기를 다시 돌리지 않고, 커밋된 JSON이 생성기의 약속(요청 스키마 보정, 필수/null 규칙)을 지키는지만 본다.
 * 실패하면 대개 `npm run contract:export`를 다시 돌리면 된다. 그래도 실패하면 scripts/contract-export.js의 보정 규칙을 본다.
 */
type Schema = {
  type?: string;
  $ref?: string;
  allOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  nullable?: boolean;
  maxLength?: number;
  minLength?: number;
  enum?: unknown[];
  'x-length-unit'?: string;
  'x-rules'?: string[];
};
type Operation = { operationId: string; requestBody?: { content: Record<string, { schema: Schema }> } };

const root = join(__dirname, '..', '..', 'contract');
const read = (name: string) => JSON.parse(readFileSync(join(root, name), 'utf8'));
const openapi = read('openapi.json') as { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, Schema> } };
const schemas = openapi.components.schemas;
const operations = Object.values(openapi.paths).flatMap((item) => Object.entries(item).map(([method, op]) => ({ method, op })));

describe('contract/openapi.json', () => {
  it('lists every route (non-trivial count) with a unique operationId', () => {
    expect(operations.length).toBeGreaterThan(70);
    const ids = operations.map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every requestBody points at an existing schema (JSON DTO) or a multipart upload', () => {
    for (const { op } of operations) {
      if (!op.requestBody) continue;
      for (const [type, media] of Object.entries(op.requestBody.content)) {
        if (type === 'multipart/form-data') continue;
        expect(type).toBe('application/json');
        const ref = media.schema.$ref ?? '';
        expect(schemas[ref.replace('#/components/schemas/', '')]).toBeDefined();
      }
    }
  });

  it('every schema property is typed and every required name exists', () => {
    for (const [name, schema] of Object.entries(schemas)) {
      for (const [prop, p] of Object.entries(schema.properties ?? {})) {
        if (!(p.type || p.$ref || p.allOf)) throw new Error(`${name}.${prop} has no type`);
      }
      for (const req of schema.required ?? []) expect(Object.keys(schema.properties ?? {})).toContain(req);
    }
  });

  // 아래는 생성기 보정의 고정점: 플러그인만으로는 틀리게 나오던 것들이다 (wiki contract-codegen-plan "실험 결과")
  it('MaxChars inside DisplayTitle becomes maxLength in code points, and the field stays required', () => {
    expect(schemas.CreateBountyDto.properties!.title).toMatchObject({ type: 'string', maxLength: 200, minLength: 1, 'x-length-unit': 'codepoint' });
    expect(schemas.CreateBountyDto.properties!.title['x-rules']).toEqual(['hasVisibleText', 'isPlainDisplayText']);
    expect(schemas.CreateBountyDto.required).toContain('title');
  });

  it('IsOptionalNotNull is optional but not nullable; IsOptional is optional and nullable', () => {
    expect(schemas.UpdateBountyDto.required ?? []).not.toContain('title');
    expect(schemas.UpdateBountyDto.properties!.title.nullable).toBeUndefined();
    expect(schemas.CreateNoticeDto.required ?? []).not.toContain('summary');
    expect(schemas.CreateNoticeDto.properties!.summary.nullable).toBe(true);
  });

  it('inherited DTOs without their own decorators get the same rules as the parent', () => {
    expect(schemas.AgentSubmitDto).toEqual(schemas.SubmitDto);
    expect(schemas.AgentApplyDto).toEqual(schemas.ApplyDto);
  });
});

describe('contract/error-codes.json', () => {
  it('matches the ERROR_CODES catalog (order, statuses, meaning)', () => {
    const { codes } = read('error-codes.json') as { codes: { code: string; statuses: number[]; ko: string }[] };
    expect(codes).toEqual(Object.entries(ERROR_CODES).map(([code, e]) => ({ code, statuses: [...e.statuses], ko: e.ko })));
  });
});
