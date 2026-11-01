import { NotFoundException } from '@nestjs/common';
import { MAX_AVATAR_BYTES } from '../media/media.service';
import { createMockDb, type SqlHandler } from '../test-support/mock-db';
import { UserAvatarService } from './user-avatar.service';

/**
 * 분기만 본다 (동시 탈퇴 404, 파일 검증 실패 시 유저 행을 바꾸지 않음, 멱등 삭제, 감사 기록). 실제 행 변화
 * (옛 media 행 삭제, 남의 이미지 보호, 탈퇴 정리)는 src/test-db/user-avatar.db-spec.ts가 실 Postgres에서 단언한다.
 */
const STMT = {
  lock: /^SELECT avatar_media_id FROM "user" WHERE id = \$1::uuid AND deleted_at IS NULL FOR UPDATE$/,
  read: /^SELECT avatar_media_id FROM "user" WHERE id = \$1::uuid$/,
  insert: /^INSERT INTO media_asset /,
  set: /^UPDATE "user" SET avatar_media_id = \$2::uuid/,
  clear: /^UPDATE "user" SET avatar_media_id = NULL/,
  deleteAsset: /^DELETE FROM media_asset WHERE id = \$1::uuid AND created_by = \$2::uuid$/,
  audit: /^INSERT INTO audit_log /,
} as const;

const on = (match: RegExp, reply: SqlHandler['reply']): SqlHandler => ({ match, reply });
const ok = (rows: unknown[] = []) => ({ rowCount: rows.length, rows });
const userId = '11111111-1111-4111-8111-111111111111';
const oldId = '22222222-2222-4222-8222-222222222222';
const newId = '33333333-3333-4333-8333-333333333333';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const png = (size = PNG.length) => ({ buffer: PNG, mimetype: 'image/png', originalname: 'me.png', size });

function setup(current: string | null | undefined) {
  const handlers = [
    on(STMT.lock, () => (current === undefined ? ok() : ok([{ avatar_media_id: current }]))),
    on(STMT.read, () => ok([{ avatar_media_id: current ?? null }])),
    on(STMT.insert, () => ok([{ id: newId }])),
    on(STMT.set, () => ok([{}])),
    on(STMT.clear, () => ok([{}])),
    on(STMT.deleteAsset, () => ok([{}])),
    on(STMT.audit, () => ok([{}])),
  ];
  const mock = createMockDb({ strict: true, handlers });
  return { ...mock, service: new UserAvatarService(mock.database, { record: jest.fn() } as never) };
}

describe('UserAvatarService.replace', () => {
  it('inserts the new image, points the user at it, deletes the previous asset and audits before/after on the tx client', async () => {
    const { service, txStatements, txClient, query } = setup(oldId);
    const audit = (service as unknown as { audit: { record: jest.Mock } }).audit;
    await expect(service.replace(userId, png())).resolves.toEqual({ avatarUrl: `/media/${newId}` });
    expect(txStatements(STMT.set)[0].params).toEqual([userId, newId]);
    expect(txStatements(STMT.deleteAsset)[0].params).toEqual([oldId, userId]);
    expect(audit.record).toHaveBeenCalledWith(userId, 'USER_AVATAR_UPDATED', 'user', userId, txClient, {
      before: { avatarMediaId: oldId }, after: { avatarMediaId: newId },
    });
    expect(query).not.toHaveBeenCalled(); // everything on the transaction
  });

  it('first upload deletes nothing', async () => {
    const { service, txStatements } = setup(null);
    await service.replace(userId, png());
    expect(txStatements(STMT.deleteAsset)).toHaveLength(0);
  });

  it('a withdrawn (or concurrently withdrawing) user -> 404 USER_NOT_FOUND before any insert', async () => {
    const { service, txStatements } = setup(undefined);
    await expect(service.replace(userId, png())).rejects.toEqual(new NotFoundException('USER_NOT_FOUND'));
    expect(txStatements(STMT.insert)).toHaveLength(0);
  });

  it.each([
    ['no file', undefined, 'MEDIA_FILE_REQUIRED'],
    ['over 2 MiB', png(MAX_AVATAR_BYTES + 1), 'MEDIA_FILE_TOO_LARGE'],
    ['spoofed type', { ...png(), mimetype: 'image/jpeg' }, 'MEDIA_FILE_TYPE_UNSUPPORTED'],
  ])('%s -> 400 %s and the user row is untouched', async (_label, file, code) => {
    const { service, txStatements } = setup(oldId);
    await expect(service.replace(userId, file)).rejects.toMatchObject({ message: code, status: 400 });
    expect(txStatements(STMT.set)).toHaveLength(0);
    expect(txStatements(STMT.deleteAsset)).toHaveLength(0);
  });
});

describe('UserAvatarService.remove', () => {
  it('clears the column, deletes the asset and audits USER_AVATAR_REMOVED', async () => {
    const { service, txStatements, txClient } = setup(oldId);
    const audit = (service as unknown as { audit: { record: jest.Mock } }).audit;
    await expect(service.remove(userId)).resolves.toEqual({ avatarUrl: null });
    expect(txStatements(STMT.clear)).toHaveLength(1);
    expect(txStatements(STMT.deleteAsset)[0].params).toEqual([oldId, userId]);
    expect(audit.record).toHaveBeenCalledWith(userId, 'USER_AVATAR_REMOVED', 'user', userId, txClient, {
      before: { avatarMediaId: oldId }, after: { avatarMediaId: null },
    });
  });

  it('is idempotent without a photo: no update, no delete, no audit row', async () => {
    const { service, txStatements } = setup(null);
    const audit = (service as unknown as { audit: { record: jest.Mock } }).audit;
    await expect(service.remove(userId)).resolves.toEqual({ avatarUrl: null });
    expect(txStatements(STMT.clear)).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('withdrawn user -> 404 USER_NOT_FOUND', async () => {
    const { service } = setup(undefined);
    await expect(service.remove(userId)).rejects.toEqual(new NotFoundException('USER_NOT_FOUND'));
  });
});
