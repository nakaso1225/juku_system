-- 生徒の予定・科目・備考の「何回目の保存か」。保存のときに、読み込んだ時点の番号と違えば（ほかの人が先に保存していれば）保存しない
ALTER TABLE student_term_entries ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
