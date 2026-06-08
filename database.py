from __future__ import annotations

import sqlite3
import random
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "juku.db"

SUBJECTS = [
    "算数（受験除く）",
    "算数（受験含む）",
    "中学受験国語",
    "中学受験理科",
    "中学受験社会",
    "中学英語",
    "中学数学",
    "中学国語",
    "中学理科",
    "中学社会",
    "高校英語",
    "数学Ⅰ・A",
    "数学Ⅱ・B",
    "数学Ⅲ・C",
    "現代文",
    "古文",
    "漢文",
    "物理",
    "化学",
    "生物",
    "地学",
    "日本史",
    "世界史",
    "地理",
    "倫政",
    "公共",
    "情報",
]

PERIODS = [2, 3, 4, 5, 6, 7]
PERIOD_LABELS = {
    2: "2限（10:45-12:15）",
    3: "3限（13:15-14:45）",
    4: "4限（15:00-16:30）",
    5: "5限（16:45-18:15）",
    6: "6限（18:30-20:00）",
    7: "7限（例外）",
}
TABLE_IDS = list("ABCDEFGHIJK")

DATES = [
    "2026-03-26",
    "2026-03-27",
    "2026-03-28",
    "2026-03-30",
    "2026-03-31",
    "2026-04-01",
    "2026-04-02",
    "2026-04-03",
    "2026-04-04",
    "2026-04-06",
    "2026-04-07",
]


def get_calendar_dates() -> list[str]:
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT DISTINCT date
        FROM (
            SELECT date FROM assignments
            UNION
            SELECT date FROM teacher_availability
            UNION
            SELECT date FROM student_availability
        )
        WHERE date IS NOT NULL AND date != ''
        ORDER BY date
        """
    ).fetchall()
    conn.close()
    if rows:
        return [row["date"] for row in rows]
    return DATES.copy()


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    conn = get_connection()
    cur = conn.cursor()

    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS teachers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            name_kana TEXT NOT NULL DEFAULT '',
            memo TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS teacher_subjects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            teacher_id INTEGER NOT NULL,
            subject TEXT NOT NULL,
            FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
            UNIQUE(teacher_id, subject)
        );

        CREATE TABLE IF NOT EXISTS teacher_availability (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            teacher_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            period INTEGER NOT NULL,
            FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
            UNIQUE(teacher_id, date, period)
        );

        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT '調整中',
            memo TEXT NOT NULL DEFAULT '',
            memo_updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS student_subjects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            subject TEXT NOT NULL,
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
            UNIQUE(student_id, subject)
        );

        CREATE TABLE IF NOT EXISTS assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            teacher_id INTEGER,
            table_id TEXT NOT NULL DEFAULT 'A',
            subject TEXT NOT NULL,
            date TEXT NOT NULL,
            period INTEGER NOT NULL,
            FOREIGN KEY (student_id) REFERENCES students(id),
            FOREIGN KEY (teacher_id) REFERENCES teachers(id)
        );

        CREATE TABLE IF NOT EXISTS student_availability (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            period INTEGER NOT NULL,
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
            UNIQUE(student_id, date, period)
        );

        CREATE TABLE IF NOT EXISTS student_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            is_edited INTEGER NOT NULL DEFAULT 0,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            deleted_at TEXT,
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_assignments_slot_teacher
            ON assignments(date, period, teacher_id);
        CREATE INDEX IF NOT EXISTS idx_assignments_student_teacher
            ON assignments(student_id, teacher_id);
        CREATE INDEX IF NOT EXISTS idx_student_subjects_student
            ON student_subjects(student_id);
        CREATE INDEX IF NOT EXISTS idx_teacher_availability_slot
            ON teacher_availability(date, period);
        CREATE INDEX IF NOT EXISTS idx_student_availability_slot
            ON student_availability(student_id, date, period);
        CREATE INDEX IF NOT EXISTS idx_student_notes_student
            ON student_notes(student_id, id);
        """
    )

    student_cols = {
        row["name"] for row in cur.execute("PRAGMA table_info(students)").fetchall()
    }
    teacher_cols = {
        row["name"] for row in cur.execute("PRAGMA table_info(teachers)").fetchall()
    }
    if "memo" not in teacher_cols:
        cur.execute("ALTER TABLE teachers ADD COLUMN memo TEXT NOT NULL DEFAULT ''")

    if "table_id" in student_cols:
        cur.execute("PRAGMA foreign_keys = OFF")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS students_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT '調整中',
                memo TEXT NOT NULL DEFAULT '',
                memo_updated_at TEXT
            )
            """
        )
        cur.execute(
            """
            INSERT OR IGNORE INTO students_new(id, name, status, memo, memo_updated_at)
            SELECT id, name, '調整中', '', NULL FROM students
            """
        )
        cur.execute("DROP TABLE students")
        cur.execute("ALTER TABLE students_new RENAME TO students")
        cur.execute("PRAGMA foreign_keys = ON")
    student_cols = {
        row["name"] for row in cur.execute("PRAGMA table_info(students)").fetchall()
    }
    if "status" not in student_cols:
        cur.execute("ALTER TABLE students ADD COLUMN status TEXT NOT NULL DEFAULT '調整中'")
    if "memo" not in student_cols:
        cur.execute("ALTER TABLE students ADD COLUMN memo TEXT NOT NULL DEFAULT ''")
    if "memo_updated_at" not in student_cols:
        cur.execute("ALTER TABLE students ADD COLUMN memo_updated_at TEXT")
    cur.execute(
        """
        INSERT INTO student_notes(student_id, body, created_at, updated_at, is_edited)
        SELECT
            s.id,
            s.memo,
            COALESCE(NULLIF(s.memo_updated_at, ''), strftime('%Y-%m-%d %H:%M', 'now', 'localtime')),
            COALESCE(NULLIF(s.memo_updated_at, ''), strftime('%Y-%m-%d %H:%M', 'now', 'localtime')),
            0
        FROM students s
        WHERE TRIM(COALESCE(s.memo, '')) != ''
          AND NOT EXISTS (
              SELECT 1 FROM student_notes n WHERE n.student_id = s.id
          )
        """
    )
    note_cols = {
        row["name"] for row in cur.execute("PRAGMA table_info(student_notes)").fetchall()
    }
    if "is_deleted" not in note_cols:
        cur.execute("ALTER TABLE student_notes ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0")
    if "deleted_at" not in note_cols:
        cur.execute("ALTER TABLE student_notes ADD COLUMN deleted_at TEXT")

    assignment_cols = {
        row["name"] for row in cur.execute("PRAGMA table_info(assignments)").fetchall()
    }
    assignment_info = {
        row["name"]: row for row in cur.execute("PRAGMA table_info(assignments)").fetchall()
    }
    if "table_id" not in assignment_cols:
        cur.execute("ALTER TABLE assignments ADD COLUMN table_id TEXT")
        cur.execute(
            """
            UPDATE assignments
            SET table_id = (
                SELECT s.table_id
                FROM students s
                WHERE s.id = assignments.student_id
            )
            """
        )
        cur.execute("UPDATE assignments SET table_id = 'A' WHERE table_id IS NULL OR table_id = ''")

    # Migrate old schema: assignments.teacher_id NOT NULL -> NULL allowed (for "講師未定").
    teacher_col = assignment_info.get("teacher_id")
    if teacher_col and int(teacher_col["notnull"]) == 1:
        cur.execute("PRAGMA foreign_keys = OFF")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS assignments_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id INTEGER NOT NULL,
                teacher_id INTEGER,
                table_id TEXT NOT NULL DEFAULT 'A',
                subject TEXT NOT NULL,
                date TEXT NOT NULL,
                period INTEGER NOT NULL,
                FOREIGN KEY (student_id) REFERENCES students(id),
                FOREIGN KEY (teacher_id) REFERENCES teachers(id)
            )
            """
        )
        cur.execute(
            """
            INSERT INTO assignments_new(id, student_id, teacher_id, table_id, subject, date, period)
            SELECT id, student_id, teacher_id, COALESCE(table_id, 'A'), subject, date, period
            FROM assignments
            """
        )
        cur.execute("DROP TABLE assignments")
        cur.execute("ALTER TABLE assignments_new RENAME TO assignments")
        cur.execute("PRAGMA foreign_keys = ON")

    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_assignments_slot_table
            ON assignments(date, period, table_id)
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_assignments_slot_teacher
            ON assignments(date, period, teacher_id)
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_assignments_student_teacher
            ON assignments(student_id, teacher_id)
        """
    )

    conn.commit()
    conn.close()


def seed_dummy_data() -> None:
    conn = get_connection()
    cur = conn.cursor()

    teacher_count = cur.execute("SELECT COUNT(*) FROM teachers").fetchone()[0]
    if teacher_count > 0:
        conn.close()
        return

    rng = random.Random(20260214)

    # Generic sample teachers for development fallback only.
    base_subject_sets = [
        ["数学Ⅰ・A", "数学Ⅱ・B", "中学数学"],
        ["高校英語", "中学英語"],
        ["算数（受験除く）", "算数（受験含む）"],
        ["数学Ⅱ・B", "数学Ⅲ・C"],
        ["中学英語", "数学Ⅱ・B"],
    ]
    teachers = []
    for i in range(15):
        name = f"講師{i + 1:02d}"
        kana = f"コウシ{i + 1:02d}"
        subjects = base_subject_sets[i % len(base_subject_sets)]
        teachers.append((name, kana, subjects))

    teacher_ids: dict[str, int] = {}
    for name, kana, subjects in teachers:
        cur.execute(
            "INSERT INTO teachers(name, name_kana) VALUES (?, ?)",
            (name, kana),
        )
        teacher_id = cur.lastrowid
        teacher_ids[name] = teacher_id
        cur.executemany(
            "INSERT INTO teacher_subjects(teacher_id, subject) VALUES (?, ?)",
            [(teacher_id, subject) for subject in subjects],
        )

    # Teachers: 8-22 slots each, varied by teacher.
    for teacher_id in teacher_ids.values():
        slots = [(d, p) for d in DATES for p in PERIODS]
        rng.shuffle(slots)
        for date, period in slots[: rng.randint(8, 22)]:
            cur.execute(
                "INSERT INTO teacher_availability(teacher_id, date, period) VALUES (?, ?, ?)",
                (teacher_id, date, period),
            )

    conn.commit()
    conn.close()
