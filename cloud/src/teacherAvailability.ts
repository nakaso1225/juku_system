// 講師の予定（来られるコマ・備考）の保存。講師本人の保存と、事務の代理入力（電話・LINE で連絡を受けたとき）で共通。
//
// - 保存のたびに rev（何回目の保存か）を1つ進める。読み込んだ時点の rev と違えば、ほかの人が先に保存しているので保存しない（409）
// - 増えたコマ・減ったコマ・備考の変化を、誰が保存したかと一緒に teacher_availability_log に残す
// - 「事務が把握している予定」（availability_baseline。割り当て画面の変更のお知らせに使う）は
//     初回の保存 … その内容にする
//     事務の代理入力 … 事務が自分で直した分だけ反映する（本人の未確認の変更のお知らせは消さない）
//     本人の2回目以降の保存 … 変えない（事務へのお知らせになる）
import { bumpVersion, resetCompletedWithErrors } from "./assignments";
import { replaceSlotsWithDiff, TEACHER_SLOTS } from "./availability";
import { HttpError, nowIso, type Slot } from "./terms";
import type { Term } from "./types";

export type AvailabilityActor = { role: "teacher" | "staff"; email: string };

export const TEACHER_STALE_MESSAGE = {
  teacher: "事務の方がこの講習の予定を直しています。画面を読み込み直して、最新の予定を確認してから保存してください",
  staff: "講師本人かほかの事務の方が、先にこの講師の予定を保存しています。閉じて開き直し、最新の予定を確認してから保存してください",
};

export async function saveTeacherAvailability(
  db: D1Database,
  opts: { term: Term; teacherId: number; slots: Slot[]; note: string; actor: AvailabilityActor; expectedRev?: number | null; reason?: string },
): Promise<{ slot_count: number; first_submission: boolean; updated_at: string; rev: number; changed: boolean }> {
  const { term, teacherId, slots, note, actor } = opts;
  const entry = await db
    .prepare("SELECT note, rev FROM teacher_term_entries WHERE term_id = ? AND teacher_id = ?")
    .bind(term.id, teacherId)
    .first<{ note: string; rev: number }>();
  const currentRev = entry ? entry.rev : -1;
  // expected_rev が null ＝「まだ入力がない」を見て保存した
  if (opts.expectedRev !== undefined && (opts.expectedRev ?? -1) !== currentRev) {
    throw new HttpError(409, TEACHER_STALE_MESSAGE[actor.role]);
  }

  const now = nowIso();
  const { statements: slotStatements, added, removed } = await replaceSlotsWithDiff(db, TEACHER_SLOTS, term.id, teacherId, slots);
  const noteChanged = (entry?.note ?? "") !== note;
  const changed = !entry || added.length > 0 || removed.length > 0 || noteChanged;

  const statements: D1PreparedStatement[] = [
    // ここまでに読んだ内容（予定・rev）のあとで誰かが保存していたら、わざとエラーにしてまとめて取り消す
    db
      .prepare(
        "SELECT CASE WHEN COALESCE((SELECT rev FROM teacher_term_entries WHERE term_id = ? AND teacher_id = ?), -1) != ? THEN json('stale') END",
      )
      .bind(term.id, teacherId, currentRev),
    ...slotStatements,
    db
      .prepare(
        `INSERT INTO teacher_term_entries (term_id, teacher_id, note, submitted_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (term_id, teacher_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at,
           rev = teacher_term_entries.rev + 1`,
      )
      .bind(term.id, teacherId, note, now, now),
  ];

  if (!entry) {
    statements.push(
      db.prepare("DELETE FROM availability_baseline WHERE term_id = ? AND teacher_id = ?").bind(term.id, teacherId),
      db
        .prepare(
          `INSERT INTO availability_baseline (term_id, teacher_id, date, period)
           SELECT ?, ?, json_extract(value, '$.date'), json_extract(value, '$.period') FROM json_each(?)`,
        )
        .bind(term.id, teacherId, JSON.stringify(slots)),
    );
  } else if (actor.role === "staff") {
    if (removed.length) {
      statements.push(
        db
          .prepare(
            `DELETE FROM availability_baseline WHERE term_id = ?1 AND teacher_id = ?2
               AND EXISTS (SELECT 1 FROM json_each(?3) j WHERE json_extract(j.value, '$.date') = availability_baseline.date
                                                         AND json_extract(j.value, '$.period') = availability_baseline.period)`,
          )
          .bind(term.id, teacherId, JSON.stringify(removed)),
      );
    }
    if (added.length) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO availability_baseline (term_id, teacher_id, date, period)
             SELECT ?, ?, json_extract(value, '$.date'), json_extract(value, '$.period') FROM json_each(?)`,
          )
          .bind(term.id, teacherId, JSON.stringify(added)),
      );
    }
  }

  if (changed) {
    statements.push(
      db
        .prepare(
          `INSERT INTO teacher_availability_log (term_id, teacher_id, actor_role, actor_email, added, removed, note_before, note_after, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          term.id,
          teacherId,
          actor.role,
          actor.email,
          JSON.stringify(added),
          JSON.stringify(removed),
          noteChanged ? (entry?.note ?? "") : null,
          noteChanged ? note : null,
          String(opts.reason ?? "").slice(0, 200),
          now,
        ),
    );
  }
  // 隠していた講師の予定が入ったら、一覧に戻す（復帰した講師を見落とさないため）
  statements.push(db.prepare("UPDATE teachers SET hidden = 0 WHERE id = ? AND hidden = 1").bind(teacherId));
  statements.push(bumpVersion(db, term.id), resetCompletedWithErrors(db, term.id));

  try {
    await db.batch(statements);
  } catch (err) {
    if (/malformed JSON|stale/i.test(String(err))) throw new HttpError(409, TEACHER_STALE_MESSAGE[actor.role]);
    throw err;
  }
  return { slot_count: slots.length, first_submission: !entry, updated_at: now, rev: entry ? currentRev + 1 : 0, changed };
}

/** 変更履歴（新しい順） */
export async function teacherAvailabilityLog(db: D1Database, termId: number, teacherId: number, limit = 50) {
  const { results } = await db
    .prepare(
      `SELECT id, actor_role, actor_email, added, removed, note_before, note_after, reason, created_at
         FROM teacher_availability_log WHERE term_id = ? AND teacher_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .bind(termId, teacherId, limit)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    id: Number(r.id),
    actor_role: String(r.actor_role),
    actor_email: String(r.actor_email),
    added: JSON.parse(String(r.added)) as Slot[],
    removed: JSON.parse(String(r.removed)) as Slot[],
    note_before: r.note_before == null ? null : String(r.note_before),
    note_after: r.note_after == null ? null : String(r.note_after),
    reason: String(r.reason ?? ""),
    created_at: String(r.created_at),
  }));
}
