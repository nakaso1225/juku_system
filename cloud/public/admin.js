// 管理画面（事務）：講習の設定・講師の承認と提出状況・予定の変更通知・事務アカウント
import { assignView, assignmentsSaving, disposeAssignView } from "./assign.js";
import { keysToSlots, renderCalendar, slotKey } from "./calendar.js";
import { api, ApiError, devLoginForm, el, fmtDate, fmtDateTime, loginUrl, logout, toast } from "./common.js";

const app = document.getElementById("app");
const TERM_KEY = "juku-admin-term";
let formDirty = () => false;
let formSaving = () => false;
let editorDirty = () => false;

function canNavigate() {
  if (assignmentsSaving() || formSaving()) {
    toast("保存中です。完了してから切り替えてください");
    return false;
  }
  return !formDirty() || confirm("保存していない設定があります。破棄して移動しますか？");
}

window.addEventListener("beforeunload", (e) => {
  if (formDirty() || editorDirty() || assignmentsSaving()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

const state = {
  me: null,
  meta: null,
  terms: [],
  termId: null,
  tab: "assign",
  teacherList: { q: "", filter: "all" },
  studentList: { q: "", filter: "all" },
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
        if (!canNavigate()) {
          e.target.value = String(state.termId);
          return;
        }
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
          el("a", { class: "btn-link", href: "/", onclick: (e) => { if (!canNavigate()) e.preventDefault(); } }, "講師ページ"),
          el("button", { type: "button", class: "btn-link", onclick: () => canNavigate() && logout() }, "ログアウト"),
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
            if (!canNavigate()) return;
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
    ["assign", "割り当て"],
    ["teachers", "講師"],
    ["students", "生徒"],
    ["term", "講習の設定"],
    ["settings", "座席設定"],
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
            if (!canNavigate()) return;
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
  formDirty = () => false;
  formSaving = () => false;
  disposeAssignView();
  const body = el("div", {}, el("p", { class: "muted" }, "読み込み中…"));
  app.replaceChildren(header(), tabs(), body);
  try {
    if (state.tab === "new-term" || (!currentTerm() && ["assign", "teachers", "students", "term"].includes(state.tab))) {
      body.replaceChildren(termForm(null));
    } else if (state.tab === "teachers") {
      body.replaceChildren(await teachersView());
    } else if (state.tab === "assign") {
      const term = currentTerm();
      body.replaceChildren(await assignView(term, state.meta, {
        editStudent: (student, onClose, isCurrent) => openStudentEditor(student, term, { onClose, isCurrent }),
      }));
    } else if (state.tab === "students") {
      body.replaceChildren(await studentsView());
    } else if (state.tab === "term") {
      body.replaceChildren(termForm(currentTerm()));
    } else if (state.tab === "staff") {
      body.replaceChildren(await staffView());
    } else if (state.tab === "settings") {
      body.replaceChildren(await roomSettingsView());
    }
  } catch (err) {
    body.replaceChildren(el("div", { class: "notice danger" }, err.message));
  }
}

// ------------------------------------------------------------ 共通：comiru の名簿・検索

const normalize = (text) => String(text ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/** comiru から取得した名簿の人数と「取り直す」ボタン */
async function comiruBar(kind) {
  const status = await api("/api/admin/comiru/status");
  const label = kind === "teachers" ? "講師" : "生徒";
  if (!status.configured) {
    return el("div", { class: "notice warn" }, `comiru 連携が未設定のため、${label}の名簿を取得できません。`);
  }
  const info = status[kind];
  const button = el(
    "button",
    {
      type: "button",
      class: "btn-small",
      onclick: async () => {
        button.disabled = true;
        try {
          const res = await api(`/api/admin/comiru/refresh?which=${kind}`, { method: "POST" });
          toast(`comiru から${label} ${res[kind]}人を取得しました`);
          render();
        } catch (err) {
          toast(err.message, true);
          button.disabled = false;
        }
      },
    },
    `comiru から${label}を取り直す`,
  );
  return el(
    "div",
    { class: "row", style: "justify-content:space-between;margin-bottom:12px;font-size:0.9rem" },
    el("span", { class: "muted" }, info.count ? `comiru の${label} ${info.count}人（${fmtDateTime(info.fetched_at)} 取得）` : `comiru の${label}をまだ取得していません`),
    button,
  );
}

/** 一覧の上の検索欄と絞り込み。条件が変わったら redraw() で表の中身だけ描き直す */
function listControls(stateKey, options, redraw) {
  const search = el("input", { type: "text", placeholder: "名前で検索", value: state[stateKey].q, style: "max-width:240px" });
  search.addEventListener("input", () => {
    state[stateKey].q = search.value;
    redraw();
  });
  const select = el(
    "select",
    { style: "width:auto" },
    options.map(([value, label]) => el("option", { value, selected: state[stateKey].filter === value }, label)),
  );
  select.addEventListener("change", () => {
    state[stateKey].filter = select.value;
    redraw();
  });
  return el("div", { class: "row" }, search, select);
}

// ------------------------------------------------------------ 講師タブ

async function teachersView() {
  const term = currentTerm();
  const showHidden = state.teacherList.filter === "hidden";
  const [teachers, requests, bar] = await Promise.all([
    api(`/api/admin/teachers?term_id=${term.id}${showHidden ? "&hidden=1" : ""}`),
    api("/api/admin/link-requests"),
    comiruBar("teachers"),
  ]);
  const submitted = teachers.filter((t) => t.submitted_at).length;
  const linked = teachers.filter((t) => t.linked).length;

  const tbody = el("tbody");
  const redraw = () => {
    const q = normalize(state.teacherList.q);
    const f = state.teacherList.filter;
    const rows = teachers.filter(
      (t) =>
        (!q || normalize(t.name).includes(q)) &&
        (f === "all" || f === "hidden" || (f === "submitted" && t.submitted_at) || (f === "unsubmitted" && !t.submitted_at) || (f === "unlinked" && !t.linked)),
    );
    tbody.replaceChildren(
      ...(rows.length ? rows.map((t) => teacherRow(t, term)) : [el("tr", {}, el("td", { colspan: "7", class: "muted" }, "該当する講師はいません"))]),
    );
  };
  redraw();

  return el(
    "div",
    {},
    bar,
    requests.length ? linkRequestsCard(requests) : null,
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "row", style: "justify-content:space-between;margin-bottom:8px" },
        el(
          "h2",
          { style: "margin:0" },
          showHidden ? `隠している講師（${teachers.length}人）` : `講師（提出 ${submitted}人・ログイン済み ${linked}人 / 全${teachers.length}人）`,
        ),
        el("a", { class: "btn btn-small", href: `/api/admin/terms/${term.id}/export/teachers.csv` }, "今のアプリ用CSV（講師）"),
      ),
      el(
        "p",
        { class: "muted" },
        "講師は comiru に登録されたメールアドレスの Google アカウントでログインすると、自動で本人と紐付きます。",
      ),
      listControls(
        "teacherList",
        [
          ["all", "すべて"],
          ["submitted", "提出済み"],
          ["unsubmitted", "未提出"],
          ["unlinked", "まだログインしていない"],
          ["hidden", "隠している講師"],
        ],
        () => (showHidden !== (state.teacherList.filter === "hidden") ? render() : redraw()),
      ),
      el(
        "div",
        { class: "table-wrap", style: "margin-top:8px" },
        el(
          "table",
          { class: "list" },
          el("thead", {}, el("tr", {}, ["氏名", "ログイン", "指導できる科目", "提出", "最終更新", "コマ数", ""].map((h) => el("th", {}, h)))),
          tbody,
        ),
      ),
    ),
  );
}

function teacherRow(t, term) {
  return el(
    "tr",
    {},
    el("td", {}, el("button", { type: "button", class: "btn-link", onclick: () => openTeacherModal(t, term) }, t.name)),
    el("td", {}, t.linked ? el("span", { class: "badge ok", title: t.google_email || "" }, "✓ 済み") : el("span", { class: "badge" }, "まだ")),
    el("td", { style: "max-width:220px" }, el("span", { class: "muted" }, t.subjects || "")),
    el("td", {}, t.submitted_at ? el("span", { class: "badge ok" }, "提出済み") : el("span", { class: "badge warn" }, "未提出")),
    el("td", {}, fmtDateTime(t.updated_at)),
    el("td", { class: "num" }, t.submitted_at ? t.slot_count : ""),
    el("td", {}, el("button", { type: "button", class: "btn-small", onclick: () => openTeacherModal(t, term) }, "詳細")),
  );
}

/** comiru のアドレスと違う Google アカウントで「本人です」と申請してきた講師 */
function linkRequestsCard(requests) {
  const act = async (path, body, message) => {
    try {
      await api(path, { method: "POST", body });
      toast(message);
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
  return el(
    "div",
    { class: "card", style: "border-color:var(--warn)" },
    el("h2", {}, `本人確認の申請（${requests.length}件）`),
    el("p", { class: "muted" }, "comiru のアドレスとは違う Google アカウントでログインした講師です。本人で間違いなければ承認してください（初回だけです）。"),
    requests.map((r) =>
      el(
        "div",
        { style: "padding:10px 0;border-top:1px solid var(--border)" },
        el("div", {}, el("strong", {}, r.requested_name), " として申請　", el("span", { class: "muted" }, `Google：${r.google_email}${r.google_name ? `（${r.google_name}）` : ""}・${fmtDateTime(r.created_at)}`)),
        el(
          "div",
          { class: "row", style: "margin-top:6px" },
          r.candidates.map((cand) =>
            el(
              "button",
              {
                type: "button",
                class: "btn-primary btn-small",
                title: `comiru のアドレス：${cand.email || "なし"}`,
                onclick: () =>
                  act("/api/admin/link-requests/approve", { google_sub: r.google_sub, teacher_id: cand.id }, `${cand.name} さんとして承認しました`),
              },
              r.candidates.length > 1 ? `承認（comiru：${cand.email || "アドレスなし"}）` : "承認",
              cand.google_email ? `※${cand.google_email} と紐付け済み` : "",
            ),
          ),
          el(
            "button",
            {
              type: "button",
              class: "btn-danger btn-small",
              onclick: () => confirm("この申請を却下しますか？") && act("/api/admin/link-requests/reject", { google_sub: r.google_sub }, "却下しました"),
            },
            "却下",
          ),
        ),
      ),
    ),
  );
}

async function openTeacherModal(t, term) {
  const data = await api(`/api/admin/terms/${term.id}/teachers/${t.id}`);
  const selected = new Set(data.slots.map((s) => slotKey(s.date, s.period)));
  const calendarRoot = el("div");
  const kana = el("input", { type: "text", value: t.name_kana || "", placeholder: "例：やまだ たろう", maxlength: "100" });
  let savedKana = kana.value;
  let savingKana = false;
  let changedKana = false;
  editorDirty = () => savingKana || kana.value !== savedKana;
  const close = () => {
    if (savingKana) return toast("保存中です。完了してから閉じてください");
    if (kana.value !== savedKana && !confirm("保存していないふりがながあります。閉じてよろしいですか？")) return;
    backdrop.remove();
    editorDirty = () => false;
    if (changedKana) render();
  };
  const saveKana = el("button", { type: "button", class: "btn-small", onclick: async () => {
    if (savingKana) return;
    const submitted = kana.value;
    savingKana = true;
    saveKana.disabled = true;
    try {
      await api(`/api/admin/teachers/${t.id}/profile`, { method: "PATCH", body: { name_kana: submitted } });
      savedKana = submitted;
      changedKana = true;
      toast("ふりがなを保存しました");
    } catch (err) { toast(err.message, true); }
    finally { savingKana = false; saveKana.disabled = false; }
  } }, "ふりがなを保存");

  const accountSection = t.linked
    ? el(
        "details",
        { style: "margin-top:16px;border-top:1px solid var(--border);padding-top:12px" },
        el("summary", { class: "muted" }, `ログインに使っている Google アカウント：${t.google_email}`),
        el(
          "p",
          { class: "muted", style: "margin-top:8px" },
          "別の人が間違ってこの講師として登録されてしまったときだけ使います。解除すると、このアカウントではこの講師の予定を見られなくなります（入力済みの予定は残ります）。",
        ),
        el(
          "p",
          { class: "muted" },
          "解除しても、comiru に登録されたアドレスと同じ Google アカウントなら、本人が次にログインしたときに自動で元に戻ります。違うアカウントの場合は、もう一度「本人確認の申請」と承認が必要です。",
        ),
        el(
          "button",
          {
            type: "button",
            class: "btn-danger btn-small",
            onclick: async () => {
              if (!confirm(`${t.google_email} での ${t.name} さんとしてのログインを解除しますか？`)) return;
              try {
                await api(`/api/admin/teachers/${t.id}/unlink`, { method: "POST" });
                toast("解除しました");
                close();
                render();
              } catch (err) {
                toast(err.message, true);
              }
            },
          },
          "このアカウントでのログインを解除する",
        ),
      )
    : el("p", { class: "muted", style: "margin-top:16px" }, "まだログインしていません。");

  const backdrop = el(
    "div",
    { class: "modal-backdrop", onclick: (e) => e.target === backdrop && close() },
    el(
      "div",
      { class: "modal" },
      el(
        "div",
        { class: "modal-head" },
        el("h2", { style: "margin:0" }, `${t.name} さん`),
        el("button", { type: "button", onclick: close }, "閉じる"),
      ),
      el("label", { class: "field" }, el("span", {}, "ふりがな（あいうえお順に使用）"), kana),
      saveKana,
      el("p", { class: "muted", style: "margin-top:12px" }, `指導できる科目：${t.subjects || "未登録"}`),
      el(
        "p",
        { class: "muted" },
        data.updated_at ? `${term.name}：最終更新 ${fmtDateTime(data.updated_at)}・${selected.size}コマ` : `${term.name}：まだ提出していません`,
      ),
      data.note ? el("div", { class: "notice info" }, `備考：${data.note}`) : null,
      data.updated_at ? calendarRoot : null,
      accountSection,
      el(
        "div",
        { style: "margin-top:12px;border-top:1px solid var(--border);padding-top:12px" },
        el(
          "p",
          { class: "muted" },
          t.hidden
            ? "この講師は一覧から隠しています。"
            : "辞めた講師など、もう使わない講師は一覧から隠せます。予定を入力すると自動で一覧に戻ります。",
        ),
        el(
          "button",
          {
            type: "button",
            class: "btn-small",
            onclick: async () => {
              try {
                await api(`/api/admin/teachers/${t.id}/visibility`, { method: "POST", body: { hidden: !t.hidden } });
                toast(t.hidden ? `${t.name} さんを一覧に戻しました` : `${t.name} さんを一覧から隠しました`);
                close();
                render();
              } catch (err) {
                toast(err.message, true);
              }
            },
          },
          t.hidden ? "一覧に戻す" : "一覧から隠す",
        ),
      ),
    ),
  );
  document.body.append(backdrop);
  if (data.updated_at) renderCalendar(calendarRoot, data.term, selected, { editable: false });
}

// ------------------------------------------------------------ 生徒タブ

async function studentsView() {
  const term = currentTerm();
  const [students, bar] = await Promise.all([api(`/api/admin/terms/${term.id}/students`), comiruBar("students")]);
  const entered = students.filter((s) => s.entered).length;

  const tbody = el("tbody");
  const redraw = () => {
    const q = normalize(state.studentList.q);
    const f = state.studentList.filter;
    const rows = students.filter((st) => (!q || normalize(st.name).includes(q)) && (f === "all" || (f === "entered") === st.entered));
    tbody.replaceChildren(
      ...(rows.length ? rows.map((st) => studentRow(st, term)) : [el("tr", {}, el("td", { colspan: "6", class: "muted" }, "該当する生徒はいません"))]),
    );
  };
  redraw();

  return el(
    "div",
    {},
    bar,
    el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "row", style: "justify-content:space-between;margin-bottom:8px" },
        el("h2", { style: "margin:0" }, `生徒（入力済み ${entered} / 全${students.length}人）`),
        el("a", { class: "btn btn-small", href: `/api/admin/terms/${term.id}/export/students.csv` }, "今のアプリ用CSV（生徒）"),
      ),
      listControls(
        "studentList",
        [
          ["all", "すべて"],
          ["entered", "入力済み"],
          ["empty", "未入力"],
        ],
        redraw,
      ),
      el(
        "div",
        { class: "table-wrap", style: "margin-top:8px" },
        el(
          "table",
          { class: "list" },
          el("thead", {}, el("tr", {}, ["氏名", "学年", "受講科目", "受講できるコマ", "最終更新", ""].map((h) => el("th", {}, h)))),
          tbody,
        ),
      ),
    ),
  );
}

function studentRow(st, term) {
  return el(
    "tr",
    {},
    el("td", {}, el("button", { type: "button", class: "btn-link", onclick: () => openStudentEditor(st, term) }, st.name)),
    el("td", {}, st.grade || el("span", { class: "muted" }, "未設定")),
    el("td", { style: "max-width:260px" }, el("span", { class: "muted" }, st.subjects.join(", "))),
    el("td", { class: "num" }, st.entered ? `${st.slot_count}コマ` : ""),
    el("td", {}, st.entered ? fmtDateTime(st.updated_at) : el("span", { class: "badge" }, "未入力")),
    el(
      "td",
      {},
      el(
        "div",
        { class: "row", style: "flex-wrap:nowrap" },
        el("button", { type: "button", class: "btn-primary btn-small", onclick: () => openStudentEditor(st, term) }, st.entered ? "予定を直す" : "予定を入力"),
        st.entered
          ? el(
              "button",
              {
                type: "button",
                class: "btn-danger btn-small",
                onclick: async () => {
                  if (!confirm(`${st.name} のこの講習の入力（受講科目・予定・備考）と割り当て済みの授業を消しますか？ comiru の授業は次の反映時に削除されます。`)) return;
                  try {
                    await api(`/api/admin/terms/${term.id}/students/${st.id}`, { method: "DELETE" });
                    toast(`${st.name} の入力を消しました`);
                    render();
                  } catch (err) {
                    toast(err.message, true);
                  }
                },
              },
              "入力を消す",
            )
          : null,
      ),
    ),
  );
}

/** 生徒の受講科目・受講できるコマ・備考を入力する画面 */
async function openStudentEditor(st, term, { onClose = render, isCurrent = () => true } = {}) {
  const data = await api(`/api/admin/terms/${term.id}/students/${st.id}`);
  if (!isCurrent()) return;
  const selected = new Set(data.slots.map((s) => slotKey(s.date, s.period)));
  const subjects = new Set(data.subjects);
  const kana = el("input", { type: "text", value: data.student.name_kana || "", maxlength: "100", placeholder: "例：やまだ はなこ" });
  const grade = el("select", {},
    el("option", { value: "" }, "未設定（comiru の学年を使用）"),
    (state.meta.grades || ["小1", "小2", "小3", "小4", "小5", "小6", "中1", "中2", "中3", "高1", "高2", "高3", "その他"]).map((g) =>
      el("option", { value: g, selected: g === data.student.grade }, g)),
  );
  if (data.student.grade && ![...grade.options].some((o) => o.value === data.student.grade)) {
    grade.append(el("option", { value: "その他", selected: true }, `その他（${data.student.grade}）`));
  }
  const saved = { slots: new Set(selected), subjects: new Set(subjects), note: data.note, updated_at: data.updated_at, rev: data.rev ?? null, touched: Boolean(data.updated_at) };
  let saving = false;
  saved.name_kana = kana.value;
  saved.grade = grade.value;

  const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  const note = el("textarea", { maxlength: "500", placeholder: "例：授業数は10コマ希望、12/28は午前のみ" });
  note.value = data.note;
  const isDirty = () => !sameSet(selected, saved.slots) || !sameSet(subjects, saved.subjects) || note.value !== saved.note || kana.value !== saved.name_kana || grade.value !== saved.grade;
  editorDirty = () => saving || isDirty();

  const status = el("span", { class: "status" });
  const saveButton = el("button", { type: "button", class: "btn-primary" }, "保存する");
  const footer = el("div", { class: "modal-footer" }, status, saveButton);
  const update = () => {
    const dirty = isDirty();
    footer.classList.toggle("dirty", dirty);
    footer.classList.toggle("saved", !dirty && saved.touched);
    const count = `${selected.size}コマ・${subjects.size}科目`;
    status.textContent = dirty ? `${count}・保存していない変更があります` : saved.touched ? `✓ 保存しました（${fmtDateTime(saved.updated_at)}）・${count}` : `${count}・まだ入力していません`;
    saveButton.disabled = saving || !dirty;
    saveButton.textContent = saving ? "保存中…" : dirty ? "保存する" : saved.touched ? "保存済み" : "保存する";
  };

  const chips = el(
    "div",
    { class: "chips" },
    state.meta.subjects.map((s) => {
      const chip = el("button", { type: "button", class: `chip${subjects.has(s) ? " on" : ""}` }, s);
      chip.addEventListener("click", () => {
        if (subjects.has(s)) subjects.delete(s);
        else subjects.add(s);
        chip.classList.toggle("on", subjects.has(s));
        update();
      });
      return chip;
    }),
  );
  note.addEventListener("input", update);
  kana.addEventListener("input", update);
  grade.addEventListener("change", update);

  saveButton.addEventListener("click", async () => {
    if (saving) return;
    const submitted = { subjects: [...subjects], slots: keysToSlots(selected), note: note.value, name_kana: kana.value, grade: grade.value };
    const body = { ...submitted, expected_rev: saved.rev }; // ほかの人が先に保存していたら 409 になる
    if (submitted.name_kana === saved.name_kana) delete body.name_kana;
    if (submitted.grade === saved.grade) delete body.grade;
    saving = true;
    update();
    try {
      const res = await api(`/api/admin/terms/${term.id}/students/${st.id}`, {
        method: "PUT",
        body,
      });
      Object.assign(saved, { slots: new Set(submitted.slots.map((s) => slotKey(s.date, s.period))), subjects: new Set(submitted.subjects), note: submitted.note, name_kana: submitted.name_kana, grade: submitted.grade, updated_at: res.updated_at, rev: res.rev, touched: true });
      toast(`✓ ${st.name} の予定を保存しました`);
    } catch (err) {
      toast(`保存できませんでした：${err.message}`, true);
    } finally {
      saving = false;
      update();
    }
  });

  const calendarRoot = el("div");
  const close = () => {
    if (saving) return toast("保存中です。完了してから閉じてください");
    if (isDirty() && !confirm("保存していない変更があります。閉じてよろしいですか？")) return;
    backdrop.remove();
    editorDirty = () => false;
    onClose();
  };
  const backdrop = el(
    "div",
    { class: "modal-backdrop", onclick: (e) => e.target === backdrop && close() },
    el(
      "div",
      { class: "modal" },
      el(
        "div",
        { class: "modal-head" },
        el("h2", { style: "margin:0" }, `${st.name} の予定`),
        el("button", { type: "button", onclick: close }, "閉じる"),
      ),
      el("div", { class: "row", style: "align-items:flex-start" },
        el("label", { class: "field", style: "flex:2;min-width:180px" }, el("span", {}, "ふりがな"), kana),
        el("label", { class: "field", style: "flex:1;min-width:100px" }, el("span", {}, "学年"), grade)),
      el("div", { class: "field" }, el("span", { style: "display:block;font-weight:600;margin-bottom:6px" }, "受講科目"), chips),
      el("div", { class: "field" }, el("span", { style: "display:block;font-weight:600;margin-bottom:6px" }, "受講できるコマ"), calendarRoot),
      el("label", { class: "field" }, el("span", {}, "備考"), note),
      footer,
    ),
  );
  document.body.append(backdrop);
  renderCalendar(calendarRoot, data.term, selected, { editable: true, onChange: update });
  update();
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
  const payload = () => ({
    name: name.value, start_date: start.value, end_date: end.value,
    periods: [...values.periods].sort((a, b) => a - b),
    closed_dates: [...values.closed_dates].sort(), accepting: accepting.checked,
  });
  let savedPayload = JSON.stringify(payload());
  let savedId = term?.id ?? null;
  let saving = false;
  formDirty = () => saving || JSON.stringify(payload()) !== savedPayload;
  formSaving = () => saving;

  return el(
    "form",
    {
      class: "card",
      onsubmit: async (e) => {
        e.preventDefault();
        if (saving) return;
        saving = true;
        const controls = [...e.currentTarget.querySelectorAll("input, button, select, textarea")];
        controls.forEach((control) => { control.disabled = true; });
        const body = payload();
        try {
          let saved;
          if (savedId) {
            try {
              saved = await api(`/api/admin/terms/${savedId}`, { method: "PUT", body });
            } catch (err) {
              // 期間・時限・休校日の変更で、授業の入っているコマが対象外になる → 一覧を見せて確認してから保存する
              if (err.status !== 409 || !err.data?.affected) throw err;
              const list = err.data.affected.slice(0, 15).map((a) => `・${fmtDate(a.date)} ${a.period}限 ${a.student_name}（${a.teacher_name ?? "講師未定"}）`);
              const more = err.data.affected.length > 15 ? `\n…ほか ${err.data.affected.length - 15}コマ` : "";
              if (!confirm(`${err.message}\n\n${list.join("\n")}${more}\n\nこのまま保存しますか？`)) throw new Error("保存をやめました");
              saved = await api(`/api/admin/terms/${savedId}`, { method: "PUT", body: { ...body, confirm_affected: true } });
            }
          } else {
            saved = await api("/api/admin/terms", { method: "POST", body });
          }
          toast(isNew ? "講習を作りました" : "保存しました");
          savedId = saved.id;
          submit.textContent = "保存する";
          savedPayload = JSON.stringify(body);
          rememberTerm(saved.id);
          await loadTerms();
          state.tab = isNew ? "teachers" : "term";
          render();
        } catch (err) {
          toast(err.message, true);
        } finally {
          saving = false;
          controls.forEach((control) => { control.disabled = false; });
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

async function roomSettingsView() {
  const settings = await api("/api/admin/settings");
  if (state.tab !== "settings") return el("div");
  let savedCount = settings.table_ids.length;
  let saving = false;
  const count = el("input", { type: "number", min: "1", max: "100", step: "1", value: savedCount, style: "width:100px" });
  const preview = el("div", { class: "chips seat-preview", "aria-live": "polite" });
  const status = el("p", { class: "muted", role: "status" });
  const submit = el("button", { type: "submit", class: "btn-primary" }, "座席設定を保存");
  const label = (index) => {
    let n = index + 1;
    let value = "";
    while (n > 0) { n--; value = String.fromCharCode(65 + n % 26) + value; n = Math.floor(n / 26); }
    return value;
  };
  const update = () => {
    const n = Number(count.value);
    const valid = Number.isInteger(n) && n >= 1 && n <= 100;
    preview.replaceChildren(...(valid ? Array.from({ length: n }, (_, i) => el("span", { class: "badge" }, label(i))) : []));
    status.textContent = saving ? "保存中…" : !valid ? "座席数は1〜100席で指定してください" : n === savedCount ? `保存済み：${n}席（A〜${label(n - 1)}）` : `変更後：${n}席（A〜${label(n - 1)}）・未保存`;
    submit.disabled = saving || !valid || n === savedCount;
  };
  count.addEventListener("input", update);
  formDirty = () => saving || Number(count.value) !== savedCount;
  formSaving = () => saving;
  const step = (amount) => {
    if (saving) return;
    count.value = String(Math.max(1, Math.min(100, Number(count.value || savedCount) + amount)));
    update();
  };
  const form = el("form", { class: "card", onsubmit: async (e) => {
    e.preventDefault();
    if (saving || submit.disabled) return;
    const submitted = Number(count.value);
    saving = true;
    const controls = [...form.querySelectorAll("input, button")];
    controls.forEach((control) => { control.disabled = true; });
    update();
    try {
      const result = await api("/api/admin/settings", { method: "PUT", body: { table_count: submitted } });
      state.meta.table_ids = result.table_ids;
      savedCount = result.table_ids.length;
      toast("座席設定を保存しました");
    } catch (err) { toast(err.message, true); }
    finally { saving = false; controls.forEach((control) => { control.disabled = false; }); update(); }
  } },
  el("h2", {}, "座席設定"),
  el("p", { class: "muted" }, "全講習で共通の座席数です。A、B、C…の順に増やせます。Zの次はAAになります。"),
  el("div", { class: "row", style: "margin:16px 0" },
    el("label", { for: "seat-count" }, "座席数"),
    el("button", { type: "button", "aria-label": "座席を1つ減らす", onclick: () => step(-1) }, "−"),
    count,
    el("button", { type: "button", "aria-label": "座席を1つ増やす", onclick: () => step(1) }, "＋")),
  preview,
  el("p", { class: "muted", style: "margin-top:12px" }, "授業が割り当てられている席は削除できません。先に別の席へ移してください。"),
  status, submit);
  count.id = "seat-count";
  update();
  return form;
}

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
