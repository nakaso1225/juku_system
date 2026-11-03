-- 管理画面の講師一覧から隠す講師（辞めた講師など）。comiru から取り直しても変わらない。
-- comiru に新しく増えた講師は 0（表示）で入る。隠した講師が予定を入力すると 0 に戻る。
ALTER TABLE teachers ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
