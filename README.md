# NinjaLabs Backend

Injective 생태계 빌더 커뮤니티 & 바운티 마켓플레이스 [NinjaLabsFE](https://github.com/NinjaLabs-Korea/NinjaLabsFE)의 백엔드.

**스택**: NestJS 11 · TypeScript 5.9 · PostgreSQL (Supabase) · raw SQL(pg) · CW-721 Nestable NFT (Injective)

## 구조

```
supabase/migrations/   스키마의 소스 오브 트루스 (ERD v1 → SQL, 24 테이블)
src/
  common/database/     pg Pool 기반 DatabaseService (query + tx 헬퍼)
  auth/                구글 OAuth → JWT 세션, AuthGuard / AdminGuard
  users/               온보딩 프로필, 닉네임 중복검사, 공개 프로필
  wallets/             지갑 연결 challenge/verify (nonce 서명 방식)
  members/             공식 멤버 탭 (공개) + 운영자 멤버 지정
  notices/             공지/소식 (공개 읽기) + 운영자 공지 관리
  highlights/          Hall of Fame 큐레이션 + 자동 집계 지표 + 운영자 관리
  media/               관리자 이미지 업로드 + 공개 immutable 조회
  bounties/            바운티 목록/상세 + applications + submissions(리비전)
    bounty-status.ts     바운티 상태 집합·전이표의 단일 출처
    admin/               운영자 바운티 관리 + 전이 차단 사유(lifecycle)
  rewards/             선입금 확인 → payout 멱등 지급 흐름 (운영자 API 포함)
  nfts/                부모/자식 NFT + nft_job 비동기 워커 (1분 폴링)
  agents/              AI 에이전트 등록/검증/API key + Agent API 인증
  audit/               감사 로그 기록(AuditService) + 조회
scripts/migrate.js     Supabase CLI 없이 쓰는 마이그레이션 러너
docs/
  api-contract.md      FE와 합의할 REST API 계약 (FE docs/auth-api-contract.md 대응)
  decisions.md         미결정 사항에 대한 MVP 디폴트 제안
  security.md          보안 체크리스트 (반영됨 / 구현 시 필수 / 운영 전 조치)
```

### 코드 배치 규칙

- **운영자 API는 도메인 모듈 안에 둔다.** `/admin/*` 라우트는 전용 `admin` 모듈이 아니라 해당 도메인 모듈의
  `*-admin.controller.ts` / `*-admin.service.ts`에 있다 (예: `notices/notice-admin.*`, `bounties/admin/*`).
  모든 운영자 컨트롤러는 `@UseGuards(AdminGuard)`를 붙이고 `AuthedRequest`로 `req.user`를 받는다.
- **감사 로그는 `AuditService.record()`로만 남긴다.** 트랜잭션 안이면 `tx`를 마지막 인자로 넘긴다.
- **바운티 상태 문자열 배열을 직접 만들지 않는다.** `bounties/bounty-status.ts`의 `BountyStatusPolicy`를 쓴다.
- **유니크 충돌 판별은 `isUniqueViolation(err)`** (`common/database/pg-errors.ts`).

## 시작하기

요구 사항: Node 22+ · npm

```bash
npm install
cp .env.example .env        # DATABASE_URL 등 채우기
npm run migrate             # supabase/migrations 순서대로 적용
npm run start:dev           # http://localhost:4000
```

Supabase 프로젝트 생성 후 `Project Settings → Database → Connection string`을 `DATABASE_URL`에 넣으면 된다. Supabase CLI를 쓰는 팀이면 `npm run migrate` 대신 `supabase db push`도 가능 (마이그레이션 디렉터리 규칙 호환).
