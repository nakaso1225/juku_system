// 生徒の予定（事務が入力する）。生徒は comiru の名簿の全員。管理画面 API（/api/admin 以下）に追加する
import type { Hono } from "hono";
import { csvResponseHeaders, readSlots, replaceSlotsStatements, scheduleCsv, STUDENT_SLOTS, type CsvPerson } from "./availability";
import { bumpVersion, resetCompletedWithErrors } from "./assignments";
import { ensureFreshRoster } from "./comiru";
import { SUBJECTS } from "./constants";
import { getTerm, HttpError, nowIso, parseSlots, termForClient, type Slot } from "./terms";
import type { AppEnv } from "./types";
import { compareStudents, GRADES, normalizeGrade, parseKana, PERSON_KANA_SQL, STUDENT_GRADE_SQL } from "./roster";

function parseSubjects(raw: unknown): string[] {
  const subjects = Array.isArray(raw) ? [...new Set(raw.map(String))] : [];
  const unknown = subjects.filter((s) => !(SUBJECTS as readonly string[]).includes(s));
  if (unknown.length) throw new HttpError(400, `不明な科目です: ${unknown.join(", ")}`);
  const order = new Map<string, number>(SUBJECTS.map((s, i) => [s, i]));
  return subjects.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

async function requireStudent(db: D1Database, studentId: number) {
  const student = await db
    .prepare(`SELECT s.id, s.name, s.comiru_student_id, ${PERSON_KANA_SQL("s")}, ${STUDENT_GRADE_SQL("s")} FROM students s WHERE id = ?`)
    .bind(studentId)
    .first<{ id: number; name: string; comiru_student_id: number | null; name_kana: string; grade: string }>();
  if (!student) throw new HttpError(404, "生徒が見つかりません");
  return student;
}

export function registerStudentRoutes(api: Hono<AppEnv>): void {
  // 生徒一覧（comiru の名簿の全員）と、この講習で入力済みかどうか
  api.get("/terms/:termId/students", async (c) => {
    await ensureFreshRoster(c.env, "comiru_students");
    const termId = Number(c.req.param("termId"));
    const { results } = await c.env.DB.prepare(
      `SELECT s.id, s.name, s.comiru_student_id, ${PERSON_KANA_SQL("s")}, ${STUDENT_GRADE_SQL("s")}, e.subjects, e.note, e.updated_at,
              (SELECT COUNT(*) FROM student_availability a WHERE a.term_id = ?1 AND a.student_id = s.id) AS slot_count
         FROM students s
         LEFT JOIN student_term_entries e ON e.student_id = s.id AND e.term_id = ?1
        WHERE s.active = 1 OR e.student_id IS NOT NULL
        ORDER BY s.name`,
    )
      .bind(termId)
      .all<Record<string, unknown>>();
    return c.json(results.map((r) => ({ ...r, entered: r.updated_at != null, subjects: r.subjects ? JSON.parse(String(r.subjects)) : [] })).sort(compareStudents));
  });

  api.get("/terms/:termId/students/:studentId", async (c) => {
    const db = c.env.DB;
    const term = await getTerm(db, Number(c.req.param("termId")));
    const student = await requireStudent(db, Number(c.req.param("studentId")));
    const entry = await db
      .prepare("SELECT subjects, note, updated_at, rev FROM student_term_entries WHERE term_id = ? AND student_id = ?")
      .bind(term.id, student.id)
      .first<{ subjects: string; note: string; updated_at: string; rev: number }>();
    return c.json({
      term: termForClient(term),
      student,
      subjects: entry ? JSON.parse(entry.subjects) : [],
      note: entry?.note ?? "",
      updated_at: entry?.updated_at ?? null,
      rev: entry ? entry.rev : null, // 保存のときに expected_rev として送り返す（null＝まだ入力がない）
      slots: await readSlots(db, STUDENT_SLOTS, term.id, student.id),
    });
  });

  // 受講科目・受講できるコマ・備考の保存
  api.put("/terms/:termId/students/:studentId", async (c) => {
    const db = c.env.DB;
    const term = await getTerm(db, Number(c.req.param("termId")));
    const student = await requireStudent(db, Number(c.req.param("studentId")));
    const body = await c.req.json<Record<string, unknown>>();
    const subjects = parseSubjects(body.subjects);
    const slots = parseSlots(term, body.slots, { dropOutside: true });
    const note = String(body.note ?? "").slice(0, 500);
    const kana = body.name_kana === undefined ? undefined : parseKana(body.name_kana);
    const grade = body.grade === undefined ? undefined : normalizeGrade(body.grade);
    if (grade && !(GRADES as readonly string[]).includes(grade)) throw new HttpError(400, "学年の指定が正しくありません");

    const now = nowIso();
    // expected_rev を付けた保存は、読み込んだ時点から誰も保存していないときだけ行う。
    // 1つめの文で番号が違えばわざとエラーにして、まとめて取り消す（予定だけ保存されて残る、ということが起きない）
    const hasExpected = body.expected_rev !== undefined;
    const expectedRev = body.expected_rev === null ? -1 : Number(body.expected_rev);
    try {
    await db.batch([
      ...(hasExpected ? [db.prepare(
        "SELECT CASE WHEN COALESCE((SELECT rev FROM student_term_entries WHERE term_id = ? AND student_id = ?), -1) != ? THEN json('stale') END",
      ).bind(term.id, student.id, expectedRev)] : []),
      ...(kana !== undefined || grade !== undefined ? [db.prepare(
        "UPDATE students SET name_kana_override = CASE WHEN ? THEN ? ELSE name_kana_override END, grade_override = CASE WHEN ? THEN ? ELSE grade_override END WHERE id = ?",
      ).bind(kana !== undefined ? 1 : 0, kana ?? null, grade !== undefined ? 1 : 0, grade || null, student.id)] : []),
      ...(await replaceSlotsStatements(db, STUDENT_SLOTS, term.id, student.id, slots)),
      db
        .prepare(
          `INSERT INTO student_term_entries (term_id, student_id, subjects, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (term_id, student_id) DO UPDATE SET subjects = excluded.subjects, note = excluded.note, updated_at = excluded.updated_at,
             rev = student_term_entries.rev + 1`,
        )
        .bind(term.id, student.id, JSON.stringify(subjects), note, now, now),
      bumpVersion(db, term.id),
      resetCompletedWithErrors(db, term.id),
    ]);
    } catch (err) {
      if (hasExpected && /malformed JSON|stale/i.test(String(err))) {
        throw new HttpError(409, "ほかの人が先にこの生徒の予定を保存しています。閉じて開き直し、最新の内容を確認してから保存してください");
      }
      throw err;
    }
    const saved = await db.prepare("SELECT rev FROM student_term_entries WHERE term_id = ? AND student_id = ?").bind(term.id, student.id).first<{ rev: number }>();
    return c.json({ ok: true, slot_count: slots.length, updated_at: now, rev: saved?.rev ?? 0 });
  });

  // この講習の入力を消す（生徒は名簿に残る）
  api.delete("/terms/:termId/students/:studentId", async (c) => {
    const db = c.env.DB;
    const termId = Number(c.req.param("termId"));
    const studentId = Number(c.req.param("studentId"));
    const results = await db.batch([
      db.prepare("DELETE FROM student_availability WHERE term_id = ? AND student_id = ?").bind(termId, studentId),
      db.prepare("DELETE FROM student_term_entries WHERE term_id = ? AND student_id = ?").bind(termId, studentId),
      db.prepare("DELETE FROM assignments WHERE term_id = ? AND student_id = ?").bind(termId, studentId),
      bumpVersion(db, termId),
    ]);
    if (!results[1].meta.changes) throw new HttpError(404, "この講習ではまだ入力されていません");
    return c.json({ ok: true });
  });

  // 今のアプリ向けの生徒 CSV（科目かコマが入っている生徒だけ）
  api.get("/terms/:termId/export/students.csv", async (c) => {
    const db = c.env.DB;
    const term = await getTerm(db, Number(c.req.param("termId")));
    const [entries, slots] = await Promise.all([
      db
        .prepare(
          `SELECT s.id, s.name, e.subjects, e.note, e.updated_at
             FROM student_term_entries e JOIN students s ON s.id = e.student_id
            WHERE e.term_id = ?
            ORDER BY s.name`,
        )
        .bind(term.id)
        .all<{ id: number; name: string; subjects: string; note: string; updated_at: string }>(),
      db
        .prepare("SELECT student_id AS owner_id, date, period FROM student_availability WHERE term_id = ?")
        .bind(term.id)
        .all<Slot & { owner_id: number }>(),
    ]);
    const withSlots = new Set(slots.results.map((s) => s.owner_id));
    const people: CsvPerson[] = entries.results
      .map((e) => ({ ...e, subjects: (JSON.parse(e.subjects) as string[]).join(", ") }))
      .filter((e) => e.subjects || withSlots.has(e.id));
    return c.body(scheduleCsv("student", term, people, slots.results), 200, csvResponseHeaders(`${term.name}_生徒予定.csv`));
  });
}

