// 割り当て画面のデータの読み込み（管理画面 API /api/admin 以下に追加する）
//
// 画面は最初に講習のデータをまとめて読み込み（snapshot）、判定はすべて画面の中で行う。
// その後は数秒ごとに「前回からの変更記録」（changes。トリガーで assign_events に残る）だけを受け取る。
// こうすると操作のたびにサーバーへ問い合わせずに済み、無料枠の読み取り行数も節約できる。
import type { Hono } from "hono";
import { PERSON_KANA_SQL, STUDENT_GRADE_SQL } from "./roster";
import { getTerm, HttpError, termForClient } from "./terms";
import type { AppEnv } from "./types";

const MAX_EVENTS = 500;

const TEACHER_SQL = `SELECT t.id, t.name, ${PERSON_KANA_SQL("t")}, t.active,
    (SELECT json_group_array(ts.subject) FROM teacher_subjects ts WHERE ts.teacher_id = t.id) AS subjects
  FROM teachers t`;

const STUDENT_SQL = `SELECT s.id, s.name, ${PERSON_KANA_SQL("s")}, ${STUDENT_GRADE_SQL("s")}, s.comiru_student_id,
    e.subjects, e.status, e.note, e.student_id IS NOT NULL AS entered
  FROM students s LEFT JOIN student_term_entries e ON e.student_id = s.id AND e.term_id = ?1`;

type Row = Record<string, unknown>;

function teacherOut(r: Row) {
  return { id: Number(r.id), name: String(r.name), name_kana: String(r.name_kana ?? ""), active: Boolean(r.active), subjects: JSON.parse(String(r.subjects ?? "[]")) };
}

function studentOut(r: Row) {
  return {
    id: Number(r.id),
    name: String(r.name),
    name_kana: String(r.name_kana ?? ""),
    grade: String(r.grade ?? ""),
    comiru_student_id: r.comiru_student_id ?? null,
    subjects: r.subjects ? JSON.parse(String(r.subjects)) : [],
    status: String(r.status ?? "調整中"),
    note: String(r.note ?? ""),
    entered: Boolean(r.entered),
  };
}

/** [{owner_id, date, period}] → { owner_id: ["日付#時限", ...] } */
function slotMap(rows: Row[]): Record<number, string[]> {
  const map: Record<number, string[]> = {};
  for (const r of rows) (map[Number(r.owner_id)] ??= []).push(`${r.date}#${r.period}`);
  return map;
}

export function registerAssignSyncRoutes(api: Hono<AppEnv>): void {
  // 講習のデータをまとめて返す（画面を開いたときに1回だけ）
  api.get("/terms/:termId/assign/snapshot", async (c) => {
    const db = c.env.DB;
    const termId = Number(c.req.param("termId"));
    const term = await getTerm(db, termId);
    // batch は1つのまとまりとして実行されるので、記録の位置（cursor）とデータが食い違わない
    const [cursor, version, room, teachers, teacherSlots, students, studentSlots, assignments] = await db.batch<Row>([
      db.prepare("SELECT COALESCE(MAX(id), 0) AS cursor FROM assign_events"),
      db.prepare("SELECT version FROM terms WHERE id = ?1").bind(termId),
      db.prepare("SELECT table_ids FROM room_settings WHERE id = 1"),
      db
        .prepare(
          `${TEACHER_SQL} WHERE t.id IN (SELECT teacher_id FROM teacher_term_entries WHERE term_id = ?1
             UNION SELECT teacher_id FROM assignments WHERE term_id = ?1 AND teacher_id IS NOT NULL)`,
        )
        .bind(termId),
      db.prepare("SELECT teacher_id AS owner_id, date, period FROM teacher_availability WHERE term_id = ?1").bind(termId),
      db
        .prepare(
          `${STUDENT_SQL} WHERE s.id IN (SELECT student_id FROM student_term_entries WHERE term_id = ?1
             UNION SELECT student_id FROM assignments WHERE term_id = ?1)`,
        )
        .bind(termId),
      db.prepare("SELECT student_id AS owner_id, date, period FROM student_availability WHERE term_id = ?1").bind(termId),
      db.prepare("SELECT id, student_id, teacher_id, table_id, subject, date, period FROM assignments WHERE term_id = ?1").bind(termId),
    ]);
    return c.json({
      cursor: Number(cursor.results[0]?.cursor ?? 0),
      version: Number(version.results[0]?.version ?? 0),
      term: termForClient(term),
      table_ids: JSON.parse(String(room.results[0]?.table_ids ?? "[]")),
      teachers: teachers.results.map(teacherOut),
      teacher_slots: slotMap(teacherSlots.results),
      students: students.results.map(studentOut),
      student_slots: slotMap(studentSlots.results),
      assignments: assignments.results,
    });
  });

  // 前回（since）からの変更記録。多すぎるとき・古い記録が消えていたときは reload: true（まとめて読み直す）
  api.get("/terms/:termId/assign/changes", async (c) => {
    const db = c.env.DB;
    const termId = Number(c.req.param("termId"));
    const since = Number(c.req.query("since") ?? 0);
    if (!Number.isInteger(since) || since < 0) throw new HttpError(400, "since の指定が正しくありません");
    const [range, events] = await db.batch<Row>([
      db.prepare("SELECT COALESCE(MIN(id), 0) AS min_id, COALESCE(MAX(id), 0) AS max_id FROM assign_events"),
      db
        .prepare(
          `SELECT id, term_id, kind, ref_id, payload FROM assign_events
            WHERE id > ?2 AND (term_id = ?1 OR term_id IS NULL) ORDER BY id LIMIT ${MAX_EVENTS + 1}`,
        )
        .bind(termId, since),
    ]);
    const minId = Number(range.results[0]?.min_id ?? 0);
    const maxId = Number(range.results[0]?.max_id ?? 0);
    if (events.results.length > MAX_EVENTS || (since > 0 && minId > since + 1) || since > maxId) {
      return c.json({ reload: true, cursor: maxId, events: [] });
    }
    return c.json({
      reload: false,
      // この講習に関係する記録がなくても、ほかの講習の分は読み飛ばせるように最後の位置まで進める
      cursor: maxId,
      events: events.results.map((e) => ({
        id: Number(e.id),
        term_id: e.term_id == null ? null : Number(e.term_id),
        kind: e.kind,
        ref_id: e.ref_id == null ? null : Number(e.ref_id),
        payload: e.payload ? JSON.parse(String(e.payload)) : null,
      })),
    });
  });

  // 1人の講師の最新の情報（予定の保存・科目の変更の記録が来たときに取り直す）
  api.get("/terms/:termId/assign/teachers/:teacherId/info", async (c) => {
    const db = c.env.DB;
    const termId = Number(c.req.param("termId"));
    const teacherId = Number(c.req.param("teacherId"));
    const [teacher, slots] = await db.batch<Row>([
      db.prepare(`${TEACHER_SQL} WHERE t.id = ?1`).bind(teacherId),
      db.prepare("SELECT teacher_id AS owner_id, date, period FROM teacher_availability WHERE term_id = ?1 AND teacher_id = ?2").bind(termId, teacherId),
    ]);
    if (!teacher.results[0]) throw new HttpError(404, "講師が見つかりません");
    return c.json({ teacher: teacherOut(teacher.results[0]), slots: slotMap(slots.results)[teacherId] ?? [] });
  });

  // 1人の生徒の最新の情報（予定・科目・ステータスの変更の記録が来たときに取り直す）
  api.get("/terms/:termId/assign/students/:studentId/info", async (c) => {
    const db = c.env.DB;
    const termId = Number(c.req.param("termId"));
    const studentId = Number(c.req.param("studentId"));
    const [student, slots] = await db.batch<Row>([
      db.prepare(`${STUDENT_SQL} WHERE s.id = ?2`).bind(termId, studentId),
      db.prepare("SELECT student_id AS owner_id, date, period FROM student_availability WHERE term_id = ?1 AND student_id = ?2").bind(termId, studentId),
    ]);
    if (!student.results[0]) throw new HttpError(404, "生徒が見つかりません");
    return c.json({ student: studentOut(student.results[0]), slots: slotMap(slots.results)[studentId] ?? [] });
  });
}
