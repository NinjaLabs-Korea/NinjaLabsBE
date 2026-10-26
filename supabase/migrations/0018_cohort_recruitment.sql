-- ============================================================
-- 0018_cohort_recruitment.sql: 기수(cohort) 모집 + 공지 행사 날짜
--
--   cohort              기수. 운영자가 만들고 DRAFT -> OPEN -> CLOSED 로 연다. 동시에 열린(OPEN) 기수는 최대 1개.
--   cohort_application  기수 지원서. 로그인한 유저가 기수당 1건 (UNIQUE cohort_id, user_id).
--                       합격(ACCEPTED)해도 멤버 지정은 아니다: user.is_member 는 운영자가 멤버 관리에서 따로 켠다.
--   notice.event_date   행사 공지의 행사 날짜 (DATE, nullable). 행사 순 정렬용 부분 인덱스.
--
-- 비파괴 변경: 새 테이블 2개 + 새 nullable 컬럼 1개 + 인덱스. 기존 행·API 응답은 바뀌지 않는다.
-- 값 집합(상태, 경력, 활동 유형, 관심 분야)은 cohorts/cohort-status.ts 가 단일 출처이고, cohort-status.spec.ts 가
-- 아래 CHECK 와 같은지 대조한다. RLS: 서버 전용 테이블이라 각자 이 파일에서 켠다 (rls-coverage.spec.ts, 0017 규칙).
-- ============================================================

CREATE TABLE cohort (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(60)  NOT NULL,
  description TEXT,
  status      VARCHAR(20)  NOT NULL DEFAULT 'DRAFT'
              CHECK (status IN ('DRAFT', 'OPEN', 'CLOSED')),
  opens_at    TIMESTAMPTZ,
  closes_at   TIMESTAMPTZ,
  created_by  UUID         NOT NULL REFERENCES "user"(id),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT chk_cohort_window CHECK (opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at),
  CONSTRAINT chk_cohort_name_not_blank CHECK (btrim(name) <> '')
);

-- 열린 기수는 한 번에 하나: status 가 OPEN 인 행만 인덱스에 들어가므로 두 번째 OPEN 은 23505
CREATE UNIQUE INDEX uq_cohort_single_open ON cohort ((status)) WHERE status = 'OPEN';

CREATE TRIGGER trg_cohort_updated_at BEFORE UPDATE ON cohort FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE cohort ENABLE ROW LEVEL SECURITY;

CREATE TABLE cohort_application (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id           UUID         NOT NULL REFERENCES cohort(id),
  user_id             UUID         NOT NULL REFERENCES "user"(id),
  display_name        VARCHAR(60)  NOT NULL,
  telegram            VARCHAR(40)  NOT NULL,
  twitter             VARCHAR(40)  NOT NULL,
  web3_experience     VARCHAR(20)  NOT NULL
                      CHECK (web3_experience IN ('LT_1Y', 'Y1_3', 'GT_3Y')),
  activity_type       VARCHAR(30)  NOT NULL
                      CHECK (activity_type IN ('DEVELOPER', 'CONTENT_CREATOR', 'KOL', 'COMMUNITY_MARKETING', 'RESEARCHER', 'BIZDEV', 'STUDENT', 'OTHER')),
  activity_type_other VARCHAR(60),
  interest_areas      TEXT[]       NOT NULL,
  interest_other      VARCHAR(60),
  intro               TEXT         NOT NULL,
  status              VARCHAR(20)  NOT NULL DEFAULT 'SUBMITTED'
                      CHECK (status IN ('SUBMITTED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN')),
  review_note         TEXT,
  reviewed_by         UUID         REFERENCES "user"(id),
  reviewed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_cohort_application_user UNIQUE (cohort_id, user_id),
  -- 정규화된 @핸들만 저장한다 (서비스가 URL/@ 유무를 정리). 텔레그램 5~32자, 트위터 1~15자는 서비스가 더 엄격히 검사
  CONSTRAINT chk_cohort_application_telegram CHECK (telegram ~ '^@[A-Za-z0-9_]{1,32}$'),
  CONSTRAINT chk_cohort_application_twitter CHECK (twitter ~ '^@[A-Za-z0-9_]{1,15}$'),
  CONSTRAINT chk_cohort_application_display_name CHECK (btrim(display_name) <> ''),
  -- "기타" 상세는 OTHER 일 때만, 그리고 OTHER 이면 반드시
  CONSTRAINT chk_cohort_application_activity_other CHECK ((activity_type = 'OTHER') = (activity_type_other IS NOT NULL AND btrim(activity_type_other) <> '')),
  CONSTRAINT chk_cohort_application_interest_areas CHECK (
    cardinality(interest_areas) BETWEEN 1 AND 7
    AND interest_areas <@ ARRAY['DEVELOPER', 'CONTENT_CREATOR', 'KOL', 'COMMUNITY_MARKETING', 'RESEARCHER', 'BIZDEV', 'OTHER']::text[]
  ),
  CONSTRAINT chk_cohort_application_interest_other CHECK (('OTHER' = ANY(interest_areas)) = (interest_other IS NOT NULL AND btrim(interest_other) <> '')),
  CONSTRAINT chk_cohort_application_intro CHECK (btrim(intro) <> '' AND char_length(intro) <= 1000)
);

-- 운영자 목록: 기수별 최신순 + 안정 정렬 (id), 상태 필터
CREATE INDEX idx_cohort_application_cohort ON cohort_application (cohort_id, created_at DESC, id);
CREATE INDEX idx_cohort_application_cohort_status ON cohort_application (cohort_id, status);
-- 내 지원 내역
CREATE INDEX idx_cohort_application_user ON cohort_application (user_id);

CREATE TRIGGER trg_cohort_application_updated_at BEFORE UPDATE ON cohort_application FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE cohort_application ENABLE ROW LEVEL SECURITY;

-- 공지 행사 날짜 (달력 날짜만; 시각·시간대 없음). 공개 목록의 ?sort=eventDate 정렬용 부분 인덱스
ALTER TABLE notice ADD COLUMN event_date DATE;
CREATE INDEX idx_notice_event_date
  ON notice (event_date DESC NULLS LAST, published_at DESC)
  WHERE status = 'PUBLISHED' AND deleted_at IS NULL;
