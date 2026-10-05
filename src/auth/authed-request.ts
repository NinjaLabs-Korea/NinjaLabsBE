import { Request } from 'express';
import { SessionUser } from './auth.service';

/** AuthGuard/AdminGuard를 통과한 요청 — req.user가 항상 채워져 있다 */
export type AuthedRequest = Request & { user: SessionUser };
