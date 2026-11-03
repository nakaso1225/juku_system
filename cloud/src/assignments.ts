// コマ割り当て（管理画面 API /api/admin 以下に追加する）
// 判定・並び順は今のアプリ（models.py）と同じにしている。違いは「講習（term）ごと」に分かれていること。
import type { Hono } from "hono";
import { ALL_PERIODS, STATUS_NEEDS_ADJUSTMENT, STUDENT_STATUSES, SUBJECTS } from "./constants";
import { HttpError, isValidDate, nowIso, rowToTerm, termForClient } from "./terms";
import type { AppEnv } from "./types";
import { compareNames, compareStudents, PERSON_KANA_SQL, STUDENT_GRADE_SQL } from "./roster";

/**
 * 割り当て a のエラー判定（models.py の get_student_timetable と同じ4種類）。?1 = term_id
 *   講師重複：同じ日時に同じ講師が別の生徒にも入っている
 *   席重複　：同じ日時に同じ席が別の生徒にも使われている
 *   講師予定不一致：講師がその日時に来られない、またはその科目を教えられない
 *   生徒予定不一致：生徒がその日時に来られない
 *   休校日・期間外：あとから講習の設定（期間・時限・休校日）を変えて、授業のある日時が対象外になった
 */
export const FLAGS_SQL = `
  (a.teacher_id IS NOT NULL AND EXISTS (
     SELECT 1 FROM assignments x WHERE x.term_id = a.term_id AND x.date = a.date AND x.period = a.period
        AND x.teacher_id = a.teacher_id AND x.student_id != a.student_id)) AS has_teacher_conflict,
  EXISTS (
     SELECT 1 FROM assignments x WHERE x.term_id = a.term_id AND x.date = a.date AND x.period = a.period
        AND x.table_id = a.table_id AND x.student_id != a.student_id) AS has_table_conflict,
  (a.teacher_id IS NOT NULL AND (
     NOT EXISTS (SELECT 1 FROM teacher_availability ta WHERE ta.term_id = a.term_id AND ta.teacher_id = a.teacher_id
                   AND ta.date = a.date AND ta.period = a.period)
     OR NOT EXISTS (SELECT 1 FROM teacher_subjects ts WHERE ts.teacher_id = a.teacher_id AND ts.subject = a.subject))) AS has_schedule_mismatch,
  NOT EXISTS (SELECT 1 FROM student_availability sa WHERE sa.term_id = a.term_id AND sa.student_id = a.student_id
                AND sa.date = a.date AND sa.period = a.period) AS has_student_schedule_mismatch,
  NOT EXISTS (SELECT 1 FROM terms tm WHERE tm.id = a.term_id AND a.date BETWEEN tm.start_date AND tm.end_date
                AND a.period IN (SELECT value FROM json_each(tm.periods))
                AND a.date NOT IN (SELECT value FROM json_each(tm.closed_dates))) AS has_slot_invalid`;

/** 生徒にエラーのある割り当てが1つでもあるか（SQL 断片。s.id = 生徒、?1 = term_id） */
export const STUDENT_HAS_ERROR_SQL = `EXISTS (
  SELECT 1 FROM (SELECT a.*, ${FLAGS_SQL} FROM assignments a WHERE a.term_id = ?1 AND a.student_id = s.id) f
   WHERE f.has_teacher_conflict OR f.has_table_conflict OR f.has_schedule_mismatch OR f.has_student_schedule_mismatch
      OR f.has_slot_invalid)`;

/**
 * 「完了」の生徒にエラーが出たら「調整中」に戻す（今のアプリの _apply_auto_student_status_rules と同じ）。
 * エラーを直しても自動では「完了」に戻さない（もう一度確認してから完了にしてもらう）。?1 = term_id
 */
export function resetCompletedWithErrors(db: D1Database, termId: number): D1PreparedStatement {
  return db
    .prepare(`UPDATE student_term_entries SET status = '調整中'
               WHERE term_id = ?1 AND status = '完了' AND student_id IN (SELECT s.id FROM students s WHERE ${STUDENT_HAS_ERROR_SQL})`)
    .bind(termId);
}

interface AssignmentRow {
  id: number;
  student_id: number;
  teacher_id: number | null;
  teacher_name: string | null;
  teacher_name_kana?: string | null;
  table_id: string;
  subject: string;
  date: string;
  period: number;
  has_teacher_conflict: number;
  has_table_conflict: number;
  has_schedule_mismatch: number;
  has_student_schedule_mismatch: number;
  has_slot_invalid: number;
}

function toAssignment(r: AssignmentRow) {
  const flags = {
    has_teacher_conflict: Boolean(r.has_teacher_conflict),
    has_table_conflict: Boolean(r.has_table_conflict),
    has_schedule_mismatch: Boolean(r.has_schedule_mismatch),
    has_student_schedule_mismatch: Boolean(r.has_student_schedule_mismatch),
    has_slot_invalid: Boolean(r.has_slot_invalid),
  };
  return {
    id: r.id,
    student_id: r.student_id,
    teacher_id: r.teacher_id,
    teacher_name: r.teacher_name ?? "講師未定",
    teacher_name_kana: r.teacher_name_kana ?? "",
    table_id: r.table_id,
    subject: r.subject,
    date: r.date,
    period: r.period,
    ...flags,
    has_conflict: Object.values(flags).some(Boolean),
  };
}

async function studentAssignments(db: D1Database, termId: number, studentId: number, id: number | null = null) {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.student_id, a.teacher_id, t.name AS teacher_name,
              COALESCE(NULLIF(t.name_kana_override, ''), t.name_kana) AS teacher_name_kana, a.table_id, a.subject, a.date, a.period, ${FLAGS_SQL}
         FROM assignments a LEFT JOIN teachers t ON t.id = a.teacher_id
        WHERE a.term_id = ?1 AND a.student_id = ?2 AND (?3 IS NULL OR a.id = ?3)
        ORDER BY a.date, a.period`,
    )
    .bind(termId, studentId, id)
    .all<AssignmentRow>();
  return results.map(toAssignment);
}

/** 割り当て・予定が変わったことをほかの画面に知らせるため、講習の番号を1つ進める */
export function bumpVersion(db: D1Database, termId: number): D1PreparedStatement {
  return db.prepare("UPDATE terms SET version = version + 1 WHERE id = ? RETURNING version").bind(termId);
}

function lastVersion(results: D1Result[]): number {
  const row = results[results.length - 1]?.results?.[0] as { version?: number } | undefined;
  return Number(row?.version ?? 0);
}

function intParam(raw: string | undefined, name: string): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n)) throw new HttpError(400, `${name} を指定してください`);
  return n;
}

interface AssignmentInput {
  student_id: number;
  teacher_id: number | null;
  table_id: string;
  subject: string;
  date: string;
  period: number;
  strict_availability: boolean;
  only_if_empty: boolean;
  /** 画面が見ていた変更前の状態。省略＝確認しない、null＝空いているはず、オブジェクト＝その内容のはず */
  expect?: { teacher_id: number | null; table_id: string; subject: string; date?: string; period?: number } | null;
}

function parseExpect(raw: unknown): AssignmentInput["expect"] {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const e = raw as Record<string, unknown>;
  const teacherId = e.teacher_id === null || e.teacher_id === undefined ? null : Number(e.teacher_id);
  return {
    teacher_id: teacherId,
    table_id: String(e.table_id ?? ""),
    subject: String(e.subject ?? ""),
    ...(isValidDate(e.date) ? { date: e.date } : {}),
    ...(Number.isInteger(Number(e.period)) && e.period != null ? { period: Number(e.period) } : {}),
  };
}

export const STALE_MESSAGE = "ほかの人が先にこのコマを変更しています。画面が最新になってから、もう一度操作してください";

function parseAssignmentInput(body: Record<string, unknown>): AssignmentInput {
  const studentId = Number(body.student_id);
  const teacherRaw = body.teacher_id;
  const teacherId = teacherRaw === null || teacherRaw === undefined || teacherRaw === "" ? null : Number(teacherRaw);
  const tableId = String(body.table_id ?? "");
  const subject = String(body.subject ?? "");
  const date = body.date;
  const period = Number(body.period);
  if (!Number.isInteger(studentId) || studentId < 1) throw new HttpError(400, "生徒を指定してください");
  if (teacherId !== null && (!Number.isInteger(teacherId) || teacherId < 1)) throw new HttpError(400, "講師の指定が正しくありません");
  if (!tableId || tableId.length > 10) throw new HttpError(400, "席の指定が正しくありません");
  if (!(SUBJECTS as readonly string[]).includes(subject)) throw new HttpError(400, "科目の指定が正しくありません");
  if (!isValidDate(date) || !Number.isInteger(period) || !ALL_PERIODS.includes(period)) throw new HttpError(400, "日時の指定が正しくありません");
  return { student_id: studentId, teacher_id: teacherId, table_id: tableId, subject, date, period,
    strict_availability: body.strict_availability === true, only_if_empty: body.only_if_empty === true, expect: parseExpect(body.expect) };
}

// 検証・空席の選択・書き込み・重複確認を1回のD1 batch内で行う。
// 席を自動選択する場合も、画面との間で空席一覧を往復させない。
const INPUT_SQL = `WITH input AS (
  SELECT ?1 AS term_id, json_extract(?2, '$.student_id') AS student_id,
    json_extract(?2, '$.teacher_id') AS teacher_id, json_extract(?2, '$.table_id') AS table_id,
    json_extract(?2, '$.subject') AS subject, json_extract(?2, '$.date') AS date,
    json_extract(?2, '$.period') AS period, json_extract(?2, '$.id') AS id,
    json_extract(?2, '$.updated_at') AS updated_at,
    json_extract(?2, '$.strict_availability') AS strict_availability,
    json_extract(?2, '$.only_if_empty') AS only_if_empty,
    json_type(?2, '$.expect') AS expect_type,
    json_extract(?2, '$.expect.teacher_id') AS expect_teacher, json_extract(?2, '$.expect.table_id') AS expect_table,
    json_extract(?2, '$.expect.subject') AS expect_subject, json_extract(?2, '$.expect.date') AS expect_date,
    json_extract(?2, '$.expect.period') AS expect_period
), checked AS (
  SELECT i.*,
    EXISTS (SELECT 1 FROM terms t WHERE t.id = i.term_id) AS term_exists,
    EXISTS (SELECT 1 FROM terms t WHERE t.id = i.term_id AND i.date BETWEEN t.start_date AND t.end_date
      AND i.period IN (SELECT value FROM json_each(t.periods))
      AND i.date NOT IN (SELECT value FROM json_each(t.closed_dates))) AS slot_valid,
    EXISTS (SELECT 1 FROM students s WHERE s.id = i.student_id) AS student_exists,
    (i.teacher_id IS NULL OR EXISTS (SELECT 1 FROM teachers t WHERE t.id = i.teacher_id)) AS teacher_exists,
    (NOT i.strict_availability OR EXISTS (SELECT 1 FROM teacher_availability ta
      JOIN teacher_subjects ts ON ts.teacher_id = ta.teacher_id AND ts.subject = i.subject
      WHERE ta.term_id = i.term_id AND ta.teacher_id = i.teacher_id AND ta.date = i.date AND ta.period = i.period)) AS teacher_available,
    (NOT i.strict_availability OR EXISTS (SELECT 1 FROM student_availability sa
      WHERE sa.term_id = i.term_id AND sa.student_id = i.student_id AND sa.date = i.date AND sa.period = i.period)) AS student_available,
    (NOT i.only_if_empty OR NOT EXISTS (SELECT 1 FROM assignments a WHERE a.term_id = i.term_id
      AND a.student_id = i.student_id AND a.date = i.date AND a.period = i.period AND (i.id IS NULL OR a.id != i.id))) AS target_empty,
    (i.table_id = 'auto' OR EXISTS (SELECT 1 FROM room_settings r, json_each(r.table_ids) seat WHERE r.id = 1 AND seat.value = i.table_id)) AS table_valid,
    (i.id IS NULL OR EXISTS (SELECT 1 FROM assignments a WHERE a.id = i.id AND a.term_id = i.term_id AND a.student_id = i.student_id)) AS assignment_exists,
    (i.id IS NOT NULL AND EXISTS (SELECT 1 FROM assignments a WHERE a.term_id = i.term_id
      AND a.student_id = i.student_id AND a.date = i.date AND a.period = i.period AND a.id != i.id)) AS student_clash,
    -- 画面が見ていた変更前の状態と、データベースの今の状態が同じか（ほかの人が先に変えていないか）
    CASE
      WHEN i.expect_type IS NULL THEN 1
      WHEN i.id IS NULL AND i.expect_type = 'null' THEN NOT EXISTS (SELECT 1 FROM assignments a WHERE a.term_id = i.term_id
        AND a.student_id = i.student_id AND a.date = i.date AND a.period = i.period)
      WHEN i.id IS NULL THEN EXISTS (SELECT 1 FROM assignments a WHERE a.term_id = i.term_id
        AND a.student_id = i.student_id AND a.date = i.date AND a.period = i.period
        AND a.teacher_id IS i.expect_teacher AND a.table_id = i.expect_table AND a.subject = i.expect_subject)
      ELSE EXISTS (SELECT 1 FROM assignments a WHERE a.id = i.id AND a.term_id = i.term_id
        AND a.teacher_id IS i.expect_teacher AND a.table_id = i.expect_table AND a.subject = i.expect_subject
        AND a.date = COALESCE(i.expect_date, a.date) AND a.period = COALESCE(i.expect_period, a.period))
    END AS expected_ok,
    CASE WHEN i.table_id = 'auto' THEN (
      SELECT seat.value FROM room_settings r, json_each(r.table_ids) seat WHERE r.id = 1
        AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.term_id = i.term_id AND a.date = i.date
          AND a.period = i.period AND a.table_id = seat.value AND a.student_id != i.student_id)
      ORDER BY CAST(seat.key AS INTEGER) LIMIT 1
    ) ELSE i.table_id END AS selected_table
  FROM input i
)`;
const VALID_SQL = `term_exists AND slot_valid AND student_exists AND teacher_exists AND table_valid AND expected_ok
  AND teacher_available AND student_available AND target_empty
  AND assignment_exists AND NOT student_clash AND selected_table IS NOT NULL`;

async function saveAssignment(db: D1Database, termId: number, a: AssignmentInput, id: number | null = null) {
  const data = JSON.stringify({ ...a, id, updated_at: nowIso() });
  const query = (sql: string) => db.prepare(`${INPUT_SQL} ${sql}`).bind(termId, data);
  const mutation = id === null
    ? `INSERT INTO assignments (term_id, student_id, teacher_id, table_id, subject, date, period, created_at, updated_at)
       SELECT term_id, student_id, teacher_id, selected_table, subject, date, period, updated_at, updated_at
       FROM checked WHERE ${VALID_SQL}
       ON CONFLICT (term_id, student_id, date, period) DO UPDATE SET
         teacher_id = excluded.teacher_id, table_id = excluded.table_id, subject = excluded.subject, updated_at = excluded.updated_at
       RETURNING id`
    : `UPDATE assignments SET teacher_id = c.teacher_id, table_id = c.selected_table, subject = c.subject,
         date = c.date, period = c.period, updated_at = c.updated_at
       FROM checked c WHERE assignments.id = c.id AND assignments.term_id = c.term_id
         AND c.term_exists AND c.slot_valid AND c.student_exists AND c.teacher_exists AND c.table_valid
         AND c.teacher_available AND c.student_available AND c.target_empty
         AND c.assignment_exists AND NOT c.student_clash AND c.selected_table IS NOT NULL AND c.expected_ok
       RETURNING id`;
  const results = await db.batch<Record<string, unknown>>([
    query("SELECT * FROM checked"),
    query(mutation),
    db.prepare("UPDATE terms SET version = version + 1 WHERE id = ? AND changes() > 0 RETURNING version").bind(termId),
    resetCompletedWithErrors(db, termId),
    query(`SELECT a.id, a.student_id, a.teacher_id, t.name AS teacher_name,
      COALESCE(NULLIF(t.name_kana_override, ''), t.name_kana) AS teacher_name_kana, a.table_id, a.subject, a.date, a.period, ${FLAGS_SQL}
      FROM assignments a JOIN input i ON a.term_id = i.term_id AND a.student_id = i.student_id AND a.date = i.date AND a.period = i.period
      LEFT JOIN teachers t ON t.id = a.teacher_id`),
  ]);
  const validation = results[0].results[0];
  if (!validation.term_exists) throw new HttpError(404, "講習が見つかりません");
  if (!validation.student_exists) throw new HttpError(404, "生徒が見つかりません");
  if (!validation.teacher_exists) throw new HttpError(404, "講師が見つかりません");
  if (!validation.assignment_exists) throw new HttpError(404, "割り当てが見つかりません");
  if (!validation.expected_ok) throw new HttpError(409, STALE_MESSAGE);
  if (!validation.slot_valid) throw new HttpError(400, "講習の対象外の日時です");
  if (!validation.student_available) throw new HttpError(409, "生徒が来られない日時です。予定を確認してください");
  if (!validation.teacher_available) throw new HttpError(409, "講師がこの日時に来られないか、この科目を担当できません。予定・科目を確認してください");
  if (!validation.target_empty) throw new HttpError(409, "このコマにはすでに授業が登録されています。画面を更新して確認してください");
  if (!validation.table_valid) throw new HttpError(400, "席の指定が正しくありません。座席設定を確認してください");
  if (validation.student_clash) throw new HttpError(409, "移動先にはすでに授業があります");
  if (!results[1].results.length) throw new HttpError(409, "空いている席がありません。座席設定で席を増やすか、別のコマを選んでください");
  return {
    ...toAssignment(results[4].results[0] as unknown as AssignmentRow),
    version: Number(results[2].results[0]?.version ?? 0),
  };
}

export function registerAssignmentRoutes(api: Hono<AppEnv>): void {
  // 自動更新用：変更番号と、休校日・時限などの最新設定を返す
  api.get("/terms/:termId/version", async (c) => {
    const row = await c.env.DB.prepare("SELECT t.*, r.table_ids FROM terms t CROSS JOIN room_settings r WHERE t.id = ? AND r.id = 1").bind(Number(c.req.param("termId"))).first<Record<string, unknown>>();
    if (!row) throw new HttpError(404, "講習が見つかりません");
    return c.json({ version: Number(row.version), term: termForClient(rowToTerm(row)), table_ids: JSON.parse(String(row.table_ids)) });
  });

  // 割り当て画面の生徒一覧（予定を入力した生徒）
  api.get("/terms/:termId/assign/students", async (c) => {
    const termId = Number(c.req.param("termId"));
    const { results } = await c.env.DB.prepare(
      `SELECT s.id, s.name, ${PERSON_KANA_SQL("s")}, ${STUDENT_GRADE_SQL("s")}, e.status, e.subjects,
              (SELECT COUNT(*) FROM assignments a WHERE a.term_id = ?1 AND a.student_id = s.id) AS assignment_count,
              ${STUDENT_HAS_ERROR_SQL} AS has_error
         FROM student_term_entries e JOIN students s ON s.id = e.student_id
        WHERE e.term_id = ?1
        ORDER BY s.name`,
    )
      .bind(termId)
      .all<Record<string, unknown>>();
    return c.json(
      results.map((r) => ({
        ...r,
        subjects: JSON.parse(String(r.subjects)),
        has_error: Boolean(r.has_error),
        display_status: r.has_error ? STATUS_NEEDS_ADJUSTMENT : r.status,
      })).sort(compareStudents),
    );
  });

  // 1人の生徒の割り当て画面に必要なもの（models.py の get_student_timetable に当たる）
  api.get("/terms/:termId/assign/students/:studentId", async (c) => {
    const db = c.env.DB;
    const termId = Number(c.req.param("termId"));
    const studentId = Number(c.req.param("studentId"));
    const [student, availability, assignments, version] = await Promise.all([
      db
        .prepare(
          `SELECT s.id, s.name, s.comiru_student_id, ${PERSON_KANA_SQL("s")}, ${STUDENT_GRADE_SQL("s")}, e.subjects, e.note, e.status, ${STUDENT_HAS_ERROR_SQL} AS has_error
             FROM students s LEFT JOIN student_term_entries e ON e.student_id = s.id AND e.term_id = ?1
            WHERE s.id = ?2`,
        )
        .bind(termId, studentId)
        .first<Record<string, unknown>>(),
      db.prepare("SELECT date, period FROM student_availability WHERE term_id = ? AND student_id = ?").bind(termId, studentId).all(),
      studentAssignments(db, termId, studentId),
      db.prepare("SELECT version FROM terms WHERE id = ?").bind(termId).first<{ version: number }>(),
    ]);
    if (!student) throw new HttpError(404, "生徒が見つかりません");

    const subjectCounts: Record<string, number> = {};
    for (const a of assignments) subjectCounts[a.subject] = (subjectCounts[a.subject] ?? 0) + 1;
    const status = String(student.status ?? "調整中");
    return c.json({
      version: version?.version ?? 0,
      student: {
        id: student.id,
        name: student.name,
        name_kana: student.name_kana,
        grade: student.grade,
        comiru_student_id: student.comiru_student_id,
        note: student.note ?? "",
        subjects: student.subjects ? JSON.parse(String(student.subjects)) : [],
        status,
        has_error: Boolean(student.has_error),
        display_status: student.has_error ? STATUS_NEEDS_ADJUSTMENT : status,
      },
      availability: availability.results,
      assignments,
      subject_counts: subjectCounts,
    });
  });

  // 生徒が来られるコマごとの「その科目を教えられて空いている講師の数」（models.py の get_slot_teacher_summary）
  api.get("/terms/:termId/assign/slot-summary", async (c) => {
    const termId = Number(c.req.param("termId"));
    const studentId = intParam(c.req.query("student_id"), "student_id");
    const subject = c.req.query("subject") ?? "";
    const { results } = await c.env.DB.prepare(
      `SELECT ta.date, ta.period, COUNT(*) AS total_teacher_count,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM assignments b WHERE b.term_id = ?1 AND b.date = ta.date AND b.period = ta.period
                                       AND b.teacher_id = ta.teacher_id) THEN 0 ELSE 1 END) AS free_teacher_count
         FROM student_availability sa
         JOIN teacher_availability ta ON ta.term_id = ?1 AND ta.date = sa.date AND ta.period = sa.period
         JOIN teacher_subjects ts ON ts.teacher_id = ta.teacher_id AND ts.subject = ?2
        WHERE sa.term_id = ?1 AND sa.student_id = ?3
        GROUP BY ta.date, ta.period`,
    )
      .bind(termId, subject, studentId)
      .all();
    return c.json(results);
  });

  // その日時・科目で割り当てられる講師（models.py の get_available_teachers と同じ並び順）
  api.get("/terms/:termId/assign/candidates", async (c) => {
    const termId = Number(c.req.param("termId"));
    const date = c.req.query("date") ?? "";
    const period = intParam(c.req.query("period"), "period");
    const subject = c.req.query("subject") ?? "";
    const studentId = intParam(c.req.query("student_id"), "student_id");
    const { results } = await c.env.DB.prepare(
      `SELECT t.id AS teacher_id, t.name, ${PERSON_KANA_SQL("t")},
              (SELECT COUNT(*) FROM teacher_availability x WHERE x.term_id = ?1 AND x.teacher_id = t.id) AS availability_count,
              (SELECT COUNT(*) FROM assignments x WHERE x.term_id = ?1 AND x.student_id = ?5 AND x.teacher_id = t.id) AS assignment_count,
              (SELECT MIN(s.name) FROM assignments x JOIN students s ON s.id = x.student_id
                WHERE x.term_id = ?1 AND x.date = ?2 AND x.period = ?3 AND x.teacher_id = t.id AND x.student_id != ?5) AS conflict_with,
              (SELECT COUNT(*) FROM assignments x
                WHERE x.term_id = ?1 AND x.date = ?2 AND x.period = ?3 AND x.teacher_id = t.id AND x.student_id != ?5) AS conflict_count
         FROM teachers t
         JOIN teacher_availability ta ON ta.teacher_id = t.id AND ta.term_id = ?1 AND ta.date = ?2 AND ta.period = ?3
         JOIN teacher_subjects ts ON ts.teacher_id = t.id AND ts.subject = ?4
        WHERE t.active = 1
        ORDER BY availability_count ASC, assignment_count DESC, t.name`,
    )
      .bind(termId, date, period, subject, studentId)
      .all<Record<string, unknown>>();
    return c.json(results.map((r) => ({ ...r, has_conflict: r.conflict_with != null })).sort(compareNames));
  });

  // その日時に使われている席
  api.get("/terms/:termId/assign/used-tables", async (c) => {
    const termId = Number(c.req.param("termId"));
    const period = intParam(c.req.query("period"), "period");
    const { results } = await c.env.DB.prepare(
      "SELECT DISTINCT table_id FROM assignments WHERE term_id = ? AND date = ? AND period = ? ORDER BY table_id",
    )
      .bind(termId, c.req.query("date") ?? "", period)
      .all<{ table_id: string }>();
    return c.json({ used_table_ids: results.map((r) => r.table_id) });
  });

  // ドラッグで置けるかの判定用：講師が来られるコマと、すでに授業が入っているコマ
  api.get("/terms/:termId/assign/teachers/:teacherId/slots", async (c) => {
    const db = c.env.DB;
    const termId = Number(c.req.param("termId"));
    const teacherId = Number(c.req.param("teacherId"));
    const [availability, busy] = await Promise.all([
      db.prepare("SELECT date, period FROM teacher_availability WHERE term_id = ? AND teacher_id = ?").bind(termId, teacherId).all(),
      db.prepare("SELECT date, period FROM assignments WHERE term_id = ? AND teacher_id = ?").bind(termId, teacherId).all(),
    ]);
    return c.json({ availability: availability.results, busy: busy.results });
  });

  // 自動席の選択も含め、成功した結果だけを返す。
  api.post("/terms/:termId/assignments", async (c) => {
    const a = parseAssignmentInput(await c.req.json());
    const result = await saveAssignment(c.env.DB, Number(c.req.param("termId")), a);
    return c.json(result, 201);
  });

  api.patch("/terms/:termId/assignments/:id", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "割り当ての指定が正しくありません");
    const termId = Number(c.req.param("termId"));
    // 旧クライアントの部分更新にも対応。現行画面は全項目を送るので、追加の照会は不要。
    let input = body;
    if (!["student_id", "teacher_id", "table_id", "subject", "date", "period"].every((key) => key in body)) {
      const current = await c.env.DB.prepare("SELECT * FROM assignments WHERE id = ? AND term_id = ?").bind(id, termId).first<Record<string, unknown>>();
      if (!current) throw new HttpError(404, "割り当てが見つかりません");
      input = { ...current, ...body, student_id: current.student_id };
    }
    const a = parseAssignmentInput(input);
    return c.json(await saveAssignment(c.env.DB, termId, a, id));
  });

  // 削除。expect（画面が見ていた内容）を付けると、その内容のときだけ消す（ほかの人の変更ごと消さない）
  api.delete("/terms/:termId/assignments/:id", async (c) => {
    const db = c.env.DB;
    const termId = Number(c.req.param("termId"));
    const id = Number(c.req.param("id"));
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const expect = parseExpect(body.expect);
    const results = await db.batch([
      expect
        ? db
            .prepare(
              `DELETE FROM assignments WHERE id = ?1 AND term_id = ?2 AND teacher_id IS ?3 AND table_id = ?4 AND subject = ?5
                 AND date = COALESCE(?6, date) AND period = COALESCE(?7, period)`,
            )
            .bind(id, termId, expect.teacher_id, expect.table_id, expect.subject, expect.date ?? null, expect.period ?? null)
        : db.prepare("DELETE FROM assignments WHERE id = ? AND term_id = ?").bind(id, termId),
      db.prepare("UPDATE terms SET version = version + 1 WHERE id = ? AND changes() > 0 RETURNING version").bind(termId),
      resetCompletedWithErrors(db, termId),
    ]);
    if (!results[0].meta.changes) {
      const exists = await db.prepare("SELECT 1 FROM assignments WHERE id = ? AND term_id = ?").bind(id, termId).first();
      throw exists ? new HttpError(409, STALE_MESSAGE) : new HttpError(404, "割り当てが見つかりません（ほかの人がすでに削除した可能性があります）");
    }
    return c.json({ ok: true, version: Number((results[1].results?.[0] as { version?: number } | undefined)?.version ?? 0) });
  });

  // 講習全体の重複・不一致の一覧（models.py の list_conflicts）
  api.get("/terms/:termId/assign/conflicts", async (c) => {
    const db = c.env.DB;
    const termId = Number(c.req.param("termId"));
    const [teacher, table, schedule, studentSchedule] = await Promise.all([
      db
        .prepare(
          `SELECT a.date, a.period, t.name AS teacher_name, group_concat(DISTINCT s.name) AS students
             FROM assignments a JOIN teachers t ON t.id = a.teacher_id JOIN students s ON s.id = a.student_id
            WHERE a.term_id = ?
            GROUP BY a.date, a.period, a.teacher_id HAVING COUNT(DISTINCT a.student_id) > 1`,
        )
        .bind(termId)
        .all<Record<string, string>>(),
      db
        .prepare(
          `SELECT a.date, a.period, a.table_id, group_concat(DISTINCT s.name) AS students
             FROM assignments a JOIN students s ON s.id = a.student_id
            WHERE a.term_id = ?
            GROUP BY a.date, a.period, a.table_id HAVING COUNT(DISTINCT a.student_id) > 1`,
        )
        .bind(termId)
        .all<Record<string, string>>(),
      db
        .prepare(
          `SELECT a.date, a.period, t.name AS teacher_name, group_concat(DISTINCT s.name) AS students
             FROM assignments a JOIN teachers t ON t.id = a.teacher_id JOIN students s ON s.id = a.student_id
            WHERE a.term_id = ?1
              AND (NOT EXISTS (SELECT 1 FROM teacher_availability ta WHERE ta.term_id = ?1 AND ta.teacher_id = a.teacher_id
                                 AND ta.date = a.date AND ta.period = a.period)
                   OR NOT EXISTS (SELECT 1 FROM teacher_subjects ts WHERE ts.teacher_id = a.teacher_id AND ts.subject = a.subject))
            GROUP BY a.date, a.period, a.teacher_id`,
        )
        .bind(termId)
        .all<Record<string, string>>(),
      db
        .prepare(
          `SELECT a.date, a.period, group_concat(DISTINCT s.name) AS students
             FROM assignments a JOIN students s ON s.id = a.student_id
            WHERE a.term_id = ?1
              AND NOT EXISTS (SELECT 1 FROM student_availability sa WHERE sa.term_id = ?1 AND sa.student_id = a.student_id
                                AND sa.date = a.date AND sa.period = a.period)
            GROUP BY a.date, a.period`,
        )
        .bind(termId)
        .all<Record<string, string>>(),
    ]);
    const split = (s: string | null) => (s ? s.split(",") : []);
    const conflicts = [
      ...teacher.results.map((r) => ({ type: "teacher", date: r.date, period: Number(r.period), label: `${r.teacher_name}（講師重複）`, students: split(r.students) })),
      ...table.results.map((r) => ({ type: "table", date: r.date, period: Number(r.period), label: `席${r.table_id}（席重複）`, students: split(r.students) })),
      ...schedule.results.map((r) => ({ type: "schedule", date: r.date, period: Number(r.period), label: `${r.teacher_name}（講師予定不一致）`, students: split(r.students) })),
      ...studentSchedule.results.map((r) => ({ type: "student_schedule", date: r.date, period: Number(r.period), label: "生徒予定（受講不可）", students: split(r.students) })),
    ].sort((x, y) => (x.date === y.date ? x.period - y.period : x.date < y.date ? -1 : 1));
    return c.json(conflicts);
  });

  // 生徒の調整ステータス（調整中 / 完了）。エラーがあるあいだは変更できない（今のアプリと同じ）
  api.patch("/terms/:termId/assign/students/:studentId/status", async (c) => {
    const db = c.env.DB;
    const termId = Number(c.req.param("termId"));
    const studentId = Number(c.req.param("studentId"));
    const status = String((await c.req.json<{ status?: string }>()).status ?? "");
    if (!(STUDENT_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "ステータスが正しくありません");
    const row = await db
      .prepare(`SELECT ${STUDENT_HAS_ERROR_SQL} AS has_error FROM students s WHERE s.id = ?2`)
      .bind(termId, studentId)
      .first<{ has_error: number }>();
    if (!row) throw new HttpError(404, "生徒が見つかりません");
    if (row.has_error) throw new HttpError(400, "エラーを直すまではステータスを変更できません（要調整のコマを確認してください）");
    const results = await db.batch([
      db.prepare("UPDATE student_term_entries SET status = ? WHERE term_id = ? AND student_id = ?").bind(status, termId, studentId),
      bumpVersion(db, termId),
    ]);
    if (!results[0].meta.changes) throw new HttpError(404, "この生徒はまだ予定が入力されていません");
    return c.json({ ok: true, version: lastVersion(results) });
  });
}
