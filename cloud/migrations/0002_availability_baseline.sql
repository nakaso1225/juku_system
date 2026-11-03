-- 予定変更の通知を「事務が最後に確認した時点の予定」と「今の予定」の差で出すための基準。
-- 講師の初回提出時と、事務が「確認済みにする」を押したときに、その時点の予定で上書きする。
CREATE TABLE availability_baseline (
    term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
    teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    period INTEGER NOT NULL,
    PRIMARY KEY (term_id, teacher_id, date, period)
);

ALTER TABLE teacher_term_entries ADD COLUMN reviewed_at TEXT;

-- 既存の提出は「確認済み」とみなして基準を作る
INSERT INTO availability_baseline (term_id, teacher_id, date, period)
SELECT term_id, teacher_id, date, period FROM teacher_availability;

-- 保存ごとの変更記録（availability_changes）は使わなくなるが、過去の記録として残しておく
