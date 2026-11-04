// 割り当て画面（今のアプリ app.js の時間割と同じ操作）
//   ・生徒と科目を選ぶと、週ごとのカレンダーに「来られるコマ」「割り当て済みのコマ」「対応できる講師の数」が出る
//   ・コマを押す → 候補の講師から選んで割り当て（★は担当したことがある、⚠は別の生徒と重複）
//   ・講師チップを押すと連続入力、ドラッグで配置・移動
//   ・元に戻す／やり直し（Ctrl+Z / Ctrl+Y）
//   ・comiru への反映（この生徒だけ／全体）
//
// 速さのしくみ：
//   画面を開いたときに講習のデータ（講師・生徒の予定、割り当て）をまとめて読み込み、判定はすべて画面の中で行う。
//   操作は押した瞬間に表示し、裏で順番にサーバーへ保存する（サーバーでも最終確認する）。失敗した操作だけ元に戻す。
//   ほかの PC の変更は、数秒ごとに「前回から変わった分だけ」受け取って反映する。
import { api, DOW, el, fmtDate, toast } from "./common.js";

const POLL_MS = 2000; // 操作しているあいだの確認の間隔
const IDLE_POLL_MS = 15000; // しばらく触っていないときの確認の間隔（無料枠の1日のリクエスト数を節約）
const IDLE_AFTER_MS = 2 * 60 * 1000;
const COMIRU_STATUS_DELAY_MS = 3000;
const COMIRU_BATCH = 8;

const SUBJECT_TONES = [
  [/算数|数学|情報/, "math"],
  [/国語|現代文|古文|漢文/, "jp"],
  [/英語/, "en"],
  [/理科|物理|化学|生物|地学/, "sci"],
  [/社会|日本史|世界史|地理|倫政|公共/, "soc"],
];
const toneOf = (subject) => SUBJECT_TONES.find(([re]) => re.test(subject))?.[1] ?? "other";
const studentColors = (id) => {
  const hue = (id * 47 + 160) % 360;
  return `--student-bg:hsl(${hue} 72% 94%);--student-border:hsl(${hue} 62% 48%);--student-text:hsl(${hue} 45% 22%)`;
};
const slotKey = (date, period) => `${date}#${period}`;
const seatKey = (x) => `${x.student_id}#${x.date}#${x.period}`; // 生徒×日時（1コマに1授業）

// 並び順（サーバーの roster.ts と同じ：講師はふりがな順、生徒は学年→ふりがな順）
const GRADE_ORDER = ["小1", "小2", "小3", "小4", "小5", "小6", "中1", "中2", "中3", "高1", "高2", "高3", "その他"];
const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
const nameKey = (p) => String(p.name_kana || p.name || "").normalize("NFKC").replace(/\s+/g, "");
const compareNames = (a, b) => collator.compare(nameKey(a), nameKey(b)) || collator.compare(a.name ?? "", b.name ?? "") || (a.id ?? 0) - (b.id ?? 0);
const gradeRank = (p) => {
  const i = GRADE_ORDER.indexOf(p.grade);
  return i < 0 ? GRADE_ORDER.length : i;
};
const compareStudents = (a, b) => gradeRank(a) - gradeRank(b) || compareNames(a, b);

// 画面の状態（タブを切り替えても生徒・科目の選択は覚えておく）
const S = {
  term: null,
  meta: null,
  root: null,
  // サーバーで確定したデータ
  teachers: new Map(), // id → { id, name, name_kana, subjects:Set, slots:Set }
  students: new Map(), // id → { id, name, name_kana, grade, subjects:[], status, note, entered, slots:Set }
  assignments: new Map(), // id → { id, student_id, teacher_id, table_id, subject, date, period }
  cursor: 0, // 受け取り済みの変更記録の位置
  // まだサーバーに保存できていない操作（押した順に1つずつ送る）
  queue: [],
  sending: false,
  writeSeq: 0,
  nextTempId: -1,
  view: null, // 確定データ＋保存待ちの操作を重ねた「画面に出す状態」（キャッシュ）
  studentId: null,
  mode: "student",
  teacherId: null,
  weekIndex: 0,
  subject: null,
  conflictsOpen: false,
  modalOpen: false,
  drag: null,
  needsDraw: false,
  undo: [],
  redo: [],
  pollTimer: null,
  polling: false,
  lastPoll: 0,
  lastActivity: Date.now(),
  syncError: false,
  lastSync: null,
  brush: null, // 連続入力中の講師 { teacher_id, teacher_name, subject }
  comiruStatus: null,
  comiruTimer: null,
  comiruRunning: false,
  editStudent: null,
  closeOverlay: null,
  loadSeq: 0,
};

const base = () => `/api/admin/terms/${S.term.id}`;

// ------------------------------------------------------------ 入口

export const assignmentsSaving = () => S.queue.length > 0 || S.comiruRunning;

export function disposeAssignView() {
  clearInterval(S.pollTimer);
  clearTimeout(S.comiruTimer);
  S.root = null;
  S.loadSeq++;
  S.closeOverlay?.();
  S.closeOverlay = null;
  S.modalOpen = false;
  S.brush = null;
  cancelDrag();
}

export async function assignView(term, meta, { editStudent } = {}) {
  if (S.term?.id !== term.id) {
    Object.assign(S, { studentId: null, teacherId: null, weekIndex: 0, subject: null, undo: [], redo: [], brush: null });
  }
  S.term = term;
  S.meta = meta;
  S.editStudent = editStudent;
  S.root = el("div", { id: "assign-root" });
  const root = S.root;
  await loadSnapshot();
  if (S.root !== root) return root;
  draw();
  scheduleComiruStatus(0);
  startPolling();
  return root;
}

// ------------------------------------------------------------ データの読み込み

/** 講習のデータをまとめて読み込む（画面を開いたとき・講習の設定が変わったときだけ） */
async function loadSnapshot() {
  const seq = ++S.loadSeq;
  const snap = await api(`${base()}/assign/snapshot`);
  if (seq !== S.loadSeq) return;
  S.term = snap.term;
  S.meta = { ...S.meta, table_ids: snap.table_ids };
  S.cursor = snap.cursor;
  S.teachers = new Map(snap.teachers.map((t) => [t.id, toTeacher(t, snap.teacher_slots[t.id])]));
  S.students = new Map(snap.students.map((s) => [s.id, toStudent(s, snap.student_slots[s.id])]));
  S.assignments = new Map(snap.assignments.map((a) => [a.id, pickAssignment(a)]));
  S.syncError = false;
  S.lastSync = new Date();
  invalidate();
  const list = studentList();
  if (!list.some((s) => s.id === S.studentId)) S.studentId = list[0]?.id ?? null;
  fixSubject();
}

const toTeacher = (t, slots = []) => ({ ...t, subjects: new Set(t.subjects), slots: new Set(slots) });
const toStudent = (s, slots = []) => ({ ...s, slots: new Set(slots) });
const pickAssignment = (a) => ({
  id: a.id,
  student_id: Number(a.student_id),
  teacher_id: a.teacher_id == null ? null : Number(a.teacher_id),
  table_id: a.table_id,
  subject: a.subject,
  date: a.date,
  period: Number(a.period),
});

function fixSubject() {
  const subjects = S.students.get(S.studentId)?.subjects ?? [];
  if (!subjects.includes(S.subject)) S.subject = subjects[0] ?? null;
}

// ------------------------------------------------------------ ほかの PC の変更を受け取る

function startPolling() {
  clearInterval(S.pollTimer);
  S.pollTimer = setInterval(poll, POLL_MS);
}

async function poll() {
  const root = S.root;
  if (!root || !document.body.contains(root)) return clearInterval(S.pollTimer);
  // 自分の保存が終わるまでは待つ（保存の結果と受け取った記録が前後しないように）
  if (document.hidden || S.polling || S.queue.length || S.comiruRunning) return;
  const idle = Date.now() - S.lastActivity > IDLE_AFTER_MS;
  if (idle && Date.now() - S.lastPoll < IDLE_POLL_MS) return;
  S.lastPoll = Date.now();
  S.polling = true;
  const seq = S.writeSeq;
  try {
    const r = await api(`${base()}/assign/changes?since=${S.cursor}`);
    if (S.root !== root || seq !== S.writeSeq || S.queue.length) return; // 途中で自分が保存した → 次の回に取り直す
    let changed = true;
    if (r.reload) {
      await loadSnapshot();
    } else {
      S.cursor = r.cursor;
      changed = await applyEvents(r.events);
    }
    const recovered = S.syncError;
    S.syncError = false;
    S.lastSync = new Date();
    if (S.root !== root) return;
    if (changed) draw(); // 変更がなければ描き直さない（入力中の欄やドラッグを邪魔しない）
    else if (recovered) updateSaveStatus();
  } catch {
    S.syncError = true;
    updateSaveStatus();
  } finally {
    S.polling = false;
  }
}

/** 変更記録を手元のデータに反映する。画面に関係する変更があれば true */
async function applyEvents(events) {
  if (!events.length) return false;
  const teacherIds = new Set();
  const studentIds = new Set();
  let reload = false;
  let assignmentsChanged = false;
  for (const e of events) {
    if (e.kind === "assignment") {
      const a = pickAssignment(e.payload);
      for (const [id, x] of S.assignments) if (id !== a.id && seatKey(x) === seatKey(a)) S.assignments.delete(id);
      S.assignments.set(a.id, a);
      assignmentsChanged = true;
    } else if (e.kind === "assignment_deleted") {
      S.assignments.delete(e.payload.id);
      assignmentsChanged = true;
    } else if (e.kind === "teacher") {
      // 講習の予定の提出は新しい講師のこともあるので必ず取る。科目・名前の変更は画面に出ている講師だけ
      if (e.term_id != null || S.teachers.has(e.ref_id)) teacherIds.add(e.ref_id);
    } else if (e.kind === "student") {
      if (e.term_id != null || S.students.has(e.ref_id)) studentIds.add(e.ref_id);
    } else if (e.kind === "comiru") {
      scheduleComiruStatus();
    } else if (e.kind === "reload") {
      reload = true;
    }
  }
  if (reload) {
    await loadSnapshot();
    return true;
  }
  await Promise.all([
    ...[...teacherIds].map(async (id) => {
      const r = await api(`${base()}/assign/teachers/${id}/info`).catch(() => null);
      if (r) S.teachers.set(id, toTeacher(r.teacher, r.slots));
    }),
    ...[...studentIds].map(async (id) => {
      const r = await api(`${base()}/assign/students/${id}/info`).catch(() => null);
      if (r) S.students.set(id, toStudent(r.student, r.slots));
    }),
  ]);
  if (assignmentsChanged) scheduleComiruStatus();
  invalidate();
  fixSubject();
  return assignmentsChanged || teacherIds.size > 0 || studentIds.size > 0;
}

function scheduleComiruStatus(delay = COMIRU_STATUS_DELAY_MS) {
  clearTimeout(S.comiruTimer);
  const root = S.root;
  S.comiruTimer = setTimeout(async () => {
    if (S.root !== root) return;
    try {
      S.comiruStatus = await api(`${base()}/comiru/status`);
    } catch {
      S.comiruStatus = null;
    }
    if (S.root !== root) return;
    // 件数とボタンの部分だけ書き換える（画面全体を描き直すと、操作中の部品が作り直されてしまうため）
    S.root.querySelector(".comiru-actions")?.replaceWith(comiruActions());
    updateSaveStatus();
  }, delay);
}

// ------------------------------------------------------------ 画面に出す状態（確定データ＋保存待ちの操作）

function invalidate() {
  S.view = null;
}

/** 保存待ちの操作を重ねた割り当てと、引きやすいように整理したもの */
function view() {
  if (S.view) return S.view;
  const bySeat = new Map();
  for (const a of S.assignments.values()) bySeat.set(seatKey(a), a);
  for (const op of S.queue) {
    if (op.before) bySeat.delete(seatKey(op.before));
    if (op.after) bySeat.set(seatKey(op.after), { ...op.after, id: op.tempId, pending: true });
  }
  const bySlot = new Map();
  const byStudent = new Map();
  const byTeacher = new Map();
  for (const a of bySeat.values()) {
    const k = slotKey(a.date, a.period);
    (bySlot.get(k) ?? bySlot.set(k, []).get(k)).push(a);
    (byStudent.get(a.student_id) ?? byStudent.set(a.student_id, []).get(a.student_id)).push(a);
    if (a.teacher_id != null) (byTeacher.get(a.teacher_id) ?? byTeacher.set(a.teacher_id, []).get(a.teacher_id)).push(a);
  }
  S.view = { bySeat, bySlot, byStudent, byTeacher };
  return S.view;
}

const teacherName = (id) => (id == null ? "講師未定" : S.teachers.get(id)?.name ?? "（講師）");
const studentName = (id) => S.students.get(id)?.name ?? "（生徒）";

/** 割り当てのエラー（サーバーの FLAGS_SQL と同じ5種類） */
function flagsOf(a, v = view()) {
  const key = slotKey(a.date, a.period);
  const others = (v.bySlot.get(key) ?? []).filter((x) => x.student_id !== a.student_id);
  const t = a.teacher_id == null ? null : S.teachers.get(a.teacher_id);
  const flags = {
    has_teacher_conflict: a.teacher_id != null && others.some((x) => x.teacher_id === a.teacher_id),
    has_table_conflict: others.some((x) => x.table_id === a.table_id),
    has_schedule_mismatch: a.teacher_id != null && (!t || !t.slots.has(key) || !t.subjects.has(a.subject)),
    has_student_schedule_mismatch: !S.students.get(a.student_id)?.slots.has(key),
    has_slot_invalid: !slotInTerm(a.date, a.period), // あとから休校日・期間外にした日時
  };
  return { ...flags, has_conflict: Object.values(flags).some(Boolean) };
}

function studentHasError(id, v = view()) {
  return (v.byStudent.get(id) ?? []).some((a) => flagsOf(a, v).has_conflict);
}

/** 生徒一覧（予定を入力した生徒、または授業が入っている生徒） */
function studentList() {
  const v = view();
  return [...S.students.values()]
    .filter((s) => s.entered || v.byStudent.has(s.id))
    .map((s) => {
      const hasError = studentHasError(s.id, v);
      return { ...s, assignment_count: (v.byStudent.get(s.id) ?? []).length, has_error: hasError, display_status: hasError ? "要調整" : s.status };
    })
    .sort(compareStudents);
}

/** 生徒1人分の時間割 */
function board(studentId = S.studentId) {
  const st = S.students.get(studentId);
  if (!st) return null;
  const v = view();
  const assignments = (v.byStudent.get(studentId) ?? [])
    .map((a) => ({ ...a, teacher_name: teacherName(a.teacher_id), teacher_name_kana: S.teachers.get(a.teacher_id)?.name_kana ?? "", ...flagsOf(a, v) }))
    .sort((x, y) => (x.date === y.date ? x.period - y.period : x.date < y.date ? -1 : 1));
  const subject_counts = {};
  for (const a of assignments) subject_counts[a.subject] = (subject_counts[a.subject] ?? 0) + 1;
  const has_error = assignments.some((a) => a.has_conflict);
  return { student: { ...st, has_error, display_status: has_error ? "要調整" : st.status }, assignments, subject_counts };
}

/** 講師がそのコマに来られて、その科目を教えられるか（comiru の講師名簿から外れた講師は除く） */
const canTeach = (t, key, subject) => t.active !== false && t.slots.has(key) && t.subjects.has(subject);

/** 講習の設定（期間・時限・休校日）の中のコマか */
function slotInTerm(date, period) {
  const term = S.term;
  return term.dates.includes(date) && term.periods.includes(Number(period)) && !term.closed_dates.includes(date);
}

/** 生徒が来られるコマごとの「その科目を教えられる講師の数」と「そのうち空いている数」 */
function slotSummary(studentId, subject) {
  const st = S.students.get(studentId);
  const result = new Map();
  if (!st || !subject) return result;
  const v = view();
  for (const key of st.slots) {
    let total = 0;
    let free = 0;
    const busy = new Set((v.bySlot.get(key) ?? []).map((a) => a.teacher_id));
    for (const t of S.teachers.values()) {
      if (!canTeach(t, key, subject)) continue;
      total++;
      if (!busy.has(t.id)) free++;
    }
    result.set(key, { total_teacher_count: total, free_teacher_count: free });
  }
  return result;
}

/** そのコマに割り当てられる講師（ふりがな順。★＝この生徒を担当した回数、⚠＝別の生徒と重複） */
function candidates(date, period, subject, studentId) {
  const key = slotKey(date, period);
  const v = view();
  const mine = v.byStudent.get(studentId) ?? [];
  const others = (v.bySlot.get(key) ?? []).filter((a) => a.student_id !== studentId);
  return [...S.teachers.values()]
    .filter((t) => canTeach(t, key, subject))
    .map((t) => {
      const clash = others.filter((a) => a.teacher_id === t.id).map((a) => studentName(a.student_id)).sort(collator.compare);
      return {
        teacher_id: t.id,
        name: t.name,
        name_kana: t.name_kana,
        availability_count: t.slots.size,
        assignment_count: mine.filter((a) => a.teacher_id === t.id).length,
        has_conflict: clash.length > 0,
        conflict_with: clash[0] ?? null,
      };
    })
    .sort(compareNames);
}

/** そのコマで、ほかの生徒が使っていない最初の席（サーバーの自動選択と同じ順） */
function guessTable(date, period, studentId) {
  const used = new Set((view().bySlot.get(slotKey(date, period)) ?? []).filter((a) => a.student_id !== studentId).map((a) => a.table_id));
  return S.meta.table_ids.find((t) => !used.has(t)) ?? null;
}

/** 講習全体の重複・不一致（サーバーの conflicts と同じ4種類＋休校日・期間外） */
function conflicts() {
  const v = view();
  const list = [];
  for (const [key, items] of v.bySlot) {
    const [date, p] = key.split("#");
    const period = Number(p);
    const group = (keyOf) => {
      const map = new Map();
      for (const a of items) {
        const k = keyOf(a);
        if (k == null) continue;
        (map.get(k) ?? map.set(k, []).get(k)).push(a);
      }
      return map;
    };
    for (const [teacherId, as] of group((a) => a.teacher_id)) {
      const students = [...new Set(as.map((a) => a.student_id))];
      if (students.length > 1) list.push({ type: "teacher", date, period, label: `${teacherName(teacherId)}（講師重複）`, students: students.map(studentName) });
    }
    for (const [tableId, as] of group((a) => a.table_id)) {
      const students = [...new Set(as.map((a) => a.student_id))];
      if (students.length > 1) list.push({ type: "table", date, period, label: `席${tableId}（席重複）`, students: students.map(studentName) });
    }
    for (const [teacherId, as] of group((a) => a.teacher_id)) {
      const t = S.teachers.get(teacherId);
      const bad = as.filter((a) => !t || !canTeach(t, key, a.subject));
      if (bad.length) list.push({ type: "schedule", date, period, label: `${teacherName(teacherId)}（講師予定不一致）`, students: [...new Set(bad.map((a) => studentName(a.student_id)))] });
    }
    const unavailable = items.filter((a) => !S.students.get(a.student_id)?.slots.has(key));
    if (unavailable.length) list.push({ type: "student_schedule", date, period, label: "生徒予定（受講不可）", students: [...new Set(unavailable.map((a) => studentName(a.student_id)))] });
    if (!slotInTerm(date, period)) list.push({ type: "slot", date, period, label: "休校日・期間外の授業", students: [...new Set(items.map((a) => studentName(a.student_id)))] });
  }
  return list.sort((x, y) => (x.date === y.date ? x.period - y.period : x.date < y.date ? -1 : 1));
}

// ------------------------------------------------------------ 割り当ての操作（押した瞬間に表示し、裏で順番に保存）

const snapshot = (a) =>
  a ? { student_id: a.student_id ?? S.studentId, teacher_id: a.teacher_id, table_id: a.table_id, subject: a.subject, date: a.date, period: Number(a.period) } : null;
const sameSeat = (a, b) => a && b && seatKey(a) === seatKey(b);

/**
 * before（今の割り当て。なければ null）を after（新しい割り当て。消すなら null）に変える。
 * request は席の自動選択（"auto"）や、サーバーでの確認の指定。画面には席の予想を先に出す。
 */
function change(before, after, { message, strict = false, onlyIfEmpty = false, record = true, action = null, kind = "new" } = {}) {
  let shown = after;
  if (after) {
    const table = after.table_id === "auto" ? guessTable(after.date, after.period, after.student_id) : after.table_id;
    if (!table) {
      toast("空いている席がありません。座席設定で席を増やすか、別のコマを選んでください", true);
      return false;
    }
    shown = { ...after, table_id: table };
  }
  const act = action ?? (record ? { before, after: shown } : null);
  if (act && !action) {
    S.undo.push(act);
    S.redo = [];
  }
  S.queue.push({
    tempId: S.nextTempId--,
    before,
    after: shown,
    request: after ? { ...after, strict_availability: strict, only_if_empty: onlyIfEmpty } : null,
    action: act,
    kind, // new（ふつうの操作）/ undo（元に戻す）/ redo（やり直す）
  });
  S.writeSeq++;
  invalidate();
  draw();
  if (message) toast(message);
  pump();
  return true;
}

/** 保存待ちの操作を1つずつサーバーへ送る */
async function pump() {
  if (S.sending) return;
  S.sending = true;
  const root = S.root;
  while (S.queue.length && S.root === root) {
    const op = S.queue[0];
    try {
      const res = await send(op);
      confirmOp(op, res);
    } catch (err) {
      failOp(op, err);
    }
    S.queue.shift();
    S.writeSeq++;
    invalidate();
    if (S.root === root) draw();
  }
  S.sending = false;
  if (S.root !== root) return;
  scheduleComiruStatus();
  if (S.staleSeen) {
    S.staleSeen = false;
    S.lastPoll = 0;
    setTimeout(poll, 0);
  }
}

/** 確定データの中から、その生徒・日時の割り当てを探す */
const confirmedAt = (snap) => [...S.assignments.values()].find((a) => sameSeat(a, snap)) ?? null;

/** 画面が見ていた変更前の状態（サーバーはこれと今の状態が同じときだけ書き込む。違えば 409） */
const expectOf = (a) => (a ? { teacher_id: a.teacher_id, table_id: a.table_id, subject: a.subject, date: a.date, period: Number(a.period) } : null);

async function send(op) {
  const { before, request } = op;
  if (before && request && !sameSeat(before, request)) {
    const current = confirmedAt(before);
    if (!current) throw new Error("移動元の授業が見つかりません（ほかの人が先に変更した可能性があります）");
    return api(`${base()}/assignments/${current.id}`, { method: "PATCH", body: { ...request, expect: expectOf(before) } });
  }
  if (request) return api(`${base()}/assignments`, { method: "POST", body: { ...request, expect: expectOf(before) } });
  const current = before && confirmedAt(before);
  if (!current) return null;
  await api(`${base()}/assignments/${current.id}`, { method: "DELETE", body: { expect: expectOf(before) } });
  return { deleted: current.id };
}

function confirmOp(op, res) {
  for (const [id, a] of S.assignments) {
    if ((op.before && sameSeat(a, op.before)) || (op.after && sameSeat(a, op.after))) S.assignments.delete(id);
  }
  if (res?.id && op.after) {
    const saved = pickAssignment(res);
    S.assignments.set(saved.id, saved);
    // 席を自動で選んだ場合は、元に戻すときのためにサーバーが選んだ席を覚える
    if (op.action?.after && sameSeat(op.action.after, saved)) op.action.after.table_id = saved.table_id;
    // 続けて同じコマを操作している場合は、その「変更前」をサーバーで確定した内容にそろえる（自分の操作同士で食い違いにしない）
    for (const later of S.queue) {
      if (later !== op && later.before && sameSeat(later.before, saved)) later.before = { ...later.before, ...snapshot(saved) };
    }
  }
}

function failOp(op, err) {
  if (err?.status === 409) S.staleSeen = true; // ほかの人が先に変えていた → 保存待ちが終わったらすぐ最新にする
  const slot = op.after ?? op.before;
  const what = op.kind === "undo" ? "元に戻せませんでした" : op.kind === "redo" ? "やり直せませんでした" : "保存できませんでした";
  toast(`${fmtDate(slot.date)} ${slot.period}限：${what}（${err.message}）。表示を元に戻しました`, true);
  const remove = (stack) => {
    const i = stack.indexOf(op.action);
    if (i >= 0) stack.splice(i, 1);
  };
  if (op.kind === "undo") {
    // 元に戻すのに失敗 → もう一度「元に戻す」を押せるように戻しておく
    remove(S.redo);
    S.undo.push(op.action);
  } else if (op.kind === "redo") {
    remove(S.undo);
    S.redo.push(op.action);
  } else {
    // ふつうの操作の失敗は、なかったことにする
    remove(S.undo);
    remove(S.redo);
  }
}

function undoOrRedo(kind) {
  const stack = kind === "undo" ? S.undo : S.redo;
  const action = stack.at(-1);
  if (!action) return;
  const [from, to] = kind === "undo" ? [action.after, action.before] : [action.before, action.after];
  // 自分の操作後に別の職員が直した授業は、Undoでも上書きしない。
  const current = from ? view().bySeat.get(seatKey(from)) : null;
  const target = to ? view().bySeat.get(seatKey(to)) : null;
  if ((from && (!current || JSON.stringify(snapshot(current)) !== JSON.stringify(snapshot(from)))) || (target && !sameSeat(from, to))) {
    toast("この操作の後に授業が変更されています。最新の授業を確認してから修正してください", true);
    return;
  }
  stack.pop();
  (kind === "undo" ? S.redo : S.undo).push(action);
  const ok = change(current ? snapshot(current) : null, to, { action, kind, message: kind === "undo" ? "元に戻しました" : "やり直しました" });
  if (!ok) (kind === "undo" ? S.redo : S.undo).pop();
  const studentId = (to ?? from)?.student_id;
  if (studentId && studentId !== S.studentId) {
    S.studentId = studentId;
    S.brush = null;
    fixSubject();
    draw();
  }
}

// 操作したら確認の間隔を短く戻す（触っていなければ間隔をあけて節約する）
for (const type of ["pointerdown", "keydown", "wheel"]) {
  document.addEventListener(type, () => {
    const wasIdle = Date.now() - S.lastActivity > IDLE_AFTER_MS;
    S.lastActivity = Date.now();
    if (wasIdle) poll(); // 久しぶりに触ったら、すぐ最新にする
  }, { passive: true, capture: true });
}

document.addEventListener("keydown", (e) => {
  if (!S.root || !document.body.contains(S.root) || S.modalOpen) return;
  if (e.target.closest?.("input, textarea, select")) return;
  if (e.key === "Escape" && S.brush) {
    e.preventDefault();
    setBrush(null);
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
    e.preventDefault();
    undoOrRedo("undo");
  } else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
    e.preventDefault();
    undoOrRedo("redo");
  }
});

/** 保存待ちがなくなるまで待つ（comiru への反映の前など） */
async function drained() {
  while (S.queue.length) await new Promise((r) => setTimeout(r, 100));
}

// ------------------------------------------------------------ 描画

function draw({ force = false } = {}) {
  if (!S.root) return;
  if (S.drag?.moved && !force) {
    S.needsDraw = true; // ドラッグ中は描き直さない（終わってから）
    return;
  }
  const active = document.activeElement;
  if (active && S.root.contains(active) && active.matches("input, textarea")) {
    // 検索欄などに入力中は描き直さない（入力が途切れないように）。欄から離れたら描き直す
    if (!S.needsDraw) active.addEventListener("blur", () => setTimeout(() => S.needsDraw && draw(), 0), { once: true });
    S.needsDraw = true;
    updateSaveStatus();
    return;
  }
  S.needsDraw = false;
  const students = studentList();
  if (!students.length && S.mode === "student") {
    S.root.replaceChildren(
      viewSwitch(),
      el("div", { class: "notice info" }, "まだ予定を入力した生徒がいません。「名簿・予定」の「生徒」で予定を入力してください。"),
    );
    return;
  }
  if (!students.some((s) => s.id === S.studentId)) {
    S.studentId = students[0]?.id ?? null;
    fixSubject();
  }
  const b = board();
  // 割り当てのたびに描き直しても、カレンダーの位置が動かないようにする：
  // 画面の真ん中にあるマスを目印にして、描き直したあとも同じ位置に来るようにスクロールを合わせる
  const mark = document.elementFromPoint(window.innerWidth / 2, window.innerHeight * 0.6)?.closest?.("td[data-key]");
  const markKey = mark?.dataset.key;
  const markTop = mark?.getBoundingClientRect().top;
  const y = window.scrollY;
  S.root.replaceChildren(
    el("div", { class: "assign-head" },
      S.mode === "teacher" ? teacherToolbar() : toolbar(b, students), S.mode === "student" ? palette(b) : null, conflictBar(),
      // 表示と週の切替はカレンダーのすぐ上の1行（ドラッグ中も週のボタンの上で少し止めると週が変わる）
      el("div", { class: "assign-navigation" }, viewSwitch(), weekNavigation())),
    ...[S.mode === "teacher" ? teacherGrid() : grid(b)].filter(Boolean),
  );
  window.scrollTo(0, y);
  const after = markKey && S.root.querySelector(`td[data-key="${markKey}"]`);
  if (after) window.scrollBy(0, after.getBoundingClientRect().top - markTop);
}

function viewSwitch() {
  return el("div", { class: "assign-view-switch", role: "group", "aria-label": "時間割の表示" },
    [["student", "生徒から見る"], ["teacher", "講師から見る"]].map(([mode, label]) => el("button", {
      type: "button", class: `btn-small${S.mode === mode ? " selected" : ""}`, "aria-pressed": String(S.mode === mode),
      onclick: () => {
        S.closeOverlay?.();
        S.mode = mode;
        S.brush = null;
        draw();
      },
    }, label)),
  );
}

function selectStudent(id) {
  S.studentId = id;
  S.mode = "student";
  S.brush = null;
  fixSubject();
  draw();
}

function studentPicker(students) {
  const current = students.find((s) => s.id === S.studentId);
  const input = el("input", { type: "text", placeholder: "生徒を検索", value: current?.name ?? "", autocomplete: "off" });
  const list = el("div", { class: "suggest hidden" });
  const statusBadge = (s) =>
    el("span", { class: `badge ${s.display_status === "要調整" ? "danger" : s.display_status === "完了" ? "ok" : ""}` }, s.display_status);
  const choose = (s) => {
    list.classList.add("hidden");
    selectStudent(s.id);
  };
  const show = () => {
    const q = input.value === current?.name ? "" : input.value.normalize("NFKC").replace(/\s+/g, "");
    const hits = students.filter((s) => !q || s.name.normalize("NFKC").replace(/\s+/g, "").includes(q) || nameKey(s).includes(q));
    list.replaceChildren(
      ...hits.map((s) =>
        el(
          "button",
          { type: "button", class: `suggest-item${s.id === S.studentId ? " current" : ""}`, onclick: () => choose(s) },
          el("span", {}, s.grade ? el("span", { class: "badge" }, s.grade) : null, " ", s.name),
          el("span", { class: "row", style: "gap:6px" }, el("span", { class: "muted" }, `${s.assignment_count}コマ`), statusBadge(s)),
        ),
      ),
    );
    list.classList.remove("hidden");
  };
  input.addEventListener("focus", () => {
    input.select();
    show();
  });
  input.addEventListener("input", show);
  input.addEventListener("blur", () => setTimeout(() => list.classList.add("hidden"), 200));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") list.querySelector("button")?.click();
  });
  return el("div", { class: "student-adder", style: "min-width:220px" }, input, list);
}

function toolbar(b, students) {
  const st = b?.student;
  const subjectSelect = el(
    "select",
    {
      style: "width:auto",
      onchange: (e) => {
        S.subject = e.target.value;
        S.brush = null;
        draw();
      },
    },
    (st?.subjects ?? []).map((s) => el("option", { value: s, selected: s === S.subject }, s)),
  );
  const statusSelect = el(
    "select",
    {
      style: "width:auto",
      disabled: st?.has_error,
      title: st?.has_error ? "エラーのあるコマを直すと変更できます" : "",
      onchange: async (e) => {
        const status = e.target.value;
        const studentId = S.studentId;
        try {
          await drained();
          await api(`${base()}/assign/students/${studentId}/status`, { method: "PATCH", body: { status } });
          const s = S.students.get(studentId);
          if (s) s.status = status;
          invalidate();
          toast(`ステータスを「${status}」にしました`);
        } catch (err) {
          toast(err.message, true);
        }
        draw();
      },
    },
    ["調整中", "完了"].map((s) => el("option", { value: s, selected: st?.status === s }, s)),
  );

  const counts = (st?.subjects ?? []).map((subject) => [subject, b?.subject_counts[subject] ?? 0]);

  return el(
    "div",
    { class: "card assign-toolbar" },
    el(
      "div",
      { class: "row", style: "justify-content:space-between;align-items:flex-start" },
      el(
        "div",
        { class: "row" },
        el("strong", {}, "生徒"),
        studentPicker(students),
        S.editStudent && st ? el("button", { type: "button", class: "btn-small", onclick: editCurrentStudent }, "予定・科目を編集") : null,
        el("strong", {}, "科目"),
        st?.subjects.length ? subjectSelect : el("span", { class: "badge warn" }, "受講科目が未入力です（生徒タブで入力）"),
        el("strong", {}, "状態"),
        st?.has_error ? el("span", { class: "badge danger" }, "要調整") : statusSelect,
      ),
      historyActions(),
    ),
    el(
      "div",
      { class: "assignment-summary" },
      el(
        "div",
        { class: "assigned-counts" },
        el("span", { class: "muted" }, "割り当て済み："),
        counts.length
          ? counts.map(([subject, n]) => el("span", { class: `count-chip tone-${toneOf(subject)}` }, `${subject} ${n}コマ`))
          : el("span", { class: "muted" }, "なし"),
      ),
      comiruActions(),
    ),
    el("div", { class: "assignment-save-status", role: "status", "aria-live": "polite" }, saveStatusText()),
    st?.note ? el("div", { class: "notice info", style: "margin:8px 0 0" }, `備考：${st.note}`) : null,
  );
}

function historyActions() {
  return el("div", { class: "row" },
    el("button", { type: "button", class: "btn-small", disabled: !S.undo.length, title: "Ctrl+Z", onclick: () => undoOrRedo("undo") }, "↶ 元に戻す"),
    el("button", { type: "button", class: "btn-small", disabled: !S.redo.length, title: "Ctrl+Y", onclick: () => undoOrRedo("redo") }, "↷ やり直す"),
  );
}

// ------------------------------------------------------------ 講師から見る（同じ保存キューと手元のデータを使う）

function calendarTeachers() {
  return [...S.teachers.values()].filter((t) => t.active !== false || view().byTeacher.has(t.id)).sort(compareNames);
}

function teacherToolbar() {
  const teachers = calendarTeachers();
  if (!teachers.some((t) => t.id === S.teacherId)) S.teacherId = teachers[0]?.id ?? null;
  const t = S.teachers.get(S.teacherId);
  const count = (view().byTeacher.get(S.teacherId) ?? []).length;
  return el("div", { class: "card assign-toolbar teacher-toolbar" },
    el("div", { class: "row", style: "justify-content:space-between" },
      el("div", { class: "row" },
        el("label", { for: "calendar-teacher" }, "講師"),
        el("select", { id: "calendar-teacher", style: "width:auto;max-width:100%", onchange: (e) => { S.teacherId = Number(e.target.value); draw(); } },
          teachers.map((x) => el("option", { value: x.id, selected: x.id === S.teacherId }, `${x.name}${x.active === false ? "（名簿対象外）" : ""}`))),
        t ? el("span", { class: "muted" }, `${[...t.subjects].join("・")} ／ ${count}コマ`) : null,
      ), historyActions(),
    ),
    el("div", { class: "row teacher-calendar-help" },
      el("span", { class: "muted" }, "空きコマから生徒を選んで配置できます。授業を押すと詳細が開きます。"),
      comiruActions(),
    ),
    el("div", { class: "assignment-save-status", role: "status", "aria-live": "polite" }, saveStatusText()),
  );
}

function teacherGrid() {
  const t = S.teachers.get(S.teacherId);
  if (!t) return el("div", { class: "notice info" }, "まだ予定を提出した講師がいません。「名簿・予定」で提出状況を確認してください。");
  return weeklyGrid((date, period) => {
    if (!date) return el("td", { class: "acell out" });
    const key = slotKey(date, period);
    const assignments = (view().bySlot.get(key) ?? []).filter((a) => a.teacher_id === t.id);
    const closed = S.term.closed_dates.includes(date);
    const td = el("td", { class: "acell teacher-cell", dataset: { key, date, period } });
    if (assignments.length) {
      td.classList.add("assigned");
      if (assignments.some((a) => a.pending)) td.classList.add("pending");
      if (assignments.some((a) => flagsOf(a).has_conflict)) td.classList.add("conflict");
      for (const a of assignments) td.append(el("button", {
        type: "button", class: "teacher-lesson", style: studentColors(a.student_id), onclick: (e) => openTeacherLesson(a, e.currentTarget),
        "aria-label": `${studentName(a.student_id)} ${a.subject} 席${a.table_id}${a.pending ? " 保存中" : ""}`,
      }, el("span", {}, studentName(a.student_id)), el("small", {}, `${a.subject}・席${a.table_id}${a.pending ? "・保存中" : ""}`)));
    } else if (closed) {
      td.classList.add("closed");
      if (period === S.term.periods[0]) td.append("休");
    } else if (!t.slots.has(key) || t.active === false) {
      td.classList.add("unavailable");
    } else {
      const full = !guessTable(date, period, -1);
      td.classList.add("open", ...(full ? ["full"] : ["has-teacher"]));
      td.append(el("button", {
        type: "button", class: "teacher-open-slot", disabled: full,
        "aria-label": `${fmtDate(date)} ${period}限 ${full ? "満席" : "空き・生徒を選ぶ"}`,
        onclick: (e) => openStudentPicker(t.id, date, period, e.currentTarget),
      }, full ? "満席" : "空き"));
    }
    return td;
  }, "teacher-grid");
}

function eligibleStudents(teacherId, date, period) {
  const key = slotKey(date, period), t = S.teachers.get(teacherId), v = view();
  if (!t || t.active === false || !t.slots.has(key) || !slotInTerm(date, period)) return [];
  if ((v.bySlot.get(key) ?? []).some((a) => a.teacher_id === teacherId)) return [];
  return [...S.students.values()].filter((s) => s.entered && s.slots.has(key) && !v.bySeat.has(seatKey({ student_id: s.id, date, period })))
    .sort(compareStudents).map((s) => ({ student: s, subjects: s.subjects.filter((subject) => t.subjects.has(subject)) })).filter((x) => x.subjects.length);
}

/** 新しい補助欄はクリック・キーボードどちらでも操作し、閉じたら元のコマへ戻す。 */
function assignmentPopover(title, anchor, content) {
  if (S.modalOpen) return;
  S.modalOpen = true;
  const close = () => {
    layer.remove();
    document.removeEventListener("keydown", onKey, true);
    S.modalOpen = false;
    S.closeOverlay = null;
    if (anchor?.isConnected) anchor.focus();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === "Tab") {
      const controls = [...pop.querySelectorAll("button:not(:disabled), input, select")];
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };
  const pop = el("div", { class: "popover", role: "dialog", "aria-label": title, "aria-modal": "true" },
    el("div", { class: "modal-head" }, el("strong", {}, title), el("button", { type: "button", class: "btn-small", onclick: close }, "閉じる")),
    content(close),
  );
  const layer = el("div", { class: "popover-layer", onclick: (e) => e.target === layer && close() }, pop);
  document.body.append(layer);
  S.closeOverlay = close;
  document.addEventListener("keydown", onKey, true);
  const r = anchor.getBoundingClientRect();
  const left = r.right + 8 + pop.offsetWidth <= innerWidth - 8 ? r.right + 8 : r.left - pop.offsetWidth - 8;
  Object.assign(pop.style, {
    left: `${Math.max(8, Math.min(left, innerWidth - pop.offsetWidth - 8))}px`,
    top: `${Math.max(8, Math.min(r.top, innerHeight - pop.offsetHeight - 8))}px`,
  });
  (pop.querySelector("input") ?? pop.querySelector("button"))?.focus();
}

function openStudentPicker(teacherId, date, period, anchor) {
  assignmentPopover(`${fmtDate(date)} ${period}限・${teacherName(teacherId)}`, anchor, (close) => {
    const search = el("input", { type: "text", placeholder: "名前・ふりがなで検索", "aria-label": "配置する生徒を検索", autocomplete: "off" });
    const list = el("div", { class: "student-candidates", "aria-live": "polite" });
    const choose = (student, subject) => {
      // 欄を開いた後に受け取った変更も確認し、古い候補のまま上書きしない。
      if (!eligibleStudents(teacherId, date, period).some((x) => x.student.id === student.id && x.subjects.includes(subject))) {
        toast("予定が変わりました。配置できる生徒を選び直してください", true);
        refresh();
        return;
      }
      close();
      change(null, { student_id: student.id, teacher_id: teacherId, subject, date, period, table_id: "auto" }, {
        strict: true, onlyIfEmpty: true, message: `${student.name} を割り当てました`,
      });
    };
    const refresh = () => {
      const q = search.value.normalize("NFKC").replace(/\s+/g, "");
      const rows = eligibleStudents(teacherId, date, period).filter(({ student: s }) => !q || nameKey(s).includes(q) || s.name.normalize("NFKC").replace(/\s+/g, "").includes(q));
      list.replaceChildren(...(rows.length ? rows.map(({ student: s, subjects }) => el("div", { class: "student-candidate" },
        el("div", {}, s.name, s.grade ? el("span", { class: "muted" }, `（${s.grade}）`) : null),
        el("div", { class: "row" }, subjects.map((subject) => el("button", { type: "button", class: "btn-small", "aria-label": `${s.name}・${subject}を配置`, onclick: () => choose(s, subject) }, subject))),
      )) : [el("p", { class: "muted" }, "通塾予定と科目が合い、授業がまだ入っていない生徒はいません。") ]));
    };
    search.addEventListener("input", refresh);
    refresh();
    return el("div", {}, el("p", { class: "muted" }, "配置する生徒と科目を選んでください。席は自動で選びます。"), search, list);
  });
}

function openTeacherLesson(assignment, anchor) {
  const a = assignment;
  assignmentPopover(`${fmtDate(a.date)} ${a.period}限`, anchor, (close) => el("div", {},
    el("p", {}, `${studentName(a.student_id)}・${a.subject}`),
    el("p", { class: "muted" }, `${teacherName(a.teacher_id)}・席${a.table_id}${a.pending ? "（確認・保存中）" : ""}`),
    flagsOf(a).has_conflict ? el("p", { class: "warn-text" }, "予定の不一致または重複があります。生徒の時間割で確認してください。") : null,
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn-small", onclick: () => { close(); selectStudent(a.student_id); } }, "この生徒の時間割を開く"),
      el("button", { type: "button", class: "btn-small btn-danger", disabled: a.pending, onclick: () => {
        const current = view().bySeat.get(seatKey(a));
        if (!current || current.pending || current.id !== a.id || JSON.stringify(snapshot(current)) !== JSON.stringify(snapshot(a))) {
          close(); toast("授業が変更されています。最新の授業を確認してください", true); draw(); return;
        }
        close(); change(snapshot(a), null, { message: "割り当てを削除しました" });
      } }, "この割り当てを削除"),
    ),
  ));
}

// ------------------------------------------------------------ コピペ用（comiru 連携が止まったとき、元の GAS のシートに貼って登録する逃げ道）

// 今のアプリ（app.py 版）の「コピペ用をコピー」と同じ形：生徒名・講師名・科目・日付・時限（タブ区切り）
const SHEET_PERIOD_LABELS = { 2: "2限（10:45-12:15）", 3: "3限（13:15-14:45）", 4: "4限（15:00-16:30）", 5: "5限（16:45-18:15）", 6: "6限（18:30-20:00）", 7: "7限（例外）" };
function sheetSubject(subject) {
  const s = String(subject || "");
  if (/算数/.test(s)) return "算数";
  if (/中学数学|数学Ⅰ・A|数学Ⅱ・B|数学Ⅲ・C|情報/.test(s)) return "数学";
  if (/中学受験国語|中学国語/.test(s)) return "国語";
  if (/現代文/.test(s)) return "現代文";
  if (/古文|漢文/.test(s)) return "古文・漢文";
  if (/中学受験理科|中学理科|地学/.test(s)) return "理科";
  if (/物理/.test(s)) return "物理";
  if (/化学/.test(s)) return "化学";
  if (/生物/.test(s)) return "生物";
  if (/中学受験社会|中学社会|倫政|公共/.test(s)) return "社会";
  if (/日本史/.test(s)) return "日本史";
  if (/世界史/.test(s)) return "世界史";
  if (/地理/.test(s)) return "地理";
  if (/英語/.test(s)) return "英語";
  return s;
}

/** studentId を指定すればその生徒だけ、null なら全員（生徒の並び順→日時順） */
export function sheetRows(studentId) {
  const v = view();
  const ids = studentId == null ? studentList().map((s) => s.id) : [studentId];
  const rows = [];
  for (const id of ids) {
    const list = [...(v.byStudent.get(id) ?? [])].sort((x, y) => (x.date === y.date ? x.period - y.period : x.date < y.date ? -1 : 1));
    for (const a of list) {
      rows.push([studentName(id), a.teacher_id == null ? "" : teacherName(a.teacher_id), sheetSubject(a.subject), a.date.replaceAll("-", "/"), SHEET_PERIOD_LABELS[a.period] ?? `${a.period}限`]);
    }
  }
  return rows;
}

async function copySheetRows(studentId) {
  await drained();
  const rows = sheetRows(studentId);
  if (!rows.length) return toast("コピーする授業がありません", true);
  const text = rows.map((r) => r.join("\t")).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast(`コピペ用をコピーしました（${rows.length}行）。GAS のシートの「生徒名」の列に貼り付けてください`);
  } catch {
    window.prompt("自動でコピーできなかったので、下の内容を手でコピーしてください", text);
  }
}

/** comiru への反映は、対象を選ぶ確認画面にまとめる。 */
function comiruActions() {
  const comiru = S.comiruStatus;
  return el(
    "div",
    { class: "row comiru-actions" },
    comiru?.configured ? el(
      "button",
      { type: "button", class: "btn-small btn-primary", onclick: () => openComiruDialog(S.mode === "student" ? S.studentId : null) },
      "comiru反映を確認",
    ) : el("span", { class: "muted" }, comiru ? "comiru 連携が未設定です" : "comiru の反映状況を確認中…"),
    el(
      "details",
      { class: "copy-menu" },
      el("summary", { class: "btn-small", title: "comiru 連携が止まったときに、元の GAS のシートへ貼って登録する" }, "コピペ用"),
      el("div", { class: "copy-menu-items" },
        S.mode === "student" ? el("button", { type: "button", class: "btn-small", onclick: () => copySheetRows(S.studentId) }, "この生徒をコピー") : null,
        el("button", { type: "button", class: "btn-small", onclick: () => copySheetRows(null) }, "全員分をコピー"),
      ),
    ),
  );
}

function saveStatusText() {
  if (S.queue.length) return `保存中…（${S.queue.length}件）そのまま操作を続けられます`;
  if (S.syncError) return "通信できませんでした。自動でつなぎ直します（入力した内容は保存済みです）";
  const pending = S.comiruStatus?.pending_total ?? 0;
  return `保存済み（自動保存）${S.comiruStatus?.configured ? `・comiru 未反映 ${pending}件（反映できないコマを除く）` : ""}`;
}

function updateSaveStatus() {
  const status = S.root?.querySelector(".assignment-save-status");
  if (status) status.textContent = saveStatusText();
}

async function editCurrentStudent() {
  if (!S.editStudent || S.modalOpen) return;
  const st = S.students.get(S.studentId);
  if (!st) return;
  S.modalOpen = true;
  const root = S.root;
  try {
    await drained();
    await S.editStudent(st, async () => {
      if (S.root !== root) return;
      S.modalOpen = false;
      try {
        await loadSnapshot();
      } catch (err) {
        S.syncError = true;
        toast(err.message, true);
      }
      draw();
    }, () => S.root === root);
  } catch (err) {
    S.modalOpen = false;
    toast(err.message, true);
  }
}

function conflictBar() {
  const list = conflicts();
  if (!list.length) return el("div", { class: "conflict-line ok" }, "要確認 0件");
  const grouped = new Map();
  for (const c of list) {
    const k = `${c.date}#${c.period}#${[...c.students].sort().join("|")}`;
    const g = grouped.get(k) ?? { ...c, labels: [] };
    g.labels.push(c.label);
    grouped.set(k, g);
  }
  const pop = el(
    "div",
    { class: `conflict-pop${S.conflictsOpen ? "" : " hidden"}` },
    [...grouped.values()].map((c) =>
      el(
        "div",
        {},
        `⚠ ${fmtDate(c.date)} ${c.period}限：${c.labels.join("、")} → `,
        c.students.map((name, i) => [
          el(
            "button",
            {
              type: "button",
              class: "btn-link",
              onclick: () => {
                const s = [...S.students.values()].find((x) => x.name === name);
                if (!s) return toast(`${name} は予定が入力されていません`, true);
                S.conflictsOpen = false;
                S.weekIndex = Math.max(0, weeksOf(S.term.dates).findIndex((week) => week.includes(c.date)));
                selectStudent(s.id);
                document.querySelector(`[data-key="${slotKey(c.date, c.period)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
              },
            },
            name,
          ),
          i < c.students.length - 1 ? " & " : "",
        ]),
      ),
    ),
  );
  return el(
    "div",
    { class: "conflict-line ng" },
    el(
      "button",
      {
        type: "button",
        class: "btn-link",
        onclick: () => {
          S.conflictsOpen = !S.conflictsOpen;
          pop.classList.toggle("hidden", !S.conflictsOpen);
        },
      },
      `要確認 ${grouped.size}件・詳細`,
    ),
    pop,
  );
}

/** この生徒に割り当て済みの「講師×科目」。押すと連続入力、ドラッグで1コマずつ配置 */
function palette(b) {
  const pairs = new Map();
  for (const a of b?.assignments ?? []) {
    if (!a.teacher_id) continue;
    const k = `${a.teacher_id}#${a.subject}`;
    const p = pairs.get(k) ?? { teacher_id: a.teacher_id, teacher_name: a.teacher_name, name_kana: a.teacher_name_kana, name: a.teacher_name, subject: a.subject, count: 0 };
    p.count += 1;
    pairs.set(k, p);
  }
  if (S.brush && !pairs.has(`${S.brush.teacher_id}#${S.brush.subject}`)) {
    const t = S.teachers.get(S.brush.teacher_id);
    pairs.set(`${S.brush.teacher_id}#${S.brush.subject}`, { ...S.brush, name: S.brush.teacher_name, name_kana: t?.name_kana ?? "", count: 0 });
  }
  const chips = [...pairs.values()].sort(compareNames).map((p) => {
    const active = S.brush && S.brush.teacher_id === p.teacher_id && S.brush.subject === p.subject;
    const chip = el(
      "button",
      { type: "button", class: `teacher-chip tone-${toneOf(p.subject)}${active ? " active" : ""}`, title: "押すと連続入力／ドラッグで1コマ配置" },
      el("span", {}, p.teacher_name),
      el("small", {}, `${p.subject}・${p.count}回`),
    );
    chip.addEventListener("pointerdown", (e) => startDrag(e, { teacher_id: p.teacher_id, teacher_name: p.teacher_name, subject: p.subject }, null));
    return chip;
  });
  return el(
    "div",
    { class: `palette-panel${S.brush ? " brushing" : ""}` },
    el(
      "div",
      { class: "palette-heading" },
      S.brush
        ? el("span", { class: "brush-note" }, `${S.brush.teacher_name}（${S.brush.subject}）で連続入力中`)
        : el("span", { class: "muted" }, chips.length ? "講師を押すと連続入力／ドラッグで配置" : "コマを押して講師を選んでください"),
      S.brush ? el("button", { type: "button", class: "btn-small", onclick: () => setBrush(null) }, "連続入力を終了（Esc）") : null,
    ),
    el("div", { class: "palette" }, chips),
  );
}

function setBrush(pair) {
  if (pair && S.brush && S.brush.teacher_id === pair.teacher_id && S.brush.subject === pair.subject) pair = null; // 同じチップをもう一度押したら終了
  S.brush = pair;
  draw();
}

/** 連続入力中の色分け（緑＝置ける、黄＝講師がほかの生徒と重なる、薄い＝講師が来られない） */
function brushState(key, existing) {
  const b = S.brush;
  if (!b) return null;
  const t = S.teachers.get(b.teacher_id);
  if (!t || !canTeach(t, key, b.subject)) return "brush-no";
  const busy = (view().bySlot.get(key) ?? []).some((a) => a.teacher_id === b.teacher_id && a.student_id !== S.studentId);
  if (existing && existing.teacher_id === b.teacher_id) return "brush-ok";
  return busy ? "brush-warn" : "brush-ok";
}

/** 連続入力：押したコマにブラシの講師を割り当てる */
function brushAssign(date, period, existing) {
  const b = S.brush;
  if (!b) return;
  const key = slotKey(date, period);
  if (existing && existing.teacher_id === b.teacher_id && existing.subject === b.subject) return;
  const state = brushState(key, existing);
  if (state === "brush-no") return toast(`${b.teacher_name} はこの日時に来られないか、${b.subject}を担当できません`, true);
  const after = { student_id: S.studentId, teacher_id: b.teacher_id, table_id: existing?.table_id ?? "auto", subject: b.subject, date, period: Number(period) };
  change(snapshot(existing), after, { strict: true, message: `${fmtDate(date)} ${period}限に ${b.teacher_name}${state === "brush-warn" ? "（講師重複あり）" : ""}` });
}

function weeksOf(dates) {
  const set = new Set(dates);
  const weeks = [];
  if (!dates.length) return weeks;
  const d = new Date(`${dates[0]}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  while (d.toISOString().slice(0, 10) <= dates[dates.length - 1]) {
    const w = [];
    for (let i = 0; i < 7; i++) {
      const iso = d.toISOString().slice(0, 10);
      w.push(set.has(iso) ? iso : null);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    weeks.push(w);
  }
  return weeks;
}

function grid(b) {
  if (!b) return null;
  const term = S.term;
  const closed = new Set(term.closed_dates);
  const available = b.student.slots;
  const byKey = new Map(b.assignments.map((a) => [slotKey(a.date, a.period), a]));
  if (!available.size && !byKey.size) {
    return el("div", { class: "notice warn" }, "この生徒の受講できるコマがまだ入力されていません（生徒タブで入力）。");
  }
  const summary = S.brush ? new Map() : slotSummary(S.studentId, S.subject);
  return weeklyGrid((date, period) => cell(date, period, closed, available, byKey, summary));
}

function weekNavigation() {
  const weeks = weeksOf(S.term.dates);
  S.weekIndex = Math.max(0, Math.min(S.weekIndex, weeks.length - 1));
  const weekSelect = el("select", {
    "aria-label": "表示する週", onchange: (e) => moveWeek(Number(e.target.value)),
  }, weeks.map((week, index) => {
    const days = week.filter(Boolean);
    return el("option", { value: index, selected: index === S.weekIndex }, `第${index + 1}週　${fmtDate(days[0], false)}〜${fmtDate(days.at(-1), false)}`);
  }));
  // 「前の週」「次の週」はカレンダーの左右の端（weekFlipButton）。ここは週を選ぶ欄だけ
  return el("div", { class: "week-navigation", "aria-label": "週の切替" }, weekSelect);
}

function moveWeek(index) {
  S.closeOverlay?.();
  S.weekIndex = index;
  draw();
}

/** カレンダーの左右の端の縦長のボタン。ドラッグ中もこの上で少し止めると週が変わる（watchWeekFlip） */
function weekFlipButton(dir) {
  const last = weeksOf(S.term.dates).length - 1;
  const label = dir < 0 ? "‹ 前の週" : "次の週 ›";
  const disabled = dir < 0 ? S.weekIndex === 0 : S.weekIndex >= last;
  return el(
    "button",
    { type: "button", class: `week-flip week-flip-${dir < 0 ? "prev" : "next"}`, dataset: { dir: String(dir) }, disabled, "aria-label": label, title: label, onclick: () => moveWeek(S.weekIndex + dir) },
    el("span", { class: "week-flip-arrow" }, dir < 0 ? "‹" : "›"),
    el("span", { class: "week-flip-text" }, dir < 0 ? "前の週" : "次の週"),
  );
}

function weeklyGrid(renderCell, className = "") {
  const term = S.term;
  const weeks = weeksOf(term.dates);
  return el(
    "div",
    { class: `assign-grid ${className}`.trim() },
    weeks.slice(S.weekIndex, S.weekIndex + 1).map((week) => {
      const days = week.filter(Boolean);
      return el(
        "div",
        { class: "cal-week" },
        el("div", { class: "cal-week-head" }, `${fmtDate(days[0], false)} 〜 ${fmtDate(days[days.length - 1], false)}`),
        el("div", { class: "week-frame" }, weekFlipButton(-1), el(
          "table",
          { class: "assign-table" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", { class: "cal-periodcol" }),
              week.map((date, i) => {
                const dow = (i + 1) % 7;
                return el(
                  "th",
                  { class: `cal-date${date ? "" : " out"}` },
                  el("span", { class: `dow dow-${dow}` }, DOW[dow]),
                  date ? el("span", { class: "day" }, el("span", { class: "assign-month" }, `${Number(date.slice(5, 7))}/`), `${Number(date.slice(8, 10))}`) : null,
                );
              }),
            ),
          ),
          el(
            "tbody",
            {},
            term.periods.map((period) =>
              el(
                "tr",
                {},
                el("th", { class: "cal-period" }, el("span", {}, `${period}限`), el("small", {}, term.period_times?.[period]?.start ?? "")),
                week.map((date) => renderCell(date, period)),
              ),
            ),
          ),
        ), weekFlipButton(1)),
      );
    }),
  );
}

function cell(date, period, closed, available, byKey, summary) {
  if (!date) return el("td", { class: "acell out" });
  const key = slotKey(date, period);
  const a = byKey.get(key);
  // 休校日のマス。ただし授業が入っていれば隠さずに出す（あとから休校日にした場合。エラーとして表示）
  if (closed.has(date) && !a) return el("td", { class: "acell closed" }, period === S.term.periods[0] ? "休" : "");
  const td = el("td", { class: "acell", dataset: { key, date, period } });

  if (a) {
    const reasons = [];
    if (a.has_teacher_conflict) reasons.push("講師重複");
    if (a.has_table_conflict) reasons.push("席重複");
    if (a.has_schedule_mismatch) reasons.push("講師予定不一致");
    if (a.has_student_schedule_mismatch) reasons.push("生徒予定不一致");
    if (a.has_slot_invalid) reasons.push("休校日・期間外");
    td.classList.add("assigned");
    if (a.pending) td.classList.add("pending");
    if (reasons.length) td.classList.add("conflict");
    td.title = `${a.subject} / ${a.teacher_name} / 席${a.table_id}${a.pending ? "（保存中）" : ""}${reasons.length ? `\nエラー：${reasons.join("・")}` : ""}`;
    const pill = el(
      "div",
      { class: `pill tone-${toneOf(a.subject)}` },
      el("span", { class: "pill-name" }, a.teacher_name, el("small", { class: "pill-subject" }, a.subject)),
      el("span", { class: "pill-table" }, a.table_id),
    );
    pill.addEventListener("pointerdown", (e) => startDrag(e, { teacher_id: a.teacher_id, teacher_name: a.teacher_name, subject: a.subject }, a));
    const del = el(
      "button",
      {
        type: "button",
        class: "acell-del",
        title: "この割り当てを削除（授業をドラッグして画面下のゴミ箱に落としても消せます）",
        "aria-label": "この割り当てを削除",
        onclick: (e) => {
          e.stopPropagation();
          change(snapshot(a), null, { message: "割り当てを削除しました" });
        },
      },
      "×",
    );
    td.append(pill, del);
    if (a.pending) td.append(el("div", { class: "pending-label" }, "確認・保存中"));
    if (reasons.length) td.append(el("div", { class: "acell-reason", title: reasons.join("・") }, reasons.join("・")));
    const bs = brushState(key, a);
    if (bs) td.classList.add(bs);
    // 講師名の部分はドラッグ用（ドラッグせずに離したときは onDragEnd が講師選択を開く）
    td.addEventListener("click", (e) => {
      if (e.target.closest(".pill")) return;
      if (S.brush) brushAssign(date, period, a);
      else openTeacherModal(date, period, a, td);
    });
    return td;
  }
  if (!available.has(key)) {
    td.classList.add("unavailable");
    return td;
  }
  td.classList.add("open");
  const bs = brushState(key, null);
  if (bs) {
    td.classList.add(bs);
    td.append(el("span", { class: "hint" }, bs === "brush-no" ? "来られない" : bs === "brush-warn" ? "＋（重複）" : "＋ 割り当て"));
    td.addEventListener("click", () => brushAssign(date, period, null));
    return td;
  }
  if (S.subject) {
    const sum = summary.get(key);
    if (sum?.free_teacher_count > 0) {
      td.classList.add("has-teacher");
      td.append(el("span", { class: "hint", title: `対応できる講師が${sum.free_teacher_count}人います` }, `${sum.free_teacher_count}人`, el("span", { class: "hint-detail" }, "対応可")));
    } else if (sum?.total_teacher_count > 0) {
      td.classList.add("full");
      td.append(el("span", { class: "hint" }, "満"));
    } else {
      td.classList.add("none");
      td.append(el("span", { class: "hint" }, "0"));
    }
  }
  td.addEventListener("click", () => openTeacherModal(date, period, null, td));
  return td;
}

// ------------------------------------------------------------ コマを押したとき：講師を選ぶ

/** 講師を選ぶ欄。押したコマのすぐ横に出す（手元のデータで判定するので待ち時間なし）。1〜9キーで選択、Escで閉じる */
function openTeacherModal(date, period, existing, anchor) {
  if (S.drag?.justDropped || S.modalOpen) return;
  if (!S.subject) return toast("先に科目を選んでください（生徒タブで受講科目を入力）", true);
  const subject = existing?.subject ?? S.subject;
  const studentId = S.studentId;
  const teachers = candidates(date, period, subject, studentId);
  S.modalOpen = true;
  const defaultTable = existing?.table_id ?? guessTable(date, period, studentId);
  let manualTable = false;
  const used = new Set((view().bySlot.get(slotKey(date, period)) ?? []).filter((a) => a.student_id !== studentId).map((a) => a.table_id));
  const tableSelect = el(
    "select",
    { "aria-label": "席", style: "width:auto;padding:4px 8px", onchange: () => { manualTable = true; } },
    defaultTable == null ? el("option", { value: "", selected: true }, "満席") : null,
    S.meta.table_ids.map((t) => el("option", { value: t, selected: t === defaultTable, disabled: used.has(t) }, t)),
  );

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    layer.remove();
    S.modalOpen = false;
    S.closeOverlay = null;
    anchor?.classList.remove("selecting");
  };
  const choose = (teacher, keepBrush = false) => {
    if (!tableSelect.value) return toast("空いている席がありません", true);
    close();
    if (keepBrush) S.brush = { teacher_id: teacher.teacher_id, teacher_name: teacher.name, subject };
    const after = { student_id: studentId, teacher_id: teacher.teacher_id, table_id: manualTable || existing ? tableSelect.value : "auto", subject, date, period: Number(period) };
    change(snapshot(existing), after, { strict: true, message: `${teacher.name} を割り当てました${teacher.has_conflict ? "（講師重複あり）" : ""}` });
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (/^[1-9]$/.test(e.key) && !e.target.closest?.("select, input")) {
      const t = teachers[Number(e.key) - 1];
      if (t) {
        e.preventDefault();
        choose(t);
      }
    }
  };

  const pop = el(
    "div",
    { class: "popover", role: "dialog" },
    el(
      "div",
      { class: "modal-head", style: "margin-bottom:6px" },
      el("strong", {}, `${fmtDate(date)} ${period}限・${subject}`),
      el("button", { type: "button", class: "btn-small", onclick: close, title: "Esc" }, "×"),
    ),
    existing ? el("p", { class: "muted", style: "margin:0 0 6px" }, `今：${existing.teacher_name}（席${existing.table_id}）`) : null,
    el("div", { class: "row", style: "margin-bottom:8px;gap:6px" }, el("span", { class: "muted" }, "席"), tableSelect),
    teachers.length
      ? el(
          "div",
          { class: "teacher-list" },
          teachers.map((t, i) =>
            el(
              "div",
              { class: "teacher-row" },
              el(
                "button",
                { type: "button", class: `teacher-item${t.has_conflict ? " conflict" : ""}`, onclick: () => choose(t) },
                el("span", {}, el("kbd", {}, i < 9 ? String(i + 1) : ""), `${t.assignment_count > 0 ? "★ " : ""}${t.name}${t.assignment_count > 0 ? `（${t.assignment_count}回）` : ""}`),
                t.has_conflict ? el("span", { class: "warn-text" }, `⚠ ${t.conflict_with}と重複`) : null,
              ),
              el(
                "button",
                { type: "button", class: "btn-small brush-btn", title: "この講師で、ほかのコマも続けて入れる", onclick: () => choose(t, true) },
                "続けて配置",
              ),
            ),
          ),
        )
      : el("p", { class: "muted" }, "この日時に来られて、この科目を教えられる講師がいません。"),
    existing
      ? el(
          "button",
          {
            type: "button",
            class: "btn-danger btn-small",
            style: "margin-top:10px",
            onclick: () => {
              close();
              change(snapshot(existing), null, { message: "割り当てを削除しました" });
            },
          },
          "この割り当てを削除",
        )
      : null,
  );
  const layer = el("div", { class: "popover-layer", onclick: (e) => e.target === layer && close() }, pop);
  document.body.append(layer);
  S.closeOverlay = close;
  document.addEventListener("keydown", onKey, true);
  anchor?.classList.add("selecting");

  // 押したコマの右（入らなければ左）に、画面からはみ出さないように置く
  const r = anchor?.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = r ? r.right + 8 : (window.innerWidth - w) / 2;
  if (r && left + w > window.innerWidth - 8) left = r.left - w - 8;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r ? r.top : 80;
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
  Object.assign(pop.style, { left: `${left}px`, top: `${top}px` });
  pop.querySelector(".teacher-item")?.focus();
}

// ------------------------------------------------------------ ドラッグ＆ドロップ

function startDrag(e, pair, source) {
  if (S.modalOpen) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if (!pair.teacher_id) return;
  e.preventDefault();
  e.stopPropagation();
  S.drag = { pair, source, root: S.root, studentId: S.studentId, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, hover: null };
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd, { once: true });
  window.addEventListener("pointercancel", cancelDrag, { once: true });
}

function cellAt(x, y) {
  return document.elementFromPoint(x, y)?.closest?.("td.acell[data-key]") ?? null;
}

/** 置けるか：生徒が来られる・その生徒のそのコマが空いている・講師が来られる（講師がほかの生徒と重複なら注意） */
function judgeDrop(td) {
  const d = S.drag;
  if (!d || !td) return { ok: false, reason: "配置不可" };
  const key = td.dataset.key;
  const st = S.students.get(d.studentId);
  if (!st?.slots.has(key)) return { ok: false, reason: "生徒が来られない日時です" };
  const occupied = view().bySeat.get(`${d.studentId}#${key}`);
  if (occupied && !(d.source && sameSeat(occupied, d.source))) return { ok: false, reason: "すでに授業が入っています" };
  const t = S.teachers.get(d.pair.teacher_id);
  if (!t || !canTeach(t, key, d.pair.subject)) return { ok: false, reason: "講師が来られない日時です" };
  const busy = (view().bySlot.get(key) ?? []).some((a) => a.teacher_id === d.pair.teacher_id && a.student_id !== d.studentId);
  return { ok: true, warn: busy, reason: busy ? "講師重複" : "配置できます", date: td.dataset.date, period: Number(td.dataset.period) };
}

function onDragMove(e) {
  const d = S.drag;
  if (!d) return;
  if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
  if (!d.moved) {
    d.moved = true;
    d.ghost = el("div", { class: `drag-ghost tone-${toneOf(d.pair.subject)}` }, d.pair.teacher_name);
    document.body.append(d.ghost);
    // 入っている授業をドラッグしているときは、画面の下に「ここに離すと削除」を出す
    if (d.source) {
      d.trash = el("div", { class: "drag-trash", "aria-hidden": "true" }, "🗑 ここに離すと削除");
      // ドラッグ中は使わない講師の並び（カレンダーのすぐ上）をゴミ箱にする。カレンダーのコマを隠さず、移動も短い。
      // 並びが画面の外にあるとき（スマホでスクロールしたときなど）だけ、画面の下に出す
      const r = S.root?.querySelector(".palette-panel")?.getBoundingClientRect();
      if (r && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight) {
        d.trash.classList.add("on-palette");
        Object.assign(d.trash.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      }
      document.body.append(d.trash);
    }
    document.body.classList.add("dragging");
  }
  d.ghost.style.left = `${e.clientX + 12}px`;
  d.ghost.style.top = `${e.clientY + 12}px`;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const overTrash = Boolean(d.trash && under?.closest?.(".drag-trash"));
  d.trash?.classList.toggle("over", overTrash);
  if (overTrash) d.ghost.dataset.reason = "離すと削除します";
  const flipButton = under?.closest?.(".week-flip:not([disabled])") ?? null;
  watchWeekFlip(d, flipButton);
  if (flipButton) {
    d.hover?.classList.remove("drop-ok", "drop-warn", "drop-no");
    d.hover = null;
    d.ghost.dataset.reason = flipButton.dataset.dir === "1" ? "止めると次の週へ" : "止めると前の週へ";
  }
  const td = overTrash || flipButton ? null : cellAt(e.clientX, e.clientY);
  if (td !== d.hover) {
    d.hover?.classList.remove("drop-ok", "drop-warn", "drop-no");
    d.hover = td;
    if (td) {
      const j = judgeDrop(td);
      td.classList.add(j.ok ? (j.warn ? "drop-warn" : "drop-ok") : "drop-no");
      d.ghost.dataset.reason = j.reason;
    }
  }
  // ポインタの位置だけではスクロールしない。横へドラッグした際に
  // 表が動いて、狙った時限と違うコマへ落ちることを防ぐ。
}

const WEEK_FLIP_DELAY_MS = 500; // ドラッグ中に週のボタンの上で止めてから週が変わるまで
const WEEK_FLIP_REPEAT_MS = 900; // 止めたままなら、続けて次の週へ

/** ドラッグ中、「前の週」「次の週」の上で少し止めたら週を変える（ほかの週のコマへ移せるように） */
function watchWeekFlip(d, button) {
  const dir = button ? Number(button.dataset.dir) : 0;
  if (dir === d.flipDir) return;
  clearTimeout(d.flipTimer);
  document.querySelectorAll(".week-flip.drag-over").forEach((b) => b.classList.remove("drag-over"));
  d.flipDir = dir;
  if (!dir) return;
  button.classList.add("drag-over");
  const flip = () => {
    if (S.drag !== d || d.flipDir !== dir) return;
    const last = weeksOf(S.term.dates).length - 1;
    const next = Math.max(0, Math.min(S.weekIndex + dir, last));
    if (next === S.weekIndex) return;
    S.weekIndex = next;
    d.hover = null;
    draw({ force: true });
    // 描き直したボタンにも印を付け直す
    S.root?.querySelector(`.week-flip[data-dir="${dir}"]:not([disabled])`)?.classList.add("drag-over");
    d.flipTimer = setTimeout(flip, WEEK_FLIP_REPEAT_MS);
  };
  d.flipTimer = setTimeout(flip, WEEK_FLIP_DELAY_MS);
}

function cancelDrag() {
  const d = S.drag;
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", cancelDrag);
  if (d) {
    clearTimeout(d.flipTimer);
    document.querySelectorAll(".week-flip.drag-over").forEach((b) => b.classList.remove("drag-over"));
    d.hover?.classList.remove("drop-ok", "drop-warn", "drop-no");
    d.ghost?.remove();
    d.trash?.remove();
  }
  document.body.classList.remove("dragging");
  S.drag = null;
  if (S.needsDraw) draw();
}

function onDragEnd(e) {
  const d = S.drag;
  const toTrash = Boolean(d?.moved && d.trash && document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".drag-trash"));
  const td = d?.moved && !toTrash ? cellAt(e.clientX, e.clientY) : null;
  const judged = td ? judgeDrop(td) : null;
  cancelDrag();
  if (!d?.moved) {
    // ドラッグせずに離した＝クリック
    if (!d) return;
    if (!d.source) return setBrush(d.pair); // 講師チップ：連続入力の開始／終了
    if (S.brush) return brushAssign(d.source.date, d.source.period, d.source);
    const cellEl = document.querySelector(`td[data-key="${slotKey(d.source.date, d.source.period)}"]`);
    return openTeacherModal(d.source.date, d.source.period, d.source, cellEl);
  }
  // ドロップ直後のクリックで講師選択が開かないようにする
  S.drag = { justDropped: true };
  setTimeout(() => {
    if (S.drag?.justDropped) S.drag = null;
  }, 300);
  if (toTrash) {
    if (S.root !== d.root) return;
    change(snapshot(d.source), null, { message: "割り当てを削除しました（「元に戻す」で戻せます）" });
    return;
  }
  if (!td) return;
  if (!judged?.ok) {
    toast(`置けません：${judged?.reason ?? "不明"}`, true);
    return;
  }
  if (d.source && slotKey(d.source.date, d.source.period) === slotKey(judged.date, judged.period)) return;
  if (S.root !== d.root || S.studentId !== d.studentId) return;

  const after = { student_id: d.studentId, teacher_id: d.pair.teacher_id, table_id: "auto", subject: d.pair.subject, date: judged.date, period: judged.period };
  const verb = d.source ? "移動しました" : "割り当てました";
  change(snapshot(d.source), after, { strict: true, onlyIfEmpty: !d.source, message: `${verb}${judged.warn ? "（講師重複あり）" : ""}` });
}

// ------------------------------------------------------------ comiru への反映

async function openComiruDialog(studentId) {
  if (S.modalOpen) return;
  S.modalOpen = true;
  const root = S.root;
  const endpoint = base();
  let closed = false;
  const body = el("div", {}, el("p", { class: "muted" }, S.queue.length ? "保存中の割り当てを保存しています…" : "comiru の授業と照らし合わせています…"));
  const close = () => {
    if (S.comiruRunning) return toast("comiru に反映中です。完了してから閉じてください");
    closed = true;
    backdrop.remove();
    S.modalOpen = false;
    S.closeOverlay = null;
    scheduleComiruStatus(0);
  };
  const name = studentId ? studentName(studentId) : null;
  const scopeSelect = el("select", {
    "aria-label": "comiruに反映する対象", style: "width:auto;max-width:100%",
    onchange: () => {
      if (S.comiruRunning) return;
      const next = scopeSelect.value === "all" ? null : Number(scopeSelect.value);
      close();
      openComiruDialog(next);
    },
  },
    S.studentId ? el("option", { value: S.studentId, selected: studentId != null }, `${studentName(S.studentId)}さん` ) : null,
    el("option", { value: "all", selected: studentId == null }, "全生徒"),
  );
  const backdrop = el(
    "div",
    { class: "modal-backdrop" },
    el(
      "div",
      { class: "modal" },
      el(
        "div",
        { class: "modal-head" },
        el("h2", { style: "margin:0" }, "comiruへの反映内容"),
        el("button", { type: "button", onclick: close }, "閉じる"),
      ),
      el("div", { class: "row", style: "margin-bottom:12px" }, el("span", {}, "対象"), scopeSelect),
      body,
    ),
  );
  document.body.append(backdrop);
  S.closeOverlay = close;

  let items;
  let verifyNote = null;
  try {
    await drained(); // 画面に出ている割り当てがすべて保存されてから計画を作る
    if (closed || S.root !== root) return;
    body.replaceChildren(el("p", { class: "muted" }, "comiru の授業と照らし合わせています…"));
    const plan = await api(`${endpoint}/comiru/plan${studentId ? `?student_id=${studentId}` : ""}`);
    if (closed || S.root !== root) return;
    items = plan.items;
    if (!plan.verified) {
      verifyNote = el(
        "div",
        { class: "notice warn" },
        `comiru の授業と照らし合わせられませんでした（${plan.verify_error ?? "不明なエラー"}）。comiru 側で直接消した・変えた授業は、この一覧に出ていない可能性があります。`,
      );
    }
  } catch (err) {
    body.replaceChildren(el("div", { class: "notice danger" }, err.message));
    return;
  }
  const runnable = items.filter((i) => i.op !== "skip");
  const label = { add: "追加", change: "変更", move: "移動", delete: "削除", skip: "保留（反映しない）" };
  const line = (i) =>
    el(
      "li",
      { dataset: { key: i.key } },
      el("span", { class: `badge op-${i.op}` }, label[i.op]),
      ` ${studentId ? "" : `${i.student_name}・`}${fmtDate(i.date)} ${i.period}限 `,
      i.op === "move"
        ? `← ${fmtDate(i.from_date)} ${i.from_period}限から移動・${i.teacher_name}（${i.comiru_subject}）`
        : i.op === "change"
          ? `${i.before_teacher_name ?? "?"}（${i.before_subject}）→ ${i.teacher_name}（${i.comiru_subject}）`
          : `${i.teacher_name ?? "講師未定"}${i.comiru_subject ? `（${i.comiru_subject}）` : ""}`,
      i.reason ? el("div", { class: "muted", style: "font-size:0.85rem" }, i.reason) : null,
      el("span", { class: "result" }),
    );
  const groups = ["delete", "move", "change", "add", "skip"]
    .map((op) => [op, items.filter((i) => i.op === op)])
    .filter(([, list]) => list.length);

  if (!items.length) {
    body.replaceChildren(...[verifyNote].filter(Boolean), el("p", {}, "✓ comiru と同じ状態です。反映するものはありません。"));
    return;
  }
  const progress = el("p", { class: "muted" });
  const runButton = el("button", { type: "button", class: "btn-primary" }, `反映する（${runnable.length}件）`);
  runButton.disabled = !runnable.length;
  runButton.addEventListener("click", async () => {
    if (S.comiruRunning || closed) return;
    if (!confirm(`${runnable.length}件を comiru に反映します。よろしいですか？`)) return;
    runButton.disabled = true;
    scopeSelect.disabled = true;
    S.comiruRunning = true;
    let done = 0;
    let failed = 0;
    let stopped = "";
    for (let i = 0; i < runnable.length; i += COMIRU_BATCH) {
      const batch = runnable.slice(i, i + COMIRU_BATCH);
      progress.textContent = `反映中… ${done} / ${runnable.length}件`;
      try {
        const res = await api(`${endpoint}/comiru/apply`, { method: "POST", body: { keys: batch.map((b) => b.key) } });
        for (const r of res.results) {
          const li = body.querySelector(`li[data-key="${CSS.escape(r.key)}"] .result`);
          if (li) {
            li.textContent = ` ${r.ok ? "✓" : "✗"} ${r.message}`;
            li.className = `result ${r.ok ? "ok" : "ng"}`;
          }
          if (!r.ok) failed++;
        }
      } catch (err) {
        stopped = `途中で止まりました：${err.message}。${runnable.length - done}件の結果を確認できていません。閉じてもう一度一覧を確認してください。`;
        for (const item of batch) {
          const result = body.querySelector(`li[data-key="${CSS.escape(item.key)}"] .result`);
          if (result) {
            result.textContent = "結果を確認できませんでした";
            result.className = "result ng";
          }
        }
        break;
      }
      done += batch.length;
    }
    S.comiruRunning = false;
    progress.textContent = stopped || (failed ? `終わりました（${failed}件は反映できませんでした。理由は各行を見てください）` : `✓ ${done}件を反映しました`);
    toast(stopped ? "通信が途中で止まりました。反映状況を再確認してください" : failed ? `${failed}件は反映できませんでした` : "comiru に反映しました", Boolean(stopped) || failed > 0);
  });

  body.replaceChildren(
    ...[verifyNote].filter(Boolean),
    el(
      "p",
      { class: "muted" },
      `${name ? `${name}さん` : "全生徒"}が対象です。アプリが登録した授業を、下の一覧のとおり追加・変更・削除します。comiruで変更された授業もアプリの内容に戻します。直接登録された通常授業は対象外です。`,
    ),
    ...groups.map(([op, list]) => el("div", { style: "margin-bottom:12px" }, el("h3", {}, `${label[op]}（${list.length}件）`), el("ul", { class: "change-list comiru-plan" }, list.map(line)))),
    el("div", { class: "row" }, runButton, progress),
  );
}
