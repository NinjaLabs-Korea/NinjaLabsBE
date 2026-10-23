import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { AdminGuard } from './admin.guard';
import { AuthGuard } from './auth.guard';
import { SessionUser } from './auth.service';

describe('AdminGuard', () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  function setup(user: SessionUser | undefined, adminRows = 1) {
    const request: { user?: SessionUser } = {};
    const authGuard = {
      canActivate: jest.fn(async () => {
        if (!user) throw new UnauthorizedException('INVALID_ACCESS_TOKEN');
        request.user = user;
        return true;
      }),
    };
    const db = { query: jest.fn().mockResolvedValue({ rowCount: adminRows, rows: adminRows ? [{ '?column?': 1 }] : [] }) };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
    const guard = new AdminGuard(authGuard as unknown as AuthGuard, { query: withParamsCheck(db.query) } as unknown as DatabaseService);
    return { guard, context, db, authGuard };
  }

  it('allows an admin whose user row is still admin, active and not deleted', async () => {
    const { guard, context, db } = setup({ userId, isAdmin: true });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('is_admin = true');
    expect(sql).toContain("status = 'ACTIVE'");
    expect(sql).toContain('deleted_at IS NULL');
    expect(params).toEqual([userId]);
  });

  it('rejects a token without the admin claim before touching the database', async () => {
    const { guard, context, db } = setup({ userId, isAdmin: false });
    await expect(guard.canActivate(context)).rejects.toMatchObject({ message: 'ADMIN_ONLY' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects an admin token whose user row lost is_admin (or was suspended/deleted)', async () => {
    const { guard, context } = setup({ userId, isAdmin: true }, 0);
    const error = await guard.canActivate(context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toBe('ADMIN_ONLY');
  });

  it('propagates AuthGuard failures unchanged', async () => {
    const { guard, context, db } = setup(undefined);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.query).not.toHaveBeenCalled();
  });
});
