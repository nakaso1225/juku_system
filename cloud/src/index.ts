import { Hono } from "hono";
import { adminApi, isStaff } from "./admin";
import { auth } from "./auth";
import { ALL_PERIODS, periodLabel, SUBJECTS } from "./constants";
import { getTableIds } from "./settings";
import { GRADES } from "./roster";
import { readSession } from "./session";
import { findLinkRequest, isInactiveTeacher, resolveTeacher, teacherApi } from "./teacher";
import { HttpError } from "./terms";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof SyntaxError) return c.json({ error: "送信内容の形式が正しくありません" }, 400);
  console.error(err);
  return c.json({ error: "サーバーでエラーが発生しました" }, 500);
});

app.route("/auth", auth);

// /api 以下はログイン必須
app.use("/api/*", async (c, next) => {
  const user = await readSession(c);
  if (!user) return c.json({ error: "ログインしてください" }, 401);
  c.set("user", user);
  await next();
});

// ログイン中のアカウント・紐付いた講師（または申請中か）・事務かどうか
app.get("/api/me", async (c) => {
  const user = c.get("user");
  const [teacher, staff] = await Promise.all([resolveTeacher(c.env, user), isStaff(c.env, user.email)]);
  const inactive = teacher ? false : await isInactiveTeacher(c.env.DB, user.sub);
  const linkRequest = teacher || inactive ? null : await findLinkRequest(c.env.DB, user.sub);
  return c.json({ user, teacher, teacher_inactive: inactive, link_request: linkRequest, is_staff: staff });
});

app.get("/api/meta", async (c) =>
  c.json({
    subjects: SUBJECTS,
    periods: ALL_PERIODS,
    period_labels: Object.fromEntries(ALL_PERIODS.map((p) => [p, periodLabel(p)])),
    table_ids: await getTableIds(c.env.DB),
    grades: GRADES,
  }),
);

app.route("/api/teacher", teacherApi);
app.route("/api/admin", adminApi);

app.all("/api/*", (c) => c.json({ error: "見つかりません" }, 404));
app.all("/auth/*", (c) => c.notFound());

export default app;
