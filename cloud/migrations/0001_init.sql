-- 講習（季節講習ごとに1つ作る。期間・時限・休校日を画面で設定する）
CREATE TABLE terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,              -- YYYY-MM-DD
    end_date TEXT NOT NULL,                -- YYYY-MM-DD
    periods TEXT NOT NULL,                 -- JSON 配列 例: [2,3,4,5,6]
    closed_dates TEXT NOT NULL DEFAULT '[]', -- JSON 配列 例: ["2026-12-31"]
    accepting INTEGER NOT NULL DEFAULT 1,  -- 1 = 講師の入力を受け付け中
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 管理画面に入れる事務アカウント（Google アカウントのメールアドレス）
CREATE TABLE staff (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 講師。Google アカウント（sub）で本人を識別する。新規登録は事務の承認制
CREATE TABLE teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT UNIQUE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    comiru_teacher_id INTEGER,
    staff_memo TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE teacher_subjects (
    teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    PRIMARY KEY (teacher_id, subject)
);

-- 講習ごとの提出状況と備考
CREATE TABLE teacher_term_entries (
    term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
    teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    submitted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (term_id, teacher_id)
);

-- 講師が来られるコマ
CREATE TABLE teacher_availability (
    term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
    teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    period INTEGER NOT NULL,
    PRIMARY KEY (term_id, teacher_id, date, period)
);

-- 初回提出後の予定変更の記録（事務への通知用）
CREATE TABLE availability_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
    teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    period INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
    changed_at TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_availability_changes_term ON availability_changes(term_id, seen, changed_at);
