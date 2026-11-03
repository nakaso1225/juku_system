-- comiru に登録した授業の記録に、次の2つを足す。
--   owned           … 1 = アプリが作った授業（アプリから変更・削除してよい）
--                     0 = comiru に元からあった同じ授業を使っているだけ（アプリからは変更・削除しない）
--   requested_table … アプリで選んだ席。comiru 側の空きの都合で別の教室になることがあるので、実際の教室（classroom）とは別に持つ
ALTER TABLE comiru_lessons ADD COLUMN owned INTEGER NOT NULL DEFAULT 1;
ALTER TABLE comiru_lessons ADD COLUMN requested_table TEXT;
UPDATE comiru_lessons SET owned = 0 WHERE seat_id IS NULL;
UPDATE comiru_lessons SET requested_table = classroom WHERE requested_table IS NULL;
