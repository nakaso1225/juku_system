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
  if (state.saving || isDirty()) {
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

// ------------------------------------------------------------ 指導できる科目のフォーム（初回・編集で共通）

function subjectsForm(subjects, { submitLabel, onSubmit, onCancel }) {
  const chosen = new Set(subjects);
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
          await onSubmit([...chosen]);
        } catch (err) {
          toast(err.message, true);
        } finally {
          submit.disabled = false;
        }
      },
    },
    el(
      "p",
      { class: "notice warn", style: "margin:0 0 10px;padding:8px 10px;font-size:0.9rem" },
      "レギュラーで担当している生徒の科目は、必ず含めてください。",
    ),
    chips,
    el("div", { class: "row", style: "margin-top:14px" }, submit, onCancel ? el("button", { type: "button", onclick: onCancel }, "やめる") : null),
  );
}

// ------------------------------------------------------------ comiru の講師と紐付いていないとき

function renderLinkForm() {
  show(topbar(), el("div", { class: "card" },
    el("h2", {}, "ログイン用メールの登録が必要です"),
    el("p", {}, state.me.user.email),
    el("p", {}, "このメールを事務に伝えてください。登録されると、このGoogleアカウントで予定を入力できます。"),
    el("button", { type: "button", onclick: start }, "登録を確認する"),
  ));
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
        el("button", { type: "button", class: "btn-small", onclick: showEdit }, "科目を編集"),
      ),
      el("p", { class: "muted", style: "margin-top:4px" }, p.google_email || state.me.user.email),
      el("div", { class: "chips" }, p.subjects.map((s) => el("span", { class: "badge" }, s))),
    );
  const showEdit = () =>
    card.replaceChildren(
      el("h2", {}, "指導できる科目"),
      subjectsForm(p.subjects, {
        submitLabel: "保存する",
        onCancel: showView,
        onSubmit: async (subjects) => {
          await api("/api/teacher/profile", { method: "PATCH", body: { subjects } });
          p.subjects = (await api("/api/teacher/profile")).teacher.subjects;
          toast("✓ 指導できる科目を保存しました");
          showView();
        },
      }),
    );
  showView();
  return card;
}

/** 初回：指導できる科目を選んでもらう */
function renderFirstSubjects() {
  show(
    topbar(),
    el(
      "div",
      { class: "card" },
      el("h2", {}, `${state.profile.name} さん、ようこそ`),
      el("p", { class: "muted" }, "はじめに、指導できる科目を選んでください。あとから変更できます。"),
      subjectsForm([], {
        submitLabel: "次へ",
        onSubmit: async (subjects) => {
          await api("/api/teacher/profile", { method: "PATCH", body: { subjects } });
          await renderMain();
        },
      }),
    ),
  );
}

// 画面下の保存バーと、講習カード上部の提出状況を今の状態に合わせる
//   未提出 → 灰色「まだ提出していません」＋「提出する」
//   未保存 → 黄色「保存していない変更があります」＋「保存する」
//   保存済 → 緑色「✓ 保存しました（時刻）」＋「保存済み」（押せない）
function updateSaveBar() {
  const bar = document.getElementById("savebar");
  const status = document.getElementById("save-status");
  const button = document.getElementById("save-button");
  const termStatus = document.getElementById("term-status");
  if (!bar || !status || !button) return;

  const dirty = isDirty();
  const submitted = Boolean(state.termData.updated_at);
  const count = `${state.selected.size}コマ選択中`;
  const savedAt = submitted ? fmtDateTime(state.termData.updated_at) : "";

  bar.classList.toggle("dirty", dirty);
  bar.classList.toggle("saved", !dirty && submitted && !state.saving);

  if (state.saving) {
    status.textContent = "保存中…";
    button.textContent = "保存中…";
  } else if (dirty) {
    status.textContent = `${count}・保存していない変更があります`;
    button.textContent = submitted ? "保存する" : "提出する";
  } else if (submitted) {
    status.textContent = `✓ 保存しました（${savedAt}）・${count}`;
    button.textContent = "保存済み";
  } else {
    status.textContent = `${count}・まだ提出していません`;
    button.textContent = "提出する";
  }
  button.disabled = state.saving || (!dirty && submitted);

  if (termStatus) {
    termStatus.replaceChildren(
      submitted
        ? el("span", { class: "badge ok" }, `✓ 提出済み・最終保存 ${savedAt}`)
        : el("span", { class: "badge warn" }, "未提出"),
    );
  }
}

async function save() {
  if (state.saving) return;
  const note = document.getElementById("term-note").value;
  const selected = new Set(state.selected);
  const termData = state.termData;
  if (state.selected.size === 0 && !confirm("1コマも選ばれていません。「この講習は来られない」として保存しますか？")) return;
  state.saving = true;
  updateSaveBar();
  try {
    const res = await api(`/api/teacher/terms/${termData.term.id}`, {
      method: "PUT",
      body: { slots: keysToSlots(selected), note, expected_rev: termData.rev ?? null },
    });
    termData.rev = res.rev;
    state.savedKeys = selected;
    state.savedNote = note;
    termData.updated_at = res.updated_at;
    const term = state.terms.find((t) => t.id === termData.term.id);
    if (term) term.updated_at = res.updated_at;
    const chip = document.querySelector(`[data-term-id="${termData.term.id}"]`);
    if (chip && term) chip.textContent = `${term.name} ✓`;
    toast(res.first_submission ? "✓ 提出しました。変更があればいつでも直せます" : "✓ 保存しました");
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // 事務の方が電話などで先に直していた。入力中の内容は消さずに知らせる
      alert(`${err.message}\n\n（いま選んでいるコマは保存されていません。読み込み直すと、事務の方が直した予定が表示されます）`);
    } else {
      toast(`保存できませんでした：${err.message}`, true);
    }
  } finally {
    state.saving = false;
    updateSaveBar();
  }
}

async function loadTerm(termId) {
  if (state.saving) { toast("保存中です。完了してから切り替えてください"); return false; }
  if (isDirty() && !confirm("保存していない変更があります。破棄して切り替えますか？")) return false;
  const data = await api(`/api/teacher/terms/${termId}`);
  state.termData = data;
  state.selected = new Set(data.slots.map((s) => slotKey(s.date, s.period)));
  state.savedKeys = new Set(state.selected);
  state.savedNote = data.note;
  renderTermSection();
  return true;
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
      el("div", { class: "row", style: "justify-content:space-between;margin-bottom:6px" }, el("h2", { style: "margin:0" }, term.name), el("div", { id: "term-status" })),
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

  if (!teacher.subjects.length) return renderFirstSubjects();

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
                    const changed = await loadTerm(t.id);
                    if (changed) document.querySelectorAll("[data-term-id]").forEach((c) => c.classList.toggle("on", Number(c.dataset.termId) === state.termData.term.id));
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
  if (state.me.teacher_inactive) {
    // comiru の講師名簿から外れた講師（ログイン済みでも使えない）
    show(topbar(), el("div", { class: "notice danger" }, "comiru の講師名簿にいないため、このページは使えません。心当たりがない場合は事務にお問い合わせください。"));
    return;
  }
  if (!state.me.teacher) {
    return renderLinkForm();
  }
  await renderMain();
}

start().catch((err) => {
  app.replaceChildren(el("div", { class: "notice danger" }, err.message));
});
