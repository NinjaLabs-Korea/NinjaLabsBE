import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReviewApplicationDto } from './applications/application-review.controller';
import { ReviewSubmissionDto } from './submissions/submission-review.controller';

const failedFields = async (cls: new () => object, body: object) =>
  (await validate(plainToInstance(cls, body))).map((error) => error.property).sort();

describe('review comment and application note', () => {
  it('turns an invisible-only comment/note into null so the required-comment rule (REVISION_COMMENT_REQUIRED) fires', () => {
    for (const text of ['​', '​​', '͏', '   ', '']) {
      expect(plainToInstance(ReviewSubmissionDto, { decision: 'REQUEST_REVISION', comment: text }).comment).toBeNull();
      expect(plainToInstance(ReviewApplicationDto, { decision: 'REJECTED', note: text }).note).toBeNull();
    }
    expect(plainToInstance(ReviewSubmissionDto, { decision: 'REJECT', comment: '  fix it  ' }).comment).toBe('fix it');
  });

  it('refuses bidi override in both, and a comment that starts with the forfeit marker (any case)', async () => {
    expect(await failedFields(ReviewSubmissionDto, { decision: 'REJECT', comment: 'a‮b' })).toEqual(['comment']);
    expect(await failedFields(ReviewApplicationDto, { decision: 'REJECTED', note: 'a‮b' })).toEqual(['note']);
    for (const comment of ['forfeited: spam', 'FORFEITED: this was low effort spam', '  Forfeited : x']) {
      expect(await failedFields(ReviewSubmissionDto, { decision: 'REJECT', comment })).toEqual(['comment']);
    }
    expect(await failedFields(ReviewSubmissionDto, { decision: 'REJECT', comment: 'We forfeited nothing: ok' })).toEqual([]);
    expect(await failedFields(ReviewSubmissionDto, { decision: 'REJECT', comment: 'not accepted' })).toEqual([]);
  });
});
