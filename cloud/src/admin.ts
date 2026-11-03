// 管理画面（事務）用 API
import { Hono } from "hono";
import { periodLabel } from "./constants";
import { datesBetween, getTerm, HttpError, isSlotInTerm, nowIso, parseTermInput, rowToTerm, termForClient, type Slot } from "./terms";
import type { AppEnv, Env } from "./types";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

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
  const term = await getTerm(c.env.DB, Number(c.req.param("termId")));
  const t = parseTermInput(await c.req.json());
  const row = await c.env.DB.prepare(
    `UPDATE terms SET name = ?, start_date = ?, end_date = ?, periods = ?, closed_dates = ?, accepting = ?
      WHERE id = ? RETURNING *`,
  )
    .bind(t.name, t.start_date, t.end_date, JSON.stringify(t.periods), JSON.stringify(t.closed_dates), t.accepting ? 1 : 0, term.id)
    .first();
  return c.json(termForClient(rowToTerm(row!)));
});

// ---------------------------------------------------------------- 講師

// 講師一覧。term_id を付けると、その講習の提出状況・未確認の変更数も返す
adminApi.get("/teachers", async (c) => {
  const termId = Number(c.req.query("term_id") || 0);
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.email, t.status, t.comiru_teacher_id, t.staff_memo, t.created_at,
            (SELECT group_concat(subject, ', ') FROM teacher_subjects s WHERE s.teacher_id = t.id) AS subjects,
            e.submitted_at, e.updated_at, e.note,
            (SELECT COUNT(*) FROM teacher_availability a WHERE a.teacher_id = t.id AND a.term_id = ?) AS slot_count,
            (SELECT COUNT(*) FROM availability_changes ch WHERE ch.teacher_id = t.id AND ch.term_id = ? AND ch.seen = 0) AS unseen_changes
       FROM teachers t
       LEFT JOIN teacher_term_entries e ON e.teacher_id = t.id AND e.term_id = ?
      ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, t.name`,
  )
    .bind(termId, termId, termId)
    .all();
  return c.json(results);
});

adminApi.patch("/teachers/:teacherId", async (c) => {
  const id = Number(c.req.param("teacherId"));
  const body = await c.req.json<Record<string, unknown>>();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (body.status !== undefined) {
    if (!["pending", "approved", "rejected"].includes(String(body.status))) throw new HttpError(400, "status が不正です");
    sets.push("status = ?");
    values.push(String(body.status));
  }
  if (body.name !== undefined) {
    const name = String(body.name).replace(/\s+/g, "");
    if (!name) throw new HttpError(400, "氏名を入力してください");
    sets.push("name = ?");
    values.push(name);
  }
  if (body.comiru_teacher_id !== undefined) {
    const raw = body.comiru_teacher_id;
    const comiruId = raw === null || raw === "" ? null : Number(raw);
    if (comiruId !== null && !Number.isInteger(comiruId)) throw new HttpError(400, "comiru の講師IDは数字で入力してください");
    sets.push("comiru_teacher_id = ?");
    values.push(comiruId);
  }
  if (body.staff_memo !== undefined) {
    sets.push("staff_memo = ?");
    values.push(String(body.staff_memo).slice(0, 500));
  }
  if (!sets.length) throw new HttpError(400, "変更する項目がありません");

  sets.push("updated_at = ?");
  values.push(nowIso(), id);
  const result = await c.env.DB.prepare(`UPDATE teachers SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  if (!result.meta.changes) throw new HttpError(404, "講師が見つかりません");
  return c.json({ ok: true });
});

// 特定の講師の予定（閲覧用）
adminApi.get("/terms/:termId/teachers/:teacherId", async (c) => {
  const term = await getTerm(c.env.DB, Number(c.req.param("termId")));
  const teacherId = Number(c.req.param("teacherId"));
  const [slots, entry, changes] = await Promise.all([
    c.env.DB.prepare("SELECT date, period FROM teacher_availability WHERE term_id = ? AND teacher_id = ?")
      .bind(term.id, teacherId)
      .all<Slot>(),
    c.env.DB.prepare("SELECT note, submitted_at, updated_at FROM teacher_term_entries WHERE term_id = ? AND teacher_id = ?")
      .bind(term.id, teacherId)
      .first(),
    c.env.DB.prepare(
      "SELECT date, period, action, changed_at, seen FROM availability_changes WHERE term_id = ? AND teacher_id = ? ORDER BY id DESC LIMIT 200",
    )
      .bind(term.id, teacherId)
      .all(),
  ]);
  return c.json({
    term: termForClient(term),
    slots: slots.results.filter((s) => isSlotInTerm(term, s)),
    note: entry?.note ?? "",
    submitted_at: entry?.submitted_at ?? null,
    updated_at: entry?.updated_at ?? null,
    changes: changes.results,
  });
});

// ---------------------------------------------------------------- 予定の変更通知

adminApi.get("/terms/:termId/changes", async (c) => {
  const termId = Number(c.req.param("termId"));
  const { results } = await c.env.DB.prepare(
    `SELECT ch.id, ch.teacher_id, t.name AS teacher_name, ch.date, ch.period, ch.action, ch.changed_at, ch.seen
       FROM availability_changes ch JOIN teachers t ON t.id = ch.teacher_id
      WHERE ch.term_id = ?
      ORDER BY ch.seen, ch.id DESC
      LIMIT 300`,
  )
    .bind(termId)
    .all();
  return c.json(results);
});

adminApi.post("/terms/:termId/changes/seen", async (c) => {
  const termId = Number(c.req.param("termId"));
  const body = await c.req.json<{ teacher_id?: number }>().catch(() => ({}) as { teacher_id?: number });
  const stmt = body.teacher_id
    ? c.env.DB.prepare("UPDATE availability_changes SET seen = 1 WHERE term_id = ? AND teacher_id = ?").bind(termId, body.teacher_id)
    : c.env.DB.prepare("UPDATE availability_changes SET seen = 1 WHERE term_id = ?").bind(termId);
  await stmt.run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- 今のアプリ向け CSV

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function dateHeader(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `勤務可能予定 [${date.replace(/-/g, "/")}（${WEEKDAYS[d.getUTCDay()]}）]`;
}

// 今のアプリの「予定表ファイルを取り込む」でそのまま読める形式（Google フォームの講師用 CSV と同じ列構成）
adminApi.get("/terms/:termId/export/teachers.csv", async (c) => {
  const db = c.env.DB;
  const term = await getTerm(db, Number(c.req.param("termId")));
  const dates = datesBetween(term.start_date, term.end_date).filter((d) => !term.closed_dates.includes(d));

  const [teachers, slots] = await Promise.all([
    db
      .prepare(
        `SELECT t.id, t.name, e.note, e.updated_at,
                (SELECT group_concat(subject, ', ') FROM teacher_subjects s WHERE s.teacher_id = t.id) AS subjects
           FROM teachers t JOIN teacher_term_entries e ON e.teacher_id = t.id AND e.term_id = ?
          WHERE t.status = 'approved'
          ORDER BY t.name`,
      )
      .bind(term.id)
      .all<{ id: number; name: string; note: string; updated_at: string; subjects: string | null }>(),
    db
      .prepare("SELECT teacher_id, date, period FROM teacher_availability WHERE term_id = ? ORDER BY period")
      .bind(term.id)
      .all<Slot & { teacher_id: number }>(),
  ]);

  const byTeacher = new Map<number, Map<string, number[]>>();
  for (const s of slots.results) {
    if (!isSlotInTerm(term, s)) continue;
    const perDate = byTeacher.get(s.teacher_id) ?? new Map<string, number[]>();
    perDate.set(s.date, [...(perDate.get(s.date) ?? []), s.period]);
    byTeacher.set(s.teacher_id, perDate);
  }

  const header = ["タイムスタンプ", "講師名", "指導可能科目", ...dates.map(dateHeader), "備考"];
  const rows = teachers.results.map((t) => {
    const perDate = byTeacher.get(t.id) ?? new Map<string, number[]>();
    return [
      t.updated_at,
      t.name,
      t.subjects ?? "",
      ...dates.map((d) => (perDate.get(d) ?? []).map(periodLabel).join(", ")),
      t.note ?? "",
    ];
  });

  const csv = "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const filename = encodeURIComponent(`${term.name}_講師予定.csv`);
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
  });
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
