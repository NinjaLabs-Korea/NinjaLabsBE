import { readFileSync } from 'fs';
import { join } from 'path';
import { ATTACHABLE, MINTED_OR_LATER, NFT_STATUSES, PARENT_READY, REQUEUE_JOB_SQL, RESTORE_NFT_AFTER_REQUEUE_SQL, sqlIn } from './nft-status';

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('nft-status single source', () => {
  it('NFT_STATUSES equals the nft.status CHECK in migration 0007', () => {
    const sql = readFileSync(join(__dirname, '../../supabase/migrations/0007_nfts.sql'), 'utf8');
    const list = /CHECK \(status IN \(([^)]*)\)\)/.exec(sql)![1];
    expect(list.split(',').map((v) => v.trim().replace(/'/g, ''))).toEqual([...NFT_STATUSES]);
  });

  it('every derived set only uses known statuses', () => {
    for (const set of [PARENT_READY, ATTACHABLE, MINTED_OR_LATER]) {
      for (const status of set) expect(NFT_STATUSES).toContain(status);
    }
  });

  it('sqlIn renders an IN list and refuses unknown values', () => {
    expect(sqlIn(ATTACHABLE)).toBe("IN ('MINTED', 'ATTACHING')");
    expect(sqlIn(PARENT_READY)).toBe("IN ('MINTED', 'ATTACHED')");
    expect(() => sqlIn(["x'; DROP" as never])).toThrow();
    expect(() => sqlIn([])).toThrow();
  });
});

describe('scripts/requeue-nft-jobs.js copies the requeue SQL from nft-status.ts', () => {
  const script = readFileSync(join(__dirname, '../../scripts/requeue-nft-jobs.js'), 'utf8');
  const statements = [...script.matchAll(/`(UPDATE nft[^`]*)`/g)].map((m) => squash(m[1]));

  it('has the job reset and the nft restore statements, equal to the exported constants', () => {
    expect(statements).toContain(squash(REQUEUE_JOB_SQL));
    expect(statements).toContain(squash(RESTORE_NFT_AFTER_REQUEUE_SQL));
  });
});
