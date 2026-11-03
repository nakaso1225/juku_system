-- すでに取得済みの comiru の講師・生徒一覧から、名簿（teachers / students）を作る。
-- 以降は comiru から取り直すたびに同じ処理で更新される（src/comiru.ts）。
INSERT INTO teachers (name, email, comiru_teacher_id, status, active)
SELECT name, COALESCE(email, ''), id, 'approved', 1 FROM comiru_teachers WHERE true
ON CONFLICT (comiru_teacher_id) WHERE comiru_teacher_id IS NOT NULL
DO UPDATE SET name = excluded.name, email = excluded.email, active = 1;

INSERT INTO students (name, comiru_student_id, active)
SELECT name, id, 1 FROM comiru_students WHERE true
ON CONFLICT (comiru_student_id) DO UPDATE SET name = excluded.name, active = 1;
