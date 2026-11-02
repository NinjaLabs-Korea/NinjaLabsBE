import { AuditService } from '../../audit/audit.service';
import { createMockDb, SqlHandler } from '../../test-support/mock-db';
import { SubmissionsService } from './submissions.service';

/**
 * 단위 스펙은 검사 순서(어떤 오류가 어떤 조회보다 먼저인가)와 트랜잭션 경계만 본다. 어떤 행이 만들어지고 바뀌는지
 * (상태 x 마감 x 기존 제출 상태 표, 지원 승인 연결, 리비전 스냅샷, 내 제출 내역 쿼리)는 src/test-db/submissions.db-spec.ts가 실 DB 행으로 단언한다.
 * DB 대역은 엄격 모드라, 오류가 나야 하는 시점 뒤의 문장(온보딩 조회, 지원서 조회, 쓰기)이 나가면 `Unexpected SQL`로 실패한다.
 */
describe('SubmissionsService check order', () => {
  const input = { submissionUrl: 'https://example.com/result', description: 'done' };
  const bountyLock: SqlHandler['match'] = /FROM bounty WHERE id = \$1 AND deleted_at IS NULL FOR UPDATE$/;

  function setup(bounty: Record<string, unknown> | null) {
    const mock = createMockDb({
      strict: true,
      handlers: [{
        match: bountyLock,
        reply: () => (bounty
          ? { rowCount: 1, rows: [{ application_required: false, submission_mode: 'DIRECT', status: 'OPEN', submission_deadline: '2999-01-01', ...bounty }] }
          : { rowCount: 0, rows: [] }),
      }],
    });
    return { mock, service: new SubmissionsService(mock.database, new AuditService(mock.database)) };
  }

  it('locks the bounty row inside one transaction and never uses the pool', async () => {
    const { mock, service } = setup(null);
    await expect(service.submit('bounty', 'user', input)).rejects.toMatchObject({ status: 404, message: 'BOUNTY_NOT_FOUND' });
    expect(mock.db.tx).toHaveBeenCalledTimes(1);
    expect(mock.txStatements(bountyLock)[0].params).toEqual(['bounty']);
    expect(mock.db.query).not.toHaveBeenCalled();
  });

  it.each(['DRAFT', 'FUNDING_PENDING', 'COMPLETED', 'CANCELLED'])('a %s bounty is BOUNTY_NOT_OPEN before the mode, onboarding and application checks', async (status) => {
    const { service } = setup({ status, submission_mode: 'AGENT' });
    await expect(service.submit('bounty', 'user', input)).rejects.toMatchObject({ status: 400, message: 'BOUNTY_NOT_OPEN' });
  });

  it('a browser user on an agent-only bounty and an agent on a direct bounty are refused before the onboarding lookup', async () => {
    await expect(setup({ submission_mode: 'AGENT' }).service.submit('bounty', 'user', input))
      .rejects.toMatchObject({ status: 400, message: 'AGENT_SUBMISSION_REQUIRED' });
    await expect(setup({ submission_mode: 'DIRECT' }).service.submitAsAgent('bounty', 'agent', input))
      .rejects.toMatchObject({ status: 400, message: 'DIRECT_SUBMISSION_REQUIRED' });
  });

  it('the onboarding lookup runs before the application lookup and the existing-submission lock: an unfinished profile stops there (409 PROFILE_REQUIRED)', async () => {
    const mock = createMockDb({
      strict: true,
      handlers: [
        { match: /FROM bounty WHERE id = \$1/, reply: () => ({ rowCount: 1, rows: [{ application_required: true, submission_mode: 'DIRECT', status: 'OPEN', submission_deadline: '2999-01-01' }] }) },
        { match: /onboarding_completed_at IS NOT NULL AS done FROM "user"/, reply: () => ({ rowCount: 1, rows: [{ done: false }] }) },
      ],
    });
    await expect(new SubmissionsService(mock.database, new AuditService(mock.database)).submit('bounty', 'user', input))
      .rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
    expect(mock.txStatements(/onboarding_completed_at/)[0].params).toEqual(['user']);
  });

  it('an agent\'s onboarding check follows its owner and is bound to the agent id', async () => {
    const mock = createMockDb({
      strict: true,
      handlers: [
        { match: /FROM bounty WHERE id = \$1/, reply: () => ({ rowCount: 1, rows: [{ application_required: false, submission_mode: 'AGENT', status: 'OPEN', submission_deadline: '2999-01-01' }] }) },
        { match: /onboarding_completed_at IS NOT NULL AS done\s*FROM agent a JOIN "user" u/, reply: () => ({ rowCount: 1, rows: [{ done: false }] }) },
      ],
    });
    await expect(new SubmissionsService(mock.database, new AuditService(mock.database)).submitAsAgent('bounty', 'agent', input))
      .rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
    expect(mock.txStatements(/FROM agent a JOIN "user" u/)[0].params).toEqual(['agent']);
  });
});

describe('SubmissionsService.mySubmissions', () => {
  it('runs one pooled read bound to the user id and returns its rows unchanged', async () => {
    const rows = [{ id: 's1', status: 'SUBMITTED' }];
    const mock = createMockDb({ strict: true, handlers: [{ match: /^SELECT s\.id, s\.status/, reply: () => ({ rowCount: 1, rows }) }] });
    await expect(new SubmissionsService(mock.database, new AuditService(mock.database)).mySubmissions('user')).resolves.toBe(rows);
    expect(mock.statements(/./)).toHaveLength(1);
    expect(mock.statements(/./)[0].params).toEqual(['user']);
    expect(mock.db.tx).not.toHaveBeenCalled();
  });
});
