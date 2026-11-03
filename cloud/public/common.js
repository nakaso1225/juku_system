// 講師ページ・管理画面で共通の小物

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `エラーが発生しました（${res.status}）`);
  return data;
}

let toastTimer = null;
export function toast(message, isError = false) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), isError ? 5000 : 2500);
}

export const DOW = ["日", "月", "火", "水", "木", "金", "土"];

export function dowOf(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/** "2026-12-22" → "12/22（火）" */
export function fmtDate(isoDate, withDow = true) {
  const [, m, d] = isoDate.split("-").map(Number);
  return withDow ? `${m}/${d}（${DOW[dowOf(isoDate)]}）` : `${m}/${d}`;
}

/** ISO 日時 → "11/3 14:20" */
export function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export function loginUrl(next) {
  return `/auth/login?next=${encodeURIComponent(next)}`;
}

/** ローカル開発時だけ表示する「Google を使わないログイン」 */
export function devLoginForm(next) {
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) return null;
  const input = el("input", { type: "email", placeholder: "テスト用メールアドレス" });
  return el(
    "div",
    { class: "dev-login card" },
    el("p", { class: "muted" }, "開発用ログイン（ローカルのみ）"),
    el(
      "div",
      { class: "row" },
      input,
      el(
        "button",
        {
          type: "button",
          onclick: () => {
            if (input.value) location.href = `/auth/dev-login?email=${encodeURIComponent(input.value)}&next=${encodeURIComponent(next)}`;
          },
        },
        "ログイン",
      ),
    ),
  );
}

export async function logout() {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  location.reload();
}
