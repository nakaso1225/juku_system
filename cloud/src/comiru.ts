// comiru API との連携（講師一覧の取得と、講師登録時の自動照合）
import { nowIso } from "./terms";
import type { Env } from "./types";
import { gradeFrom, nameKanaFrom } from "./roster";

export const DEFAULT_COMIRU_API_BASE_URL = "https://api.comiru.com";
const ROSTER_MAX_AGE_HOURS = 12;
const MAX_PAGES = 20; // 無料プランの外部リクエスト上限（1回50件）に余裕を残す

export function comiruConfigured(env: Env): boolean {
  return Boolean(env.COMIRU_TOKEN?.trim() && env.COMIRU_SCHOOL_ID?.trim());
}

export class ComiruError extends Error {}

async function comiruGet(env: Env, path: string, query: Record<string, string | number> = {}): Promise<unknown> {
  const url = new URL(`${(env.COMIRU_API_BASE_URL || DEFAULT_COMIRU_API_BASE_URL).replace(/\/+$/, "")}/${env.COMIRU_SCHOOL_ID!.trim()}/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.COMIRU_TOKEN!.trim()}`, Accept: "application/json" },
  });
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) {
    console.error("comiru api error", path, res.status, body?.message);
    throw new ComiruError(`comiru との通信に失敗しました（${res.status}${body?.message ? `：${body.message}` : ""}）`);
  }
  return body;
}

/** 氏名の比較用：全角/半角をそろえ、空白をすべて取り除く */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "");
}

interface ComiruTeacher {
  id: number;
  name: string;
  email: string | null;
  name_kana: string;
}

function toTeachers(list: unknown[]): ComiruTeacher[] {
  return list
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      const email = typeof r.email === "string" ? r.email : typeof r.mail === "string" ? r.mail : null;
      return { id: Number(r.id), name: String(r.name ?? ""), email: email ? email.trim().toLowerCase() : null, name_kana: nameKanaFrom(r) };
    })
    .filter((t) => Number.isInteger(t.id) && t.name);
}

/** 一覧系 API を全ページ取得する。応答は配列そのもの、またはページ分けされた { data: [...], last_page } のどちらにも対応する */
async function fetchAllPages(env: Env, path: string): Promise<unknown[]> {
  if (!comiruConfigured(env)) throw new ComiruError("comiru の接続情報が設定されていません");
  const first = await comiruGet(env, path);
  if (Array.isArray(first)) return first;
  const page = first as { data?: unknown[]; last_page?: number; meta?: { last_page?: number } };
  const items = [...(page.data ?? [])];
  const lastPage = Math.min(Number(page.last_page ?? page.meta?.last_page) || 1, MAX_PAGES);
  for (let p = 2; p <= lastPage; p++) {
    const next = (await comiruGet(env, path, { page: p })) as { data?: unknown[] };
    items.push(...(next.data ?? []));
  }
  return items;
}

/** comiru から講師一覧を取り直して保存する。取得した人数を返す */
export async function refreshComiruTeachers(env: Env): Promise<number> {
  const teachers = toTeachers(await fetchAllPages(env, "teachers"));
  const now = nowIso();
  const rows = teachers.map((t) => ({ ...t, normalized_name: normalizeName(t.name) }));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM comiru_teachers"),
    env.DB.prepare(
      `INSERT OR REPLACE INTO comiru_teachers (id, name, normalized_name, email, fetched_at, name_kana)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.normalized_name'),
              json_extract(value, '$.email'), ?, json_extract(value, '$.name_kana')
         FROM json_each(?)`,
    ).bind(now, JSON.stringify(rows)),
    // 名簿（teachers）に反映：新しい講師は追加、名前・メールは comiru に合わせ、いなくなった講師は隠す
    env.DB.prepare(
      `INSERT INTO teachers (name, email, comiru_teacher_id, status, active, name_kana)
       SELECT name, COALESCE(email, ''), id, 'approved', 1, name_kana FROM comiru_teachers WHERE true
       ON CONFLICT (comiru_teacher_id) WHERE comiru_teacher_id IS NOT NULL
       DO UPDATE SET name = excluded.name, email = excluded.email, active = 1,
         name_kana = CASE WHEN excluded.name_kana != '' THEN excluded.name_kana ELSE teachers.name_kana END`,
    ),
    env.DB.prepare(
      "UPDATE teachers SET active = 0 WHERE comiru_teacher_id IS NOT NULL AND comiru_teacher_id NOT IN (SELECT id FROM comiru_teachers)",
    ),
  ]);
  return rows.length;
}

/** comiru で退会・削除された生徒か（削除フラグ、退会日時、今日までの退会日） */
function hasLeft(r: Record<string, unknown>, today: string): boolean {
  if (r.is_deleted === true || r.is_deleted === 1 || r.is_deleted === "1") return true;
  if (typeof r.deleted_at === "string" && r.deleted_at.trim()) return true;
  const out = typeof r.out_school_date === "string" ? r.out_school_date.trim().slice(0, 10) : "";
  return Boolean(out) && out <= today;
}

/** comiru から生徒一覧を取り直し、名簿（students）に反映する。取得した人数を返す（退会した生徒は数えない） */
export async function refreshComiruStudents(env: Env): Promise<number> {
  const today = nowIso().slice(0, 10);
  const students = (await fetchAllPages(env, "students"))
    .filter((raw) => !hasLeft(raw as Record<string, unknown>, today))
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      return { id: Number(r.id), name: String(r.name ?? ""), name_kana: nameKanaFrom(r), grade: gradeFrom(r) };
    })
    .filter((st) => Number.isInteger(st.id) && st.name)
    .map((st) => ({ ...st, normalized_name: normalizeName(st.name) }));

  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM comiru_students"),
    db
      .prepare(
        `INSERT OR REPLACE INTO comiru_students (id, name, normalized_name, fetched_at, name_kana, grade)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.normalized_name'), ?,
                json_extract(value, '$.name_kana'), json_extract(value, '$.grade')
           FROM json_each(?)`,
      )
      .bind(nowIso(), JSON.stringify(students)),
    db.prepare(
      `INSERT INTO students (name, comiru_student_id, active, name_kana, grade)
       SELECT name, id, 1, name_kana, grade FROM comiru_students WHERE true
       ON CONFLICT (comiru_student_id) DO UPDATE SET name = excluded.name, active = 1,
         name_kana = CASE WHEN excluded.name_kana != '' THEN excluded.name_kana ELSE students.name_kana END,
         grade = CASE WHEN excluded.grade != '' THEN excluded.grade ELSE students.grade END`,
    ),
    db.prepare(
      "UPDATE students SET active = 0 WHERE comiru_student_id IS NULL OR comiru_student_id NOT IN (SELECT id FROM comiru_students)",
    ),
  ]);
  return students.length;
}

/** 名簿が空か古ければ comiru から取り直す。失敗しても手元の名簿で続ける */
export async function ensureFreshRoster(env: Env, table: "comiru_teachers" | "comiru_students"): Promise<void> {
  if (!comiruConfigured(env)) return;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n, MIN(fetched_at) AS fetched_at FROM ${table}`).first<{
    n: number;
    fetched_at: string | null;
  }>();
  const stale = !row?.n || !row.fetched_at || Date.now() - Date.parse(row.fetched_at) > ROSTER_MAX_AGE_HOURS * 3600 * 1000;
  if (!stale) return;
  try {
    if (table === "comiru_teachers") await refreshComiruTeachers(env);
    else await refreshComiruStudents(env);
  } catch (err) {
    console.error(`comiru ${table} refresh failed`, err);
  }
}
