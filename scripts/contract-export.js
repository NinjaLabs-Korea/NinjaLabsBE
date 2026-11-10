/**
 * API 계약 산출물 생성기 - `npm run contract:export`.
 *
 * 만드는 것 (모두 커밋한다, 손으로 고치지 않는다):
 *   contract/openapi.json     라우트 + 요청 DTO 스키마 (응답 스키마는 아직 없다: 핸들러에 반환 타입이 없어 `{}`로 나온다)
 *   contract/error-codes.json common/http/error-codes.ts의 ERROR_CODES 그대로 (코드, 상태, 한 줄 의미)
 *   contract/constants.json   상태 집합, 전이표, 블로커 코드, 감사 action, 토큰 자릿수, 정적 확장자, 카테고리·역할
 *
 * 운영 의존성 분리: `@nestjs/swagger`는 devDependency다. 운영 `nest build`에는 swagger CLI 플러그인을 켜지 않고, 여기서만
 * TypeScript API로 플러그인을 적용해 .contract-build/ 에 따로 컴파일한다(끝나면 지운다) (dist/ 는 건드리지 않는다).
 * 앱은 `NestFactory.create(AppModule, { preview: true })`로 띄운다: provider를 만들지 않으므로 DB·env 없이 라우트만 모은다.
 * swagger가 끌고 오는 @scarf/scarf의 설치 시 텔레메트리는 package.json `scarfSettings.enabled: false`로 끈다.
 *
 * 스키마 보정: 플러그인(classValidatorShim)은 데코레이터를 **문법으로** 읽어서 커스텀 데코레이터(MaxChars, HasVisibleText 등)와
 * applyDecorators로 감싼 표준 데코레이터(DisplayTitle 안의 IsNotEmpty/MaxLength, IsOptionalNotNull 안의 ValidateIf)를 놓친다.
 * 그래서 문서를 만든 뒤 런타임 ValidationPipe가 실제로 쓰는 class-validator 메타데이터를 다시 훑어 필수 여부, null 허용,
 * 길이·범위·enum·pattern을 덮어쓰고, 표준 키워드로 표현 못 하는 규칙은 이름만 `x-rules`에 남긴다. 런타임 코드는 바꾸지 않는다.
 * 주의: 커스텀 데코레이터 안에 `@ApiProperty({ required })`를 넣지 말 것 - 플러그인 추론을 덮어써 필수 필드가 선택으로 뒤집힌다.
 *
 * 결정성: 객체 키를 재귀 정렬해 쓴다(배열 순서는 원본 그대로). CI가 다시 생성해 `git diff --exit-code contract/`로 비교한다.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
// dist/와 같은 깊이여야 한다: src가 `../../../scripts/ops-alert`처럼 레포 루트의 scripts/를 상대 경로로 require한다
const OUT_DIR = path.join(ROOT, '.contract-build');
const CONTRACT_DIR = path.join(ROOT, 'contract');

/**
 * 플러그인이 DTO로 보고 메타데이터를 붙일 파일 접미사. BE에는 컨트롤러 파일 안에 선언된 DTO가 많아 `.controller.ts`도 넣는다
 * (`.ts` 전체는 플러그인이 거부한다). 다른 파일에 DTO를 새로 두면 여기에 추가한다 - 빠지면 아래 assertPluginCoverage가 실패한다.
 */
const DTO_FILE_SUFFIXES = ['.dto.ts', '.controller.ts', '/cohort-fields.ts'];

/** 이 파일들을 루트로 컴파일한다 (나머지는 import를 따라 들어온다). error-codes.ts는 런타임이 import하지 않아 따로 넣는다. */
const ROOT_FILES = ['app.module.ts', 'common/http/error-codes.ts', 'users/nickname.ts', 'audit/audit-actions.ts'];

function fail(message) {
  console.error(`contract:export: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------------------------------------
// 1. 계약 전용 컴파일 (swagger CLI 플러그인 적용)
// ---------------------------------------------------------------------------------------------------------------------------
function compile() {
  const ts = require('typescript');
  const swaggerPlugin = require('@nestjs/swagger/plugin');
  const configPath = path.join(ROOT, 'tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => fail(ts.flattenDiagnosticMessageText(d.messageText, '\n')) });
  const options = {
    ...parsed.options,
    outDir: OUT_DIR,
    rootDir: SRC,
    incremental: false,
    tsBuildInfoFile: undefined,
    declaration: false,
    sourceMap: false,
    noEmit: false,
  };
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  const program = ts.createProgram(ROOT_FILES.map((f) => path.join(SRC, f)), options);
  const before = swaggerPlugin.before(
    { classValidatorShim: true, introspectComments: false, dtoFileNameSuffix: DTO_FILE_SUFFIXES, controllerFileNameSuffix: ['.controller.ts'] },
    program,
  );
  const result = program.emit(undefined, undefined, undefined, false, { before: [before] });
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(result.diagnostics).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length || result.emitSkipped) {
    const host = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => ROOT, getNewLine: () => '\n' };
    fail(`compile failed (npm run typecheck로 먼저 확인)\n${ts.formatDiagnostics(diagnostics, host)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// 2. class-validator 메타데이터 -> 속성별 규칙
// ---------------------------------------------------------------------------------------------------------------------------

/** 문서에 이름만 남길 규칙의 표시 이름 (메타데이터 name 그대로 쓰되, 의미가 바뀌는 것만 여기서 고친다) */
const CONDITIONAL_RULE = 'validateIf';

/**
 * 한 DTO 클래스의 속성별 런타임 규칙. 반환: Map<property, Rule>
 *   Rule = { optional, nullable, metas: [{ name, constraints, each }] }
 * - optional: IsOptional 또는 ValidateIf가 있으면 생략해도 검증을 건너뛴다. 없으면 생략 시 다른 검증기가 실패하므로 필수다.
 * - nullable: IsOptional(null도 건너뜀)이 있고 IsDefined(IsOptionalNotNull의 null 거부)가 없을 때만.
 */
function rulesFor(target, storage) {
  const metas = storage.getTargetValidationMetadatas(target, '', true, false);
  const byProp = new Map();
  for (const m of metas) {
    if (!byProp.has(m.propertyName)) byProp.set(m.propertyName, []);
    byProp.get(m.propertyName).push(m);
  }
  const rules = new Map();
  for (const [prop, list] of byProp) {
    const conditionals = list.filter((m) => m.type === 'conditionalValidation');
    const hasIsOptional = conditionals.some((m) => m.name === 'isOptional');
    const hasIsDefined = list.some((m) => m.type === 'isDefined' || m.name === 'isDefined');
    const out = [];
    for (const m of list) {
      if (m.type === 'conditionalValidation') {
        // IsOptionalNotNull = ValidateIf(value !== undefined) + IsDefined: "생략 가능, null 거부"로 이미 표현된다. 그 밖의 ValidateIf는 조건부 필수다.
        if (m.name !== 'isOptional' && !hasIsDefined) out.push({ name: CONDITIONAL_RULE, constraints: [], each: false });
        continue;
      }
      if (m.type === 'nestedValidation' || m.type === 'whitelistValidation' || m.type === 'isDefined') continue;
      let name = m.name;
      if (!name && m.constraintCls) name = (storage.getTargetValidatorConstraints(m.constraintCls)[0] || {}).name;
      if (!name) name = m.type;
      out.push({ name, constraints: m.constraints || [], each: Boolean(m.each || (m.validationOptions && m.validationOptions.each)) });
    }
    rules.set(prop, { optional: conditionals.length > 0, nullable: hasIsOptional && !hasIsDefined, metas: out });
  }
  return rules;
}

/** 이 규칙들은 표준 JSON Schema 키워드로 옮긴다. 나머지는 `x-rules`에 이름만. */
function applyRule(schema, rule, counters) {
  const { name, constraints } = rule;
  const c0 = constraints[0];
  const isString = schema.type === 'string';
  switch (name) {
    case 'maxChars':
      // VARCHAR(n)과 같은 코드 포인트 기준 (MaxLength는 이형 선택자를 빼고 센다 - common/validation/max-chars.ts)
      schema.maxLength = schema.maxLength === undefined ? c0 : Math.min(schema.maxLength, c0);
      schema['x-length-unit'] = 'codepoint';
      return;
    case 'maxLength':
      schema.maxLength = schema.maxLength === undefined ? c0 : Math.min(schema.maxLength, c0);
      return;
    case 'minLength':
      schema.minLength = Math.max(schema.minLength || 0, c0);
      return;
    case 'isLength':
      schema.minLength = Math.max(schema.minLength || 0, c0);
      if (constraints[1] !== undefined) schema.maxLength = schema.maxLength === undefined ? constraints[1] : Math.min(schema.maxLength, constraints[1]);
      return;
    case 'isNotEmpty':
      if (isString) {
        schema.minLength = Math.max(schema.minLength || 0, 1);
        return;
      }
      break;
    case 'min':
      schema.minimum = schema.minimum === undefined ? c0 : Math.max(schema.minimum, c0);
      return;
    case 'max':
      schema.maximum = schema.maximum === undefined ? c0 : Math.min(schema.maximum, c0);
      return;
    case 'isInt':
      schema.type = 'integer';
      return;
    case 'isIn':
      schema.enum = [...c0];
      return;
    case 'matches': {
      const re = c0 instanceof RegExp ? c0 : new RegExp(c0, constraints[1]);
      if (schema.pattern !== undefined && schema.pattern !== re.source) {
        // 여러 Matches가 겹치면 첫 번째만 pattern, 나머지는 x-patterns
        (schema['x-patterns'] = schema['x-patterns'] || []).push(re.flags ? `/${re.source}/${re.flags}` : re.source);
        return;
      }
      schema.pattern = re.source;
      if (re.flags) schema['x-pattern-flags'] = re.flags;
      return;
    }
    case 'arrayNotEmpty':
      schema.minItems = Math.max(schema.minItems || 0, 1);
      return;
    case 'arrayMinSize':
      schema.minItems = Math.max(schema.minItems || 0, c0);
      return;
    case 'arrayMaxSize':
      schema.maxItems = schema.maxItems === undefined ? c0 : Math.min(schema.maxItems, c0);
      return;
    case 'arrayUnique':
      schema.uniqueItems = true;
      return;
    case 'isUuid':
      schema.format = 'uuid';
      return;
    // 타입 검사: 플러그인이 TS 타입에서 이미 type을 넣는다
    case 'isString':
    case 'isBoolean':
    case 'isNumber':
    case 'isArray':
    case 'isObject':
      return;
    default:
      break;
  }
  const rules = new Set(schema['x-rules'] || []);
  rules.add(name);
  schema['x-rules'] = [...rules].sort();
  counters[name] = (counters[name] || 0) + 1;
}

/** 속성 스키마 하나에 런타임 규칙을 반영한다. each 규칙은 배열 원소(items)에 건다. */
function applyRulesToProperty(schema, rule, counters) {
  for (const r of rule.metas) {
    let targetSchema = schema;
    if (r.each) {
      if (schema.items && !schema.items.$ref) targetSchema = schema.items;
      else {
        const rules = new Set(schema['x-rules'] || []);
        rules.add(`each:${r.name}`);
        schema['x-rules'] = [...rules].sort();
        counters[`each:${r.name}`] = (counters[`each:${r.name}`] || 0) + 1;
        continue;
      }
    }
    applyRule(targetSchema, r, counters);
  }
  if (rule.nullable) schema.nullable = true;
  else delete schema.nullable;
}

/** $ref 옆의 키워드는 OpenAPI 3.0 도구가 무시한다 - nullable 등을 붙여야 하면 allOf로 감싼다 */
function wrapRefIfNeeded(schema) {
  if (!schema.$ref) return schema;
  const extra = Object.keys(schema).filter((k) => k !== '$ref');
  if (!extra.length) return schema;
  const wrapped = { allOf: [{ $ref: schema.$ref }] };
  for (const k of extra) wrapped[k] = schema[k];
  return wrapped;
}

function enrichComponentSchemas(doc, classesByName, storage, counters) {
  for (const [schemaName, schema] of Object.entries(doc.components.schemas)) {
    const target = classesByName.get(schemaName);
    if (!target) fail(`schema ${schemaName}: DTO class not found (본문/중첩 DTO가 아닌 스키마가 생겼다 - 보정 규칙을 정해야 한다)`);
    const rules = rulesFor(target, storage);
    schema.properties = schema.properties || {};
    const required = [];
    for (const [prop, rule] of rules) {
      if (!schema.properties[prop]) fail(`${schemaName}.${prop} has validators but no schema property (DTO_FILE_SUFFIXES에 파일 접미사가 빠졌나?)`);
      applyRulesToProperty(schema.properties[prop], rule, counters);
      schema.properties[prop] = wrapRefIfNeeded(schema.properties[prop]);
      if (!rule.optional) required.push(prop);
    }
    // 검증기가 하나도 없는 속성은 forbidNonWhitelisted가 400으로 거부한다 - 문서에서도 뺀다 (지금은 없어야 정상)
    for (const prop of Object.keys(schema.properties)) {
      if (!rules.has(prop)) fail(`${schemaName}.${prop} has no class-validator decorator (forbidNonWhitelisted가 거부하는 필드)`);
    }
    if (required.length) schema.required = required;
    else delete schema.required;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// 3. 핸들러 인자 보정. operationId(`Controller_method`)로 핸들러를 찾아 라우트 인자 메타데이터를 본다.
//    - `@Query() dto`: swagger는 DTO를 개별 query 파라미터로 펼친다 -> 그 DTO의 규칙을 파라미터에 반영한다.
//      쿼리스트링에는 null이 없으므로 nullable은 뺀다.
//    - `@UploadedFile()`: multer가 본문을 읽어 swagger가 requestBody를 모른다 -> multipart/form-data 파일 1개로 적는다.
//    - `@Body() dto`: 본문 DTO 클래스를 모아 돌려준다. 검증기를 전부 상속만 하는 클래스(AgentSubmitDto 등)는 class-validator
//      저장소에 자기 항목이 없어서, 여기서 모아야 컴포넌트 스키마 보정 대상이 된다.
// ---------------------------------------------------------------------------------------------------------------------------

/** 업로드 라우트의 multipart 필드 이름. FileInterceptor('file')과 같아야 한다 (assertUploadFieldName이 소스를 확인한다). */
const UPLOAD_FIELD = 'file';

function assertUploadFieldName() {
  for (const file of walkTs(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/FileInterceptor\(\s*'([^']*)'/g)) {
      if (m[1] !== UPLOAD_FIELD) fail(`${path.relative(ROOT, file)}: FileInterceptor('${m[1]}') - contract-export.js UPLOAD_FIELD는 '${UPLOAD_FIELD}'다`);
    }
  }
}

function walkTs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts') && !/\.(spec|db-spec|e2e-spec|d)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

function enrichFromHandlers(doc, app, storage, counters) {
  const bodyClasses = [];
  const { ROUTE_ARGS_METADATA } = require('@nestjs/common/constants');
  const { RouteParamtypes } = require('@nestjs/common/enums/route-paramtypes.enum');
  const controllers = new Map();
  for (const mod of app.container.getModules().values()) {
    for (const wrapper of mod.controllers.values()) controllers.set(wrapper.metatype.name, wrapper.metatype);
  }
  for (const item of Object.values(doc.paths)) {
    for (const op of Object.values(item)) {
      if (!op || !op.operationId) continue;
      const [ctrlName, method] = op.operationId.split('_');
      const ctrl = controllers.get(ctrlName);
      if (!ctrl) fail(`operation ${op.operationId}: controller not found`);
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, method) || {};
      const paramTypes = Reflect.getMetadata('design:paramtypes', ctrl.prototype, method) || [];
      for (const [key, arg] of Object.entries(args)) {
        const paramType = Number(key.split(':')[0]);
        if (paramType === RouteParamtypes.FILE) {
          op.requestBody = {
            required: true,
            content: {
              'multipart/form-data': {
                schema: { type: 'object', properties: { [UPLOAD_FIELD]: { type: 'string', format: 'binary' } }, required: [UPLOAD_FIELD] },
              },
            },
          };
          continue;
        }
        if (arg.data !== undefined) continue;
        const dto = paramTypes[arg.index];
        if (paramType === RouteParamtypes.BODY) {
          if (typeof dto === 'function' && dto !== Object) bodyClasses.push(dto);
          continue;
        }
        if (paramType !== RouteParamtypes.QUERY) continue;
        const rules = rulesFor(dto, storage);
        for (const p of op.parameters || []) {
          if (p.in !== 'query') continue;
          const rule = rules.get(p.name);
          if (!rule) continue;
          applyRulesToProperty(p.schema, rule, counters);
          delete p.schema.nullable;
          p.required = !rule.optional;
        }
      }
    }
  }
  return bodyClasses;
}

// ---------------------------------------------------------------------------------------------------------------------------
// 4. 검사: 플러그인 메타데이터가 모든 검증 DTO에 붙었나 (새 DTO가 접미사 밖 파일에 생기면 여기서 멈춘다)
// ---------------------------------------------------------------------------------------------------------------------------
function assertPluginCoverage(storage) {
  const missing = [];
  for (const target of storage.validationMetadatas.keys()) {
    if (typeof target !== 'function') continue;
    if (!Object.prototype.hasOwnProperty.call(target, '_OPENAPI_METADATA_FACTORY')) missing.push(target.name);
  }
  if (missing.length) fail(`swagger plugin metadata missing for: ${missing.sort().join(', ')} (DTO_FILE_SUFFIXES에 그 파일을 추가)`);
}

function classesByNameFrom(storage, extraClasses) {
  const map = new Map();
  for (const target of [...storage.validationMetadatas.keys(), ...extraClasses]) {
    if (typeof target !== 'function') continue;
    if (map.has(target.name) && map.get(target.name) !== target) fail(`duplicate DTO class name: ${target.name} (스키마 이름이 겹친다)`);
    map.set(target.name, target);
  }
  // 부모 클래스(PaginationQueryDto 등)도 상속 규칙을 위해 같이 둔다 - getTargetValidationMetadatas가 상속을 합친다
  return map;
}

// ---------------------------------------------------------------------------------------------------------------------------
// 5. 상수 / 에러 코드
// ---------------------------------------------------------------------------------------------------------------------------
function load(rel) {
  return require(path.join(OUT_DIR, rel));
}

function buildErrorCodes() {
  const { ERROR_CODES } = load('common/http/error-codes.js');
  return Object.entries(ERROR_CODES).map(([code, entry]) => ({ code, statuses: [...entry.statuses], ko: entry.ko }));
}

function buildConstants() {
  const bounty = load('bounties/bounty-status.js');
  const submission = load('bounties/submission-status.js');
  const application = load('bounties/application-status.js');
  const bountyDto = load('bounties/admin/bounty-admin.dto.js');
  const lifecycle = load('bounties/admin/bounty-lifecycle.service.js');
  const payout = load('rewards/payout-status.js');
  const decimals = load('rewards/reward-token-decimals.js');
  const cohort = load('cohorts/cohort-status.js');
  const questions = load('cohorts/cohort-questions.js');
  const audit = load('audit/audit-actions.js');
  const nickname = load('users/nickname.js');
  const members = load('members/member-admin.controller.js');
  const notices = load('notices/notice-admin.controller.js');
  const pagination = load('common/pagination.dto.js');

  const bountyStatuses = Object.values(bounty.BountyStatus);
  const cohortStatuses = cohort.CohortStatusPolicy.all();
  return {
    bounty: {
      statuses: bountyStatuses,
      transitions: Object.fromEntries(bountyStatuses.map((s) => [s, [...bounty.BountyStatusPolicy.transitionsFrom(s)]])),
      inProgressStatuses: bounty.BountyStatusPolicy.inProgressStatuses(),
      categories: [...bountyDto.CATEGORIES],
      submissionModes: [...bountyDto.SUBMISSION_MODES],
      rewardTokenTypes: [...bountyDto.TOKEN_TYPES],
      lifecycleBlockerCodes: [...lifecycle.LIFECYCLE_BLOCKER_CODES],
    },
    submission: {
      statuses: Object.values(submission.SubmissionStatus),
      reviewDecisions: Object.values(submission.SubmissionDecision),
    },
    application: {
      statuses: application.ApplicationStatusPolicy.all(),
      reviewDecisions: application.ApplicationStatusPolicy.reviewDecisions(),
    },
    payout: {
      rowStatuses: [...payout.PAYOUT_ROW_STATUSES],
      awaitingApprovalStatuses: [...payout.AWAITING_APPROVAL_PAYOUT_STATUSES],
      sendableStatuses: [...payout.SENDABLE_PAYOUT_STATUSES],
      openStatuses: [...payout.OPEN_PAYOUT_STATUSES],
      terminalStatuses: [...payout.TERMINAL_PAYOUT_STATUSES],
      allocatedStatuses: [...payout.ALLOCATED_PAYOUT_STATUSES],
      unsettledStatuses: [...payout.UNSETTLED_PAYOUT_STATUSES],
      submissionPayoutStatuses: [...payout.PAYOUT_STATUSES],
    },
    reward: {
      payableStatuses: [...payout.PAYABLE_REWARD_STATUSES],
      tokenDecimals: { ...decimals.REWARD_TOKEN_DECIMALS },
    },
    cohort: {
      statuses: cohortStatuses,
      transitions: Object.fromEntries(cohortStatuses.map((s) => [s, cohort.CohortStatusPolicy.allowedTransitions(s)])),
      transitionTargets: cohort.CohortStatusPolicy.transitionTargets(),
      applicationStatuses: cohort.CohortApplicationPolicy.all(),
      reviewDecisions: cohort.CohortApplicationPolicy.reviewDecisions(),
      web3Experiences: [...cohort.WEB3_EXPERIENCES],
      activityTypes: [...cohort.ACTIVITY_TYPES],
      interestAreas: [...cohort.INTEREST_AREAS],
      questionTypes: [...questions.QUESTION_TYPES],
      questionIdPattern: questions.QUESTION_ID_PATTERN.source,
      limits: {
        maxQuestions: questions.MAX_QUESTIONS,
        labelMax: questions.LABEL_MAX,
        helpMax: questions.HELP_MAX,
        optionLabelMax: questions.OPTION_LABEL_MAX,
        optionMin: questions.OPTION_MIN,
        optionMax: questions.OPTION_MAX,
        shortTextMax: questions.SHORT_TEXT_MAX,
        longTextMax: questions.LONG_TEXT_MAX,
        otherMax: questions.OTHER_MAX,
        answersMax: questions.ANSWERS_MAX,
      },
    },
    audit: {
      actions: { ...audit.AUDIT_ACTIONS },
      scriptActions: { ...audit.SCRIPT_AUDIT_ACTIONS },
      legacyActions: { ...audit.LEGACY_AUDIT_ACTIONS },
    },
    members: { roles: [...members.MEMBER_ROLES] },
    notices: { categories: [...notices.NOTICE_CATEGORIES] },
    nickname: {
      staticFileExtensions: [...nickname.STATIC_FILE_EXTENSIONS],
      withdrawnPrefix: nickname.WITHDRAWN_NICKNAME_PREFIX,
    },
    pagination: { maxPage: pagination.MAX_PAGE },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// 6. 쓰기
// ---------------------------------------------------------------------------------------------------------------------------
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function write(name, data) {
  const text = `${JSON.stringify(sortKeys(data), null, 2)}\n`;
  if (text.includes(String.fromCharCode(0x2014))) fail(`${name} contains U+2014 (em dash) - 원본 문자열을 고친다`);
  fs.writeFileSync(path.join(CONTRACT_DIR, name), text);
}

const DOC_DESCRIPTION = [
  'NinjaLabs BE API 계약 (npm run contract:export로 생성, 손으로 고치지 않는다).',
  '요청 본문·query 스키마는 런타임 ValidationPipe(whitelist + forbidNonWhitelisted + transform)의 class-validator 규칙에서 왔다.',
  'x-length-unit: codepoint 는 Postgres char_length 기준 길이, x-rules 는 표준 키워드로 표현 못 한 검증 규칙 이름이다 (의미는 BE src/common/validation/).',
  '응답 스키마는 아직 없다: 핸들러에 반환 타입이 없어 비어 있는 것이 정상이며, 응답 모양은 BE docs/api-contract.md 서술이 기준이다.',
  '에러 응답은 { statusCode, message: ERROR_CODE, error } 이고 코드 목록은 contract/error-codes.json 이다.',
].join('\n');

async function main() {
  compile();
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
  const { getMetadataStorage } = require('class-validator');
  const { AppModule } = load('app.module.js');

  const app = await NestFactory.create(AppModule, { logger: false, preview: true, abortOnError: false });
  const config = new DocumentBuilder()
    .setTitle('NinjaLabs API')
    .setVersion(require(path.join(ROOT, 'package.json')).version)
    .setDescription(DOC_DESCRIPTION)
    .build();
  const doc = SwaggerModule.createDocument(app, config);

  const storage = getMetadataStorage();
  assertPluginCoverage(storage);
  const counters = {};
  assertUploadFieldName();
  const bodyClasses = enrichFromHandlers(doc, app, storage, counters);
  enrichComponentSchemas(doc, classesByNameFrom(storage, bodyClasses), storage, counters);
  await app.close();

  fs.mkdirSync(CONTRACT_DIR, { recursive: true });
  write('openapi.json', doc);
  write('error-codes.json', { codes: buildErrorCodes() });
  write('constants.json', buildConstants());

  const pathCount = Object.keys(doc.paths).length;
  const opCount = Object.values(doc.paths).reduce((n, item) => n + Object.keys(item).length, 0);
  console.log(`contract:export: ${pathCount} paths, ${opCount} operations, ${Object.keys(doc.components.schemas).length} schemas`);
  console.log(`contract:export: x-rules ${JSON.stringify(sortKeys(counters))}`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
