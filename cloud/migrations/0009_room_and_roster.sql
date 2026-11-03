CREATE TABLE room_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    table_ids TEXT NOT NULL
);
INSERT INTO room_settings (id, table_ids) VALUES (1, '["A","B","C","D","E","F","G","H","I","J","K"]');

ALTER TABLE teachers ADD COLUMN name_kana TEXT NOT NULL DEFAULT '';
ALTER TABLE teachers ADD COLUMN name_kana_override TEXT;
ALTER TABLE students ADD COLUMN name_kana TEXT NOT NULL DEFAULT '';
ALTER TABLE students ADD COLUMN name_kana_override TEXT;
ALTER TABLE students ADD COLUMN grade TEXT NOT NULL DEFAULT '';
ALTER TABLE students ADD COLUMN grade_override TEXT;
ALTER TABLE comiru_teachers ADD COLUMN name_kana TEXT NOT NULL DEFAULT '';
ALTER TABLE comiru_students ADD COLUMN name_kana TEXT NOT NULL DEFAULT '';
ALTER TABLE comiru_students ADD COLUMN grade TEXT NOT NULL DEFAULT '';

-- 次の名簿表示時に、追加した項目も一度取り直す。
UPDATE comiru_teachers SET fetched_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-13 hours');
UPDATE comiru_students SET fetched_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-13 hours');

CREATE INDEX idx_assignments_teacher_slot ON assignments(term_id, date, period, teacher_id);
CREATE INDEX idx_assignments_table_slot ON assignments(term_id, date, period, table_id);
