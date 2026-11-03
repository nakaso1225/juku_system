// 「Googleでログイン」（OpenID Connect の認可コードフロー）
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { decodeJwtPayload, endSession, randomToken, setShortCookie, signValue, startSession, verifyValue } from "./session";
import type { AppEnv } from "./types";

const STATE_COOKIE = "juku_oauth";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

/** ログイン後の戻り先は同じサイト内のパスだけ許可する */
function safeNext(next: string | undefined): string {
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/";
}

/** 貼り付け時に混ざった前後の空白・改行を除いた Google の設定値 */
function googleConfig(env: AppEnv["Bindings"]) {
  return {
    clientId: (env.GOOGLE_CLIENT_ID || "").trim(),
    clientSecret: (env.GOOGLE_CLIENT_SECRET || "").trim(),
  };
}

function callbackUrl(requestUrl: string): string {
  return new URL("/auth/callback", requestUrl).toString();
}

export const auth = new Hono<AppEnv>();

auth.get("/login", async (c) => {
  const { clientId } = googleConfig(c.env);
  if (!clientId) {
    return c.text("GOOGLE_CLIENT_ID が設定されていません", 500);
  }
  const state = randomToken();
  const next = safeNext(c.req.query("next"));
  setShortCookie(c, STATE_COOKIE, await signValue(c.env.SESSION_SECRET, { state, next }));

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", callbackUrl(c.req.url));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString());
});

auth.get("/callback", async (c) => {
  const saved = await verifyValue<{ state: string; next: string }>(c.env.SESSION_SECRET, getCookie(c, STATE_COOKIE));
  deleteCookie(c, STATE_COOKIE, { path: "/auth" });

  const code = c.req.query("code");
  if (c.req.query("error")) {
    return c.text(`Google でのログインが中断されました（${c.req.query("error")}）。もう一度お試しください。`, 400);
  }
  if (!saved || !code || c.req.query("state") !== saved.state) {
    // 戻るボタンや再読み込みで同じ画面を開き直したときもここに来る
    return c.html(
      '<p>ログインの有効期限が切れました。<a href="/">最初の画面</a>からもう一度ログインしてください。</p>',
      400,
    );
  }
  const { clientId, clientSecret } = googleConfig(c.env);

  // 認可コードを Google のトークン窓口で直接交換する。
  // サーバー間の TLS 通信で受け取った id_token なので、署名検証の代わりに TLS で発行元を確認できる（OIDC Core 3.1.3.7）
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl(c.req.url),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    // Google の応答は error と error_description だけで、秘密の値は含まれない
    const detail = (await tokenRes.json().catch(() => ({}))) as { error?: string; error_description?: string };
    console.error("google token exchange failed", tokenRes.status, detail.error, detail.error_description, {
      // 値そのものは出さず、設定ミスの見当をつけるための形だけを記録する
      secret_length: clientSecret.length,
      secret_has_google_prefix: clientSecret.startsWith("GOCSPX-"),
      secret_equals_client_id: clientSecret === clientId,
      client_id_suffix_ok: clientId.endsWith(".apps.googleusercontent.com"),
    });
    return c.text(`Google での確認に失敗しました（${detail.error ?? tokenRes.status}）。もう一度お試しください。`, 400);
  }
  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  if (!id_token) return c.text("Google から本人情報を受け取れませんでした。", 400);

  const claims = decodeJwtPayload(id_token);
  const valid =
    GOOGLE_ISSUERS.has(String(claims.iss)) &&
    claims.aud === clientId &&
    Number(claims.exp) > Date.now() / 1000 &&
    claims.email_verified === true &&
    typeof claims.sub === "string" &&
    typeof claims.email === "string";
  if (!valid) {
    console.error("id_token rejected", { iss: claims.iss, aud_ok: claims.aud === clientId, email_verified: claims.email_verified });
    return c.text("Google アカウントを確認できませんでした。", 400);
  }

  await startSession(c, {
    sub: claims.sub as string,
    email: (claims.email as string).toLowerCase(),
    name: typeof claims.name === "string" ? claims.name : "",
  });
  return c.redirect(saved.next);
});

auth.post("/logout", (c) => {
  endSession(c);
  return c.json({ ok: true });
});

// ローカル開発専用：Google を通さずにログインする（DEV_LOGIN=1 かつ localhost のときだけ動く）
auth.get("/dev-login", async (c) => {
  const host = new URL(c.req.url).hostname;
  if (c.env.DEV_LOGIN !== "1" || !["localhost", "127.0.0.1"].includes(host)) {
    return c.notFound();
  }
  const email = (c.req.query("email") || "").trim().toLowerCase();
  if (!email) return c.text("email を指定してください", 400);
  await startSession(c, { sub: `dev:${email}`, email, name: c.req.query("name") || "" });
  return c.redirect(safeNext(c.req.query("next")));
});
