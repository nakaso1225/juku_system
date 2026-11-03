// 署名付き Cookie によるセッション（DB に保存しないので無料枠の書き込みを使わない）
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, SessionUser } from "./types";

const SESSION_COOKIE = "juku_session";
const SESSION_DAYS = 30;

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET が未設定か短すぎます（16文字以上）");
  }
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signValue(secret: string, payload: unknown): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(sig))}`;
}

export async function verifyValue<T>(secret: string, token: string | undefined): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromBase64url(sig), encoder.encode(body));
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(fromBase64url(body))) as T;
  } catch {
    return null;
  }
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("invalid id_token");
  return JSON.parse(new TextDecoder().decode(fromBase64url(part)));
}

export function randomToken(bytes = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function isSecure(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === "https:";
}

export async function startSession(c: Context<AppEnv>, user: SessionUser): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 24 * 3600;
  const token = await signValue(c.env.SESSION_SECRET, { ...user, exp });
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

export async function readSession(c: Context<AppEnv>): Promise<SessionUser | null> {
  const data = await verifyValue<SessionUser & { exp: number }>(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE));
  if (!data || data.exp < Date.now() / 1000) return null;
  return { sub: data.sub, email: data.email, name: data.name };
}

export function endSession(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function setShortCookie(c: Context<AppEnv>, name: string, value: string): void {
  setCookie(c, name, value, { path: "/auth", httpOnly: true, secure: isSecure(c), sameSite: "Lax", maxAge: 600 });
}
