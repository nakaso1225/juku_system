import { HttpError } from "./terms";

export const GRADES = [
  "小1", "小2", "小3", "小4", "小5", "小6",
  "中1", "中2", "中3", "高1", "高2", "高3", "その他",
] as const;

const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

export function nameKanaFrom(row: Record<string, unknown>): string {
  return text(row.name_kana) || text(row.kana) || text(row.furigana) || text(row.name_reading)
    || [text(row.last_name_kana), text(row.first_name_kana)].filter(Boolean).join(" ");
}

/**
 * comiru の学年コード（公式仕様）→ この画面の学年。
 * 4〜9＝小1〜小6、10〜12＝中1〜中3、13〜15＝高1〜高3。0＝不明・未定は空欄。それ以外（未就学・大学生・社会人・既卒など）は「その他」
 */
export function gradeFromCode(code: number): string {
  if (code >= 4 && code <= 9) return `小${code - 3}`;
  if (code >= 10 && code <= 12) return `中${code - 9}`;
  if (code >= 13 && code <= 15) return `高${code - 12}`;
  if (code === 0) return "";
  return "その他";
}

export function normalizeGrade(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) return gradeFromCode(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return gradeFromCode(Number(value.trim()));
  const raw = typeof value === "object" && value !== null ? text((value as Record<string, unknown>).name) : text(value);
  const normalized = raw.normalize("NFKC").replace(/\s+/g, "");
  const match = normalized.match(/^(小学校|小学生|小学|小|中学校|中学生|中学|中|高等学校|高校生|高校|高)([1-6])(?:年生|年)?$/);
  if (!match) return normalized === "その他" ? "その他" : raw;
  const school = match[1][0];
  if (school !== "小" && Number(match[2]) > 3) return raw;
  return `${school}${match[2]}`;
}

export function gradeFrom(row: Record<string, unknown>): string {
  // comiru の公式形式は grade が数値コード。名前で来る形式にも対応しておく
  return normalizeGrade(row.grade) || normalizeGrade(row.grade_name) || normalizeGrade(row.school_grade);
}

type Person = Record<string, unknown>;
export function compareNames(a: Person, b: Person): number {
  const key = (p: Person) => (text(p.name_kana) || text(p.name)).normalize("NFKC").replace(/\s+/g, "");
  return collator.compare(key(a), key(b)) || collator.compare(text(a.name), text(b.name))
    || Number(a.id ?? a.teacher_id ?? 0) - Number(b.id ?? b.teacher_id ?? 0);
}

export function compareStudents(a: Person, b: Person): number {
  const rank = (p: Person) => {
    const i = (GRADES as readonly string[]).indexOf(normalizeGrade(p.grade));
    return i < 0 ? GRADES.length : i;
  };
  return rank(a) - rank(b) || compareNames(a, b);
}

export const PERSON_KANA_SQL = (alias: string) => `COALESCE(NULLIF(${alias}.name_kana_override, ''), ${alias}.name_kana) AS name_kana`;
export const STUDENT_GRADE_SQL = (alias: string) => `COALESCE(${alias}.grade_override, ${alias}.grade) AS grade`;

export function parseKana(raw: unknown): string | null {
  const kana = text(raw).normalize("NFKC");
  if (kana.length > 100 || (kana && !/^[\p{Script=Hiragana}\p{Script=Katakana}ー・\s]+$/u.test(kana))) {
    throw new HttpError(400, "ふりがなは、ひらがな・カタカナで入力してください（100文字以内）");
  }
  return kana || null;
}
