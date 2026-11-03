-- comiru の講師一覧のコピー（講師登録時の自動照合に使う。comiru から取り直して上書きする）
CREATE TABLE comiru_teachers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    email TEXT,
    fetched_at TEXT NOT NULL
);

CREATE INDEX idx_comiru_teachers_name ON comiru_teachers(normalized_name);

-- 承認待ちになった理由（comiru に同じ名前がいない、など）
ALTER TABLE teachers ADD COLUMN pending_reason TEXT NOT NULL DEFAULT '';
