import { defineRailway, preserve, project, service } from "railway/iac";

export const partial = "ninjalabsbe";

export default defineRailway(() => {
  const web = service("ninjalabsbe", {
    start: "npm run start:prod",
    // 새 컨테이너가 뜨기 전에 supabase/migrations를 적용한다 — 새 코드가 옛 스키마 위에서 기동하면 SchemaGuard가 MIGRATIONS_PENDING으로 거부한다 (README "배포")
    preDeploy: "npm run migrate",
    healthcheck: "/health",
    healthcheckTimeout: 120,
    deploy: {
      // SIGTERM → SIGKILL 유예. 종료 훅이 크론/NFT 워커를 드레인(최대 20초, common/lifecycle/single-flight-task.ts)하고 진행 중 HTTP 요청을 끝낸 뒤
      // 풀을 닫는다 — 플랫폼 기본값(0에 가깝다)이면 그 전에 SIGKILL로 잘려 잡이 PROCESSING에 남는다 (docs/runbook.md "배포 중 종료 순서")
      drainingSeconds: 30,
    },
    env: {
      // ── 공개 설정값 (git으로 관리) ──
      NODE_ENV: "production",
      // Railway 엣지 프록시 1홉 — X-Forwarded-For를 신뢰해야 rate limit / auth_session.ip_address가 클라이언트 IP가 된다 (미설정이면 main.ts가 1로 보고 warn, 0이면 기동 거부)
      TRUST_PROXY: "1",
      // rate limit 카운터를 Postgres(throttler_storage, 0016)에 둔다 — 레플리카 N대여도 한도가 N배가 되지 않는다 (production 기본값이지만 명시, docs/security.md)
      THROTTLER_STORAGE: "postgres",
      JWT_ACCESS_TTL: "15m",
      JWT_REFRESH_TTL: "14d",
      INJECTIVE_NETWORK: "testnet",
      INJECTIVE_EVM_CHAIN_ID: "1439",
      USDC_EVM_CONTRACT_ADDRESS: "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d",
      NFT_CONTRACT_ADDRESS: "inj17lcltxazkcntvv8r8dmxjjyeaxctgtz2dyu88w",
      // production 허용 목록에 localhost를 두지 않는다 — 로컬 FE는 로컬 BE(.env의 CORS_ORIGINS/AUTH_ALLOWED_REDIRECT_ORIGINS)로 붙는다 (README "로컬 오리진")
      // FE는 n1-nj-4 팀의 ninjalabs-korea-platform으로 옮겼다 (2026-10-25). 옛 ninjalabsfe.vercel.app은 Vercel에서 새 주소로 308 리다이렉트한다
      CORS_ORIGINS: "https://ninjalabs-korea-platform.vercel.app",
      GOOGLE_CALLBACK_URL:
        "https://ninjalabsbe-production.up.railway.app/auth/google/callback",
      AUTH_SUCCESS_REDIRECT: "https://ninjalabs-korea-platform.vercel.app/",
      GOOGLE_CLIENT_ID:
        "693249955885-ejgrdgjr75uhkst92ttloid3lpkpecf1.apps.googleusercontent.com",
      // ── 비밀값 (Railway 대시보드/CLI로만 설정, git에 두지 않음) ──
      DATABASE_URL: preserve(),
      // Supabase CA PEM — 비어 있으면 database.service.ts가 production에서 warn (docs/security.md)
      DATABASE_CA_CERT: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      JWT_SECRET: preserve(),
      MASTER_WALLET_MNEMONIC: preserve(),
      // 운영 알림 Discord/Slack incoming webhook (https, URL 자체가 토큰) — 비어 있으면 알림은 로그로만 (README env 표, docs/security.md "운영 알림")
      OPS_ALERT_WEBHOOK_URL: preserve(),
      // 선택 — 비어 있으면 로그인 봇 방지 생략 + 기동 시 warn. FE NEXT_PUBLIC_TURNSTILE_SITE_KEY 배포 후 설정 (README env 표)
      TURNSTILE_SECRET_KEY: preserve(),
      // 멀티시그 보상 지갑 주소 — 비어 있으면 새 보상의 custody_address가 PENDING_MULTISIG_SETUP (스폰서가 입금할 곳이 없다). production 필수 (docs/runbook.md §1, §8, §9)
      REWARD_MULTISIG_ADDRESS: preserve(),
      // 선택 — 전용 gRPC 노드/프록시 URL (자격 증명이 섞일 수 있어 git에 두지 않는다). 비우면 INJECTIVE_NETWORK 프리셋 (docs/runbook.md §8)
      INJECTIVE_GRPC_ENDPOINT: preserve(),
      // 선택 — 로그인 returnTo/Turnstile hostname에 더 허용할 FE 오리진 (정확한 항목, 예: preview 별칭). 기본 허용 오리진은 AUTH_SUCCESS_REDIRECT의 것 하나.
      // 비워 두되 자리는 잡는다: 대시보드에서 넣은 값이 `railway config apply` 때 삭제 대상이 되지 않게 (src/auth/fe-origins.ts)
      AUTH_ALLOWED_REDIRECT_ORIGINS: preserve(),
      // ── 선택 운영 스위치 (기본값이면 비워 둔다) — 대시보드에서 넣은 값이 `railway config apply` 때 삭제 대상이 되지 않게 자리만 잡는다 ──
      // payout 2인 규칙 탈출구 (기본 false — 운영자 1인일 때만 true, README env 표)
      PAYOUT_ALLOW_SELF_APPROVAL: preserve(),
      // 구 access 토큰 전환기 경계 (기본 = 프로세스 시작 시각, 2026-11-30 이후 코드와 함께 제거)
      LEGACY_ACCESS_TOKEN_CUTOFF: preserve(),
      // pg Pool 타임아웃 튜닝 (기본 5000 / 15000 ms — common/database/pool-timeouts.ts)
      DB_CONNECTION_TIMEOUT_MS: preserve(),
      DB_STATEMENT_TIMEOUT_MS: preserve(),
    },
  });

  return project("NinjaLabsBE", {
    resources: [web],
  });
});
