import { ALL_PERIODS, PERIOD_DEFS, periodLabel } from "./constants";
import type { Term } from "./types";

export class HttpError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface Slot {
  date: string;
  period: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isValidDate(text: unknown): text is string {
  if (typeof text !== "string" || !DATE_RE.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(text);
}

/** 開始日〜終了日の全日付（YYYY-MM-DD） */
export function datesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function rowToTerm(row: Record<string, unknown>): Term {
  return {
    id: Number(row.id),
    name: String(row.name),
    start_date: String(row.start_date),
    end_date: String(row.end_date),
    periods: JSON.parse(String(row.periods)),
    closed_dates: JSON.parse(String(row.closed_dates)),
    accepting: Boolean(row.accepting),
  };
}

/** 画面表示用：講習の情報にカレンダーの日付と時限ラベルを足したもの */
export function termForClient(term: Term) {
  return {
    ...term,
    dates: datesBetween(term.start_date, term.end_date),
    period_labels: Object.fromEntries(term.periods.map((p) => [p, periodLabel(p)])),
    period_times: Object.fromEntries(term.periods.map((p) => [p, PERIOD_DEFS[p]])),
  };
}

export async function getTerm(db: D1Database, termId: number): Promise<Term> {
  const row = await db.prepare("SELECT * FROM terms WHERE id = ?").bind(termId).first();
  if (!row) throw new HttpError(404, "講習が見つかりません");
  return rowToTerm(row);
}

/** 講習の期間内・休校日以外・設定された時限のコマかどうか */
export function isSlotInTerm(term: Term, slot: Slot): boolean {
  return (
    slot.date >= term.start_date &&
    slot.date <= term.end_date &&
    !term.closed_dates.includes(slot.date) &&
    term.periods.includes(slot.period)
  );
}

/** クライアントから来たコマ一覧を検証し、重複を除いて返す */
export function parseSlots(term: Term, raw: unknown): Slot[] {
  if (!Array.isArray(raw)) throw new HttpError(400, "slots は配列で指定してください");
  const seen = new Set<string>();
  const slots: Slot[] = [];
  for (const item of raw) {
    const date = (item as Slot)?.date;
    const period = Number((item as Slot)?.period);
    if (!isValidDate(date) || !Number.isInteger(period)) {
      throw new HttpError(400, "コマの形式が正しくありません");
    }
    const slot = { date, period };
    if (!isSlotInTerm(term, slot)) {
      throw new HttpError(400, `${date} ${period}限 は講習の対象外です`);
    }
    const key = `${date}#${period}`;
    if (!seen.has(key)) {
      seen.add(key);
      slots.push(slot);
    }
  }
  return slots;
}

/** 管理画面から来た講習の設定を検証する */
export function parseTermInput(body: Record<string, unknown>): Omit<Term, "id"> {
  const name = String(body.name ?? "").trim();
  const start = body.start_date;
  const end = body.end_date;
  if (!name) throw new HttpError(400, "講習名を入力してください");
  if (!isValidDate(start) || !isValidDate(end)) throw new HttpError(400, "開始日・終了日を正しく入力してください");
  if (start > end) throw new HttpError(400, "終了日は開始日以降にしてください");
  if (datesBetween(start, end).length > 120) throw new HttpError(400, "期間は120日以内にしてください");

  const periods = Array.isArray(body.periods) ? body.periods.map(Number) : [];
  if (!periods.length || periods.some((p) => !ALL_PERIODS.includes(p))) {
    throw new HttpError(400, "時限を1つ以上選んでください");
  }

  const closedRaw = Array.isArray(body.closed_dates) ? body.closed_dates : [];
  const closed = [...new Set(closedRaw.map(String))].sort();
  if (closed.some((d) => !isValidDate(d) || d < start || d > end)) {
    throw new HttpError(400, "休校日は期間内の日付にしてください");
  }

  return {
    name,
    start_date: start,
    end_date: end,
    periods: [...new Set(periods)].sort((a, b) => a - b),
    closed_dates: closed,
    accepting: body.accepting === undefined ? true : Boolean(body.accepting),
  };
}
