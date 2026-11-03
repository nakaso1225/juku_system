import type { Hono } from "hono";
import { HttpError } from "./terms";
import type { AppEnv } from "./types";

export function seatLabels(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    let n = i + 1;
    let label = "";
    while (n > 0) { n--; label = String.fromCharCode(65 + n % 26) + label; n = Math.floor(n / 26); }
    return label;
  });
}

export async function getTableIds(db: D1Database): Promise<string[]> {
  const row = await db.prepare("SELECT table_ids FROM room_settings WHERE id = 1").first<{ table_ids: string }>();
  return row ? JSON.parse(row.table_ids) : seatLabels(11);
}

export function registerSettingsRoutes(api: Hono<AppEnv>): void {
  api.get("/settings", async (c) => c.json({ table_ids: await getTableIds(c.env.DB) }));
  api.put("/settings", async (c) => {
    const count = Number((await c.req.json<{ table_count?: number }>()).table_count);
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new HttpError(400, "座席数は1〜100席で指定してください");
    const tableIds = seatLabels(count);
    const json = JSON.stringify(tableIds);
    const used = "SELECT DISTINCT table_id FROM assignments WHERE table_id NOT IN (SELECT value FROM json_each(?1))";
    const results = await c.env.DB.batch<Record<string, unknown>>([
      c.env.DB.prepare(used).bind(json),
      c.env.DB.prepare(`UPDATE room_settings SET table_ids = ?1 WHERE id = 1 AND NOT EXISTS (${used})`).bind(json),
      c.env.DB.prepare("UPDATE terms SET version = version + 1 WHERE changes() > 0"),
    ]);
    if (!results[1].meta.changes) {
      const labels = results[0].results.map((r) => String(r.table_id)).join("、");
      throw new HttpError(409, `席${labels}に授業が登録されています。先に割り当てを移してから減らしてください`);
    }
    return c.json({ table_ids: tableIds });
  });
}
