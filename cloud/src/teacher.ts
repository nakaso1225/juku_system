// 講師ページ用 API（ログインした本人の情報だけを扱う）
//
// 講師は comiru の名簿（teachers）に最初から全員いる。Google でログインすると
//   1. その Google アカウントがすでに紐付いていれば、その講師
//   2. 事務が登録したログイン用メール（未設定時はcomiruのメール）と一致すれば自動的に紐付ける
// 旧画面からの申請APIは互換用に残す。通常は事務のメール設定だけで利用できる。
import { Hono } from "hono";
import { bumpVersion, resetCompletedWithErrors } from "./assignments";
import { replaceSlotsStatements, TEACHER_SLOTS } from "./availability";
import { ensureFreshRoster, normalizeName } from "./comiru";
import { SUBJECTS } from "./constants";
import { getTerm, HttpError, nowIso, parseSlots, rowToTerm, termForClient, type Slot } from "./terms";
import type { AppEnv, Env, SessionUser } from "./types";

export interface TeacherRow {
  id: number;
  name: string;
  google_email: string | null;
}

export interface LinkRequestRow {
  requested_name: string;
  created_at: string;
}

/** ログイン中の Google アカウントに紐付いた講師。未紐付けなら comiru のアドレスとの照合を試す */
export async function resolveTeacher(env: Env, user: SessionUser): Promise<TeacherRow | null> {
  const db = env.DB;
  const linked = await db
    .prepare("SELECT id, name, google_email, active, login_email_override FROM teachers WHERE google_sub = ?")
    .bind(user.sub)
    .first<TeacherRow & { active: number; login_email_override: string | null }>();
  // 紐付け済みでも、comiru の講師名簿から外れた講師（active = 0）は使えない（一覧から「隠す」とは別）
  if (linked) return linked.active && (linked.login_email_override == null || linked.login_email_override === user.email.toLowerCase())
    ? { id: linked.id, name: linked.name, google_email: linked.google_email } : null;

  await ensureFreshRoster(env, "comiru_teachers");
  const { results } = await db
    .prepare("SELECT id FROM teachers WHERE google_sub IS NULL AND active = 1 AND lower(COALESCE(login_email_override, email)) = ?")
    .bind(user.email.toLowerCase())
    .all<{ id: number }>();
  if (results.length !== 1) return null;

  await db.batch([
    db
      .prepare("UPDATE teachers SET google_sub = ?, google_email = ?, updated_at = ? WHERE id = ? AND google_sub IS NULL")
      .bind(user.sub, user.email, nowIso(), results[0].id),
    db.prepare("DELETE FROM teacher_link_requests WHERE google_sub = ?").bind(user.sub),
  ]);
  return db.prepare("SELECT id, name, google_email FROM teachers WHERE google_sub = ?").bind(user.sub).first<TeacherRow>();
}

export async function findLinkRequest(db: D1Database, sub: string): Promise<LinkRequestRow | null> {
  return db
    .prepare("SELECT requested_name, created_at FROM teacher_link_requests WHERE google_sub = ?")
    .bind(sub)
    .first<LinkRequestRow>();
}

async function teacherSubjects(db: D1Database, teacherId: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT subject FROM teacher_subjects WHERE teacher_id = ?")
    .bind(teacherId)
    .all<{ subject: string }>();
  const order = new Map<string, number>(SUBJECTS.map((s, i) => [s, i]));
  return results.map((r) => r.subject).sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
}

function parseSubjects(raw: unknown): string[] {
  const subjects = Array.isArray(raw) ? [...new Set(raw.map(String))] : [];
  if (!subjects.length) throw new HttpError(400, "指導できる科目を1つ以上選んでください");
  const unknown = subjects.filter((s) => !(SUBJECTS as readonly string[]).includes(s));
  if (unknown.length) throw new HttpError(400, `不明な科目です: ${unknown.join(", ")}`);
  return subjects;
}

/** ログイン中のアカウントが、名簿から外れた講師に紐付いているか */
export async function isInactiveTeacher(db: D1Database, sub: string): Promise<boolean> {
  return Boolean(await db.prepare("SELECT 1 FROM teachers WHERE google_sub = ? AND active = 0").bind(sub).first());
}

export const INACTIVE_TEACHER_MESSAGE = "comiru の講師名簿にいないため、使えません。心当たりがない場合は事務にお問い合わせください";

async function requireTeacher(env: Env, user: SessionUser): Promise<TeacherRow> {
  const teacher = await resolveTeacher(env, user);
  if (!teacher) {
    throw new HttpError(403, (await isInactiveTeacher(env.DB, user.sub)) ? INACTIVE_TEACHER_MESSAGE : "このアカウントはまだ講師と紐付いていません");
  }
  return teacher;
}

export const teacherApi = new Hono<AppEnv>();

teacherApi.get("/profile", async (c) => {
  const user = c.get("user");
  const teacher = await resolveTeacher(c.env, user);
  if (!teacher) return c.json({ teacher: null, link_request: await findLinkRequest(c.env.DB, user.sub) });
  return c.json({ teacher: { ...teacher, subjects: await teacherSubjects(c.env.DB, teacher.id) }, link_request: null });
});

// comiru のアドレスと一致しなかった人の「本人です」申請。名前が comiru の講師と一致するときだけ受け付ける
teacherApi.post("/link-request", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  if (await resolveTeacher(c.env, user)) throw new HttpError(409, "すでに講師と紐付いています");
  if (await isInactiveTeacher(db, user.sub)) throw new HttpError(403, INACTIVE_TEACHER_MESSAGE);

  const name = String((await c.req.json<{ name?: string }>()).name ?? "").trim();
  if (!name) throw new HttpError(400, "名前を入力してください");
  const { results } = await db
    .prepare("SELECT id, name FROM teachers WHERE active = 1")
    .all<{ id: number; name: string }>();
  const match = results.find((t) => normalizeName(t.name) === normalizeName(name));
  if (!match) {
    throw new HttpError(400, "comiru に登録されている講師の名前と一致しません。comiru と同じ漢字で入力してください");
  }
  await db
    .prepare(
      `INSERT INTO teacher_link_requests (google_sub, google_email, google_name, requested_name, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (google_sub) DO UPDATE SET requested_name = excluded.requested_name, created_at = excluded.created_at`,
    )
    .bind(user.sub, user.email, user.name, match.name, nowIso())
    .run();
  return c.json({ ok: true }, 201);
});

teacherApi.delete("/link-request", async (c) => {
  await c.env.DB.prepare("DELETE FROM teacher_link_requests WHERE google_sub = ?").bind(c.get("user").sub).run();
  return c.json({ ok: true });
});

// 指導できる科目の変更（名前・メールアドレスは comiru のものを使うので変更しない）
teacherApi.patch("/profile", async (c) => {
  const db = c.env.DB;
  const teacher = await requireTeacher(c.env, c.get("user"));
  const subjects = parseSubjects((await c.req.json<{ subjects?: unknown }>()).subjects);
  // 科目が変わると、授業の入っている講習で「講師予定不一致」が出ることがある
  const { results: termRows } = await db.prepare("SELECT DISTINCT term_id FROM assignments WHERE teacher_id = ?").bind(teacher.id).all<{ term_id: number }>();
  await db.batch([
    db.prepare("DELETE FROM teacher_subjects WHERE teacher_id = ?").bind(teacher.id),
    db
      .prepare("INSERT INTO teacher_subjects (teacher_id, subject) SELECT ?, value FROM json_each(?)")
      .bind(teacher.id, JSON.stringify(subjects)),
    db.prepare("UPDATE teachers SET updated_at = ? WHERE id = ?").bind(nowIso(), teacher.id),
    db.prepare("UPDATE terms SET version = version + 1 WHERE id IN (SELECT term_id FROM assignments WHERE teacher_id = ?)").bind(teacher.id),
    ...termRows.map((r) => resetCompletedWithErrors(db, r.term_id)),
  ]);
  return c.json({ ok: true });
});

// 入力を受け付けている講習の一覧と、それぞれの提出状況
teacherApi.get("/terms", async (c) => {
  const db = c.env.DB;
  const teacher = await requireTeacher(c.env, c.get("user"));
  const { results } = await db
    .prepare(
      `SELECT t.*, e.submitted_at, e.updated_at
         FROM terms t
         LEFT JOIN teacher_term_entries e ON e.term_id = t.id AND e.teacher_id = ?
        WHERE t.accepting = 1 AND t.deleted_at IS NULL
        ORDER BY t.start_date`,
    )
    .bind(teacher.id)
    .all();
  return c.json(
    results.map((row) => ({
      ...rowToTerm(row),
      submitted_at: row.submitted_at ?? null,
      updated_at: row.updated_at ?? null,
    })),
  );
});

teacherApi.get("/terms/:termId", async (c) => {
  const db = c.env.DB;
  const teacher = await requireTeacher(c.env, c.get("user"));
  const term = await getTerm(db, Number(c.req.param("termId")));
  const [slots, entry] = await Promise.all([
    db
      .prepare("SELECT date, period FROM teacher_availability WHERE term_id = ? AND teacher_id = ? ORDER BY date, period")
      .bind(term.id, teacher.id)
      .all<Slot>(),
    db
      .prepare("SELECT note, submitted_at, updated_at FROM teacher_term_entries WHERE term_id = ? AND teacher_id = ?")
      .bind(term.id, teacher.id)
      .first(),
  ]);
  return c.json({
    term: termForClient(term),
    slots: slots.results,
    note: entry?.note ?? "",
    submitted_at: entry?.submitted_at ?? null,
    updated_at: entry?.updated_at ?? null,
  });
});

// 予定の保存
teacherApi.put("/terms/:termId", async (c) => {
  const db = c.env.DB;
  const teacher = await requireTeacher(c.env, c.get("user"));
  const term = await getTerm(db, Number(c.req.param("termId")));
  if (!term.accepting) throw new HttpError(403, "この講習の入力受付は終了しています");

  const body = await c.req.json<Record<string, unknown>>();
  const slots = parseSlots(term, body.slots, { dropOutside: true });
  const note = String(body.note ?? "").slice(0, 500);

  const entry = await db
    .prepare("SELECT submitted_at FROM teacher_term_entries WHERE term_id = ? AND teacher_id = ?")
    .bind(term.id, teacher.id)
    .first<{ submitted_at: string }>();

  const now = nowIso();
  const statements = await replaceSlotsStatements(db, TEACHER_SLOTS, term.id, teacher.id, slots);
  statements.push(
    db
      .prepare(
        `INSERT INTO teacher_term_entries (term_id, teacher_id, note, submitted_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (term_id, teacher_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
      )
      .bind(term.id, teacher.id, note, now, now),
  );
  // 初回提出の内容を「事務が把握している予定」の基準にする（コマ割り当て時の変更検知に使う）
  if (!entry) {
    statements.push(
      db.prepare("DELETE FROM availability_baseline WHERE term_id = ? AND teacher_id = ?").bind(term.id, teacher.id),
      db
        .prepare(
          `INSERT INTO availability_baseline (term_id, teacher_id, date, period)
           SELECT ?, ?, json_extract(value, '$.date'), json_extract(value, '$.period') FROM json_each(?)`,
        )
        .bind(term.id, teacher.id, JSON.stringify(slots)),
    );
  }
  // 隠していた講師が予定を入力したら、一覧に戻す（復帰した講師を見落とさないため）
  statements.push(db.prepare("UPDATE teachers SET hidden = 0 WHERE id = ? AND hidden = 1").bind(teacher.id));
  statements.push(bumpVersion(db, term.id), resetCompletedWithErrors(db, term.id));
  await db.batch(statements);

  return c.json({ ok: true, slot_count: slots.length, first_submission: !entry, updated_at: now });
});
