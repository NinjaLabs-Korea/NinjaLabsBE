# 보안 체크리스트

> 스캐폴드에 반영된 것 / 구현 단계(Phase 1~3)에서 반드시 챙길 것을 구분해 관리한다.
> PR 리뷰 시 이 문서를 기준으로 확인.

## ✅ 스캐폴드에 반영됨

| 항목 | 위치 |
|---|---|
| SQL 인젝션 차단 — 전 쿼리 파라미터 바인딩, 문자열 조립 없음 | 전체 서비스 |
| refresh token / agent API key **해시만 저장** (sha256), 원문 DB 저장 금지 | `auth.service.ts`, `agents.service.ts` |
| refresh token **회전** — 재발급 시 구 토큰 즉시 폐기, 폐기 토큰 재사용 거부 | `auth.service.ts` refresh() |
| `JWT_SECRET` 미설정/기본값 시 **프로덕션 기동 거부** (fail-fast) | `auth.module.ts` |
| 어드민 API 서버측 가드 (`is_admin` JWT 클레임) — FE `/admin` 공개 문제와 무관하게 서버가 차단 | `admin.guard.ts` |
| 전역 rate limit (IP당 120/min) + 민감 엔드포인트 강화 (refresh 10/min, 닉네임 검사 30/min) | `app.module.ts`, 각 컨트롤러 |
| 보안 헤더 (helmet) | `main.ts` |
| CORS 오리진 화이트리스트 | `main.ts` |
| DTO whitelist — 정의 안 된 필드 자동 제거 (mass assignment 방지) | `main.ts` ValidationPipe |
| payout / nft_job **멱등키** — 중복 지급·중복 민팅 DB 레벨 차단 | `0006`, `0007` 마이그레이션 |
| 지갑 nonce 1회용 + 5분 만료 | `wallets.service.ts`, `0002` |
| 상태 전이 서버측 검증 (마감 후 제출, 승인 전 제출, 확정 후 수정 차단) | `submissions.service.ts`, `admin.service.ts` |
| 트랜잭션 + `FOR UPDATE` — 제출/심사 레이스 컨디션 방지 | `submissions.service.ts` |
| 닉네임 unique 인덱스 — 중복검사~저장 레이스의 최종 방어선 (23505 → 409) | `users.service.ts` |
| 금액 정수 저장 (DECIMAL(78,0)) — 부동소수점 오차 원천 차단 | `0006` |
| 감사 로그 — 민감정보(토큰 원문, private key) 기록 금지 원칙 명시 | `0009` |
| `.env` 커밋 차단 | `.gitignore` |

## 🚧 Phase 1 구현 시 필수 (구글 OAuth / 지갑 검증 구현할 때)

- [ ] **OAuth `state` 파라미터** — CSRF 방지. 세션별 랜덤 state 발급·검증 없이 콜백 처리 금지
- [ ] 콜백에서 토큰을 **URL 쿼리로 FE에 넘기지 말 것** — httpOnly + Secure + SameSite 쿠키 권장 (FE와 방식 합의)
- [ ] **Cloudflare Turnstile 검증** — 가입(첫 로그인) 요청에서 서버측 siteverify 호출 (기획 확정 사항)
- [ ] 지갑 서명 검증(ADR-36) 시: challenge의 `user_id`·`wallet_address` 일치 확인, `used_at` 선점 마킹(재사용 차단), 서명자 pubkey → 주소 유도 일치 확인
- [ ] 만료된 `wallet_verification_challenge` 주기 삭제 (크론)
- [ ] 로그에 이메일·토큰 등 PII/비밀 출력 금지 확인

## 🚧 Phase 2~3 구현 시 필수

- [ ] 에이전트 API key 인증 가드 — 해시 비교는 timing-safe (`crypto.timingSafeEqual`), prefix로 조회 후 검증
- [ ] 파일 업로드 (첨부): MIME/확장자 화이트리스트, 크기 제한(`platform_setting`), Supabase Storage **signed URL** 사용, 공개 버킷 금지
- [ ] payout 자동화 도입 시: 송금 전 잔액 확인, tx 브로드캐스트와 DB 상태 갱신 사이 크래시 복구 로직 (BROADCASTING 상태 재조회)
- [ ] 마스터 지갑 키: 호스팅 secret/Vault 외 저장 금지, 레포·로그·에러 메시지에 노출 금지. **민팅 권한만** 부여 (보상 자금 지갑과 분리 — 기획 확정)

## ⚠️ 운영 전 결정/조치 필요

- [ ] **DB TLS 인증서 검증** — 현재 `rejectUnauthorized: false` (Supabase 기본 연결 관행이지만 MITM에 취약). 운영에서는 Supabase CA 인증서를 받아 `ssl.ca`로 검증 활성화 권장
- [ ] rate limit이 IP 기준 — 프록시/로드밸런서 뒤에서는 `app.set('trust proxy', ...)` 설정 필요 (미설정 시 모든 요청이 LB IP로 묶임)
- [ ] 어드민 계정 부트스트랩 — `is_admin`은 DB에서 수동 지정. 지정 절차·권한자를 운영 문서에 명시
- [ ] 멀티시그 서명자 구성(2-of-3 제안)과 서명자 목록 — 오프체인 정책 문서화
- [ ] `npm audit` CI 통합 + 의존성 업데이트 주기
- [ ] Supabase `service_role` 키는 백엔드에서만 사용, FE·레포 노출 금지
