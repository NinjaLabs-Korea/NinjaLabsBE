import { defineRailway, preserve, project, service } from "railway/iac";

export const partial = "ninjalabsbe";

export default defineRailway(() => {
  const web = service("ninjalabsbe", {
    start: "npm run start:prod",
    healthcheck: "/health",
    healthcheckTimeout: 120,
    env: {
      // ── 공개 설정값 (git으로 관리) ──
      JWT_ACCESS_TTL: "15m",
      JWT_REFRESH_TTL: "14d",
      INJECTIVE_NETWORK: "testnet",
      INJECTIVE_EVM_CHAIN_ID: "1439",
      USDC_EVM_CONTRACT_ADDRESS: "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d",
      NFT_CONTRACT_ADDRESS: "inj17lcltxazkcntvv8r8dmxjjyeaxctgtz2dyu88w",
      CORS_ORIGINS: "https://ninjalabsfe.vercel.app,http://localhost:3000",
      GOOGLE_CALLBACK_URL:
        "https://ninjalabsbe-production.up.railway.app/auth/google/callback",
      AUTH_SUCCESS_REDIRECT: "https://ninjalabsfe.vercel.app/",
      GOOGLE_CLIENT_ID:
        "693249955885-ejgrdgjr75uhkst92ttloid3lpkpecf1.apps.googleusercontent.com",
      // ── 비밀값 (Railway 대시보드/CLI로만 설정, git에 두지 않음) ──
      DATABASE_URL: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      JWT_SECRET: preserve(),
      MASTER_WALLET_MNEMONIC: preserve(),
    },
  });

  return project("NinjaLabsBE", {
    resources: [web],
  });
});
