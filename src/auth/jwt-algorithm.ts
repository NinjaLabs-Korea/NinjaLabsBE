import { JwtSignOptions, JwtVerifyOptions } from '@nestjs/jwt';

/**
 * 우리가 서명하고 검증하는 JWT(access 토큰, OAuth state)의 알고리즘 단일 출처.
 * 모든 signAsync / verifyAsync 호출이 아래 옵션을 넘긴다: 모듈 기본값이나 키 유형이 바뀌어도 (예: 비대칭 키로 교체)
 * 다른 알고리즘으로 서명된 토큰(HS512, none)이 통과하지 않도록 검증 쪽에서 허용 목록을 고정한다.
 * 정적 가드(jwt-algorithm.spec.ts)가 호출부에서 이 옵션이 빠진 것을 잡는다.
 */
export const JWT_ALGORITHM = 'HS256' as const;
export const JWT_SIGN_OPTIONS: Pick<JwtSignOptions, 'algorithm'> = { algorithm: JWT_ALGORITHM };
export const JWT_VERIFY_OPTIONS: Pick<JwtVerifyOptions, 'algorithms'> = { algorithms: [JWT_ALGORITHM] };
