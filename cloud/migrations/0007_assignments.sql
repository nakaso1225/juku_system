-- コマ割り当て（今のアプリの assignments と同じ考え方。講習ごとに持つ）
--   同じ生徒・同じ日・同じ時限には1コマだけ（今のアプリと同じく、上書き扱い）
--   teacher_id が NULL のものは「講師未定」
CREATE TABLE assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id),
    teacher_id INTEGER REFERENCES teachers(id),
    table_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    date TEXT NOT NULL,
    period INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (term_id, student_id, date, period)
);
CREATE INDEX idx_assignments_slot ON assignments(term_id, date, period);
CREATE INDEX idx_assignments_teacher ON assignments(term_id, teacher_id);

-- 生徒の調整ステータス（調整中 / 完了）。エラーがあるあいだは画面上「要調整」と表示する（今のアプリと同じ）
ALTER TABLE student_term_entries ADD COLUMN status TEXT NOT NULL DEFAULT '調整中';

-- 割り当て・予定が変わるたびに増える番号。ほかの PC の画面がこれを見て自動で更新する
ALTER TABLE terms ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- comiru に登録した授業（アプリが登録したものだけ）。次に反映するときの差分計算に使う
CREATE TABLE comiru_lessons (
    term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id),
    date TEXT NOT NULL,
    period INTEGER NOT NULL,
    seat_id INTEGER,                 -- comiru の座席（授業）ID。分からなかったときは NULL
    teacher_id INTEGER NOT NULL,     -- 登録した時点の講師（アプリの teachers.id）
    comiru_subject TEXT NOT NULL,    -- 登録した時点の comiru の科目名
    classroom TEXT,
    registered_at TEXT NOT NULL,
    PRIMARY KEY (term_id, student_id, date, period)
);

-- comiru のコマ・科目一覧のコピー（反映のときに使う。12時間ごとに取り直す）
CREATE TABLE comiru_masters (
    kind TEXT PRIMARY KEY,           -- 'comas' / 'subjects'
    data TEXT NOT NULL,              -- JSON
    fetched_at TEXT NOT NULL
);
