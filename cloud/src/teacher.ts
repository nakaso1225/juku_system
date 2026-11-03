// 講師ページ用 API（ログインした本人の情報だけを扱う）
import { Hono } from "hono";
import { SUBJECTS } from "./constants";
import { getTerm, HttpError, nowIso, parseSlots, rowToTerm, termForClient, type Slot } from "./terms";
import type { AppEnv } from "./types";

interface TeacherRow {
  id: number;
  email: string;
  name: string;
  status: "pending" | "approved" | "rejected";
}

export async function findTeacherBySub(db: D1Database, sub: string): Promise<TeacherRow | null> {
  return db.prepare("SELECT id, email, name, status FROM teachers WHERE google_sub = ?").bind(sub).first<TeacherRow>();
}

async function teacherSubjects(db: D1Database, teacherId: number): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT subject FROM teacher_subjects WHERE teacher_id = ?")
    .bind(teacherId)
    .all<{ subject: string }>();
  const order = new Map<string, number>(SUBJECTS.map((s, i) => [s, i]));
  return results.map((r) => r.subject).sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
}

function parseProfile(body: Record<string, unknown>): { name: string; subjects: string[] } {
  const name = String(body.name ?? "").replace(/\s+/g, "");
  if (!name) throw new HttpError(400, "氏名を入力してください");
  if (name.length > 40) throw new HttpError(400, "氏名は40文字以内にしてください");
  const subjects = Array.isArray(body.subjects) ? [...new Set(body.subjects.map(String))] : [];
  if (!subjects.length) throw new HttpError(400, "指導できる科目を1つ以上選んでください");
  const unknown = subjects.filter((s) => !(SUBJECTS as readonly string[]).includes(s));
  if (unknown.length) throw new HttpError(400, `不明な科目です: ${unknown.join(", ")}`);
  return { name, subjects };
}

function replaceSubjectsStatements(db: D1Database, teacherId: number, subjects: string[]): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM teacher_subjects WHERE teacher_id = ?").bind(teacherId),
    db
      .prepare("INSERT INTO teacher_subjects (teacher_id, subject) SELECT ?, value FROM json_each(?)")
      .bind(teacherId, JSON.stringify(subjects)),
  ];
}

/** 登録済みで、却下されていない講師本人を取り出す */
async function requireTeacher(db: D1Database, sub: string): Promise<TeacherRow> {
  const teacher = await findTeacherBySub(db, sub);
  if (!teacher) throw new HttpError(404, "講師登録がまだです");
  if (teacher.status === "rejected") throw new HttpError(403, "この講師登録は承認されませんでした。事務にお問い合わせください");
  return teacher;
}

export const teacherApi = new Hono<AppEnv>();

teacherApi.get("/profile", async (c) => {
  const teacher = await findTeacherBySub(c.env.DB, c.get("user").sub);
  if (!teacher) return c.json({ teacher: null });
  return c.json({ teacher: { ...teacher, subjects: await teacherSubjects(c.env.DB, teacher.id) } });
});

// 新規登録（事務の承認待ちになる）
teacherApi.post("/register", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  if (await findTeacherBySub(db, user.sub)) throw new HttpError(409, "すでに登録されています");
  const { name, subjects } = parseProfile(await c.req.json());

  const inserted = await db
    .prepare("INSERT INTO teachers (google_sub, email, name) VALUES (?, ?, ?) RETURNING id")
    .bind(user.sub, user.email, name)
    .first<{ id: number }>();
  await db.batch(replaceSubjectsStatements(db, inserted!.id, subjects));
  return c.json({ ok: true }, 201);
});

// 氏名・科目の変更（メールアドレスは Google アカウントのものを使う）
teacherApi.patch("/profile", async (c) => {
  const db = c.env.DB;
  const teacher = await requireTeacher(db, c.get("user").sub);
  const { name, subjects } = parseProfile(await c.req.json());
  await db.batch([
    db
      .prepare("UPDATE teachers SET name = ?, email = ?, updated_at = ? WHERE id = ?")
      .bind(name, c.get("user").email, nowIso(), teacher.id),
    ...replaceSubjectsStatements(db, teacher.id, subjects),
  ]);
  return c.json({ ok: true });
});

// 入力を受け付けている講習の一覧と、それぞれの提出状況
teacherApi.get("/terms", async (c) => {
  const db = c.env.DB;
  const teacher = await requireTeacher(db, c.get("user").sub);
  const { results } = await db
    .prepare(
      `SELECT t.*, e.submitted_at, e.updated_at
         FROM terms t
         LEFT JOIN teacher_term_entries e ON e.term_id = t.id AND e.teacher_id = ?
        WHERE t.accepting = 1
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
  const teacher = await requireTeacher(db, c.get("user").sub);
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

// 予定の保存。2回目以降の保存では、変わったコマを事務への通知用に記録する
teacherApi.put("/terms/:termId", async (c) => {
  const db = c.env.DB;
  const teacher = await requireTeacher(db, c.get("user").sub);
  const term = await getTerm(db, Number(c.req.param("termId")));
  if (!term.accepting) throw new HttpError(403, "この講習の入力受付は終了しています");

  const body = await c.req.json<Record<string, unknown>>();
  const slots = parseSlots(term, body.slots);
  const note = String(body.note ?? "").slice(0, 500);

  const [existingRes, entry] = await Promise.all([
    db
      .prepare("SELECT date, period FROM teacher_availability WHERE term_id = ? AND teacher_id = ?")
      .bind(term.id, teacher.id)
      .all<Slot>(),
    db
      .prepare("SELECT submitted_at FROM teacher_term_entries WHERE term_id = ? AND teacher_id = ?")
      .bind(term.id, teacher.id)
      .first<{ submitted_at: string }>(),
  ]);

  const key = (s: Slot) => `${s.date}#${s.period}`;
  const before = new Set(existingRes.results.map(key));
  const after = new Set(slots.map(key));
  const changes = [
    ...slots.filter((s) => !before.has(key(s))).map((s) => ({ ...s, action: "add" })),
    ...existingRes.results.filter((s) => !after.has(key(s))).map((s) => ({ ...s, action: "remove" })),
  ];

  const now = nowIso();
  const statements = [
    db.prepare("DELETE FROM teacher_availability WHERE term_id = ? AND teacher_id = ?").bind(term.id, teacher.id),
    db
      .prepare(
        `INSERT INTO teacher_availability (term_id, teacher_id, date, period)
         SELECT ?, ?, json_extract(value, '$.date'), json_extract(value, '$.period') FROM json_each(?)`,
      )
      .bind(term.id, teacher.id, JSON.stringify(slots)),
    db
      .prepare(
        `INSERT INTO teacher_term_entries (term_id, teacher_id, note, submitted_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (term_id, teacher_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
      )
      .bind(term.id, teacher.id, note, now, now),
  ];
  if (entry && changes.length) {
    statements.push(
      db
        .prepare(
          `INSERT INTO availability_changes (term_id, teacher_id, date, period, action, changed_at)
           SELECT ?, ?, json_extract(value, '$.date'), json_extract(value, '$.period'), json_extract(value, '$.action'), ?
             FROM json_each(?)`,
        )
        .bind(term.id, teacher.id, now, JSON.stringify(changes)),
    );
  }
  await db.batch(statements);

  return c.json({ ok: true, slot_count: slots.length, changed: entry ? changes.length : null, updated_at: now });
});
