-- comiru の生徒一覧のコピー（生徒を追加するときの検索に使う。comiru から取り直して上書きする）
CREATE TABLE comiru_students (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    fetched_at TEXT NOT NULL
);

-- 生徒。基本は comiru の生徒と紐付ける。comiru にまだいない生徒は名前だけで登録できる
CREATE TABLE students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    comiru_student_id INTEGER UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 講習ごとの生徒の受講科目・備考（事務が入力する）
CREATE TABLE student_term_entries (
    term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    subjects TEXT NOT NULL DEFAULT '[]',   -- JSON 配列
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (term_id, student_id)
);

-- 生徒が受講できるコマ
CREATE TABLE student_availability (
    term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    period INTEGER NOT NULL,
    PRIMARY KEY (term_id, student_id, date, period)
);
