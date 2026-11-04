-- comiru名簿を更新しても、事務が登録したログイン用アドレスは保持する。
ALTER TABLE teachers ADD COLUMN login_email_override TEXT;

-- 講習の削除は復元可能にし、予定とcomiruへの反映記録を保持する。
ALTER TABLE terms ADD COLUMN deleted_at TEXT;
CREATE TRIGGER trg_terms_deleted AFTER UPDATE OF deleted_at ON terms
  WHEN OLD.deleted_at IS NOT NEW.deleted_at BEGIN
  INSERT INTO assign_events (term_id, kind) VALUES (NEW.id, 'reload');
END;
