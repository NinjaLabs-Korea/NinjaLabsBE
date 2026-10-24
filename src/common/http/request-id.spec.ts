import { Request, Response } from 'express';
import { REQUEST_ID_HEADER, requestIdMiddleware, resolveRequestId, ridSuffix } from './request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('request id', () => {
  it('keeps a valid incoming id', () => {
    expect(resolveRequestId('abc12345')).toBe('abc12345');
    expect(resolveRequestId('a.b_c-D9'.repeat(8))).toBe('a.b_c-D9'.repeat(8));
  });

  it.each([
    ['too short', 'abc1234'],
    ['too long', 'a'.repeat(65)],
    ['space', 'abc 12345'],
    ['CRLF injection', 'abc12345\r\nSet-Cookie: x=1'],
    ['trailing newline', 'abc12345\n'],
    ['non-ascii', 'abcdéfgh12'],
    ['empty', ''],
    ['missing', undefined],
    ['duplicate header (array)', ['abc12345', 'def67890']],
  ])('replaces a bad id (%s) with a generated UUID', (_label, incoming) => {
    expect(resolveRequestId(incoming)).toMatch(UUID);
  });

  it('middleware stores the id on the request, sets the response header and calls next', () => {
    const req = { headers: { 'x-request-id': 'client-id-1234' } } as unknown as Request;
    const setHeader = jest.fn();
    const next = jest.fn();
    requestIdMiddleware(req, { setHeader } as unknown as Response, next);
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, 'client-id-1234');
    expect(ridSuffix(req)).toBe(' rid=client-id-1234');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('middleware never echoes a malicious id', () => {
    const req = { headers: { 'x-request-id': 'abc12345\r\nX: y' } } as unknown as Request;
    const setHeader = jest.fn();
    requestIdMiddleware(req, { setHeader } as unknown as Response, jest.fn());
    expect(setHeader.mock.calls[0][1]).toMatch(UUID);
  });

  it('ridSuffix is empty without an id', () => {
    expect(ridSuffix({} as Request)).toBe('');
    expect(ridSuffix(undefined)).toBe('');
  });
});
