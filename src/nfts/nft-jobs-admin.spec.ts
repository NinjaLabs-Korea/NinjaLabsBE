import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { NftJobsQueryDto } from './nft-jobs-admin.controller';
import { NFT_JOB_PAGE_SIZE, NftJobsAdminService } from './nft-jobs-admin.service';

const jobId = '11111111-1111-4111-8111-111111111111';
const nftId = '22222222-2222-4222-8222-222222222222';

/** `db.query` (autocommit) and `tx.query` are separate mocks — the retry must run entirely inside the transaction */
function setup(txRows: { job: number }) {
  const dbQuery = jest.fn(withParamsCheck(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('count(*)')) return { rowCount: 1, rows: [{ total: 42 }] };
    return { rowCount: 1, rows: [{ id: jobId }] };
  }));
  const txQuery = jest.fn(withParamsCheck(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('UPDATE nft_job')) {
      return txRows.job ? { rowCount: 1, rows: [{ id: jobId, nft_id: nftId, status: 'PENDING', retry_count: 0 }] } : { rowCount: 0, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  }));
  const db = { query: dbQuery, tx: (fn: (tx: { query: jest.Mock }) => Promise<unknown>) => fn({ query: txQuery }) } as unknown as DatabaseService;
  return { service: new NftJobsAdminService(db, new AuditService(db)), dbQuery, txQuery };
}

describe('NftJobsAdminService', () => {
  it('lists one status page (30/page, newest update first) with the total for that status', async () => {
    const { service, dbQuery } = setup({ job: 1 });
    await expect(service.list({ status: 'FAILED', page: 3 })).resolves.toEqual({ items: [{ id: jobId }], page: 3, pageSize: NFT_JOB_PAGE_SIZE, total: 42 });
    const [listSql, listParams] = dbQuery.mock.calls[0];
    expect(listSql).toContain('WHERE j.status = $1');
    expect(listSql).toContain('ORDER BY j.updated_at DESC, j.id');
    expect(listParams).toEqual(['FAILED', 30, 60]);
    expect(dbQuery.mock.calls[1][1]).toEqual(['FAILED']);
  });

  it('retry: FAILED → PENDING with retry_count reset, the nft back to MINTED/PENDING, and NFT_JOB_RETRIED audited in the same transaction', async () => {
    const { service, dbQuery, txQuery } = setup({ job: 1 });
    await expect(service.retry(jobId, 'admin')).resolves.toEqual({ id: jobId, nft_id: nftId, status: 'PENDING', retry_count: 0 });
    expect(txQuery.mock.calls[0][0]).toContain("SET status = 'PENDING', retry_count = 0, scheduled_at = now(), started_at = NULL, processed_at = NULL");
    expect(txQuery.mock.calls[0][0]).toContain("WHERE id = $1 AND status = 'FAILED'");
    expect(txQuery.mock.calls[0][1]).toEqual([jobId]);
    expect(txQuery.mock.calls[1][0]).toContain("CASE WHEN minted_at IS NOT NULL THEN 'MINTED' ELSE 'PENDING' END");
    expect(txQuery.mock.calls[1][1]).toEqual([nftId]);
    expect(txQuery.mock.calls[2]).toEqual([expect.stringContaining('INSERT INTO audit_log'), ['admin', 'NFT_JOB_RETRIED', 'nft_job', jobId]]);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('retry of a job that is not FAILED (or does not exist) → 404 NFT_JOB_NOT_FOUND_OR_NOT_FAILED, nothing else written', async () => {
    const { service, txQuery } = setup({ job: 0 });
    await expect(service.retry(jobId, 'admin')).rejects.toEqual(new NotFoundException('NFT_JOB_NOT_FOUND_OR_NOT_FAILED'));
    expect(txQuery).toHaveBeenCalledTimes(1);
  });
});

describe('NftJobsQueryDto', () => {
  const errors = async (query: Record<string, string>) =>
    (await validate(plainToInstance(NftJobsQueryDto, query))).map((error) => error.property);

  it.each([{}, { status: 'FAILED' }, { status: 'PENDING', page: '2' }, { status: 'PROCESSING' }])('accepts %j', async (query) => {
    expect(await errors(query as Record<string, string>)).toEqual([]);
  });

  it.each([[{ status: 'SUCCEEDED' }, 'status'], [{ status: 'failed' }, 'status'], [{ page: '0' }, 'page'], [{ page: 'abc' }, 'page'], [{ page: '100001' }, 'page']])('rejects %j', async (query, property) => {
    expect(await errors(query as Record<string, string>)).toEqual([property]);
  });
});
