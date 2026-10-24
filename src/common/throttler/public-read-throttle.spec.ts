import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { BountiesController } from '../../bounties/bounties.controller';
import { HighlightsController } from '../../highlights/highlights.controller';
import { MediaController } from '../../media/media.controller';
import { MembersController } from '../../members/members.controller';
import { NoticesController } from '../../notices/notices.controller';
import { UsersController } from '../../users/users.controller';
import { PUBLIC_READ_IP_THROTTLE } from './public-read-throttle';

const LIMIT = 'THROTTLER:LIMITdefault';
const TTL = 'THROTTLER:TTLdefault';

type Ctor = { prototype: any };
const limitOf = (c: Ctor, handler: string) => Reflect.getMetadata(LIMIT, c.prototype[handler] as object);
const ttlOf = (c: Ctor, handler: string) => Reflect.getMetadata(TTL, c.prototype[handler] as object);

// 공개 GET 핸들러 전부 
const PUBLIC_READ_HANDLERS: Array<[string, Ctor, string]> = [
  ['GET /bounties', BountiesController, 'list'],
  ['GET /bounties/:id', BountiesController, 'detail'],
  ['GET /notices', NoticesController, 'list'],
  ['GET /notices/:id', NoticesController, 'detail'],
  ['GET /members', MembersController, 'list'],
  ['GET /hall-of-fame', HighlightsController, 'list'],
  ['GET /hall-of-fame/stats', HighlightsController, 'stats'],
  ['GET /media/:id', MediaController, 'get'],
  ['GET /users/:nickname', UsersController, 'publicProfile'],
];

describe('PUBLIC_READ_IP_THROTTLE', () => {
  it('is 600 per 60s', () => {
    expect(PUBLIC_READ_IP_THROTTLE).toEqual({ default: { ttl: 60_000, limit: 600 } });
  });

  it.each(PUBLIC_READ_HANDLERS)('%s carries the 600/min override', (_label, ctrl, handler) => {
    expect(Reflect.getMetadata(METHOD_METADATA, ctrl.prototype[handler] as object)).toBe(RequestMethod.GET);
    expect(limitOf(ctrl, handler)).toBe(600);
    expect(ttlOf(ctrl, handler)).toBe(60_000);
  });

  it('no non-GET handler of those controllers is raised to 600 (writes keep 120 or stricter)', () => {
    for (const [, ctrl] of PUBLIC_READ_HANDLERS) {
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        if (name === 'constructor') continue;
        const fn = ctrl.prototype[name] as object;
        const method = Reflect.getMetadata(METHOD_METADATA, fn);
        if (method !== undefined && method !== RequestMethod.GET) expect(limitOf(ctrl, name)).not.toBe(600);
      }
    }
  });
});

describe('sensitive users routes keep their own limits', () => {
  it('check-nickname stays 30 and DELETE /users/me stays 5', () => {
    const limits = Object.getOwnPropertyNames(UsersController.prototype)
      .map((n) => Reflect.getMetadata(LIMIT, (UsersController.prototype as any)[n] as object))
      .filter((l) => l !== undefined)
      .sort((a, b) => a - b);
    expect(limits).toEqual([5, 30, 600]);
  });
});
