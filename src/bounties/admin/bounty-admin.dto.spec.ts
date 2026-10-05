import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateBountyDto, UpdateBountyDto } from './bounty-admin.dto';

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
});
