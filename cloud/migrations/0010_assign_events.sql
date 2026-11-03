-- 割り当て画面の「変わった分だけ受け取る」ための変更記録。
-- 画面は最初に講習のデータをまとめて読み込み、その後は id が前回より大きい記録だけを受け取る。
-- 記録はトリガーで自動的に残すので、どの画面・処理から変更しても漏れない。
--   term_id が NULL の記録は、すべての講習に関係する変更（講師の科目、生徒のふりがな、座席設定など）
CREATE TABLE assign_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term_id INTEGER,
    kind TEXT NOT NULL,      -- assignment / assignment_deleted / teacher / student / comiru / reload
    ref_id INTEGER,
    payload TEXT
);
CREATE INDEX idx_assign_events_term ON assign_events(term_id, id);

-- 名簿の取り直しなどで値が変わらなかったときは記録しない（WHEN）

-- 割り当て：追加・変更・削除（画面はこの内容でそのまま手元のデータを直す）
CREATE TRIGGER trg_assignments_insert AFTER INSERT ON assignments BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id, payload) VALUES (NEW.term_id, 'assignment', NEW.id,
    json_object('id', NEW.id, 'student_id', NEW.student_id, 'teacher_id', NEW.teacher_id, 'table_id', NEW.table_id,
                'subject', NEW.subject, 'date', NEW.date, 'period', NEW.period));
END;
CREATE TRIGGER trg_assignments_update AFTER UPDATE ON assignments BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id, payload) VALUES (NEW.term_id, 'assignment', NEW.id,
    json_object('id', NEW.id, 'student_id', NEW.student_id, 'teacher_id', NEW.teacher_id, 'table_id', NEW.table_id,
                'subject', NEW.subject, 'date', NEW.date, 'period', NEW.period));
END;
CREATE TRIGGER trg_assignments_delete AFTER DELETE ON assignments BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id, payload) VALUES (OLD.term_id, 'assignment_deleted', OLD.id,
    json_object('id', OLD.id, 'student_id', OLD.student_id, 'date', OLD.date, 'period', OLD.period));
END;

-- 講師：予定の提出・修正（講習ごと）、科目・ふりがな・名前の変更（全講習）
CREATE TRIGGER trg_teacher_entry_insert AFTER INSERT ON teacher_term_entries BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id) VALUES (NEW.term_id, 'teacher', NEW.teacher_id);
END;
CREATE TRIGGER trg_teacher_entry_update AFTER UPDATE ON teacher_term_entries BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id) VALUES (NEW.term_id, 'teacher', NEW.teacher_id);
END;
CREATE TRIGGER trg_teacher_entry_delete AFTER DELETE ON teacher_term_entries BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id) VALUES (OLD.term_id, 'teacher', OLD.teacher_id);
END;
CREATE TRIGGER trg_teachers_update AFTER UPDATE OF name, name_kana, name_kana_override ON teachers
  WHEN OLD.name IS NOT NEW.name OR OLD.name_kana IS NOT NEW.name_kana OR OLD.name_kana_override IS NOT NEW.name_kana_override BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id) VALUES (NULL, 'teacher', NEW.id);
END;
-- 指導できる科目（更新時刻は秒単位なので使わず、科目の表の変更そのものを記録する）
CREATE TRIGGER trg_teacher_subjects_insert AFTER INSERT ON teacher_subjects BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id) VALUES (NULL, 'teacher', NEW.teacher_id);
END;
CREATE TRIGGER trg_teacher_subjects_delete AFTER DELETE ON teacher_subjects BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id) VALUES (NULL, 'teacher', OLD.teacher_id);
END;

-- 生徒：予定・科目・ステータス・備考（講習ごと）、ふりがな・学年・名前（全講習）
CREATE TRIGGER trg_student_entry_insert AFTER INSERT ON student_term_entries BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id) VALUES (NEW.term_id, 'student', NEW.student_id);
END;
CREATE TRIGGER trg_student_entry_update AFTER UPDATE ON student_term_entries BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id) VALUES (NEW.term_id, 'student', NEW.student_id);
END;
CREATE TRIGGER trg_student_entry_delete AFTER DELETE ON student_term_entries BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id) VALUES (OLD.term_id, 'student', OLD.student_id);
END;
CREATE TRIGGER trg_students_update AFTER UPDATE OF name, name_kana, name_kana_override, grade, grade_override ON students
  WHEN OLD.name IS NOT NEW.name OR OLD.name_kana IS NOT NEW.name_kana OR OLD.name_kana_override IS NOT NEW.name_kana_override
    OR OLD.grade IS NOT NEW.grade OR OLD.grade_override IS NOT NEW.grade_override BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id) VALUES (NULL, 'student', NEW.id);
END;

-- 講習の設定（期間・時限・休校日）と座席設定は、画面全体を読み込み直す
CREATE TRIGGER trg_terms_settings AFTER UPDATE OF start_date, end_date, periods, closed_dates ON terms
  WHEN OLD.start_date IS NOT NEW.start_date OR OLD.end_date IS NOT NEW.end_date
    OR OLD.periods IS NOT NEW.periods OR OLD.closed_dates IS NOT NEW.closed_dates BEGIN
  INSERT INTO assign_events (term_id, kind) VALUES (NEW.id, 'reload');
END;
CREATE TRIGGER trg_room_settings AFTER UPDATE ON room_settings WHEN OLD.table_ids IS NOT NEW.table_ids BEGIN
  INSERT INTO assign_events (term_id, kind) VALUES (NULL, 'reload');
END;

-- comiru への反映（反映状況の表示だけ取り直す）
CREATE TRIGGER trg_comiru_lessons_insert AFTER INSERT ON comiru_lessons BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id) VALUES (NEW.term_id, 'comiru', NEW.student_id);
END;
CREATE TRIGGER trg_comiru_lessons_delete AFTER DELETE ON comiru_lessons BEGIN
  INSERT INTO assign_events (term_id, kind, ref_id) VALUES (OLD.term_id, 'comiru', OLD.student_id);
END;

-- 古い記録は自動で消す（500件ごとに、5000件より前を削除）
CREATE TRIGGER trg_assign_events_prune AFTER INSERT ON assign_events WHEN NEW.id % 500 = 0 BEGIN
  DELETE FROM assign_events WHERE id < NEW.id - 5000;
END;
