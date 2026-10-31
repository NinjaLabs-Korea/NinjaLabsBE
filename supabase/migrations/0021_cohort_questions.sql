-- ============================================================
-- 0021_cohort_questions.sql: 기수 지원서 질문을 기수마다 편집 가능하게
--
--   cohort.questions                 기수 질문 목록 (JSONB 배열, 최대 30개). 운영자가 /admin/recruitment 에서 편집한다.
--   cohort_application.answers       지원자의 답변 스냅샷 (질문 라벨/선택지 라벨을 쓰는 순간 복사). 질문을 나중에 고쳐도 낸 지원서는 안 바뀐다.
--   옛 컬럼 web3_experience / activity_type / interest_areas 는 NOT NULL 을 풀었다: 새 형식 지원서는 이 컬럼이 전부 NULL, answers 가 찬다.
--                                    옛 형식 지원서(기존 행, 옛 FE 본문)는 옛 컬럼이 차고 answers 가 [] 다. 둘이 섞인 행은 CHECK 가 막는다.
--
-- 고정 필드(display_name, telegram, twitter, intro)와 0018 의 CHECK 는 그대로다 (NULL 이면 CHECK 는 통과). 기존 지원서 행은 고치지 않는다:
-- 읽을 때 cohorts/cohort-questions.ts legacyAnswers 가 답변으로 합성한다. 기본 질문(Web3 경력 + 참여하고 싶은 분야)은 기존 모든 기수에 심는다.
-- 비파괴 변경: 새 컬럼 2개 + 제약 3개. 새 테이블이 없어 RLS 변경도 없다. 질문 모델의 단일 출처는 cohorts/cohort-questions.ts 이고
-- cohort-questions.spec.ts 가 아래 마커 블록의 JSON 이 DEFAULT_COHORT_QUESTIONS 와 같은지 대조한다.
-- ============================================================

ALTER TABLE cohort ADD COLUMN questions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE cohort ADD CONSTRAINT chk_cohort_questions_shape CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) <= 30);

ALTER TABLE cohort_application
  ADD COLUMN answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  ALTER COLUMN web3_experience DROP NOT NULL,
  ALTER COLUMN activity_type DROP NOT NULL,
  ALTER COLUMN interest_areas DROP NOT NULL;

ALTER TABLE cohort_application ADD CONSTRAINT chk_cohort_application_answers_array CHECK (jsonb_typeof(answers) = 'array');

-- 한 행은 옛 형식(옛 컬럼이 차고 answers 가 비어 있음) 아니면 새 형식(옛 컬럼이 전부 NULL) 중 하나다
ALTER TABLE cohort_application ADD CONSTRAINT chk_cohort_application_answer_shape CHECK (
  (web3_experience IS NULL AND activity_type IS NULL AND activity_type_other IS NULL AND interest_areas IS NULL AND interest_other IS NULL)
  OR (web3_experience IS NOT NULL AND activity_type IS NOT NULL AND interest_areas IS NOT NULL AND answers = '[]'::jsonb)
);

-- 기존 모든 기수(상태 무관)에 기본 질문을 심는다. 마커 사이는 스펙이 파싱한다
-- default-questions:begin
UPDATE cohort SET questions = '[{"id":"web3_experience","type":"SINGLE_CHOICE","label":{"ko":"Web3 경력","en":"Web3 experience","zh":"Web3 经验"},"help":null,"required":true,"options":[{"id":"LT_1Y","label":{"ko":"1년 미만","en":"Under 1 year","zh":"不足 1 年"},"withDetail":false},{"id":"Y1_3","label":{"ko":"1~3년","en":"1-3 years","zh":"1-3 年"},"withDetail":false},{"id":"GT_3Y","label":{"ko":"3년 이상","en":"Over 3 years","zh":"3 年以上"},"withDetail":false}]},{"id":"interest_areas","type":"MULTI_CHOICE","label":{"ko":"참여하고 싶은 분야","en":"Areas you want to join","zh":"想参与的领域"},"help":{"ko":"해당하는 분야를 모두 골라 주세요.","en":"Choose all that apply.","zh":"可多选。"},"required":true,"options":[{"id":"DEVELOPER","label":{"ko":"개발자","en":"Developer","zh":"开发者"},"withDetail":false},{"id":"CONTENT_CREATOR","label":{"ko":"콘텐츠 크리에이터","en":"Content creator","zh":"内容创作者"},"withDetail":false},{"id":"KOL","label":{"ko":"KOL(인플루언서)","en":"KOL (influencer)","zh":"KOL(意见领袖)"},"withDetail":false},{"id":"COMMUNITY_MARKETING","label":{"ko":"커뮤니티·마케팅","en":"Community & marketing","zh":"社区与营销"},"withDetail":false},{"id":"RESEARCHER","label":{"ko":"리서처","en":"Researcher","zh":"研究员"},"withDetail":false},{"id":"BIZDEV","label":{"ko":"사업개발","en":"Business development","zh":"商务拓展"},"withDetail":false},{"id":"OTHER","label":{"ko":"기타","en":"Other","zh":"其他"},"withDetail":true}]}]'::jsonb WHERE questions = '[]'::jsonb;
-- default-questions:end
