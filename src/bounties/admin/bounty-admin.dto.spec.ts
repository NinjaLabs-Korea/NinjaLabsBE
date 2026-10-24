import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateBountyDto, TransitionBountyDto, UpdateBountyDto } from './bounty-admin.dto';

const failedFields = async (cls: new () => object, body: object) =>
  (await validate(plainToInstance(cls, body))).map((error) => error.property).sort();

const validCreate = {
  title: 'Build a widget',
  sponsorName: 'Injective',
  summary: 'Ship a widget.',
  description: 'Ship a reusable widget.',
  requirements: 'Repo',
  evaluationCriteria: 'Sponsor review',
  category: 'DEV',
  applicationRequired: false,
  submissionMode: 'DIRECT',
  maxWinners: 1,
  submissionDeadline: '2026-07-14T14:59:00.000Z',
};

describe('bounty admin DTOs', () => {
  it('accepts a complete create request', async () => {
    expect(await failedFields(CreateBountyDto, validCreate)).toEqual([]);
  });

  it('rejects whitespace-only required text and a malformed deadline on create', async () => {
    expect(
      await failedFields(CreateBountyDto, { ...validCreate, title: '   ', sponsorName: '', submissionDeadline: 'soon' }),
    ).toEqual(['sponsorName', 'submissionDeadline', 'title']);
  });

  it('trims text fields', () => {
    expect(plainToInstance(CreateBountyDto, { ...validCreate, title: '  Build a widget  ' }).title).toBe('Build a widget');
  });

  it('lets updates omit fields but not blank out required text', async () => {
    expect(await failedFields(UpdateBountyDto, {})).toEqual([]);
    expect(await failedFields(UpdateBountyDto, { title: '', description: '  ' })).toEqual(['description', 'title']);
  });

  it('bounds free text (title 200, sponsorName 100, summary 500, description 50000, requirements/evaluationCriteria 20000)', async () => {
    expect(await failedFields(CreateBountyDto, {
      ...validCreate, title: 't'.repeat(200), sponsorName: 's'.repeat(100), summary: 'u'.repeat(500),
      description: 'd'.repeat(50_000), requirements: 'r'.repeat(20_000), evaluationCriteria: 'e'.repeat(20_000),
    })).toEqual([]);
    expect(await failedFields(CreateBountyDto, {
      ...validCreate, title: 't'.repeat(201), sponsorName: 's'.repeat(101), summary: 'u'.repeat(501),
      description: 'd'.repeat(50_001), requirements: 'r'.repeat(20_001), evaluationCriteria: 'e'.repeat(20_001),
    })).toEqual(['description', 'evaluationCriteria', 'requirements', 'sponsorName', 'summary', 'title']);
  });

  it('update bounds are 2x the create bounds so legacy rows re-sent unchanged by the FE still pass', async () => {
    expect(await failedFields(UpdateBountyDto, {
      title: 't'.repeat(400), sponsorName: 's'.repeat(200), summary: 'u'.repeat(1000),
      description: 'd'.repeat(100_000), requirements: 'r'.repeat(40_000), evaluationCriteria: 'e'.repeat(40_000),
    })).toEqual([]);
    expect(await failedFields(UpdateBountyDto, {
      title: 't'.repeat(401), sponsorName: 's'.repeat(201), summary: 'u'.repeat(1001),
      description: 'd'.repeat(100_001), requirements: 'r'.repeat(40_001), evaluationCriteria: 'e'.repeat(40_001),
    })).toEqual(['description', 'evaluationCriteria', 'requirements', 'sponsorName', 'summary', 'title']);
  });

  it('accepts coverImageUrl as the /media/<uuid> path returned by POST /admin/media or an http(s) URL, null clears it on update', async () => {
    expect(await failedFields(CreateBountyDto, { ...validCreate, coverImageUrl: '/media/11111111-1111-4111-8111-111111111111' })).toEqual([]);
    expect(await failedFields(CreateBountyDto, { ...validCreate, coverImageUrl: 'https://cdn.example/cover.png' })).toEqual([]);
    expect(await failedFields(CreateBountyDto, { ...validCreate, coverImageUrl: 'javascript:alert(1)' })).toEqual(['coverImageUrl']);
    expect(await failedFields(CreateBountyDto, { ...validCreate, coverImageUrl: '/uploads/x.png' })).toEqual(['coverImageUrl']);
    expect(await failedFields(UpdateBountyDto, { coverImageUrl: null })).toEqual([]);
  });

  it('update accepts legacy site-relative and scheme-less cover images (lenient IsSafeUrl) but still rejects unsafe schemes', async () => {
    // the FE PATCH re-sends every field — a legacy row saved before the strict rule must not make the whole edit fail
    const legacyRow = { ...validCreate, coverImageUrl: '/uploads/legacy-cover.png', maxWinners: 1 };
    expect(await failedFields(CreateBountyDto, legacyRow)).toEqual(['coverImageUrl']);
    expect(await failedFields(UpdateBountyDto, legacyRow)).toEqual([]);
    expect(await failedFields(UpdateBountyDto, { coverImageUrl: 'javascript:alert(1)' })).toEqual(['coverImageUrl']);
    expect(await failedFields(UpdateBountyDto, { coverImageUrl: '//evil.com/x.png' })).toEqual(['coverImageUrl']);
    // a legacy bare-host value (no scheme) is re-sent unchanged by the FE: it must not block the edit (create stays strict)
    expect(await failedFields(UpdateBountyDto, { ...legacyRow, coverImageUrl: 'ninjalabs.xyz/x.png' })).toEqual([]);
    expect(await failedFields(CreateBountyDto, { ...legacyRow, coverImageUrl: 'ninjalabs.xyz/x.png' })).toEqual(['coverImageUrl']);
  });

  it('validates the nested reward: token type, amount as integer base units, display symbol', async () => {
    const reward = { tokenType: 'ERC20', displaySymbol: 'USDC', amount: '1000000' };
    expect(await failedFields(CreateBountyDto, { ...validCreate, reward })).toEqual([]);
    expect(await failedFields(CreateBountyDto, { ...validCreate, reward: { ...reward, tokenType: 'NATIVE', tokenDenom: 'inj', evmChainId: 1439 } })).toEqual([]);
    const nested = async (body: object) => {
      const errors = await validate(plainToInstance(CreateBountyDto, body));
      return errors.flatMap((error) => (error.children?.length ? error.children.map((child) => child.property) : [error.property])).sort();
    };
    expect(await nested({ ...validCreate, reward: { ...reward, amount: '0' } })).toEqual(['amount']);
    expect(await nested({ ...validCreate, reward: { ...reward, amount: '1.5' } })).toEqual(['amount']);
    expect(await nested({ ...validCreate, reward: { ...reward, amount: 1000000 } })).toEqual(['amount']);
    expect(await nested({ ...validCreate, reward: { ...reward, displaySymbol: 'US DC' } })).toEqual(['displaySymbol']);
    expect(await nested({ ...validCreate, reward: { ...reward, displaySymbol: 'A'.repeat(13) } })).toEqual(['displaySymbol']);
    expect(await nested({ ...validCreate, reward: { ...reward, tokenType: 'SPL' } })).toEqual(['tokenType']);
    expect(await nested({ ...validCreate, reward: { ...reward, evmChainId: 0 } })).toEqual(['evmChainId']);
    expect(await nested({ ...validCreate, reward: 'USDC 10' })).toEqual(['reward']);
  });

  it('validates applicationDeadline as a date string but allows null to clear it', async () => {
    expect(await failedFields(UpdateBountyDto, { applicationDeadline: null })).toEqual([]);
    expect(await failedFields(UpdateBountyDto, { applicationDeadline: '2026-07-01T00:00:00.000Z' })).toEqual([]);
    expect(await failedFields(UpdateBountyDto, { applicationDeadline: 'soon' })).toEqual(['applicationDeadline']);
  });
});

describe('TransitionBountyDto', () => {
  it.each(['DRAFT', 'FUNDING_PENDING', 'OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED'])('accepts the bounty status %p', async (to) => {
    expect(await failedFields(TransitionBountyDto, { to })).toEqual([]);
  });

  it.each([undefined, '', 'open', 'ARCHIVED', 42, ['OPEN']])('rejects %p', async (to) => {
    expect(await failedFields(TransitionBountyDto, { to })).toEqual(['to']);
  });
});
