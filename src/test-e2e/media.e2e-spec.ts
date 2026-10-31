import { createHash } from 'crypto';
import { describeDb } from '../test-db/describe-db';
import { E2eApp, multipart, PNG_1x1, Session, startApp } from './support/harness';

const badRequest = (message: string) => ({ statusCode: 400, error: 'Bad Request', message });

// i. media - admin multipart upload (FE: FormData with one `file` part) + public immutable reads
describeDb('media over HTTP (e2e)', () => {
  let e2e: E2eApp;
  let admin: Session;
  beforeAll(async () => {
    e2e = await startApp();
    admin = await e2e.loginAdmin();
  });
  afterAll(async () => e2e?.close());

  function upload(value: Buffer, contentType: string, filename = 'cover.png', field = 'file', token = admin.accessToken) {
    const form = multipart([{ name: field, value, filename, contentType }]);
    return e2e.request('POST', '/admin/media', { body: form.body, headers: { 'content-type': form.contentType }, token });
  }

  it('upload png → 201 {id, url:"/media/<uuid>"}; GET serves the bytes with an immutable cache, ETag and nosniff; If-None-Match → 304', async () => {
    const res = await upload(PNG_1x1, 'image/png');
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['id', 'url']);
    expect(res.body.url).toBe(`/media/${res.body.id}`);

    const served = await e2e.get(res.body.url);
    expect(served.status).toBe(200);
    expect(Buffer.compare(served.body as Buffer, PNG_1x1)).toBe(0);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['content-length']).toBe(String(PNG_1x1.length));
    expect(served.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(served.headers.etag).toBe(`"${createHash('sha256').update(PNG_1x1).digest('hex')}"`);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin'); // helmet's global same-origin would stop a cross-origin <img>

    const revalidated = await e2e.get(res.body.url, { headers: { 'if-none-match': String(served.headers.etag) } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.text).toBe('');
  });

  it('jpeg and webp with matching magic bytes are accepted', async () => {
    expect((await upload(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), 'image/jpeg', 'a.jpg')).status).toBe(201);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
    expect((await upload(webp, 'image/webp', 'a.webp')).status).toBe(201);
  });

  it('a file over 5 MiB → 400 MEDIA_FILE_TOO_LARGE (multer limit mapped to the same code as the service check)', async () => {
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(5 * 1024 * 1024)]);
    const res = await upload(big, 'image/png');
    expect(res.status).toBe(400);
    expect(res.body).toEqual(badRequest('MEDIA_FILE_TOO_LARGE'));
  });

  it('a spoofed mimetype is refused by magic-byte sniffing → 400 MEDIA_FILE_TYPE_UNSUPPORTED', async () => {
    expect((await upload(PNG_1x1, 'image/jpeg', 'x.jpg')).body).toEqual(badRequest('MEDIA_FILE_TYPE_UNSUPPORTED'));
    expect((await upload(Buffer.from('<svg onload=alert(1)>'), 'image/png', 'x.png')).body).toEqual(badRequest('MEDIA_FILE_TYPE_UNSUPPORTED'));
    expect((await upload(Buffer.from('GIF89a....'), 'image/gif', 'x.gif')).body).toEqual(badRequest('MEDIA_FILE_TYPE_UNSUPPORTED'));
    expect((await upload(Buffer.from('<svg/>'), 'image/svg+xml', 'x.svg')).body).toEqual(badRequest('MEDIA_FILE_TYPE_UNSUPPORTED'));
  });

  it('no file / wrong field name / non-admin / unknown id', async () => {
    const empty = multipart([{ name: 'note', value: 'hello' }]);
    const none = await e2e.request('POST', '/admin/media', { body: empty.body, headers: { 'content-type': empty.contentType }, token: admin.accessToken });
    expect(none.body).toEqual(badRequest('MEDIA_FILE_REQUIRED'));
    const wrongField = await upload(PNG_1x1, 'image/png', 'a.png', 'image');
    expect(wrongField.status).toBe(400);
    const user = await e2e.login();
    const forbidden = await upload(PNG_1x1, 'image/png', 'a.png', 'file', user.accessToken);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.message).toBe('ADMIN_ONLY');
    const missing = await e2e.get('/media/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ statusCode: 404, error: 'Not Found', message: 'MEDIA_NOT_FOUND' });
  });
  it('serves each asset with its own stored mime type (webp → image/webp) and a byte-exact Content-Length', async () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(20, 7)]);
    const created = await upload(webp, 'image/webp', 'a.webp');
    const served = await e2e.get(created.body.url);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
    expect(served.headers['content-length']).toBe(String(webp.length));
    expect(Buffer.compare(served.body as Buffer, webp)).toBe(0);
    expect(served.headers.etag).toBe(`"${createHash('sha256').update(webp).digest('hex')}"`);
  });

  it('the same bytes uploaded twice get two ids but the same ETag (content hash), and a 300-char file name is stored truncated to 255', async () => {
    const longName = `${'n'.repeat(300)}.png`;
    const a = await upload(PNG_1x1, 'image/png', longName);
    const b = await upload(PNG_1x1, 'image/png');
    expect(a.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    const [ea, eb] = await Promise.all([e2e.get(a.body.url), e2e.get(b.body.url)]);
    expect(ea.headers.etag).toBe(eb.headers.etag);
    const row = await e2e.db.query<{ file_name: string; created_by: string }>(`SELECT file_name, created_by FROM media_asset WHERE id = $1`, [a.body.id]);
    expect(row.rows[0].file_name).toBe('n'.repeat(255));
    expect(row.rows[0].created_by).toBe(admin.userId);
  });

  it('a non-ASCII file name (the browser sends UTF-8 bytes) is stored as typed, not as latin1 mojibake', async () => {
    const created = await upload(PNG_1x1, 'image/png', '한글 커버 🥷.png');
    expect(created.status).toBe(201);
    const row = await e2e.db.query<{ file_name: string }>(`SELECT file_name FROM media_asset WHERE id = $1`, [created.body.id]);
    expect(row.rows[0].file_name).toBe('한글 커버 🥷.png');
  });

  it('a request with two file parts is refused with 400 (multer files: 1) and stores nothing', async () => {
    const before = (await e2e.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM media_asset`)).rows[0].n;
    const form = multipart([
      { name: 'file', value: PNG_1x1, filename: 'a.png', contentType: 'image/png' },
      { name: 'file', value: PNG_1x1, filename: 'b.png', contentType: 'image/png' },
    ]);
    const res = await e2e.request('POST', '/admin/media', { body: form.body, headers: { 'content-type': form.contentType }, token: admin.accessToken });
    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
    expect((await e2e.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM media_asset`)).rows[0].n).toBe(before);
  });

  it('GET /media/:id with a non-UUID id is 400 (ParseUUIDPipe), and an unauthenticated upload is 401', async () => {
    expect((await e2e.get('/media/not-a-uuid')).status).toBe(400);
    const form = multipart([{ name: 'file', value: PNG_1x1, filename: 'a.png', contentType: 'image/png' }]);
    const anon = await e2e.request('POST', '/admin/media', { body: form.body, headers: { 'content-type': form.contentType } });
    expect(anon.status).toBe(401);
  });
});
