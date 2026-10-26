import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AgentApplyDto, AgentSubmitDto } from '../agents/agent-api.controller';
import { ReviewApplicationDto } from './applications/application-review.controller';
import { ApplyDto } from './applications/applications.controller';
import { ReviewSubmissionDto } from './submissions/submission-review.controller';
import { SubmitDto } from './submissions/submissions.controller';

// 컨트롤러가 서비스 → wallet-signature → @injectivelabs/sdk-ts(ESM)를 끌어오므로 서명 검증 모듈만 껍데기로 대체한다
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

const failedFields = async (cls: new () => object, body: object) =>
  (await validate(plainToInstance(cls, body))).map((error) => error.property).sort();

describe('bounty participation DTOs (user and agent surfaces share the same rules)', () => {
  it.each([ApplyDto, AgentApplyDto])('%p: message ≤ 4000 and portfolioUrl must be http(s)', async (cls) => {
    expect(await failedFields(cls, { message: 'hi', portfolioUrl: 'https://me.dev' })).toEqual([]);
    expect(await failedFields(cls, { message: 'm'.repeat(4000) })).toEqual([]);
    expect(await failedFields(cls, { message: 'm'.repeat(4001), portfolioUrl: 'me.dev' })).toEqual(['message', 'portfolioUrl']);
    expect(await failedFields(cls, { message: '', portfolioUrl: 'javascript:alert(1)' })).toEqual(['message', 'portfolioUrl']);
  });

  it.each([ApplyDto, AgentApplyDto])('%p: portfolioUrl must be public (no localhost / private addresses)', async (cls) => {
    for (const portfolioUrl of ['http://localhost:3000/x', 'http://127.0.0.1/x', 'http://192.168.0.2/x', 'http://intranet/x']) {
      expect(await failedFields(cls, { message: 'hi', portfolioUrl })).toEqual(['portfolioUrl']);
    }
  });

  it.each([SubmitDto, AgentSubmitDto])('%p: submissionUrl and repositoryUrl must be public (no localhost / private addresses)', async (cls) => {
    for (const url of ['http://localhost:3000/x', 'http://127.0.0.1/x', 'http://10.1.2.3/x', 'http://169.254.169.254/x']) {
      expect(await failedFields(cls, { submissionUrl: url, description: 'd' })).toEqual(['submissionUrl']);
      expect(await failedFields(cls, { submissionUrl: 'https://demo.app', description: 'd', repositoryUrl: url })).toEqual(['repositoryUrl']);
    }
  });

  it.each([ApplyDto, AgentApplyDto])('%p: a whitespace-only message is empty, and the stored message is trimmed', async (cls) => {
    expect(await failedFields(cls, { message: '   \n ' })).toEqual(['message']);
    expect(plainToInstance(cls, { message: '  hello  ' }).message).toBe('hello');
  });

  it.each([SubmitDto, AgentSubmitDto])('%p: a whitespace-only description is empty, and the stored description is trimmed', async (cls) => {
    expect(await failedFields(cls, { submissionUrl: 'https://demo.app', description: ' \t ' })).toEqual(['description']);
    expect(plainToInstance(cls, { submissionUrl: 'https://demo.app', description: ' done ' }).description).toBe('done');
  });

  it.each([SubmitDto, AgentSubmitDto])('%p: submissionUrl/repositoryUrl http(s), description ≤ 8000, commitSha ≤ 64', async (cls) => {
    expect(await failedFields(cls, { submissionUrl: 'https://demo.app', description: 'done', repositoryUrl: 'https://github.com/o/r', commitSha: 'a'.repeat(40) })).toEqual([]);
    expect(await failedFields(cls, { submissionUrl: 'https://demo.app', description: 'd'.repeat(8000) })).toEqual([]);
    expect(await failedFields(cls, { submissionUrl: 'ftp://demo.app', description: 'd'.repeat(8001), repositoryUrl: '/media/11111111-1111-4111-8111-111111111111', commitSha: 'a'.repeat(65) }))
      .toEqual(['commitSha', 'description', 'repositoryUrl', 'submissionUrl']);
  });

  it('bounds review note/comment to 2000 characters', async () => {
    expect(await failedFields(ReviewApplicationDto, { decision: 'APPROVED', note: 'n'.repeat(2000) })).toEqual([]);
    expect(await failedFields(ReviewApplicationDto, { decision: 'APPROVED', note: 'n'.repeat(2001) })).toEqual(['note']);
    expect(await failedFields(ReviewSubmissionDto, { decision: 'APPROVE', comment: 'c'.repeat(2000) })).toEqual([]);
    expect(await failedFields(ReviewSubmissionDto, { decision: 'APPROVE', comment: 'c'.repeat(2001) })).toEqual(['comment']);
  });

  it('revisionNo may be omitted but not null (null used to surface as SUBMISSION_REVISION_CHANGED)', async () => {
    expect(await failedFields(ReviewSubmissionDto, { decision: 'APPROVE' })).toEqual([]);
    expect(await failedFields(ReviewSubmissionDto, { decision: 'APPROVE', revisionNo: 2 })).toEqual([]);
    expect(await failedFields(ReviewSubmissionDto, { decision: 'APPROVE', revisionNo: null })).toEqual(['revisionNo']);
  });
});

describe('participation DTOs: invisible text and commit hash', () => {
  it.each([ApplyDto, AgentApplyDto])('%p: a message made only of zero-width / filler characters is rejected like a blank one', async (cls) => {
    for (const message of ['\u200B', '\u200B\u200B\u3164', '\u2060\u2063']) expect(await failedFields(cls, { message })).toEqual(['message']);
    expect(await failedFields(cls, { message: 'hi\u200B' })).toEqual([]);
  });

  it.each([SubmitDto, AgentSubmitDto])('%p: a description made only of invisible characters is rejected', async (cls) => {
    for (const description of ['\u200B', '\u200B\u2063', '\u3164']) {
      expect(await failedFields(cls, { submissionUrl: 'https://demo.app', description })).toEqual(['description']);
    }
  });

  it.each([SubmitDto, AgentSubmitDto])('%p: commitSha must be a 4..64 digit hex hash (empty and absent are fine, spaces are trimmed)', async (cls) => {
    const base = { submissionUrl: 'https://demo.app', description: 'd' };
    for (const commitSha of ['abc123', 'deadbeef', 'A'.repeat(40), 'f'.repeat(64), '', '  abc123  ']) expect(await failedFields(cls, { ...base, commitSha })).toEqual([]);
    for (const commitSha of ['zz zz', 'abc', 'g'.repeat(40), 'f'.repeat(65), 'abc 123', 'abc\n123']) expect(await failedFields(cls, { ...base, commitSha })).toEqual(['commitSha']);
    expect(await failedFields(cls, base)).toEqual([]);
    expect(plainToInstance(cls, { ...base, commitSha: '  abc123 ' }).commitSha).toBe('abc123');
  });
});
