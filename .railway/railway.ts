import { defineRailway, preserve, project, service } from "railway/iac";

export const partial = "ninjalabsbe";

export default defineRailway(() => {
  const web = service("ninjalabsbe", {
    start: "npm run start:prod",
    // 새 컨테이너가 뜨기 전에 supabase/migrations를 적용한다 — 새 코드가 옛 스키마 위에서 기동하면 SchemaGuard가 MIGRATIONS_PENDING으로 거부한다 (README "배포")
    preDeploy: "npm run migrate",
    healthcheck: "/health",
    healthcheckTimeout: 120,
    env: {
      // ── 공개 설정값 (git으로 관리) ──
      NODE_ENV: "production",
      // Railway 엣지 프록시 1홉 — X-Forwarded-For를 신뢰해야 rate limit / auth_session.ip_address가 클라이언트 IP가 된다 (미설정이면 main.ts가 1로 보고 warn, 0이면 기동 거부)
      TRUST_PROXY: "1",
      JWT_ACCESS_TTL: "15m",
      JWT_REFRESH_TTL: "14d",
      INJECTIVE_NETWORK: "testnet",
      INJECTIVE_EVM_CHAIN_ID: "1439",
      USDC_EVM_CONTRACT_ADDRESS: "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d",
      NFT_CONTRACT_ADDRESS: "inj17lcltxazkcntvv8r8dmxjjyeaxctgtz2dyu88w",
      // production 허용 목록에 localhost를 두지 않는다 — 로컬 FE는 로컬 BE(.env의 CORS_ORIGINS/AUTH_ALLOWED_REDIRECT_ORIGINS)로 붙는다 (README "로컬 오리진")
      CORS_ORIGINS: "https://ninjalabsfe.vercel.app",
      GOOGLE_CALLBACK_URL:
        "https://ninjalabsbe-production.up.railway.app/auth/google/callback",
      AUTH_SUCCESS_REDIRECT: "https://ninjalabsfe.vercel.app/",
      GOOGLE_CLIENT_ID:
        "693249955885-ejgrdgjr75uhkst92ttloid3lpkpecf1.apps.googleusercontent.com",
      // ── 비밀값 (Railway 대시보드/CLI로만 설정, git에 두지 않음) ──
      DATABASE_URL: preserve(),
      // Supabase CA PEM — 비어 있으면 database.service.ts가 production에서 warn (docs/security.md)
      DATABASE_CA_CERT: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      JWT_SECRET: preserve(),
      MASTER_WALLET_MNEMONIC: preserve(),
    },
  });

  return project("NinjaLabsBE", {
    resources: [web],
  });
});
