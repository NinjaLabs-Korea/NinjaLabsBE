import { BadRequestException } from '@nestjs/common';
import { SubmissionsService } from './submissions.service';

const BOUNTY = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000004';
const input = { submissionUrl: 'https://example.test/work', description: 'done' };

function service(bountyStatus: string, existing?: { status: string }) {
  const tx = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM bounty WHERE id')) {
        return { rows: [{ application_required: false, submission_mode: 'DIRECT', status: bountyStatus, submission_deadline: new Date(Date.now() - 86_400_000) }], rowCount: 1 };
      }
      if (sql.includes('SELECT id, status, current_revision_no FROM bounty_submission')) {
        return existing ? { rows: [{ id: 'sub-1', current_revision_no: 1, ...existing }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [{ id: 'new' }], rowCount: 1 };
    }),
  };
  const db = { tx: jest.fn(async (fn: (runner: typeof tx) => unknown) => fn(tx)) };
  return new SubmissionsService(db as never);
}

describe('SubmissionsService during review', () => {
  it('accepts a resubmission after a revision request while the bounty is in review', async () => {
    await expect(service('IN_REVIEW', { status: 'REVISION_REQUESTED' }).submit(BOUNTY, USER, input)).resolves.toEqual({ id: 'sub-1', revisionNo: 2, status: 'RESUBMITTED' });
  });

  it('rejects new submissions and in-review updates once submissions are closed', async () => {
    await expect(service('SUBMISSION_CLOSED').submit(BOUNTY, USER, input)).rejects.toThrow(new BadRequestException('BOUNTY_NOT_OPEN'));
    await expect(service('IN_REVIEW', { status: 'IN_REVIEW' }).submit(BOUNTY, USER, input)).rejects.toThrow(new BadRequestException('BOUNTY_NOT_OPEN'));
  });

  it('rejects any submission on a completed bounty', async () => {
    await expect(service('COMPLETED', { status: 'REVISION_REQUESTED' }).submit(BOUNTY, USER, input)).rejects.toThrow(new BadRequestException('BOUNTY_NOT_OPEN'));
  });
});
