-- 講師の予定の「何回目の保存か」。本人と事務が同時に直したとき、あとの保存を止める（生徒の rev と同じ仕組み）
ALTER TABLE teacher_term_entries ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;

-- 講師の予定の変更履歴（本人の保存も、事務の代理入力も残す）
CREATE TABLE teacher_availability_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
    teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    actor_role TEXT NOT NULL,          -- teacher（本人）/ staff（事務の代理入力）
    actor_email TEXT NOT NULL,
    added TEXT NOT NULL DEFAULT '[]',   -- 増えたコマ [{date, period}]
    removed TEXT NOT NULL DEFAULT '[]', -- 減ったコマ
    note_before TEXT,                   -- 備考を変えたときだけ入れる
    note_after TEXT,
    reason TEXT NOT NULL DEFAULT '',    -- 事務が書く理由（例：電話で連絡）
    created_at TEXT NOT NULL
);
CREATE INDEX idx_teacher_availability_log ON teacher_availability_log (term_id, teacher_id, id);
