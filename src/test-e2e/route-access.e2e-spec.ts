import { describeDb } from '../test-db/describe-db';
import { E2eApp, startApp } from './support/harness';

const ID = '00000000-0000-4000-8000-000000000000';

/** 등록된 모든 Express 라우트 - `METHOD /path` (Nest 컨트롤러가 만든 것 전부, 가드 데코레이터 해석 없이 실제 앱에서 읽는다) */
function registeredRoutes(e2e: E2eApp): Array<{ method: string; path: string }> {
  const router = (e2e.app.getHttpAdapter().getInstance() as { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } }).router;
  return router.stack.flatMap((layer) => (layer.route ? Object.keys(layer.route.methods).map((m) => ({ method: m.toUpperCase(), path: layer.route!.path })) : []));
}

/**
 * 인증이 필요 없는 라우트의 **명시적 허용 목록**. 새 라우트는 기본적으로 로그인(401)이 필요하다고 가정하므로, 가드를 깜빡한 새 컨트롤러는
 * 이 목록에 일부러 올리지 않는 한 아래 테스트에서 실패한다. 목록에 올릴 때는 공개해도 되는 이유를 docs/api-contract.md와 함께 확인한다.
 */
const PUBLIC_ROUTES = new Set([
  'GET /health',
  'GET /auth/google', 'GET /auth/google/callback', 'POST /auth/exchange', 'POST /auth/refresh', 'POST /auth/logout', // 자격 증명은 쿼리/본문/쿠키로 직접 검증
  'GET /users/check-nickname', 'GET /users/:nickname',
  'GET /members', 'GET /hall-of-fame', 'GET /hall-of-fame/stats',
  'GET /notices', 'GET /notices/:id', 'GET /cohorts/current', 'GET /bounties', 'GET /bounties/:id', 'GET /media/:id',
]);

describeDb('route access inventory (e2e)', () => {
  let e2e: E2eApp;
  beforeAll(async () => { e2e = await startApp(); });
  afterAll(async () => e2e?.close());

  const fill = (path: string) => path.replace(/:nickname/g, 'someone').replace(/:\w+/g, ID);

  it('finds the whole route table (sanity: a router change must not make this guard vacuous)', () => {
    const routes = registeredRoutes(e2e);
    expect(routes.length).toBeGreaterThanOrEqual(60);
    expect(routes.filter((r) => PUBLIC_ROUTES.has(`${r.method} ${r.path}`)).length).toBe(PUBLIC_ROUTES.size); // 허용 목록에 죽은 항목이 없다
  });

  it('every route outside the public allowlist answers an anonymous request with 401', async () => {
    const open: string[] = [];
    for (const { method, path } of registeredRoutes(e2e)) {
      if (PUBLIC_ROUTES.has(`${method} ${path}`)) continue;
      const res = await e2e.request(method, fill(path));
      if (res.status !== 401) open.push(`${method} ${path} → ${res.status}`);
    }
    expect(open).toEqual([]);
  });

  it('every /admin route refuses a signed-in non-admin with 403 ADMIN_ONLY', async () => {
    const user = await e2e.login();
    const open: string[] = [];
    for (const { method, path } of registeredRoutes(e2e)) {
      if (!path.startsWith('/admin/')) continue;
      const res = await e2e.request(method, fill(path), { token: user.accessToken });
      if (res.status !== 403 || res.body?.message !== 'ADMIN_ONLY') open.push(`${method} ${path} → ${res.status} ${res.text.slice(0, 80)}`);
    }
    expect(open).toEqual([]);
  });
});
