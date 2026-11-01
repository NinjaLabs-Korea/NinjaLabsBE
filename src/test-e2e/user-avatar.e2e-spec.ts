import { describeDb } from '../test-db/describe-db';
import { E2eApp, multipart, PNG_1x1, Session, startApp } from './support/harness';

const badRequest = (message: string) => ({ statusCode: 400, error: 'Bad Request', message });

// 회원 프로필 사진 - FE /account가 FormData(`file` 하나)로 올리고, 헤더 칩·공개 프로필·멤버 카드·/home이 avatarUrl을 그린다
describeDb('profile avatar over HTTP (e2e)', () => {
  let e2e: E2eApp;
  beforeAll(async () => {
    e2e = await startApp();
  });
  afterAll(async () => e2e?.close());

  function upload(session: Session | null, value: Buffer, contentType = 'image/png', field = 'file') {
    const form = multipart([{ name: field, value, filename: 'me.png', contentType }]);
    return e2e.request('POST', '/users/me/avatar', {
      body: form.body, headers: { 'content-type': form.contentType }, token: session?.accessToken,
    });
  }

  it('upload -> 201 {avatarUrl}; /auth/me, the public profile and /members carry it; the image is served from /media; delete -> null', async () => {
    const session = await e2e.loginOnboarded();
    const nickname = `ava_${session.userId.slice(0, 8)}`;
    await e2e.db.query(`UPDATE "user" SET nickname = $2, is_member = true, member_role = 'DEV' WHERE id = $1`, [session.userId, nickname]);

    const before = await e2e.get('/auth/me', { token: session.accessToken });
    expect(before.body.avatarUrl).toBeNull();

    const res = await upload(session, PNG_1x1);
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['avatarUrl']);
    expect(res.body.avatarUrl).toMatch(/^\/media\/[0-9a-f-]{36}$/);

    const served = await e2e.get(res.body.avatarUrl);
    expect(served.status).toBe(200);
    expect(Buffer.compare(served.body as Buffer, PNG_1x1)).toBe(0);
    expect(served.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    expect((await e2e.get('/auth/me', { token: session.accessToken })).body.avatarUrl).toBe(res.body.avatarUrl);
    expect((await e2e.get(`/users/${encodeURIComponent(nickname)}`)).body.avatar_url).toBe(res.body.avatarUrl);
    const members = await e2e.get('/members');
    expect(members.body.find((m: { id: string }) => m.id === session.userId).avatar_url).toBe(res.body.avatarUrl);

    const removed = await e2e.delete('/users/me/avatar', { token: session.accessToken });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ avatarUrl: null });
    expect((await e2e.get(res.body.avatarUrl)).status).toBe(404); // the old image is gone, not just unlinked
    expect((await e2e.get('/auth/me', { token: session.accessToken })).body.avatarUrl).toBeNull();
  });

  it('a user still in onboarding can set a photo too (same rule as saving the profile)', async () => {
    const session = await e2e.login();
    expect((await upload(session, PNG_1x1)).status).toBe(201);
  });

  it('over 2 MiB -> 400 MEDIA_FILE_TOO_LARGE (multer limit mapped to the media code); spoofed type / no file -> the media codes', async () => {
    const session = await e2e.login();
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(2 * 1024 * 1024)]);
    expect((await upload(session, big)).body).toEqual(badRequest('MEDIA_FILE_TOO_LARGE'));
    expect((await upload(session, PNG_1x1, 'image/jpeg')).body).toEqual(badRequest('MEDIA_FILE_TYPE_UNSUPPORTED'));
    expect((await upload(session, Buffer.from('<svg/>'), 'image/svg+xml')).body).toEqual(badRequest('MEDIA_FILE_TYPE_UNSUPPORTED'));
    const empty = multipart([{ name: 'note', value: 'hello' }]);
    const none = await e2e.request('POST', '/users/me/avatar', { body: empty.body, headers: { 'content-type': empty.contentType }, token: session.accessToken });
    expect(none.body).toEqual(badRequest('MEDIA_FILE_REQUIRED'));
    expect((await e2e.get('/auth/me', { token: session.accessToken })).body.avatarUrl).toBeNull();
  });

  it('anonymous upload and delete -> 401 before multer reads the body', async () => {
    expect((await upload(null, PNG_1x1)).status).toBe(401);
    expect((await e2e.delete('/users/me/avatar')).status).toBe(401);
  });

  it('the cookie-mode refresh `user` carries avatarUrl like /auth/me', async () => {
    const session = await e2e.login();
    const { avatarUrl } = (await upload(session, PNG_1x1)).body;
    const refreshed = await e2e.request('POST', '/auth/refresh', {
      json: { refreshToken: session.refreshToken }, headers: { 'x-ninja-session': 'cookie' },
    });
    expect(refreshed.status).toBe(200);
    e2e.trackTokens(refreshed.body);
    expect(refreshed.body.user.avatarUrl).toBe(avatarUrl);
  });
});
