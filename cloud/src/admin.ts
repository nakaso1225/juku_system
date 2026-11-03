// 管理画面（事務）用 API
import { Hono } from "hono";
import { comiruConfigured, ComiruError, ensureFreshRoster, normalizeName, refreshComiruStudents, refreshComiruTeachers } from "./comiru";
import { csvResponseHeaders, scheduleCsv, type CsvPerson } from "./availability";
import { registerAssignmentRoutes, resetCompletedWithErrors } from "./assignments";
import { registerAssignSyncRoutes } from "./assignSync";
import { registerComiruSyncRoutes } from "./comiruSync";
import { registerStudentRoutes } from "./students";
import { getTerm, HttpError, isSlotInTerm, nowIso, parseTermInput, rowToTerm, termForClient, type Slot } from "./terms";
import type { AppEnv, Env } from "./types";
import { registerSettingsRoutes } from "./settings";
import { compareNames, parseKana, PERSON_KANA_SQL } from "./roster";

function envAdminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export async function isStaff(env: Env, email: string): Promise<boolean> {
  if (envAdminEmails(env).includes(email)) return true;
  const row = await env.DB.prepare("SELECT 1 FROM staff WHERE email = ?").bind(email).first();
  return Boolean(row);
}

export const adminApi = new Hono<AppEnv>();

adminApi.use("*", async (c, next) => {
  if (!(await isStaff(c.env, c.get("user").email))) {
    throw new HttpError(403, "管理画面を使う権限がありません");
  }
  await next();
});
registerSettingsRoutes(adminApi);

// ---------------------------------------------------------------- 講習

adminApi.get("/terms", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM terms ORDER BY start_date DESC").all();
  return c.json(results.map((row) => termForClient(rowToTerm(row))));
});

adminApi.post("/terms", async (c) => {
  const t = parseTermInput(await c.req.json());
  const row = await c.env.DB.prepare(
    `INSERT INTO terms (name, start_date, end_date, periods, closed_dates, accepting)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
  )
    .bind(t.name, t.start_date, t.end_date, JSON.stringify(t.periods), JSON.stringify(t.closed_dates), t.accepting ? 1 : 0)
    .first();
  return c.json(termForClient(rowToTerm(row!)), 201);
});

adminApi.put("/terms/:termId", async (c) => {
  const db = c.env.DB;
  const term = await getTerm(db, Number(c.req.param("termId")));
  const body = await c.req.json<Record<string, unknown>>();
  const t = parseTermInput(body);
  // 新しい設定で対象外になる授業（休校日・期間外・時限外）。授業は消さずに残し、エラーとして表示して移動してもらう
  const { results: affected } = await db
    .prepare(
      `SELECT a.date, a.period, s.name AS student_name, tc.name AS teacher_name
         FROM assignments a JOIN students s ON s.id = a.student_id LEFT JOIN teachers tc ON tc.id = a.teacher_id
        WHERE a.term_id = ?1 AND NOT (a.date BETWEEN ?2 AND ?3 AND a.period IN (SELECT value FROM json_each(?4))
              AND a.date NOT IN (SELECT value FROM json_each(?5)))
        ORDER BY a.date, a.period, s.name`,
    )
    .bind(term.id, t.start_date, t.end_date, JSON.stringify(t.periods), JSON.stringify(t.closed_dates))
    .all<{ date: string; period: number; student_name: string; teacher_name: string | null }>();
  const before = new Set(
    (await db.prepare("SELECT date, period FROM assignments WHERE term_id = ?").bind(term.id).all<{ date: string; period: number }>()).results
      .filter((a) => !isSlotInTerm(term, a))
      .map((a) => `${a.date}#${a.period}`),
  );
  const newlyAffected = affected.filter((a) => !before.has(`${a.date}#${a.period}`));
  if (newlyAffected.length && body.confirm_affected !== true) {
    return c.json(
      {
        error: `この変更で、授業が入っている ${newlyAffected.length}コマが休校日・期間外になります。授業は消えずに「休校日・期間外」のエラーとして残るので、保存したあとに移動してください。`,
        affected: newlyAffected,
      },
      409,
    );
  }
  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE terms SET name = ?, start_date = ?, end_date = ?, periods = ?, closed_dates = ?, accepting = ?, version = version + 1
          WHERE id = ? RETURNING *`,
      )
      .bind(t.name, t.start_date, t.end_date, JSON.stringify(t.periods), JSON.stringify(t.closed_dates), t.accepting ? 1 : 0, term.id),
    resetCompletedWithErrors(db, term.id),
  ]);
  return c.json(termForClient(rowToTerm(updated.results[0] as Record<string, unknown>)));
});

// ---------------------------------------------------------------- 講師（comiru の名簿）

// 「事務が最後に確認した予定（基準）」から消えたコマ・増えたコマを数える SQL 断片（?1 = term_id）
const REMOVED_EXISTS = `NOT EXISTS (SELECT 1 FROM teacher_availability a
   WHERE a.term_id = b.term_id AND a.teacher_id = b.teacher_id AND a.date = b.date AND a.period = b.period)`;
const ADDED_EXISTS = `NOT EXISTS (SELECT 1 FROM availability_baseline b
   WHERE b.term_id = a.term_id AND b.teacher_id = a.teacher_id AND b.date = a.date AND b.period = a.period)`;

// 講師一覧（comiru の名簿のうち、隠していない講師）。term_id の講習の提出状況も返す。hidden=1 で隠した講師だけ
adminApi.get("/teachers", async (c) => {
  await ensureFreshRoster(c.env, "comiru_teachers");
  const termId = Number(c.req.query("term_id") || 0);
  const hidden = c.req.query("hidden") === "1" ? 1 : 0;
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.name, ${PERSON_KANA_SQL("t")}, t.email, t.google_email, t.google_sub IS NOT NULL AS linked, t.comiru_teacher_id, t.hidden,
            (SELECT group_concat(subject, ', ') FROM teacher_subjects s WHERE s.teacher_id = t.id) AS subjects,
            e.submitted_at, e.updated_at, e.note,
            (SELECT COUNT(*) FROM teacher_availability a WHERE a.teacher_id = t.id AND a.term_id = ?1) AS slot_count
       FROM teachers t
       LEFT JOIN teacher_term_entries e ON e.teacher_id = t.id AND e.term_id = ?1
      WHERE (t.active = 1 OR e.teacher_id IS NOT NULL) AND t.hidden = ?2
      ORDER BY t.name`,
  )
    .bind(termId, hidden)
    .all();
  return c.json(results.map((r) => ({ ...r, linked: Boolean(r.linked) })).sort(compareNames));
});

adminApi.patch("/teachers/:teacherId/profile", async (c) => {
  const kana = parseKana((await c.req.json<{ name_kana?: string }>()).name_kana);
  const results = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE teachers SET name_kana_override = ? WHERE id = ?")
      .bind(kana, Number(c.req.param("teacherId"))),
    c.env.DB.prepare("UPDATE terms SET version = version + 1 WHERE changes() > 0"),
  ]);
  if (!results[0].meta.changes) throw new HttpError(404, "講師が見つかりません");
  return c.json({ ok: true });
});

// 「本人です」申請の一覧。同じ名前の講師（候補）を、comiru のメールアドレスと一緒に返す
adminApi.get("/link-requests", async (c) => {
  const db = c.env.DB;
  const [requests, teachers] = await Promise.all([
    db.prepare("SELECT google_sub, google_email, google_name, requested_name, created_at FROM teacher_link_requests ORDER BY created_at").all<{
      google_sub: string;
      google_email: string;
      google_name: string;
      requested_name: string;
      created_at: string;
    }>(),
    db.prepare("SELECT id, name, email, google_email FROM teachers WHERE active = 1").all<{
      id: number;
      name: string;
      email: string;
      google_email: string | null;
    }>(),
  ]);
  return c.json(
    requests.results.map((r) => ({
      ...r,
      candidates: teachers.results.filter((t) => normalizeName(t.name) === normalizeName(r.requested_name)),
    })),
  );
});

// 申請を承認：その Google アカウントを講師に紐付ける（すでに別のアカウントが紐付いていれば置き換える）
adminApi.post("/link-requests/approve", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ google_sub?: string; teacher_id?: number }>();
  const request = await db
    .prepare("SELECT google_sub, google_email FROM teacher_link_requests WHERE google_sub = ?")
    .bind(String(body.google_sub ?? ""))
    .first<{ google_sub: string; google_email: string }>();
  if (!request) throw new HttpError(404, "申請が見つかりません");
  const teacher = await db.prepare("SELECT id FROM teachers WHERE id = ? AND active = 1").bind(Number(body.teacher_id)).first<{ id: number }>();
  if (!teacher) throw new HttpError(404, "講師が見つかりません");

  await db.batch([
    db.prepare("UPDATE teachers SET google_sub = NULL, google_email = NULL WHERE google_sub = ?").bind(request.google_sub),
    db
      .prepare("UPDATE teachers SET google_sub = ?, google_email = ?, updated_at = ? WHERE id = ?")
      .bind(request.google_sub, request.google_email, nowIso(), teacher.id),
    db.prepare("DELETE FROM teacher_link_requests WHERE google_sub = ?").bind(request.google_sub),
  ]);
  return c.json({ ok: true });
});

adminApi.post("/link-requests/reject", async (c) => {
  const body = await c.req.json<{ google_sub?: string }>();
  const result = await c.env.DB.prepare("DELETE FROM teacher_link_requests WHERE google_sub = ?").bind(String(body.google_sub ?? "")).run();
  if (!result.meta.changes) throw new HttpError(404, "申請が見つかりません");
  return c.json({ ok: true });
});

// 一覧から隠す／表示に戻す
adminApi.post("/teachers/:teacherId/visibility", async (c) => {
  const hidden = Boolean((await c.req.json<{ hidden?: boolean }>()).hidden);
  const result = await c.env.DB.prepare("UPDATE teachers SET hidden = ?, updated_at = ? WHERE id = ?")
    .bind(hidden ? 1 : 0, nowIso(), Number(c.req.param("teacherId")))
    .run();
  if (!result.meta.changes) throw new HttpError(404, "講師が見つかりません");
  return c.json({ ok: true });
});

// Google アカウントの紐付けを外す（間違って紐付いたとき用。入力済みの予定はそのまま残る）
adminApi.post("/teachers/:teacherId/unlink", async (c) => {
  const result = await c.env.DB.prepare("UPDATE teachers SET google_sub = NULL, google_email = NULL, updated_at = ? WHERE id = ?")
    .bind(nowIso(), Number(c.req.param("teacherId")))
    .run();
  if (!result.meta.changes) throw new HttpError(404, "講師が見つかりません");
  return c.json({ ok: true });
});

interface DiffRow {
  teacher_id: number;
  teacher_name: string;
  date: string;
  period: number;
  action: "remove" | "add";
  updated_at: string;
}

/** 事務が最後に確認した予定（基準）と今の予定の差。講師を指定しなければ講習全体 */
async function availabilityDiff(db: D1Database, termId: number, teacherId: number | null): Promise<DiffRow[]> {
  const term = await getTerm(db, termId);
  const { results } = await db
    .prepare(
      `SELECT d.teacher_id, t.name AS teacher_name, d.date, d.period, d.action, e.updated_at
         FROM (
           SELECT b.teacher_id, b.date, b.period, 'remove' AS action
             FROM availability_baseline b WHERE b.term_id = ?1 AND ${REMOVED_EXISTS}
           UNION ALL
           SELECT a.teacher_id, a.date, a.period, 'add' AS action
             FROM teacher_availability a WHERE a.term_id = ?1 AND ${ADDED_EXISTS}
         ) d
         JOIN teachers t ON t.id = d.teacher_id
         JOIN teacher_term_entries e ON e.term_id = ?1 AND e.teacher_id = d.teacher_id
        WHERE (?2 IS NULL OR d.teacher_id = ?2) AND t.status != 'rejected'
        ORDER BY t.name, d.date, d.period`,
    )
    .bind(termId, teacherId)
    .all<DiffRow>();
  return results.filter((r) => isSlotInTerm(term, r));
}

// 講師の削除（予定・提出状況もすべて消える）
// ---------------------------------------------------------------- comiru 連携

adminApi.get("/comiru/status", async (c) => {
  const db = c.env.DB;
  const [teachers, students] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count, MAX(fetched_at) AS fetched_at FROM comiru_teachers").first(),
    db.prepare("SELECT COUNT(*) AS count, MAX(fetched_at) AS fetched_at FROM comiru_students").first(),
  ]);
  return c.json({ configured: comiruConfigured(c.env), teachers, students });
});

// comiru から講師・生徒の名簿を取り直す
adminApi.post("/comiru/refresh", async (c) => {
  const which = c.req.query("which");
  try {
    const teachers = which === "students" ? null : await refreshComiruTeachers(c.env);
    const students = which === "teachers" ? null : await refreshComiruStudents(c.env);
    return c.json({ teachers, students });
  } catch (err) {
    if (err instanceof ComiruError) throw new HttpError(400, err.message);
    throw err;
  }
});

// 特定の講師の予定（閲覧用）。確認後に消えたコマ・増えたコマも返す
adminApi.get("/terms/:termId/teachers/:teacherId", async (c) => {
  const term = await getTerm(c.env.DB, Number(c.req.param("termId")));
  const teacherId = Number(c.req.param("teacherId"));
  const [slots, entry, diff] = await Promise.all([
    c.env.DB.prepare("SELECT date, period FROM teacher_availability WHERE term_id = ? AND teacher_id = ?")
      .bind(term.id, teacherId)
      .all<Slot>(),
    c.env.DB.prepare(
      "SELECT note, submitted_at, updated_at, reviewed_at FROM teacher_term_entries WHERE term_id = ? AND teacher_id = ?",
    )
      .bind(term.id, teacherId)
      .first(),
    availabilityDiff(c.env.DB, term.id, teacherId),
  ]);
  return c.json({
    term: termForClient(term),
    slots: slots.results.filter((s) => isSlotInTerm(term, s)),
    note: entry?.note ?? "",
    submitted_at: entry?.submitted_at ?? null,
    updated_at: entry?.updated_at ?? null,
    reviewed_at: entry?.reviewed_at ?? null,
    removed: diff.filter((d) => d.action === "remove"),
    added: diff.filter((d) => d.action === "add"),
  });
});

// ---------------------------------------------------------------- 予定の変更（確認後に変わったコマ）

adminApi.get("/terms/:termId/changes", async (c) => {
  return c.json(await availabilityDiff(c.env.DB, Number(c.req.param("termId")), null));
});

// 確認済みにする：今の予定を新しい基準にする（teacher_id を省略すると講習全体）
adminApi.post("/terms/:termId/changes/reviewed", async (c) => {
  const termId = Number(c.req.param("termId"));
  const body = await c.req.json<{ teacher_id?: number }>().catch(() => ({}) as { teacher_id?: number });
  const teacherId = body.teacher_id ? Number(body.teacher_id) : null;
  const db = c.env.DB;
  await db.batch([
    db.prepare("DELETE FROM availability_baseline WHERE term_id = ?1 AND (?2 IS NULL OR teacher_id = ?2)").bind(termId, teacherId),
    db
      .prepare(
        `INSERT INTO availability_baseline (term_id, teacher_id, date, period)
         SELECT a.term_id, a.teacher_id, a.date, a.period
           FROM teacher_availability a
           JOIN teacher_term_entries e ON e.term_id = a.term_id AND e.teacher_id = a.teacher_id
          WHERE a.term_id = ?1 AND (?2 IS NULL OR a.teacher_id = ?2)`,
      )
      .bind(termId, teacherId),
    db
      .prepare("UPDATE teacher_term_entries SET reviewed_at = ?3 WHERE term_id = ?1 AND (?2 IS NULL OR teacher_id = ?2)")
      .bind(termId, teacherId, nowIso()),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- 今のアプリ向け CSV

// 提出済みの講師だけを出す
adminApi.get("/terms/:termId/export/teachers.csv", async (c) => {
  const db = c.env.DB;
  const term = await getTerm(db, Number(c.req.param("termId")));
  const [people, slots] = await Promise.all([
    db
      .prepare(
        `SELECT t.id, t.name, e.note, e.updated_at,
                COALESCE((SELECT group_concat(subject, ', ') FROM teacher_subjects s WHERE s.teacher_id = t.id), '') AS subjects
           FROM teachers t JOIN teacher_term_entries e ON e.teacher_id = t.id AND e.term_id = ?
          ORDER BY t.name`,
      )
      .bind(term.id)
      .all<CsvPerson>(),
    db
      .prepare("SELECT teacher_id AS owner_id, date, period FROM teacher_availability WHERE term_id = ?")
      .bind(term.id)
      .all<Slot & { owner_id: number }>(),
  ]);
  return c.body(scheduleCsv("teacher", term, people.results, slots.results), 200, csvResponseHeaders(`${term.name}_講師予定.csv`));
});

// ---------------------------------------------------------------- 事務アカウント

adminApi.get("/staff", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT email, name, created_at FROM staff ORDER BY created_at").all();
  return c.json({ staff: results, env_admins: envAdminEmails(c.env) });
});

adminApi.post("/staff", async (c) => {
  const body = await c.req.json<{ email?: string; name?: string }>();
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "メールアドレスを正しく入力してください");
  await c.env.DB.prepare("INSERT INTO staff (email, name) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name")
    .bind(email, String(body.name ?? "").trim())
    .run();
  return c.json({ ok: true }, 201);
});

adminApi.delete("/staff/:email", async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  if (email === c.get("user").email) throw new HttpError(400, "自分自身は削除できません");
  await c.env.DB.prepare("DELETE FROM staff WHERE email = ?").bind(email).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- 生徒（students.ts）

registerStudentRoutes(adminApi);

// ---------------------------------------------------------------- コマ割り当て（assignments.ts）と comiru への反映（comiruSync.ts）

registerAssignmentRoutes(adminApi);
registerAssignSyncRoutes(adminApi);
registerComiruSyncRoutes(adminApi);
