// 割り当てを comiru に反映する（管理画面 API /api/admin 以下に追加する）
//
// 登録のルール（GAS の registerLessons を元に、安全側に直したもの）：
//   ・コマ：comiru のコマ一覧から、開始・終了時刻が一致するものを使う
//   ・科目：今のアプリの「コピペ用」と同じ対応表で comiru の科目名に変換し、comiru にある科目か確認する
//   ・教室：その日時に comiru で使われていない席。アプリで選んだ席が空いていればそれ、なければ座席設定の中の空き
//   ・同じ授業：同じ時間・同じ生徒・同じ講師・同じ科目の授業（欠席でない）がすでにあれば、新しく作らずそれを使う
//     （その授業は comiru に元からあったものとして、アプリからは変更・削除しない）
//   ・食い違い：同じ時間にその生徒の別の授業（科目や講師が違う）があれば、登録せずに知らせる
// アプリが作った授業は comiru_lessons に覚えておき、次の反映では差分だけを行う：
//   ・講師・科目・席の変更や日時の移動は、削除して作り直さず「更新（PUT）」で同じ授業を書き換える（失敗しても元の授業が残る）
//   ・重複や予定不一致など入力の問題がある授業は「保留」にして、登録済みの授業は残す（削除はアプリで授業を消したときだけ）
// comiru に直接入れた授業（レギュラーなど）には触らない。
import type { Hono } from "hono";
import { comiruConfigured, DEFAULT_COMIRU_API_BASE_URL } from "./comiru";
import { PERIOD_DEFS } from "./constants";
import { getTerm, HttpError, nowIso } from "./terms";
import type { AppEnv, Env } from "./types";
import { FLAGS_SQL } from "./assignments";
import { getTableIds } from "./settings";

const MASTER_MAX_AGE_HOURS = 12;
const MAX_OPS_PER_REQUEST = 8; // 無料プランの外部リクエスト上限（1回50件）に収まるように分けて実行する
const COMIRU_INTERVAL_MS = 250; // comiru の推奨（1秒5回以下）を守る

// 今のアプリの normalizeSubjectForSpreadsheet（app.js）・memo.txt と同じ対応表
const SUBJECT_TO_COMIRU: [RegExp, string][] = [
  [/算数/, "算数"],
  [/中学数学|数学Ⅰ・A|数学Ⅱ・B|数学Ⅲ・C|情報/, "数学"],
  [/中学受験国語|中学国語/, "国語"],
  [/現代文/, "現代文"],
  [/古文|漢文/, "古文・漢文"],
  [/中学受験理科|中学理科|地学/, "理科"],
  [/物理/, "物理"],
  [/化学/, "化学"],
  [/生物/, "生物"],
  [/中学受験社会|中学社会|倫政|公共/, "社会"],
  [/日本史/, "日本史"],
  [/世界史/, "世界史"],
  [/地理/, "地理"],
  [/中学英語|高校英語|英語/, "英語"],
];

export function toComiruSubjectName(subject: string): string {
  return SUBJECT_TO_COMIRU.find(([re]) => re.test(subject))?.[1] ?? subject;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "9:00" → "09:00" */
function hhmm(time: unknown): string {
  const m = String(time ?? "").match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
}

class ComiruCallError extends Error {}

async function comiruFetch(env: Env, method: string, path: string, init: { query?: Record<string, string | number>; body?: unknown } = {}) {
  const url = new URL(`${(env.COMIRU_API_BASE_URL || DEFAULT_COMIRU_API_BASE_URL).replace(/\/+$/, "")}/${env.COMIRU_SCHOOL_ID!.trim()}/${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.COMIRU_TOKEN!.trim()}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, ok: res.ok, json };
}

function comiruMessage(r: { status: number; json: Record<string, unknown> | null }): string {
  const msg = r.json?.message ?? (r.json?.errors ? JSON.stringify(r.json.errors) : "");
  return `comiru ${r.status}${msg ? `：${msg}` : ""}`;
}

// ---------------------------------------------------------------- comiru のコマ・科目一覧

interface Masters {
  comas: { id: number; time_start: string; time_end: string; coma_no: unknown }[];
  subjects: string[];
}

async function loadMasters(env: Env, force = false): Promise<Masters> {
  const db = env.DB;
  const { results } = await db.prepare("SELECT kind, data, fetched_at FROM comiru_masters").all<{ kind: string; data: string; fetched_at: string }>();
  const byKind = new Map(results.map((r) => [r.kind, r]));
  const fresh = (kind: string) => {
    const r = byKind.get(kind);
    return r && Date.now() - Date.parse(r.fetched_at) < MASTER_MAX_AGE_HOURS * 3600 * 1000;
  };
  if (force || !fresh("comas") || !fresh("subjects")) {
    const [comas, subjects] = [await comiruFetch(env, "GET", "comas", { query: { type: 0 } }), await comiruFetch(env, "GET", "subjects")];
    if (!comas.ok) throw new HttpError(400, `comiru のコマ一覧を取得できませんでした（${comiruMessage(comas)}）`);
    if (!subjects.ok) throw new HttpError(400, `comiru の科目一覧を取得できませんでした（${comiruMessage(subjects)}）`);
    const comaList = ((comas.json?.data as unknown[]) ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return { id: Number(r.id), time_start: hhmm(r.time_start), time_end: hhmm(r.time_end), coma_no: r.coma_no };
    });
    const subjectList = ((subjects.json?.data as unknown[]) ?? []).map((s) =>
      typeof s === "string" ? s : String((s as Record<string, unknown>)?.name ?? ""),
    );
    const now = nowIso();
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO comiru_masters (kind, data, fetched_at) VALUES ('comas', ?, ?)").bind(JSON.stringify(comaList), now),
      db.prepare("INSERT OR REPLACE INTO comiru_masters (kind, data, fetched_at) VALUES ('subjects', ?, ?)").bind(JSON.stringify(subjectList), now),
    ]);
    return { comas: comaList, subjects: subjectList.filter(Boolean) };
  }
  return { comas: JSON.parse(byKind.get("comas")!.data), subjects: JSON.parse(byKind.get("subjects")!.data) };
}

function comaForPeriod(masters: Masters, period: number) {
  const def = PERIOD_DEFS[period];
  if (!def) return null;
  return masters.comas.find((c) => c.time_start === hhmm(def.start) && c.time_end === hhmm(def.end)) ?? null;
}

function comiruSubjectFor(masters: Masters, subject: string): string | null {
  const mapped = toComiruSubjectName(subject);
  if (masters.subjects.includes(mapped)) return mapped;
  if (masters.subjects.includes(subject)) return subject;
  return null;
}

// ---------------------------------------------------------------- 反映の計画（差分）

interface Desired {
  student_id: number;
  student_name: string;
  comiru_student_id: number | null;
  teacher_id: number | null;
  teacher_name: string | null;
  comiru_teacher_id: number | null;
  subject: string;
  table_id: string;
  date: string;
  period: number;
  has_teacher_conflict: number;
  has_schedule_mismatch: number;
  has_student_schedule_mismatch: number;
  has_slot_invalid: number;
}

interface Registered {
  student_id: number;
  student_name: string;
  comiru_student_id: number | null;
  date: string;
  period: number;
  seat_id: number | null;
  owned: number;
  teacher_id: number;
  teacher_name: string | null;
  comiru_subject: string;
  classroom: string | null;
  requested_table: string | null;
}

export interface PlanItem {
  key: string; // student_id#date#period（移動のときは移動先）
  op: "add" | "change" | "move" | "delete" | "skip";
  student_id: number;
  student_name: string;
  date: string;
  period: number;
  subject: string | null;
  comiru_subject: string | null;
  teacher_name: string | null;
  before_teacher_name?: string | null;
  before_subject?: string | null;
  from_key?: string; // 移動元
  from_date?: string;
  from_period?: number;
  record_only?: boolean; // comiru には触らず、記録だけ消す
  reason?: string; // 保留の理由、または注意
}

const keyOf = (studentId: number, date: string, period: number) => `${studentId}#${date}#${period}`;

/**
 * 反映の計画を作る。アプリの割り当てが基準。
 * live に comiru の実際の授業（seat_id → 授業）を渡すと、アプリが記録している授業が
 *   ・comiru で消されていた → もう一度登録する（add）
 *   ・comiru で講師・時間・科目などが変えられていた → アプリの内容に更新する（change）
 * live が null のとき（照合しないとき）は、アプリの記録だけで判断する。
 */
async function buildPlan(
  env: Env,
  termId: number,
  studentId: number | null,
  masters: Masters | null,
  live: Map<number, ComiruSeat> | null = null,
): Promise<PlanItem[]> {
  const db = env.DB;
  const [desired, registered] = await Promise.all([
    db
      .prepare(
        `SELECT a.student_id, s.name AS student_name, s.comiru_student_id, a.teacher_id, t.name AS teacher_name, t.comiru_teacher_id,
                a.subject, a.table_id, a.date, a.period, ${FLAGS_SQL}
           FROM assignments a JOIN students s ON s.id = a.student_id LEFT JOIN teachers t ON t.id = a.teacher_id
          WHERE a.term_id = ?1 AND (?2 IS NULL OR a.student_id = ?2)`,
      )
      .bind(termId, studentId)
      .all<Desired>(),
    db
      .prepare(
        `SELECT l.student_id, s.name AS student_name, s.comiru_student_id, l.date, l.period, l.seat_id, l.owned, l.teacher_id,
                t.name AS teacher_name, l.comiru_subject, l.classroom, l.requested_table
           FROM comiru_lessons l JOIN students s ON s.id = l.student_id LEFT JOIN teachers t ON t.id = l.teacher_id
          WHERE l.term_id = ?1 AND (?2 IS NULL OR l.student_id = ?2)`,
      )
      .bind(termId, studentId)
      .all<Registered>(),
  ]);

  const registeredByKey = new Map(registered.results.map((r) => [keyOf(r.student_id, r.date, r.period), r]));
  const items: PlanItem[] = [];

  for (const d of desired.results) {
    const key = keyOf(d.student_id, d.date, d.period);
    const reg = registeredByKey.get(key);
    registeredByKey.delete(key);
    const comiruSubject = masters ? comiruSubjectFor(masters, d.subject) : toComiruSubjectName(d.subject);
    const base = {
      key,
      student_id: d.student_id,
      student_name: d.student_name,
      date: d.date,
      period: d.period,
      subject: d.subject,
      comiru_subject: comiruSubject,
      teacher_name: d.teacher_name,
    };

    // 反映できない理由（入力の問題）
    let reason = "";
    if (d.teacher_id === null) reason = "講師未定";
    else if (!d.comiru_student_id) reason = "生徒が comiru と紐付いていません";
    else if (!d.comiru_teacher_id) reason = "講師が comiru と紐付いていません";
    else if (d.has_teacher_conflict) reason = "講師が同じ時間に別の生徒にも入っています（講師重複を直してください）";
    else if (d.has_schedule_mismatch) reason = "講師がその時間に来られないか、その科目を教えられません（講師予定不一致を直してください）";
    else if (d.has_student_schedule_mismatch) reason = "生徒がその時間に来られません（生徒予定不一致を直してください）";
    else if (d.has_slot_invalid) reason = "休校日・期間外の日時です（授業を移動してください）";
    else if (masters && !comaForPeriod(masters, d.period)) reason = `comiru に ${d.period}限（${PERIOD_DEFS[d.period]?.start}〜）のコマがありません`;
    else if (!comiruSubject) reason = `科目「${d.subject}」に当たる comiru の科目がありません`;

    const state = liveState(reg, live);

    if (reason) {
      // 入力の問題は削除の意図ではないので、登録済みの授業は残して保留にする
      items.push({ ...base, op: "skip", reason: reg && state !== "missing" ? `${reason}。登録済みの授業はそのまま残しています` : reason });
      continue;
    }
    if (!reg || state === "missing") {
      items.push({ ...base, op: "add", reason: reg ? "comiru で削除されていたため、もう一度登録します" : undefined });
      continue;
    }
    // ここから先は登録済み。何が違うか
    const diffs: string[] = [];
    if (reg.teacher_id !== d.teacher_id) diffs.push("講師");
    if (reg.comiru_subject !== comiruSubject) diffs.push("科目");
    if ((reg.requested_table ?? reg.classroom) !== d.table_id) diffs.push("席");
    const drift = typeof state === "object" ? driftOf(state, d, masters, comiruSubject) : "";
    if (!diffs.length && !drift) continue; // 同じ
    if (!reg.owned) {
      items.push({
        ...base,
        op: "skip",
        reason: `comiru に元からあった授業なので、アプリからは変更しません（${diffs.join("・") || drift}が違います）。comiru で直してください`,
      });
      continue;
    }
    items.push({
      ...base,
      op: "change",
      before_teacher_name: typeof state === "object" ? state.teacher_name : reg.teacher_name,
      before_subject: (typeof state === "object" ? subjectOf(state, d) : null) ?? reg.comiru_subject,
      reason: drift && !diffs.length ? `comiru 側で${drift}が変えられていたため、アプリの内容に戻します` : diffs.includes("席") && diffs.length === 1 ? "席を変更します" : undefined,
    });
  }

  // アプリから消した割り当て → comiru からも消す（comiru に元からあった授業・すでに消えている授業は記録だけ消す）
  const deletes: PlanItem[] = [];
  for (const reg of registeredByKey.values()) {
    const missing = liveState(reg, live) === "missing";
    deletes.push({
      key: keyOf(reg.student_id, reg.date, reg.period),
      op: "delete",
      student_id: reg.student_id,
      student_name: reg.student_name,
      date: reg.date,
      period: reg.period,
      subject: null,
      comiru_subject: reg.comiru_subject,
      teacher_name: reg.teacher_name,
      record_only: !reg.owned || !reg.seat_id || missing,
      reason: !reg.owned || !reg.seat_id
        ? "comiru に元からあった授業なので、comiru 側はそのままにします"
        : missing
          ? "comiru ではすでに削除されているので、記録だけ消します"
          : undefined,
    });
  }

  // 同じ生徒の「削除」と「追加」で、講師・科目が同じものは「移動」にまとめる（削除して作り直さない）
  const adds = items.filter((i) => i.op === "add" && !i.reason);
  for (const del of deletes) {
    if (del.record_only) continue;
    const reg = registered.results.find((r) => keyOf(r.student_id, r.date, r.period) === del.key)!;
    const idx = adds.findIndex((a) => a.student_id === del.student_id && a.teacher_name === del.teacher_name && a.comiru_subject === del.comiru_subject);
    if (idx < 0) continue;
    const add = adds.splice(idx, 1)[0];
    Object.assign(add, {
      op: "move",
      from_key: del.key,
      from_date: reg.date,
      from_period: reg.period,
      before_teacher_name: reg.teacher_name,
      before_subject: reg.comiru_subject,
    });
    del.op = "skip"; // 移動に含めたので、削除としては行わない（下で取り除く）
    del.key = "";
  }
  items.push(...deletes.filter((d) => d.key));

  const order = { delete: 0, move: 1, change: 2, add: 3, skip: 4 };
  return items.sort((a, b) => order[a.op] - order[b.op] || a.student_name.localeCompare(b.student_name) || a.date.localeCompare(b.date) || a.period - b.period);
}

/** アプリが記録している授業の、comiru での今の状態 */
function liveState(reg: Registered | undefined, live: Map<number, ComiruSeat> | null): "unknown" | "missing" | ComiruSeat {
  if (!reg?.seat_id || !live) return "unknown"; // 照合していない／授業IDが分からない
  return live.get(reg.seat_id) ?? "missing";
}

/** comiru の授業の中の、この生徒の分 */
function studentIn(seat: ComiruSeat, comiruStudentId: number | null, name: string | null) {
  return seat.students.find((st) => (comiruStudentId != null && st.student_id === comiruStudentId) || (st.student_id == null && name != null && st.student_name === name)) ?? null;
}

function subjectOf(seat: ComiruSeat, d: Desired): string | null {
  return studentIn(seat, d.comiru_student_id, d.student_name)?.subject ?? null;
}

/** comiru の授業が、アプリの割り当てと食い違っているところ（なければ空文字） */
function driftOf(seat: ComiruSeat, d: Desired, masters: Masters | null, comiruSubject: string | null): string {
  const diffs: string[] = [];
  if (seat.date && seat.date !== d.date) diffs.push("日付");
  const coma = masters ? comaForPeriod(masters, d.period) : null;
  if (coma && seat.start_time && seat.start_time !== coma.time_start) diffs.push("時間");
  const teacherDiffers = seat.teacher_id != null && d.comiru_teacher_id != null ? seat.teacher_id !== d.comiru_teacher_id : Boolean(d.teacher_name && seat.teacher_name && seat.teacher_name !== d.teacher_name);
  if (teacherDiffers) diffs.push("講師");
  const mine = studentIn(seat, d.comiru_student_id, d.student_name);
  if (!mine) diffs.push("生徒");
  else if (comiruSubject && mine.subject && mine.subject !== comiruSubject) diffs.push("科目");
  return diffs.join("・");
}

// ---------------------------------------------------------------- comiru の授業一覧

interface ComiruSeatStudent {
  student_id: number | null;
  student_name: string | null;
  subject: string | null;
  absent: boolean;
}

interface ComiruSeat {
  id: number;
  date: string;
  start_time: string;
  end_time: string;
  classroom: string | null;
  teacher_id: number | null;
  teacher_name: string;
  students: ComiruSeatStudent[]; // 1対2などの授業もあるので全員分
}

const MAX_SEAT_PAGES = 40;
const SEATS_PER_PAGE = 500; // comiru の上限

/** 期間の comiru の授業を全部取る（1ページ最大500件。空のページが来るまで読む） */
async function seatsInRange(env: Env, start: string, end: string, comiruStudentId: number | null = null): Promise<Map<number, ComiruSeat>> {
  const all = new Map<number, ComiruSeat>();
  for (let page = 1; page <= MAX_SEAT_PAGES; page++) {
    const query: Record<string, string | number> = { type: 0, start_date: start, end_date: end, page, per_page: SEATS_PER_PAGE };
    if (comiruStudentId) query.student_id = comiruStudentId;
    const r = await comiruFetch(env, "GET", "seats", { query });
    if (!r.ok) throw new ComiruCallError(`comiru の授業一覧を取得できませんでした（${comiruMessage(r)}）`);
    const days = (r.json?.data as Record<string, unknown>[]) ?? [];
    // 相手が1ページの件数を減らしても読み落とさないよう、空のページが来るまで読む（GAS の fetchSeats と同じ）
    if (!days.length) return all;
    for (const seat of days.flatMap(toSeats)) all.set(seat.id, seat);
  }
  throw new ComiruCallError("comiru の授業が多すぎて、照合しきれませんでした");
}

/** その日の comiru の授業（全員分・全ページ） */
async function seatsOn(env: Env, date: string): Promise<ComiruSeat[]> {
  return [...(await seatsInRange(env, date, date)).values()];
}

/** comiru の「日ごとの授業一覧」1日分を、扱いやすい形にする */
function toSeats(day: Record<string, unknown>): ComiruSeat[] {
  return ((day.seats as Record<string, unknown>[]) ?? []).map((s) => {
    const teacher = (s.teacher as Record<string, unknown> | undefined) ?? {};
    return {
      id: Number(s.id),
      date: String(s.date ?? day.date ?? ""),
      start_time: hhmm(s.start_time),
      end_time: hhmm(s.end_time),
      classroom: s.classroom == null ? null : String(s.classroom),
      teacher_id: teacher.id != null ? Number(teacher.id) : s.teacher_id != null ? Number(s.teacher_id) : null,
      teacher_name: String(teacher.name ?? ""),
      students: ((s.seat_students as Record<string, unknown>[]) ?? []).map((st) => ({
        student_id: st.student_id != null ? Number(st.student_id) : null,
        student_name: (st.student_name as string | null) ?? null,
        subject: (st.subject as string | null) ?? null,
        absent: Boolean(st.absent),
      })),
    };
  });
}

/** その時間に使われていない席。アプリで選んだ席が空いていればそれ、なければ座席設定の順で空いている席 */
function pickClassroom(slotSeats: ComiruSeat[], preferred: string, allowed: string[], exceptSeatId: number | null = null): string | null {
  const used = new Set(slotSeats.filter((s) => s.id !== exceptSeatId).map((s) => s.classroom).filter(Boolean));
  if (!used.has(preferred)) return preferred;
  return allowed.find((c) => !used.has(c)) ?? null;
}

interface OpResult {
  key: string;
  ok: boolean;
  message: string;
}

export function registerComiruSyncRoutes(api: Hono<AppEnv>): void {
  // 反映の計画（何を追加・変更・移動・削除するか）。student_id を付けるとその生徒だけ
  api.get("/terms/:termId/comiru/plan", async (c) => {
    if (!comiruConfigured(c.env)) throw new HttpError(400, "comiru 連携が設定されていません");
    const termId = Number(c.req.param("termId"));
    const term = await getTerm(c.env.DB, termId);
    const studentId = c.req.query("student_id") ? Number(c.req.query("student_id")) : null;
    const masters = await loadMasters(c.env, c.req.query("refresh") === "1");
    // comiru の実際の授業と照らし合わせる（comiru で消された・変えられた授業を見つけるため）
    let live: Map<number, ComiruSeat> | null = null;
    let verifyError: string | null = null;
    try {
      const comiruStudentId = studentId
        ? ((await c.env.DB.prepare("SELECT comiru_student_id FROM students WHERE id = ?").bind(studentId).first<{ comiru_student_id: number | null }>())
            ?.comiru_student_id ?? null)
        : null;
      live = await seatsInRange(c.env, term.start_date, term.end_date, comiruStudentId);
    } catch (err) {
      verifyError = err instanceof Error ? err.message : "comiru と照合できませんでした";
    }
    const items = await buildPlan(c.env, termId, studentId, masters, live);
    return c.json({ items, verified: live !== null, verify_error: verifyError });
  });

  // 計画のうち指定したものを実行する（1回 MAX_OPS_PER_REQUEST 件まで。画面側で分けて呼ぶ）
  api.post("/terms/:termId/comiru/apply", async (c) => {
    const env = c.env;
    if (!comiruConfigured(env)) throw new HttpError(400, "comiru 連携が設定されていません");
    const db = env.DB;
    const termId = Number(c.req.param("termId"));
    const term = await getTerm(db, termId);
    const keys = ((await c.req.json<{ keys?: string[] }>()).keys ?? []).map(String);
    if (!keys.length) throw new HttpError(400, "反映するものを選んでください");
    if (keys.length > MAX_OPS_PER_REQUEST) throw new HttpError(400, `1回に反映できるのは ${MAX_OPS_PER_REQUEST} 件までです`);

    const masters = await loadMasters(env);
    const tableIds = await getTableIds(db);
    // その日の全員分の授業（教室の空き・同じ授業の確認用）
    const dayCache = new Map<string, ComiruSeat[]>();
    const seatsFor = async (date: string) => {
      if (!dayCache.has(date)) dayCache.set(date, await seatsOn(env, date));
      return dayCache.get(date)!;
    };
    // 生徒ごとの講習期間の授業（計画の作り直し用）
    const studentCache = new Map<number, Map<number, ComiruSeat>>();
    const liveFor = async (studentId: number) => {
      if (!studentCache.has(studentId)) {
        const row = await db.prepare("SELECT comiru_student_id FROM students WHERE id = ?").bind(studentId).first<{ comiru_student_id: number | null }>();
        studentCache.set(studentId, await seatsInRange(env, term.start_date, term.end_date, row?.comiru_student_id ?? null));
      }
      return studentCache.get(studentId)!;
    };

    const results: OpResult[] = [];
    for (const key of keys) {
      // 画面で見た計画ではなく、今のデータと comiru の今の授業で計画を作り直してから実行する
      // （ほかの人が直していても、comiru 側が変わっていても安全なように）
      const sid = Number(key.split("#")[0]);
      let item: PlanItem | undefined;
      try {
        item = (await buildPlan(env, termId, sid, masters, await liveFor(sid))).find((p) => p.key === key);
      } catch (err) {
        results.push({ key, ok: false, message: err instanceof Error ? err.message : "comiru と照合できませんでした" });
        continue;
      }
      if (!item || item.op === "skip") {
        results.push({ key, ok: false, message: item?.reason ?? "反映するものがありません（すでに反映済みか、内容が変わりました）" });
        continue;
      }
      try {
        let message: string;
        if (item.op === "delete") message = await removeLesson(env, termId, item);
        else if (item.op === "add") message = await addLesson(env, termId, item, masters, tableIds, seatsFor);
        else message = await updateLesson(env, termId, item, masters, tableIds, seatsFor); // change / move
        dayCache.clear(); // 書き換えた授業を次の判定に反映させるため取り直す
        studentCache.delete(sid);
        results.push({ key, ok: true, message });
      } catch (err) {
        const message = err instanceof ComiruCallError || err instanceof HttpError ? err.message : "予期しないエラーが発生しました";
        if (!(err instanceof ComiruCallError || err instanceof HttpError)) console.error("comiru apply failed", key, err);
        results.push({ key, ok: false, message });
      }
    }
    await db.prepare("UPDATE terms SET version = version + 1 WHERE id = ?").bind(termId).run();
    return c.json({ results });
  });

  // comiru に登録済みかどうか（割り当て画面で生徒ごとの反映状況を出す）
  api.get("/terms/:termId/comiru/status", async (c) => {
    const termId = Number(c.req.param("termId"));
    const items = await buildPlan(c.env, termId, null, null);
    const pending = new Map<number, number>();
    for (const i of items) if (i.op !== "skip") pending.set(i.student_id, (pending.get(i.student_id) ?? 0) + 1);
    const { results } = await c.env.DB.prepare("SELECT student_id, COUNT(*) AS n FROM comiru_lessons WHERE term_id = ? GROUP BY student_id")
      .bind(termId)
      .all<{ student_id: number; n: number }>();
    return c.json({
      configured: comiruConfigured(c.env),
      pending_total: [...pending.values()].reduce((a, b) => a + b, 0),
      students: Object.fromEntries(
        [...new Set([...pending.keys(), ...results.map((r) => r.student_id)])].map((id) => [
          id,
          { pending: pending.get(id) ?? 0, registered: results.find((r) => r.student_id === id)?.n ?? 0 },
        ]),
      ),
    });
  });
}

// ---------------------------------------------------------------- 実行（1件ずつ）

interface AssignmentForComiru {
  teacher_id: number;
  table_id: string;
  comiru_student_id: number;
  student_name: string;
  comiru_teacher_id: number;
  teacher_name: string;
}

async function assignmentFor(env: Env, termId: number, item: PlanItem): Promise<AssignmentForComiru> {
  const a = await env.DB
    .prepare(
      `SELECT a.teacher_id, a.table_id, s.comiru_student_id, s.name AS student_name, t.comiru_teacher_id, t.name AS teacher_name
         FROM assignments a JOIN students s ON s.id = a.student_id JOIN teachers t ON t.id = a.teacher_id
        WHERE a.term_id = ? AND a.student_id = ? AND a.date = ? AND a.period = ?`,
    )
    .bind(termId, item.student_id, item.date, item.period)
    .first<AssignmentForComiru>();
  if (!a) throw new HttpError(404, "割り当てが見つかりません");
  return a;
}

function recordLesson(
  env: Env,
  termId: number,
  item: PlanItem,
  a: AssignmentForComiru,
  seatId: number | null,
  owned: boolean,
  classroom: string | null,
) {
  return env.DB.prepare(
    `INSERT OR REPLACE INTO comiru_lessons
       (term_id, student_id, date, period, seat_id, owned, teacher_id, comiru_subject, classroom, requested_table, registered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(termId, item.student_id, item.date, item.period, seatId, owned ? 1 : 0, a.teacher_id, item.comiru_subject, classroom, a.table_id, nowIso());
}

function seatPayload(masters: Masters, item: PlanItem, a: AssignmentForComiru, classroom: string) {
  return {
    coma_id: comaForPeriod(masters, item.period)!.id,
    date: item.date,
    classroom,
    teacher_id: a.comiru_teacher_id,
    max_seats: 1,
    is_public: true,
    students: [{ student_id: a.comiru_student_id, subject: item.comiru_subject }],
  };
}

/** アプリが作った授業を comiru から消し、記録も消す（comiru に元からあった授業・すでに消えている授業は記録だけ） */
async function removeLesson(env: Env, termId: number, item: PlanItem): Promise<string> {
  const db = env.DB;
  const reg = await db
    .prepare("SELECT seat_id, owned FROM comiru_lessons WHERE term_id = ? AND student_id = ? AND date = ? AND period = ?")
    .bind(termId, item.student_id, item.date, item.period)
    .first<{ seat_id: number | null; owned: number }>();
  if (!reg) return "すでに記録はありません";
  let message = "記録だけ消しました（comiru 側はそのままです）";
  if (reg.seat_id && reg.owned && !item.record_only) {
    await sleep(COMIRU_INTERVAL_MS);
    const r = await comiruFetch(env, "DELETE", `seats/${reg.seat_id}`);
    // すでに comiru 側で消されていた（404）場合は、消せたものとして扱う
    if (!r.ok && r.status !== 404) throw new ComiruCallError(`comiru の授業を削除できませんでした（${comiruMessage(r)}）`);
    message = "削除しました";
  }
  await db
    .prepare("DELETE FROM comiru_lessons WHERE term_id = ? AND student_id = ? AND date = ? AND period = ?")
    .bind(termId, item.student_id, item.date, item.period)
    .run();
  return message;
}

/** comiru に授業を登録し、記録する。結果のメッセージを返す */
async function addLesson(
  env: Env,
  termId: number,
  item: PlanItem,
  masters: Masters,
  tableIds: string[],
  seatsFor: (date: string) => Promise<ComiruSeat[]>,
): Promise<string> {
  const a = await assignmentFor(env, termId, item);
  const coma = comaForPeriod(masters, item.period)!;
  const slotSeats = (await seatsFor(item.date)).filter((s) => s.start_time === coma.time_start && s.end_time === coma.time_end);

  // 同じ時間に、この生徒の授業（欠席でない）がすでにあるか
  const existing = slotSeats
    .map((seat) => ({ seat, mine: studentIn(seat, a.comiru_student_id, a.student_name) }))
    .filter((x) => x.mine && !x.mine.absent);
  const sameTeacher = (seat: ComiruSeat) => (seat.teacher_id != null ? seat.teacher_id === a.comiru_teacher_id : seat.teacher_name === a.teacher_name);
  const same = existing.find((x) => sameTeacher(x.seat) && x.mine!.subject === item.comiru_subject);
  if (same) {
    // 同じ授業が comiru にある → 新しく作らず、それを使う（comiru に元からあった授業なので、アプリからは変更・削除しない）
    await recordLesson(env, termId, item, a, same.seat.id, false, same.seat.classroom).run();
    return "comiru にすでに同じ授業があったため、登録はせずその授業を使います（アプリからは変更・削除しません）";
  }
  if (existing.length) {
    const other = existing[0];
    throw new ComiruCallError(
      `comiru の同じ時間に、この生徒の別の授業（${other.mine!.subject ?? "科目不明"}・${other.seat.teacher_name || "講師不明"}）がすでにあります。comiru で確認してください`,
    );
  }

  const classroom = pickClassroom(slotSeats, a.table_id, tableIds);
  if (!classroom) throw new ComiruCallError("その時間に comiru で空いている席がありません（座席設定の席がすべて使われています）");

  await sleep(COMIRU_INTERVAL_MS);
  const r = await comiruFetch(env, "POST", "seats", { body: seatPayload(masters, item, a, classroom) });
  if (r.status !== 201 && !r.ok) throw new ComiruCallError(`comiru に登録できませんでした（${comiruMessage(r)}）`);

  // 登録した授業の ID（応答の形が分からないので、いくつかの形に対応し、なければ一覧から探す）
  const body = r.json ?? {};
  const data = body.data as Record<string, unknown> | undefined;
  let seatId = Number(body.id ?? data?.id ?? (body.seat as Record<string, unknown> | undefined)?.id ?? (data?.seat as Record<string, unknown> | undefined)?.id) || null;
  if (!seatId) {
    await sleep(COMIRU_INTERVAL_MS);
    const found = (await seatsOn(env, item.date)).find(
      (s) => s.start_time === coma.time_start && s.classroom === classroom && sameTeacher(s) && studentIn(s, a.comiru_student_id, a.student_name),
    );
    seatId = found?.id ?? null;
  }
  await recordLesson(env, termId, item, a, seatId, true, classroom).run();
  const roomNote = classroom === a.table_id ? "" : `（席${a.table_id}は comiru で使われていたため、席${classroom}で登録）`;
  return seatId ? `登録しました${roomNote}` : `登録しました${roomNote}。ただし comiru の授業IDを確認できなかったため、この授業はアプリから変更・削除できません`;
}

/**
 * アプリが作った授業を、削除せずに更新（PUT）で書き換える（講師・科目・席の変更、日時の移動）。
 * 失敗しても comiru の元の授業はそのまま残る。
 */
async function updateLesson(
  env: Env,
  termId: number,
  item: PlanItem,
  masters: Masters,
  tableIds: string[],
  seatsFor: (date: string) => Promise<ComiruSeat[]>,
): Promise<string> {
  const db = env.DB;
  const fromKey = item.from_key ?? item.key;
  const [, fromDate, fromPeriod] = fromKey.split("#");
  const reg = await db
    .prepare("SELECT seat_id, owned, classroom FROM comiru_lessons WHERE term_id = ? AND student_id = ? AND date = ? AND period = ?")
    .bind(termId, item.student_id, fromDate, Number(fromPeriod))
    .first<{ seat_id: number | null; owned: number; classroom: string | null }>();
  if (!reg?.seat_id || !reg.owned) throw new ComiruCallError("comiru の授業IDが分からないため、更新できません");
  const a = await assignmentFor(env, termId, item);
  const coma = comaForPeriod(masters, item.period)!;
  const slotSeats = (await seatsFor(item.date)).filter((s) => s.start_time === coma.time_start && s.end_time === coma.time_end);
  // 席：アプリで選んだ席 → 今の教室 → 座席設定の空き の順（自分自身の授業は「使用中」に数えない）
  const classroom =
    pickClassroom(slotSeats, a.table_id, [], reg.seat_id) ??
    (reg.classroom && fromDate === item.date && Number(fromPeriod) === item.period ? pickClassroom(slotSeats, reg.classroom, [], reg.seat_id) : null) ??
    pickClassroom(slotSeats, a.table_id, tableIds, reg.seat_id);
  if (!classroom) throw new ComiruCallError("その時間に comiru で空いている席がありません（座席設定の席がすべて使われています）");

  await sleep(COMIRU_INTERVAL_MS);
  const r = await comiruFetch(env, "PUT", `seats/${reg.seat_id}`, { body: seatPayload(masters, item, a, classroom) });
  if (r.status === 404) {
    throw new ComiruCallError("comiru でこの授業が見つかりません（削除された可能性があります）。もう一度「反映」の一覧を開いて確認してください");
  }
  if (!r.ok) throw new ComiruCallError(`comiru の授業を更新できませんでした（${comiruMessage(r)}）。元の授業はそのまま残っています`);

  const statements = [recordLesson(env, termId, item, a, reg.seat_id, true, classroom)];
  if (item.from_key) {
    statements.unshift(
      db.prepare("DELETE FROM comiru_lessons WHERE term_id = ? AND student_id = ? AND date = ? AND period = ?").bind(termId, item.student_id, fromDate, Number(fromPeriod)),
    );
  }
  await db.batch(statements);
  const roomNote = classroom === a.table_id ? "" : `（席${a.table_id}は comiru で使われていたため、席${classroom}で登録）`;
  return `${item.op === "move" ? "移動しました" : "更新しました"}${roomNote}`;
}
