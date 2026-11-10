import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../common/database/database.service';
import { evmAddressOf, maskAddress, parsePayoutAddress } from '../../common/validation/injective-address';
import { activeUserSql } from '../../users/active-user';
import { payoutStatusSql } from '../../rewards/payout-status';
import { BountyActor } from '../bounty-actor';
import { BountyStatus, BountyStatusPolicy } from '../bounty-status';
import { SubmissionStatus, SubmissionStatusPolicy } from '../submission-status';

export interface SubmitInput {
  submissionUrl: string;
  description: string;
  repositoryUrl?: string;
  commitSha?: string;
}

/**
 * 제출 정책 (ERD §9)
 * - 제출자당 제출 레코드 1개(최신본) + submission_revision 스냅샷
 * - 지원형 바운티는 APPROVED 지원서가 있어야 제출 가능
 * - 마감 전 자유 수정, 마감 후엔 REVISION_REQUESTED 상태에서만 재제출
 * 제출 상태 규칙(재제출 가능·확정)의 단일 출처는 bounties/submission-status.ts
 */
@Injectable()
export class SubmissionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async submit(bountyId: string, userId: string, input: SubmitInput) {
    const actor = BountyActor.user(userId);
    return this.db.tx(async (tx) => {
      const bounty = await tx.query<{
        application_required: boolean;
        status: string;
        submission_deadline: Date;
      }>(
        `SELECT application_required, status, submission_deadline
           FROM bounty WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [bountyId],
      );
      if (!bounty.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
      const b = bounty.rows[0];
      if (!BountyStatusPolicy.isInProgress(b.status)) throw new BadRequestException('BOUNTY_NOT_OPEN');
      await actor.assertOnboarded(tx);

      // 지원형: 승인된 지원서 필요
      let applicationId: string | null = null;
      if (b.application_required) {
        const app = await tx.query<{ id: string }>(
          `SELECT id FROM bounty_application
            WHERE bounty_id = $1
              AND applicant_user_id = $2
              AND status = 'APPROVED'`,
          [bountyId, actor.id],
        );
        if (!app.rowCount) throw new ForbiddenException('APPLICATION_NOT_APPROVED');
        applicationId = app.rows[0].id;
      }

      // upsert: 기존 제출이 있으면 리비전 증가, 없으면 신규
      const existing = await tx.query<{ id: string; status: string; current_revision_no: number }>(
        `SELECT id, status, current_revision_no FROM bounty_submission
          WHERE bounty_id = $1
            AND submitter_user_id = $2 FOR UPDATE`,
        [bountyId, actor.id],
      );

      const deadlinePassed = new Date(b.submission_deadline) < new Date();

      if (!existing.rowCount) {
        if (b.status !== BountyStatus.OPEN) throw new BadRequestException('BOUNTY_NOT_OPEN');
        if (deadlinePassed) throw new BadRequestException('DEADLINE_PASSED');
        const created = await tx.query<{ id: string }>(
          `INSERT INTO bounty_submission
             (bounty_id, application_id, submitter_user_id,
              submission_url, description, repository_url, commit_sha)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [bountyId, applicationId, actor.id,
           input.submissionUrl, input.description,
           input.repositoryUrl ?? null, input.commitSha ?? null],
        );
        const submissionId = created.rows[0].id;
        await tx.query(
          `INSERT INTO submission_revision
             (submission_id, revision_no, submission_url, description, repository_url,
              commit_sha, created_by_user_id)
           VALUES ($1, 1, $2, $3, $4, $5, $6)`,
          [submissionId, input.submissionUrl, input.description,
           input.repositoryUrl ?? null, input.commitSha ?? null,
           actor.id],
        );
        // 감사는 같은 tx (실패하면 제출도 롤백). URL·설명(사용자 입력)은 넣지 않는다 - 내용은 submission_revision에 있다
        await actor.recordAudit(this.audit, 'SUBMISSION_SUBMITTED', 'bounty_submission', submissionId, tx, {
          after: { status: SubmissionStatus.SUBMITTED, revisionNo: 1, bountyId },
        });
        return { id: submissionId, revisionNo: 1, status: SubmissionStatus.SUBMITTED };
      }

      const sub = existing.rows[0];
      const resubmitAfterClose = SubmissionStatusPolicy.canResubmitAfterIntakeClosed(sub.status);
      if (b.status !== BountyStatus.OPEN && !resubmitAfterClose) {
        throw new BadRequestException('BOUNTY_NOT_OPEN');
      }
      // 마감 후에는 REVISION_REQUESTED 상태에서만 재제출 허용
      if (deadlinePassed && !resubmitAfterClose) {
        throw new BadRequestException('DEADLINE_PASSED');
      }
      // 승인/거절 확정 후에는 수정 불가
      if (SubmissionStatusPolicy.isFinalized(sub.status)) {
        throw new ConflictException('SUBMISSION_FINALIZED');
      }

      const nextRev = sub.current_revision_no + 1;
      await tx.query(
        `UPDATE bounty_submission
            SET submission_url = $2, description = $3, repository_url = $4, commit_sha = $5,
                status = 'RESUBMITTED', current_revision_no = $6, last_resubmitted_at = now()
          WHERE id = $1`,
        [sub.id, input.submissionUrl, input.description,
         input.repositoryUrl ?? null, input.commitSha ?? null, nextRev],
      );
      await tx.query(
        `INSERT INTO submission_revision
           (submission_id, revision_no, submission_url, description, repository_url,
            commit_sha, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sub.id, nextRev, input.submissionUrl, input.description,
         input.repositoryUrl ?? null, input.commitSha ?? null,
         actor.id],
      );
      await actor.recordAudit(this.audit, 'SUBMISSION_RESUBMITTED', 'bounty_submission', sub.id, tx, {
        before: { status: sub.status, revisionNo: sub.current_revision_no },
        after: { status: SubmissionStatus.RESUBMITTED, revisionNo: nextRev, bountyId },
      });
      return { id: sub.id, revisionNo: nextRev, status: SubmissionStatus.RESUBMITTED };
    });
  }

  /**
   * 내 제출 내역(본인 제출만). 각 행의 `agent`는 항상 null(에이전트 제거 후에도 FE 계약 호환용 shim, 다음 정리 PR에서 제거).
   * payment_status는 rewards/payout-status.ts payoutStatusSql(공개 프로필 payoutStatus와 같은 SQL)인데, 그 식은 **승인된 제출** 전용이다 -
   * APPROVED가 아닌 제출(심사 중·반려·scripts/forfeit-award.js로 보상 미지급 처리된 수상)은 받을 몫이 없으므로 'NONE'으로 고정한다.
   * (식을 그대로 쓰면 여유분이 남은 입금 보상이 있는 동안 반려된 제출도 'PENDING' - "지급 대기"로 보인다.)
   * bounty_status/submission_deadline/has_review는 덧붙인 필드다: 바운티 취소로 자동 반려된 제출(REJECTED + has_review false + CANCELLED)을 운영자 반려와 구분하는 데 쓴다.
   * 취소 전이(bounty-admin.service)는 미결 제출마다 코멘트 없는 REJECT 심사 행을 남기므로 "행이 있다"만으로는 구분되지 않는다:
   * 취소된 바운티의 코멘트 없는 REJECT 행은 시스템 정리로 보고 has_review에서 뺀다 (취소 전에 운영자가 코멘트 없이 반려한 건도 같이 false가 되는 것은 감수한다).
   */
  async mySubmissions(userId: string) {
    const r = await this.db.query(
      `SELECT s.id, s.status, s.current_revision_no, s.submitted_at, s.last_resubmitted_at,
              b.id AS bounty_id, b.title AS bounty_title, b.category,
              b.status AS bounty_status, b.submission_deadline,
              NULL::json AS agent,
              CASE WHEN s.status = 'APPROVED' THEN ${payoutStatusSql('s', 'b')} ELSE 'NONE' END AS payment_status, s.description,
              s.submission_url, s.repository_url, s.commit_sha, -- 현재 리비전 값: FE 재제출 폼 미리 채우기용 (재제출은 전체 교체라 비워 보내면 지워진다)
              s.payout_address, s.payout_address_updated_at,
              -- setPayoutAddress가 지금 받아 줄 조건과 같다 (내가 낸 APPROVED 제출 + payout 행 없음)
              (s.submitter_user_id = $1 AND s.status = 'APPROVED'
                AND NOT EXISTS (SELECT 1 FROM payout px WHERE px.submission_id = s.id)) AS payout_address_editable,
              review.comment AS review_comment, (review.id IS NOT NULL AND NOT (b.status = 'CANCELLED' AND review.decision = 'REJECT' AND review.comment IS NULL)) AS has_review
         FROM bounty_submission s
         JOIN bounty b ON b.id = s.bounty_id AND b.deleted_at IS NULL -- 삭제된 바운티는 공개 프로필·상세와 같이 없는 것으로 본다 (링크가 404가 된다)
         LEFT JOIN LATERAL (SELECT id, decision, comment FROM submission_review WHERE submission_id = s.id
                            ORDER BY created_at DESC LIMIT 1) review ON true
        WHERE s.submitter_user_id = $1
        ORDER BY s.submitted_at DESC`,
      [userId],
    );
    return r.rows.map((row): Record<string, any> => ({ ...row, payout_address_evm: evmAddressOf(row.payout_address as string | null) }));
  }

  /**
   * PUT /submissions/:id/payout-address - 승인된 제출의 제출자가 보상을 받을 주소를 입력/수정한다 (2026-11-10 결정, 지갑 연결 대체).
   * 주소는 0x(EVM) 또는 inj1(bech32 계정)을 받고 소문자 inj1로 저장한다 (common/validation/injective-address.ts, 400 INVALID_INJECTIVE_ADDRESS).
   *   404 SUBMISSION_NOT_FOUND     제출이 없음, 내 제출이 아님(submitter_user_id가 나인 행만), 바운티 삭제됨
   *   409 SUBMISSION_NOT_APPROVED  APPROVED가 아님 (심사 중·반려·철회·보상 미지급 처리)
   *   409 PAYOUT_ADDRESS_LOCKED    그 제출에 payout 행이 이미 있다(상태 무관 - requestPayout이 같은 제출에 다시 요청하지 않으므로). 정정은 runbook §7.4
   * 같은 주소를 다시 보내면 아무것도 바꾸지 않고 현재 값을 돌려준다(감사 없음). 처음 설정/변경은 감사 PAYOUT_ADDRESS_SET(마스킹된 주소만).
   * 잠금 순서는 탈퇴·requestPayout과 같다: 유저 FOR SHARE → 제출 FOR UPDATE → payout 존재 검사 → UPDATE.
   * requestPayout은 같은 제출 행을 FOR UPDATE로 잠근 뒤 주소를 읽으므로, 변경과 요청은 한쪽이 끝난 뒤에 다른 쪽이 본다.
   */
  async setPayoutAddress(submissionId: string, userId: string, address: string) {
    const parsed = parsePayoutAddress(address);
    return this.db.tx(async (tx) => {
      const user = await tx.query(`SELECT 1 FROM "user" u WHERE u.id = $1 AND ${activeUserSql('u')} FOR SHARE`, [userId]);
      if (!user.rowCount) throw new NotFoundException('SUBMISSION_NOT_FOUND');
      const sub = await tx.query<{ status: string; payout_address: string | null; payout_address_updated_at: Date | null }>(
        `SELECT s.status, s.payout_address, s.payout_address_updated_at
           FROM bounty_submission s
           JOIN bounty b ON b.id = s.bounty_id AND b.deleted_at IS NULL
          WHERE s.id = $1 AND s.submitter_user_id = $2
          FOR UPDATE OF s`,
        [submissionId, userId],
      );
      if (!sub.rowCount) throw new NotFoundException('SUBMISSION_NOT_FOUND');
      const current = sub.rows[0];
      if (current.status !== SubmissionStatus.APPROVED) throw new ConflictException('SUBMISSION_NOT_APPROVED');
      const requested = await tx.query(`SELECT 1 FROM payout WHERE submission_id = $1 LIMIT 1`, [submissionId]);
      if (requested.rowCount) throw new ConflictException('PAYOUT_ADDRESS_LOCKED');
      if (current.payout_address === parsed.injective) {
        return { submissionId, payoutAddress: parsed.injective, payoutAddressEvm: parsed.evm, updatedAt: current.payout_address_updated_at };
      }
      const updated = await tx.query<{ payout_address_updated_at: Date }>(
        `UPDATE bounty_submission SET payout_address = $2, payout_address_updated_at = now()
          WHERE id = $1 RETURNING payout_address_updated_at`,
        [submissionId, parsed.injective],
      );
      // 원문 주소는 감사 행에 넣지 않는다 (앞 6자 + 뒤 4자 마스킹 - 운영자가 "바뀌었다"만 확인할 수 있게)
      await this.audit.record(userId, 'PAYOUT_ADDRESS_SET', 'bounty_submission', submissionId, tx, {
        before: { address: current.payout_address ? maskAddress(current.payout_address) : null },
        after: { address: maskAddress(parsed.injective) },
      });
      return { submissionId, payoutAddress: parsed.injective, payoutAddressEvm: parsed.evm, updatedAt: updated.rows[0].payout_address_updated_at };
    });
  }
}
