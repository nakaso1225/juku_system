-- 講師・生徒を「comiru の名簿」として全員分持ち、講師は Google ログインで本人の行に紐付ける方式に変更する。
--   teachers.email        … comiru に登録されているメールアドレス（照合に使う）
--   teachers.google_sub   … 紐付いた Google アカウント（NULL ならまだログインしていない）
--   teachers.google_email … 紐付いた Google アカウントのメールアドレス
--   active                … comiru の名簿に今もいるか（いなくなったら 0 にして一覧から隠す）
-- 新規登録・承認（status / pending_reason）は使わなくなる。

ALTER TABLE teachers ADD COLUMN google_email TEXT;
ALTER TABLE teachers ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

-- これまでにログインした講師は、その Google アカウントで紐付け済みとして引き継ぐ
UPDATE teachers SET google_email = email WHERE google_sub IS NOT NULL;

-- comiru と紐付いていない講師（名前だけで登録した人）は名簿の外なので隠す
UPDATE teachers SET active = 0 WHERE comiru_teacher_id IS NULL;

CREATE UNIQUE INDEX idx_teachers_comiru ON teachers(comiru_teacher_id) WHERE comiru_teacher_id IS NOT NULL;

-- comiru のアドレスと Google アカウントが一致しなかった講師の「本人です」申請。事務が承認すると紐付く
CREATE TABLE teacher_link_requests (
    google_sub TEXT PRIMARY KEY,
    google_email TEXT NOT NULL,
    google_name TEXT NOT NULL DEFAULT '',
    requested_name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

ALTER TABLE students ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
