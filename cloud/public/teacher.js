// 講師ページ：Google でログイン → 登録 → 講習ごとに来られるコマをカレンダーで入力
import { keysToSlots, renderCalendar, slotKey } from "./calendar.js";
import { api, ApiError, devLoginForm, el, fmtDate, fmtDateTime, loginUrl, logout, toast } from "./common.js";

const app = document.getElementById("app");
const show = (...nodes) => app.replaceChildren(...nodes.filter(Boolean));
const state = {
  me: null,
  meta: null,
  profile: null,
  terms: [],
  termData: null,
  selected: new Set(),
  savedKeys: new Set(),
  savedNote: "",
  saving: false,
};

function isDirty() {
  if (!state.termData) return false;
  const noteEl = document.getElementById("term-note");
  const note = noteEl ? noteEl.value : state.savedNote;
  if (note !== state.savedNote) return true;
  if (state.selected.size !== state.savedKeys.size) return true;
  for (const k of state.selected) if (!state.savedKeys.has(k)) return true;
  return false;
}

window.addEventListener("beforeunload", (e) => {
  if (isDirty()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function topbar() {
  const { user, is_staff } = state.me;
  return el(
    "div",
    { class: "topbar" },
    el("h1", {}, "講習の予定入力"),
    el(
      "div",
      { class: "who" },
      el("div", {}, user.email),
      el(
        "div",
        { class: "row", style: "justify-content:flex-end" },
        is_staff ? el("a", { class: "btn-link", href: "/admin" }, "管理画面") : null,
        el("button", { type: "button", class: "btn-link", onclick: logout }, "ログアウト"),
      ),
    ),
  );
}

// ------------------------------------------------------------ ログイン前

function renderLogin() {
  show(
    el(
      "div",
      { class: "card login-box" },
      el("h1", {}, "講習の予定入力"),
      el("p", { class: "muted" }, "講師の方はGoogleアカウントでログインしてください。"),
      el("p", {}, el("a", { class: "btn btn-primary", href: loginUrl("/") }, "Googleでログイン")),
    ),
    devLoginForm("/"),
  );
}

// ------------------------------------------------------------ 氏名・科目のフォーム（登録・編集で共通）

function profileForm({ name = "", subjects = [] }, { submitLabel, onSubmit, onCancel }) {
  const chosen = new Set(subjects);
  const nameInput = el("input", { type: "text", value: name, placeholder: "例：山田太郎", autocomplete: "name" });
  const chips = el(
    "div",
    { class: "chips" },
    state.meta.subjects.map((s) => {
      const chip = el("button", { type: "button", class: `chip${chosen.has(s) ? " on" : ""}` }, s);
      chip.addEventListener("click", () => {
        if (chosen.has(s)) chosen.delete(s);
        else chosen.add(s);
        chip.classList.toggle("on", chosen.has(s));
      });
      return chip;
    }),
  );
  const submit = el("button", { type: "submit", class: "btn-primary" }, submitLabel);

  return el(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          await onSubmit({ name: nameInput.value, subjects: [...chosen] });
        } catch (err) {
          toast(err.message, true);
        } finally {
          submit.disabled = false;
        }
      },
    },
    el(
      "label",
      { class: "field" },
      el("span", {}, "氏名（comiruと同じ表記・姓と名の間にスペースなし）"),
      nameInput,
    ),
    el("div", { class: "field" }, el("span", { style: "display:block;font-weight:600;margin-bottom:6px" }, "指導できる科目"), chips),
    el("div", { class: "row" }, submit, onCancel ? el("button", { type: "button", onclick: onCancel }, "やめる") : null),
  );
}

function renderRegister() {
  app.replaceChildren(
    topbar(),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "はじめに講師登録をしてください"),
      el("p", { class: "muted" }, "登録後、事務が確認します。確認を待つ間も予定は入力できます。"),
      profileForm(
        {},
        {
          submitLabel: "登録する",
          onSubmit: async (values) => {
            await api("/api/teacher/register", { method: "POST", body: values });
            toast("登録しました");
            await start();
          },
        },
      ),
    ),
  );
}

// ------------------------------------------------------------ メイン画面

function profileCard() {
  const p = state.profile;
  const card = el("div", { class: "card" });
  const showView = () =>
    card.replaceChildren(
      el(
        "div",
        { class: "row", style: "justify-content:space-between" },
        el("h2", { style: "margin:0" }, p.name),
        el("button", { type: "button", class: "btn-small", onclick: showEdit }, "編集"),
      ),
      el("p", { class: "muted", style: "margin-top:4px" }, p.email),
      el("div", { class: "chips" }, p.subjects.map((s) => el("span", { class: "badge" }, s))),
    );
  const showEdit = () =>
    card.replaceChildren(
      el("h2", {}, "登録情報の編集"),
      profileForm(p, {
        submitLabel: "保存する",
        onCancel: showView,
        onSubmit: async (values) => {
          await api("/api/teacher/profile", { method: "PATCH", body: values });
          state.profile = (await api("/api/teacher/profile")).teacher;
          Object.assign(p, state.profile);
          toast("登録情報を保存しました");
          showView();
        },
      }),
      el("p", { class: "muted", style: "margin-top:8px" }, "メールアドレスはログイン中のGoogleアカウントのものが使われます。"),
    );
  showView();
  return card;
}

function updateSaveBar() {
  const status = document.getElementById("save-status");
  const button = document.getElementById("save-button");
  if (!status || !button) return;
  const dirty = isDirty();
  const count = `${state.selected.size}コマ選択中`;
  if (dirty) {
    status.textContent = `${count}・未保存`;
  } else if (state.termData.updated_at) {
    status.textContent = `${count}・保存済み ${fmtDateTime(state.termData.updated_at)}`;
  } else {
    status.textContent = `${count}・未提出`;
  }
  status.classList.toggle("dirty", dirty || !state.termData.updated_at);
  button.disabled = state.saving || (!dirty && Boolean(state.termData.updated_at));
  button.textContent = state.termData.updated_at ? "保存する" : "提出する";
}

async function save() {
  const note = document.getElementById("term-note").value;
  if (state.selected.size === 0 && !confirm("1コマも選ばれていません。「この講習は来られない」として保存しますか？")) return;
  state.saving = true;
  updateSaveBar();
  try {
    const firstTime = !state.termData.updated_at;
    const res = await api(`/api/teacher/terms/${state.termData.term.id}`, {
      method: "PUT",
      body: { slots: keysToSlots(state.selected), note },
    });
    state.savedKeys = new Set(state.selected);
    state.savedNote = note;
    state.termData.updated_at = res.updated_at;
    toast(firstTime ? "提出しました。変更があればいつでも直せます" : "保存しました");
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.saving = false;
    updateSaveBar();
  }
}

async function loadTerm(termId) {
  if (isDirty() && !confirm("保存していない変更があります。破棄して切り替えますか？")) return;
  const data = await api(`/api/teacher/terms/${termId}`);
  state.termData = data;
  state.selected = new Set(data.slots.map((s) => slotKey(s.date, s.period)));
  state.savedKeys = new Set(state.selected);
  state.savedNote = data.note;
  renderTermSection();
}

function renderTermSection() {
  const section = document.getElementById("term-section");
  const { term } = state.termData;
  const calendarRoot = el("div");
  const note = el("textarea", { id: "term-note", maxlength: "500", placeholder: "例：12/28は午前のみ可、など" });
  note.value = state.savedNote;
  note.addEventListener("input", updateSaveBar);

  section.replaceChildren(
    el(
      "div",
      { class: "card" },
      el("h2", {}, term.name),
      el(
        "p",
        { class: "muted" },
        `${fmtDate(term.start_date)} 〜 ${fmtDate(term.end_date)}　来られるコマをタップして○にしてください。`,
      ),
      calendarRoot,
      el("label", { class: "field", style: "margin-top:12px" }, el("span", {}, "備考"), note),
    ),
  );
  renderCalendar(calendarRoot, term, state.selected, { editable: true, onChange: updateSaveBar });

  document.getElementById("savebar").classList.remove("hidden");
  updateSaveBar();
}

async function renderMain() {
  const [{ teacher }, terms] = await Promise.all([api("/api/teacher/profile"), api("/api/teacher/terms")]);
  state.profile = teacher;
  state.terms = terms;

  const notices = [];
  if (teacher.status === "pending") {
    notices.push(el("div", { class: "notice warn" }, "事務の確認待ちです。予定の入力はこのまま進めてください。"));
  }

  const termPicker =
    terms.length > 1
      ? el(
          "div",
          { class: "card" },
          el("h3", {}, "講習を選んでください"),
          el(
            "div",
            { class: "chips" },
            terms.map((t) =>
              el(
                "button",
                {
                  type: "button",
                  class: "chip",
                  dataset: { termId: t.id },
                  onclick: async (e) => {
                    await loadTerm(t.id);
                    document.querySelectorAll("[data-term-id]").forEach((c) => c.classList.toggle("on", c === e.currentTarget));
                  },
                },
                t.name,
                t.updated_at ? " ✓" : "",
              ),
            ),
          ),
        )
      : null;

  const savebar = el(
    "div",
    { id: "savebar", class: "savebar hidden" },
    el(
      "div",
      { class: "savebar-inner" },
      el("span", { id: "save-status", class: "status" }),
      el("button", { id: "save-button", type: "button", class: "btn-primary", onclick: save }, "保存する"),
    ),
  );

  show(
    topbar(),
    ...notices,
    profileCard(),
    terms.length ? termPicker : el("div", { class: "notice info" }, "現在、予定の入力を受け付けている講習はありません。"),
    el("div", { id: "term-section" }),
    savebar,
  );

  if (terms.length) {
    await loadTerm(terms[0].id);
    document.querySelector(`[data-term-id="${terms[0].id}"]`)?.classList.add("on");
  }
}

// ------------------------------------------------------------ 起動

async function start() {
  try {
    state.me = await api("/api/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderLogin();
    app.replaceChildren(el("div", { class: "notice danger" }, err.message));
    return;
  }
  state.meta = await api("/api/meta");
  const teacher = state.me.teacher;
  if (!teacher) return renderRegister();
  if (teacher.status === "rejected") {
    app.replaceChildren(
      topbar(),
      el("div", { class: "notice danger" }, "この講師登録は承認されませんでした。心当たりがない場合は事務にお問い合わせください。"),
    );
    return;
  }
  await renderMain();
}

start().catch((err) => {
  app.replaceChildren(el("div", { class: "notice danger" }, err.message));
});
