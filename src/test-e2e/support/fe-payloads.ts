import { parseUnits } from 'ethers';

/**
 * 요청 본문을 FE가 만드는 그대로 만든다 — NinjaLabsFE/src/lib/api/admin.ts · api-client.ts의 매핑을 옮긴 것.
 * JSON.stringify가 undefined 키를 버리고, 지운 URL은 null로 간다(FE 주석: 생략하면 PATCH가 옛 값을 유지한다).
 * FE 매핑이 바뀌면 여기도 같이 바꾼다 (이 파일이 BE DTO와 FE 계약 사이의 e2e 고정점이다).
 */
export type AdminBountyForm = {
  slug: string;
  title: string;
  sponsor: string;
  description: string;
  requirements: string;
  reviewProcess: string;
  tags: Array<'Dev' | 'Design' | 'Content' | 'Other'>;
  intakeEnabled: boolean;
  maxWinners: number;
  submissionMode: 'agent' | 'direct';
  coverImage: string | null;
  deadline: string;
  reward: { amount: number; currency: 'INJ' | 'USDC' };
};

const CATEGORY: Record<string, string> = { Dev: 'DEV', Design: 'DESIGN', Content: 'CONTENT', Other: 'OTHER' };
const DECIMALS = { INJ: 18, USDC: 6 } as const;

/** createAdminApi().saveAdminBounty */
export function saveAdminBountyBody(bounty: AdminBountyForm, create: boolean) {
  return JSON.parse(JSON.stringify({
    title: bounty.title, sponsorName: bounty.sponsor,
    summary: bounty.description.slice(0, 240), description: bounty.description,
    requirements: bounty.requirements,
    evaluationCriteria: bounty.reviewProcess,
    category: CATEGORY[bounty.tags[0] ?? 'Other'],
    applicationRequired: bounty.intakeEnabled, maxWinners: create ? 1 : bounty.maxWinners,
    submissionMode: bounty.submissionMode === 'agent' ? 'AGENT' : 'DIRECT',
    coverImageUrl: bounty.coverImage,
    submissionDeadline: bounty.deadline,
    ...(create && bounty.reward.amount > 0 ? { reward: {
      tokenType: bounty.reward.currency === 'USDC' ? 'ERC20' : 'NATIVE',
      ...(bounty.reward.currency === 'INJ' ? { tokenDenom: 'inj' } : {}),
      displaySymbol: bounty.reward.currency,
      amount: parseUnits(String(bounty.reward.amount), DECIMALS[bounty.reward.currency]).toString(),
    } } : {}),
  }));
}

export type AdminPostForm = { slug: string; title: string; bodyMarkdown: string; category: string; status: 'published' | 'draft'; thumbnail: string | null; externalUrl: string | null };

/** createAdminApi().saveAdminPost — category는 이미 코드값 */
export function saveAdminPostBody(post: AdminPostForm, create: boolean, options?: { publish?: boolean }) {
  const publish = create ? post.status === 'published' : options?.publish;
  return JSON.parse(JSON.stringify({
    title: post.title, summary: post.bodyMarkdown.slice(0, 240), body: post.bodyMarkdown, category: post.category,
    thumbnailUrl: post.thumbnail ?? null, externalUrl: post.externalUrl ?? null,
    ...(publish === undefined ? {} : { publish }),
  }));
}

export type AdminHighlightForm = { id: string; type: string; title: string; description?: string; order: number; link?: string; image: string | null; published?: boolean };

/** createAdminApi().saveAdminHighlight */
export function saveAdminHighlightBody(item: AdminHighlightForm, create: boolean, options?: { publish?: boolean; typeChanged?: boolean }) {
  const publish = create ? item.published ?? false : options?.publish;
  return JSON.parse(JSON.stringify({
    ...(create || options?.typeChanged ? { type: item.type } : {}),
    title: item.title, description: item.description ?? item.title,
    imageUrl: item.image ?? null, linkUrl: item.link ?? null, displayOrder: item.order,
    ...(publish === undefined ? {} : { publish }),
  }));
}

/** createAdminApi().setAdminMember (role은 라벨 → 코드) */
export function setAdminMemberBody(input: { isMember: boolean; role?: 'Core' | 'Dev' | 'Design' | 'Ops'; displayOrder?: number }) {
  return JSON.parse(JSON.stringify({ ...input, ...(input.role ? { role: input.role.toUpperCase() } : {}) }));
}

/** BountyActionPanel apply/submit — 빈 선택 필드는 키째 빠진다 */
export function applyBody(message: string, portfolioUrl = '') {
  return { message, ...(portfolioUrl ? { portfolioUrl } : {}) };
}
export function submitBody(input: { submissionUrl: string; description: string; repositoryUrl?: string; commitSha?: string }) {
  return {
    submissionUrl: input.submissionUrl, description: input.description,
    ...(input.repositoryUrl ? { repositoryUrl: input.repositoryUrl } : {}),
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
  };
}
