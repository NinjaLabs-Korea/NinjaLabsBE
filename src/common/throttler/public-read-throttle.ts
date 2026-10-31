/**
 * 공개 GET 라우트(바운티·공지·멤버·명예의 전당·미디어)에 거는 전역(IP) throttler 덮어쓰기 - 120/min → **600/min**.
 * 공개 페이지는 FE(Vercel)가 요청마다 서버에서 렌더하며 BE를 부르므로(`cache: "no-store"`, 랜딩 한 번에 4회 이상, `/media/*`는 rewrite)
 * 이 서버가 보는 IP는 소수의 Vercel egress IP다. 120/min이면 분당 30 페이지뷰쯤에서 429가 되어 공개 페이지가 깨진다.
 * 쓰기·민감 라우트는 이걸 쓰지 않는다 (전역 120, check-nickname 30, DELETE /users/me 5 등 그대로). docs/security.md.
 */
export const PUBLIC_READ_IP_THROTTLE = { default: { ttl: 60_000, limit: 600 } } as const;
