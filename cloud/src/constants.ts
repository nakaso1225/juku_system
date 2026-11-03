// 科目（今のアプリ database.py の SUBJECTS と同じ並び）
export const SUBJECTS = [
  "算数（受験除く）",
  "算数（受験含む）",
  "中学受験国語",
  "中学受験理科",
  "中学受験社会",
  "中学英語",
  "中学数学",
  "中学国語",
  "中学理科",
  "中学社会",
  "高校英語",
  "数学Ⅰ・A",
  "数学Ⅱ・B",
  "数学Ⅲ・C",
  "現代文",
  "古文",
  "漢文",
  "物理",
  "化学",
  "生物",
  "地学",
  "日本史",
  "世界史",
  "地理",
  "倫政",
  "公共",
  "情報",
] as const;

// 時限と時刻。comiru のコマ表示名は "[10:45 - 12:15] 2" の形
export const PERIOD_DEFS: Record<number, { start: string; end: string }> = {
  2: { start: "10:45", end: "12:15" },
  3: { start: "13:15", end: "14:45" },
  4: { start: "15:00", end: "16:30" },
  5: { start: "16:45", end: "18:15" },
  6: { start: "18:30", end: "20:00" },
  7: { start: "20:15", end: "21:45" },
};

export const ALL_PERIODS = Object.keys(PERIOD_DEFS).map(Number);

export function periodLabel(period: number): string {
  const def = PERIOD_DEFS[period];
  return def ? `${period}限（${def.start}-${def.end}）` : `${period}限`;
}
