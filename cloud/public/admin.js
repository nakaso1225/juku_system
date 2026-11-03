// 管理画面（事務）：講習の設定・講師の承認と提出状況・予定の変更通知・事務アカウント
import { renderCalendar, slotKey } from "./calendar.js";
import { api, ApiError, devLoginForm, el, fmtDate, fmtDateTime, loginUrl, logout, toast } from "./common.js";

const app = document.getElementById("app");
const TERM_KEY = "juku-admin-term";

const state = {
  me: null,
  meta: null,
  terms: [],
  termId: null,
  tab: "teachers",
  onlyUnsubmitted: false,
};

function currentTerm() {
  return state.terms.find((t) => t.id === state.termId) || null;
}

function rememberTerm(id) {
  state.termId = id;
  try {
    localStorage.setItem(TERM_KEY, String(id));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

function recalledTerm() {
  try {
    return Number(localStorage.getItem(TERM_KEY)) || null;
  } catch {
    return null;
  }
}

async function loadTerms() {
  state.terms = await api("/api/admin/terms");
  const wanted = state.termId ?? recalledTerm();
  const exists = state.terms.some((t) => t.id === wanted);
  state.termId = exists ? wanted : state.terms[0]?.id ?? null;
}

// ------------------------------------------------------------ 枠組み

function header() {
  const termSelect = el(
    "select",
    {
      style: "width:auto;min-width:200px",
      onchange: (e) => {
        rememberTerm(Number(e.target.value));
        render();
      },
    },
    state.terms.map((t) =>
      el("option", { value: t.id, selected: t.id === state.termId }, `${t.name}（${fmtDate(t.start_date, false)}〜${fmtDate(t.end_date, false)}）`),
    ),
  );
  return el(
    "div",
    {},
    el(
      "div",
      { class: "topbar" },
      el("h1", {}, "講習管理"),
      el(
        "div",
        { class: "who" },
        el("div", {}, state.me.user.email),
        el(
          "div",
          { class: "row", style: "justify-content:flex-end" },
          el("a", { class: "btn-link", href: "/" }, "講師ページ"),
          el("button", { type: "button", class: "btn-link", onclick: logout }, "ログアウト"),
        ),
      ),
    ),
    el(
      "div",
      { class: "row", style: "margin-bottom:12px" },
      state.terms.length ? termSelect : el("span", { class: "muted" }, "講習がまだありません"),
      el(
        "button",
        {
          type: "button",
          onclick: () => {
            state.tab = "new-term";
            render();
          },
        },
        "＋ 新しい講習を作る",
      ),
    ),
  );
}

function tabs() {
  const items = [
    ["teachers", "講師"],
    ["changes", "予定の変更"],
    ["term", "講習の設定"],
    ["staff", "事務アカウント"],
  ];
  return el(
    "div",
    { class: "tabs" },
    items.map(([key, label]) =>
      el(
        "button",
        {
          type: "button",
          class: `tab${state.tab === key ? " active" : ""}`,
          onclick: () => {
            state.tab = key;
            render();
          },
        },
        label,
      ),
    ),
  );
}

async function render() {
  const body = el("div", {}, el("p", { class: "muted" }, "読み込み中…"));
  app.replaceChildren(header(), tabs(), body);
  try {
    if (state.tab === "new-term" || (!currentTerm() && ["teachers", "changes", "term"].includes(state.tab))) {
      body.replaceChildren(termForm(null));
    } else if (state.tab === "teachers") {
      body.replaceChildren(await teachersView());
    } else if (state.tab === "changes") {
      body.replaceChildren(await changesView());
    } else if (state.tab === "term") {
      body.replaceChildren(termForm(currentTerm()));
    } else if (state.tab === "staff") {
      body.replaceChildren(await staffView());
    }
  } catch (err) {
    body.replaceChildren(el("div", { class: "notice danger" }, err.message));
  }
}

// ------------------------------------------------------------ 講師タブ

async function setTeacher(id, patch, message) {
  try {
    await api(`/api/admin/teachers/${id}`, { method: "PATCH", body: patch });
    if (message) toast(message);
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

async function teachersView() {
  const term = currentTerm();
  const teachers = await api(`/api/admin/teachers?term_id=${term.id}`);
  const pending = teachers.filter((t) => t.status === "pending");
  const approved = teachers.filter((t) => t.status === "approved");
  const rejected = teachers.filter((t) => t.status === "rejected");
  const submitted = approved.filter((t) => t.submitted_at);

  const wrap = el("div");

  if (pending.length) {
    wrap.append(
      el(
        "div",
        { class: "card" },
        el("h2", {}, `承認待ち（${pending.length}人）`),
        el("p", { class: "muted" }, "講師ページから新しく登録した人です。本人か確認して承認してください。"),
        el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            { class: "list" },
            el("thead", {}, el("tr", {}, ["氏名", "メール", "科目", "登録日時", ""].map((h) => el("th", {}, h)))),
            el(
              "tbody",
              {},
              pending.map((t) =>
                el(
                  "tr",
                  {},
                  el("td", {}, t.name),
                  el("td", {}, t.email),
                  el("td", {}, t.subjects || ""),
                  el("td", {}, fmtDateTime(t.created_at)),
                  el(
                    "td",
                    {},
                    el(
                      "div",
                      { class: "row" },
                      el(
                        "button",
                        {
                          type: "button",
                          class: "btn-primary btn-small",
                          onclick: async () => (await setTeacher(t.id, { status: "approved" }, `${t.name} さんを承認しました`)) && render(),
                        },
                        "承認",
                      ),
                      el(
                        "button",
                        {
                          type: "button",
                          class: "btn-danger btn-small",
                          onclick: async () => {
                            if (!confirm(`${t.name}（${t.email}）を却下しますか？`)) return;
                            if (await setTeacher(t.id, { status: "rejected" }, "却下しました")) render();
                          },
                        },
                        "却下",
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  const visible = state.onlyUnsubmitted ? approved.filter((t) => !t.submitted_at) : approved;
  const filterToggle = el("label", { class: "row", style: "gap:6px;font-size:0.9rem" }, el("input", { type: "checkbox", checked: state.onlyUnsubmitted }), "未提出の人だけ表示");
  filterToggle.querySelector("input").addEventListener("change", (e) => {
    state.onlyUnsubmitted = e.target.checked;
    render();
  });

  wrap.append(
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "row", style: "justify-content:space-between;margin-bottom:8px" },
        el("h2", { style: "margin:0" }, `講師（提出 ${submitted.length} / ${approved.length}人）`),
        el(
          "div",
          { class: "row" },
          filterToggle,
          el(
            "a",
            { class: "btn btn-small", href: `/api/admin/terms/${term.id}/export/teachers.csv` },
            "今のアプリ用CSVをダウンロード",
          ),
        ),
      ),
      el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          { class: "list" },
          el(
            "thead",
            {},
            el("tr", {}, ["氏名", "科目", "提出", "最終更新", "コマ数", "変更", "comiru講師ID", ""].map((h) => el("th", {}, h))),
          ),
          el(
            "tbody",
            {},
            visible.length
              ? visible.map((t) => teacherRow(t, term))
              : el("tr", {}, el("td", { colspan: "8", class: "muted" }, "該当する講師はいません")),
          ),
        ),
      ),
    ),
  );

  if (rejected.length) {
    wrap.append(
      el(
        "details",
        { class: "card" },
        el("summary", {}, `却下した登録（${rejected.length}件）`),
        el(
          "ul",
          { class: "change-list" },
          rejected.map((t) =>
            el(
              "li",
              {},
              `${t.name}（${t.email}）`,
              el(
                "button",
                {
                  type: "button",
                  class: "btn-small",
                  onclick: async () => (await setTeacher(t.id, { status: "pending" }, "承認待ちに戻しました")) && render(),
                },
                "承認待ちに戻す",
              ),
            ),
          ),
        ),
      ),
    );
  }
  return wrap;
}

function teacherRow(t, term) {
  const comiruInput = el("input", { type: "number", value: t.comiru_teacher_id ?? "", placeholder: "未設定", style: "width:110px" });
  comiruInput.addEventListener("change", () =>
    setTeacher(t.id, { comiru_teacher_id: comiruInput.value }, `${t.name} さんの comiru 講師IDを保存しました`),
  );
  return el(
    "tr",
    {},
    el("td", {}, t.name),
    el("td", { style: "max-width:220px" }, el("span", { class: "muted" }, t.subjects || "")),
    el("td", {}, t.submitted_at ? el("span", { class: "badge ok" }, "提出済み") : el("span", { class: "badge warn" }, "未提出")),
    el("td", {}, fmtDateTime(t.updated_at)),
    el("td", { class: "num" }, t.submitted_at ? t.slot_count : ""),
    el("td", {}, t.unseen_changes ? el("span", { class: "badge danger" }, `未確認 ${t.unseen_changes}`) : ""),
    el("td", {}, comiruInput),
    el("td", {}, el("button", { type: "button", class: "btn-small", onclick: () => openTeacherModal(t, term) }, "予定を見る")),
  );
}

function changeText(ch) {
  return `${fmtDate(ch.date)} ${ch.period}限：${ch.action === "add" ? "× → ○（来られるようになった）" : "○ → ×（来られなくなった）"}`;
}

async function openTeacherModal(t, term) {
  const data = await api(`/api/admin/terms/${term.id}/teachers/${t.id}`);
  const selected = new Set(data.slots.map((s) => slotKey(s.date, s.period)));
  const unseen = data.changes.filter((c) => !c.seen);
  const highlight = new Set(unseen.filter((c) => c.action === "add").map((c) => slotKey(c.date, c.period)));
  const calendarRoot = el("div");

  const close = () => backdrop.remove();
  const backdrop = el(
    "div",
    { class: "modal-backdrop", onclick: (e) => e.target === backdrop && close() },
    el(
      "div",
      { class: "modal" },
      el(
        "div",
        { class: "modal-head" },
        el("h2", { style: "margin:0" }, `${t.name} さんの予定`),
        el("button", { type: "button", onclick: close }, "閉じる"),
      ),
      el(
        "p",
        { class: "muted" },
        data.updated_at ? `最終更新 ${fmtDateTime(data.updated_at)}・${selected.size}コマ` : "まだ提出していません",
      ),
      data.note ? el("div", { class: "notice info" }, `備考：${data.note}`) : null,
      unseen.length
        ? el(
            "div",
            { class: "card" },
            el("h3", {}, `未確認の変更（${unseen.length}件）`),
            el("ul", { class: "change-list" }, unseen.map((c) => el("li", {}, changeText(c), el("span", { class: "muted" }, fmtDateTime(c.changed_at))))),
            el(
              "button",
              {
                type: "button",
                class: "btn-primary btn-small",
                style: "margin-top:8px",
                onclick: async () => {
                  await api(`/api/admin/terms/${term.id}/changes/seen`, { method: "POST", body: { teacher_id: t.id } });
                  toast("確認済みにしました");
                  close();
                  render();
                },
              },
              "確認済みにする",
            ),
          )
        : null,
      calendarRoot,
    ),
  );
  document.body.append(backdrop);
  renderCalendar(calendarRoot, data.term, selected, { editable: false, highlight });
}

// ------------------------------------------------------------ 予定の変更タブ

async function changesView() {
  const term = currentTerm();
  const changes = await api(`/api/admin/terms/${term.id}/changes`);
  const unseen = changes.filter((c) => !c.seen);
  const seen = changes.filter((c) => c.seen);

  const group = (list) => {
    const byTeacher = new Map();
    for (const c of list) byTeacher.set(c.teacher_name, [...(byTeacher.get(c.teacher_name) || []), c]);
    return [...byTeacher.entries()].map(([name, items]) =>
      el(
        "div",
        { style: "margin-bottom:12px" },
        el("h3", {}, name),
        el(
          "ul",
          { class: "change-list" },
          items.map((c) =>
            el(
              "li",
              {},
              el("span", { class: `badge ${c.action === "add" ? "ok" : "danger"}` }, c.action === "add" ? "追加" : "取消"),
              changeText(c),
              el("span", { class: "muted" }, fmtDateTime(c.changed_at)),
            ),
          ),
        ),
      ),
    );
  };

  return el(
    "div",
    {},
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "row", style: "justify-content:space-between;margin-bottom:8px" },
        el("h2", { style: "margin:0" }, `未確認の変更（${unseen.length}件）`),
        unseen.length
          ? el(
              "button",
              {
                type: "button",
                class: "btn-primary btn-small",
                onclick: async () => {
                  await api(`/api/admin/terms/${term.id}/changes/seen`, { method: "POST", body: {} });
                  toast("すべて確認済みにしました");
                  render();
                },
              },
              "すべて確認済みにする",
            )
          : null,
      ),
      el("p", { class: "muted" }, "講師が一度提出したあとに予定を直すと、ここに表示されます。"),
      unseen.length ? group(unseen) : el("p", {}, "新しい変更はありません。"),
    ),
    seen.length ? el("details", { class: "card" }, el("summary", {}, `確認済み（最近の${seen.length}件）`), group(seen)) : null,
  );
}

// ------------------------------------------------------------ 講習の設定タブ

function datesBetween(start, end) {
  const out = [];
  if (!start || !end || start > end) return out;
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last && out.length < 200) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function termForm(term) {
  const isNew = !term;
  const values = term
    ? { ...term, closed_dates: new Set(term.closed_dates), periods: new Set(term.periods) }
    : { name: "", start_date: "", end_date: "", periods: new Set([2, 3, 4, 5, 6]), closed_dates: new Set(), accepting: true };

  const name = el("input", { type: "text", value: values.name, placeholder: "例：2026年冬期講習" });
  const start = el("input", { type: "date", value: values.start_date });
  const end = el("input", { type: "date", value: values.end_date });
  const accepting = el("input", { type: "checkbox", checked: values.accepting });

  const periodChips = el(
    "div",
    { class: "chips" },
    state.meta.periods.map((p) => {
      const chip = el("button", { type: "button", class: `chip${values.periods.has(p) ? " on" : ""}` }, state.meta.period_labels[p]);
      chip.addEventListener("click", () => {
        if (values.periods.has(p)) values.periods.delete(p);
        else values.periods.add(p);
        chip.classList.toggle("on", values.periods.has(p));
      });
      return chip;
    }),
  );

  const closedBox = el("div", { class: "date-chips" });
  const drawClosed = () => {
    const dates = datesBetween(start.value, end.value);
    for (const d of [...values.closed_dates]) if (!dates.includes(d)) values.closed_dates.delete(d);
    closedBox.replaceChildren(
      ...(dates.length
        ? dates.map((d) => {
            const chip = el("button", { type: "button", class: `chip${values.closed_dates.has(d) ? " on" : ""}` }, fmtDate(d));
            chip.addEventListener("click", () => {
              if (values.closed_dates.has(d)) values.closed_dates.delete(d);
              else values.closed_dates.add(d);
              chip.classList.toggle("on", values.closed_dates.has(d));
            });
            return chip;
          })
        : [el("span", { class: "muted" }, "開始日と終了日を入れると、ここに日付が並びます")]),
    );
  };
  start.addEventListener("change", drawClosed);
  end.addEventListener("change", drawClosed);
  drawClosed();

  const submit = el("button", { type: "submit", class: "btn-primary" }, isNew ? "講習を作る" : "保存する");

  return el(
    "form",
    {
      class: "card",
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        const body = {
          name: name.value,
          start_date: start.value,
          end_date: end.value,
          periods: [...values.periods],
          closed_dates: [...values.closed_dates],
          accepting: accepting.checked,
        };
        try {
          const saved = isNew
            ? await api("/api/admin/terms", { method: "POST", body })
            : await api(`/api/admin/terms/${term.id}`, { method: "PUT", body });
          toast(isNew ? "講習を作りました" : "保存しました");
          rememberTerm(saved.id);
          await loadTerms();
          state.tab = isNew ? "teachers" : "term";
          render();
        } catch (err) {
          toast(err.message, true);
        } finally {
          submit.disabled = false;
        }
      },
    },
    el("h2", {}, isNew ? "新しい講習を作る" : "講習の設定"),
    el("label", { class: "field" }, el("span", {}, "講習名"), name),
    el(
      "div",
      { class: "row", style: "align-items:flex-start" },
      el("label", { class: "field", style: "flex:1;min-width:160px" }, el("span", {}, "開始日"), start),
      el("label", { class: "field", style: "flex:1;min-width:160px" }, el("span", {}, "終了日"), end),
    ),
    el("div", { class: "field" }, el("span", { style: "display:block;font-weight:600;margin-bottom:6px" }, "時限"), periodChips),
    el(
      "div",
      { class: "field" },
      el("span", { style: "display:block;font-weight:600;margin-bottom:6px" }, "休校日（押すと休校になります）"),
      closedBox,
    ),
    el("label", { class: "row field", style: "gap:8px" }, accepting, "講師の予定入力を受け付ける"),
    el("div", { class: "row" }, submit),
  );
}

// ------------------------------------------------------------ 事務アカウントタブ

async function staffView() {
  const { staff, env_admins } = await api("/api/admin/staff");
  const email = el("input", { type: "email", placeholder: "Googleアカウントのメールアドレス" });
  const name = el("input", { type: "text", placeholder: "名前（任意）" });

  return el(
    "div",
    { class: "card" },
    el("h2", {}, "事務アカウント"),
    el("p", { class: "muted" }, "ここに登録した Google アカウントで管理画面に入れます。"),
    el(
      "ul",
      { class: "change-list" },
      env_admins.map((e) => el("li", {}, e, el("span", { class: "badge" }, "初期設定の管理者"))),
      staff.map((s) =>
        el(
          "li",
          {},
          `${s.email}${s.name ? `（${s.name}）` : ""}`,
          el(
            "button",
            {
              type: "button",
              class: "btn-danger btn-small",
              onclick: async () => {
                if (!confirm(`${s.email} を事務アカウントから外しますか？`)) return;
                try {
                  await api(`/api/admin/staff/${encodeURIComponent(s.email)}`, { method: "DELETE" });
                  render();
                } catch (err) {
                  toast(err.message, true);
                }
              },
            },
            "外す",
          ),
        ),
      ),
    ),
    el(
      "form",
      {
        style: "margin-top:16px",
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api("/api/admin/staff", { method: "POST", body: { email: email.value, name: name.value } });
            toast("追加しました");
            render();
          } catch (err) {
            toast(err.message, true);
          }
        },
      },
      el("h3", {}, "事務アカウントを追加"),
      el("div", { class: "row" }, el("div", { style: "flex:2;min-width:220px" }, email), el("div", { style: "flex:1;min-width:140px" }, name), el("button", { type: "submit" }, "追加")),
    ),
  );
}

// ------------------------------------------------------------ 起動

async function start() {
  try {
    state.me = await api("/api/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      app.replaceChildren(
        ...[
        el(
          "div",
          { class: "card login-box" },
          el("h1", {}, "講習管理"),
          el("p", { class: "muted" }, "事務の方はGoogleアカウントでログインしてください。"),
          el("p", {}, el("a", { class: "btn btn-primary", href: loginUrl("/admin") }, "Googleでログイン")),
        ),
        devLoginForm("/admin"),
        ].filter(Boolean),
      );
      return;
    }
    throw err;
  }
  if (!state.me.is_staff) {
    app.replaceChildren(
      el(
        "div",
        { class: "card login-box" },
        el("h1", {}, "講習管理"),
        el("p", {}, `${state.me.user.email} には管理画面を使う権限がありません。`),
        el("p", { class: "muted" }, "事務アカウントとして登録されている Google アカウントでログインし直してください。"),
        el("button", { type: "button", onclick: logout }, "ログアウト"),
      ),
    );
    return;
  }
  state.meta = await api("/api/meta");
  await loadTerms();
  if (!state.terms.length) state.tab = "new-term";
  await render();
}

start().catch((err) => app.replaceChildren(el("div", { class: "notice danger" }, err.message)));
