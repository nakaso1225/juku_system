// 講師・生徒で共通の「来られるコマ」の保存と、今のアプリ（Flask 版）向け CSV の組み立て
import { periodLabel } from "./constants";
import { datesBetween, isSlotInTerm, type Slot } from "./terms";
import type { Term } from "./types";

type Owner = { table: "teacher_availability"; column: "teacher_id" } | { table: "student_availability"; column: "student_id" };

export const TEACHER_SLOTS: Owner = { table: "teacher_availability", column: "teacher_id" };
export const STUDENT_SLOTS: Owner = { table: "student_availability", column: "student_id" };

export async function readSlots(db: D1Database, owner: Owner, termId: number, ownerId: number): Promise<Slot[]> {
  const { results } = await db
    .prepare(`SELECT date, period FROM ${owner.table} WHERE term_id = ? AND ${owner.column} = ? ORDER BY date, period`)
    .bind(termId, ownerId)
    .all<Slot>();
  return results;
}

/**
 * 保存するコマ一覧に置き換えるための SQL を作る。
 * 全部消して入れ直すと無料枠の「1日の書き込み行数」を無駄に使うので、増えた・減ったコマだけを書き込む。
 */
export async function replaceSlotsStatements(
  db: D1Database,
  owner: Owner,
  termId: number,
  ownerId: number,
  slots: Slot[],
): Promise<D1PreparedStatement[]> {
  const existing = await readSlots(db, owner, termId, ownerId);
  const key = (s: Slot) => `${s.date}#${s.period}`;
  const before = new Set(existing.map(key));
  const after = new Set(slots.map(key));
  const added = slots.filter((s) => !before.has(key(s)));
  const removed = existing.filter((s) => !after.has(key(s)));

  const statements: D1PreparedStatement[] = [];
  if (removed.length) {
    statements.push(
      db
        .prepare(
          `DELETE FROM ${owner.table}
            WHERE term_id = ?1 AND ${owner.column} = ?2
              AND EXISTS (SELECT 1 FROM json_each(?3) j
                           WHERE json_extract(j.value, '$.date') = ${owner.table}.date
                             AND json_extract(j.value, '$.period') = ${owner.table}.period)`,
        )
        .bind(termId, ownerId, JSON.stringify(removed)),
    );
  }
  if (added.length) {
    statements.push(
      db
        .prepare(
          `INSERT INTO ${owner.table} (term_id, ${owner.column}, date, period)
           SELECT ?, ?, json_extract(value, '$.date'), json_extract(value, '$.period') FROM json_each(?)`,
        )
        .bind(termId, ownerId, JSON.stringify(added)),
    );
  }
  return statements;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface CsvPerson {
  id: number;
  name: string;
  subjects: string;
  note: string;
  updated_at: string;
}

/**
 * 今のアプリの「予定表ファイルを取り込む」でそのまま読める CSV（Google フォームの回答と同じ列構成）。
 * 講師は「講師名・指導可能科目・勤務可能予定」、生徒は「氏名・受講科目・受講可能予定」の見出しで、今のアプリが種類を判別する。
 */
export function scheduleCsv(
  kind: "teacher" | "student",
  term: Term,
  people: CsvPerson[],
  slots: (Slot & { owner_id: number })[],
): string {
  const labels =
    kind === "teacher"
      ? { name: "講師名", subjects: "指導可能科目", schedule: "勤務可能予定" }
      : { name: "氏名", subjects: "受講科目", schedule: "受講可能予定" };
  const dates = datesBetween(term.start_date, term.end_date).filter((d) => !term.closed_dates.includes(d));

  const byOwner = new Map<number, Map<string, number[]>>();
  for (const s of slots) {
    if (!isSlotInTerm(term, s)) continue;
    const perDate = byOwner.get(s.owner_id) ?? new Map<string, number[]>();
    perDate.set(s.date, [...(perDate.get(s.date) ?? []), s.period].sort((a, b) => a - b));
    byOwner.set(s.owner_id, perDate);
  }

  const dateHeader = (date: string) => {
    const dow = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
    return `${labels.schedule} [${date.replace(/-/g, "/")}（${dow}）]`;
  };
  const header = ["タイムスタンプ", labels.name, labels.subjects, ...dates.map(dateHeader), "備考"];
  const rows = people.map((p) => {
    const perDate = byOwner.get(p.id) ?? new Map<string, number[]>();
    return [p.updated_at, p.name, p.subjects, ...dates.map((d) => (perDate.get(d) ?? []).map(periodLabel).join(", ")), p.note];
  });
  return "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function csvResponseHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  };
}
