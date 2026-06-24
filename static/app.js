const state = {
  meta: null,
  students: [],
  studentNotes: [],
  selectedStudentId: null,
  selectedSubject: null,
  selectedTeacherId: null,
  isTeacherPanelOpen: false,
  timetable: null,
  teacherPanel: null,
  conflicts: [],
  slotSummary: [],
  selectedSlot: null,
  weeks: [],
  currentWeekIndex: 0,
};

let flashTimer = null;
let tabHeartbeatTimer = null;
let tabCloseNotified = false;
let editingStudentNoteId = null;
let isStudentTrashOpen = false;
let realtimeSocket = null;
let realtimeReconnectTimer = null;
let realtimeRefreshTimer = null;
let pendingRealtimeRefresh = false;
let pendingRealtimeBaseReload = false;
let isRealtimeRefreshRunning = false;
let studentDropdownOptions = [];
let activeStudentOptionIndex = -1;
let teacherDropdownOptions = [];
let activeTeacherOptionIndex = -1;
let dragState = null;
let suppressTeacherModalUntil = 0;
const dragTeacherCache = new Map();
const assignmentUndoStack = [];
const assignmentRedoStack = [];
let isApplyingAssignmentHistory = false;
const TAB_ID_KEY = "juku_scheduler_tab_id";
const STUDENT_STATUS_ADJUSTING = "調整中";
const STUDENT_STATUS_NEEDS_ADJUSTMENT = "要調整";
const STUDENT_STATUS_COMPLETE = "完了";

function shouldSuppressTeacherModal() {
  return Date.now() < suppressTeacherModalUntil;
}

function suppressTeacherModal(ms = 500) {
  suppressTeacherModalUntil = Date.now() + ms;
}

const subjectAbbrevRules = [
  [/物理/, "物"],
  [/化学/, "化"],
  [/生物/, "生"],
  [/地学/, "地"],
  [/算数/, "算"],
  [/数学/, "M"],
  [/英語/, "E"],
  [/国語/, "国"],
  [/理科/, "理"],
  [/社会/, "社"],
  [/現代文/, "現"],
  [/古文/, "古"],
  [/漢文/, "漢"],
  [/日本史/, "日"],
  [/世界史/, "世"],
  [/地理/, "地理"],
  [/倫政/, "倫"],
  [/公共/, "公"],
  [/情報/, "情"],
];

function subjectAbbrev(subject) {
  for (const [regex, label] of subjectAbbrevRules) {
    if (regex.test(subject)) return label;
  }
  return "他";
}

function subjectTone(subject) {
  if (/物理/.test(subject)) return "science-physics";
  if (/化学/.test(subject)) return "science-chemistry";
  if (/生物/.test(subject)) return "science-biology";
  if (/地学/.test(subject)) return "science-earth";
  if (/算数|数学/.test(subject)) return "math";
  if (/英語/.test(subject)) return "english";
  if (/国語|現代文|古文|漢文/.test(subject)) return "japanese";
  if (/理科/.test(subject)) return "science";
  if (/社会|日本史|世界史|地理|倫政|公共/.test(subject)) return "social";
  if (/情報/.test(subject)) return "informatics";
  return "other";
}

function getOrCreateTabId() {
  const existing = sessionStorage.getItem(TAB_ID_KEY);
  if (existing) return existing;
  const newId =
    (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
    `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessionStorage.setItem(TAB_ID_KEY, newId);
  return newId;
}

function colorForStudentRef(ref) {
  let base = 0;
  if (typeof ref === "number" && Number.isFinite(ref)) {
    base = ref * 47 + 160;
  } else {
    const text = String(ref || "");
    for (let i = 0; i < text.length; i += 1) {
      base = (base * 31 + text.charCodeAt(i)) % 3600;
    }
  }
  const hue = base % 360;
  return {
    bg: `hsl(${hue} 72% 94%)`,
    border: `hsl(${hue} 62% 48%)`,
    text: `hsl(${hue} 45% 22%)`,
  };
}

function groupDatesByWeek(dates) {
  // dates: ISO文字列の配列（例: 2026-06-01）
  if (!dates || dates.length === 0) return [];

  // 元の存在する日付をSetにして扱いやすくする
  const originalSet = new Set(dates);

  // 最初と最後の日付を取得
  const first = dates[0];
  const last = dates[dates.length - 1];
  const [fy, fm, fd] = first.split("-").map(Number);
  const [ly, lm, ld] = last.split("-").map(Number);
  const firstDate = new Date(fy, fm - 1, fd);
  const lastDate = new Date(ly, lm - 1, ld);

  // 最初の月曜に合わせる（getDay: 0=日曜, 1=月曜）
  const firstDay = firstDate.getDay();
  const daysToMonday = (firstDay + 6) % 7; // 日曜->6, 月曜->0, 火曜->1...
  const startDate = new Date(firstDate);
  startDate.setDate(firstDate.getDate() - daysToMonday);

  // 最後の日曜に合わせる
  const lastDay = lastDate.getDay();
  const daysToSunday = (7 - lastDay) % 7; // 日曜->0, 土曜->1
  const endDate = new Date(lastDate);
  endDate.setDate(lastDate.getDate() + daysToSunday);

  // 全日付を生成
  const allDates = [];
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const iso = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${day
      .toString()
      .padStart(2, "0")}`;
    allDates.push(iso);
  }

  // 7日ごとに分割して週配列を作る（各要素はISO日付文字列）
  const weeks = [];
  for (let i = 0; i < allDates.length; i += 7) {
    weeks.push(allDates.slice(i, i + 7));
  }

  return weeks;
}

function formatDate(isoDate) {
  if (!isoDate) return "";
  const [y, m, day] = isoDate.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  const week = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${week})`;
}

function weekRangeLabel(weekDates) {
  if (!weekDates || weekDates.length === 0) return "";
  const validDates = weekDates.filter(d => d !== null);
  if (validDates.length === 0) return "";
  const first = validDates[0];
  const last = validDates[validDates.length - 1];
  const [, sm, sd] = first.split("-").map(Number);
  const [, em, ed] = last.split("-").map(Number);
  if (sm === em) return `${sm}/${sd}〜${ed}`;
  return `${sm}/${sd}〜${em}/${ed}`;
}

function buildWeekHeader(weekDates) {
  const validDates = weekDates.filter(d => d !== null);
  if (validDates.length === 0) return "";
  const startDate = validDates[0];
  const endDate = validDates[validDates.length - 1];
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  return `${sm}/${sd} - ${em}/${ed}`;
}

function renderAccessInfo() {
  const el = document.getElementById("access-info");
  if (!el) return;
  const lanUrl = state.meta && state.meta.lan_url;
  if (!lanUrl) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.innerHTML = `別PCからのアクセス先: <code>${lanUrl}</code>`;
  el.classList.remove("hidden");
}

function getRequestHeaders(extraHeaders = {}) {
  return {
    "X-Tab-Id": getOrCreateTabId(),
    ...extraHeaders,
  };
}

async function api(path, options = {}) {
  const headers = getRequestHeaders({ "Content-Type": "application/json", ...(options.headers || {}) });
  const res = await fetch(path, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return null;
}

async function loadBaseData(options = {}) {
  const { preserveSelection = false } = options;
  const previousStudentId = state.selectedStudentId;
  const previousSubject = state.selectedSubject;

  state.meta = await api("/api/meta");
  state.students = await api("/api/students");
  renderAccessInfo();

  const studentCombo = document.getElementById("student-combo");
  const subjectSelect = document.getElementById("subject-select");

  renderStudentOptions("");

  if (state.students.length > 0) {
    const selectedStudent =
      (preserveSelection && state.students.find((s) => s.id === previousStudentId)) ||
      state.students[0];
    state.selectedStudentId = selectedStudent.id;
    if (studentCombo) studentCombo.value = selectedStudent.name;
  } else {
    state.selectedStudentId = null;
    if (studentCombo) studentCombo.value = "";
  }
  updateStudentPlaceholder();
  const canKeepSubject =
    preserveSelection &&
    previousSubject &&
    (state.meta.subjects || []).includes(previousSubject);
  state.selectedSubject = canKeepSubject ? previousSubject : state.meta.subjects[0] || null;
  buildSubjectSelect([]);
  if (subjectSelect) subjectSelect.value = state.selectedSubject || "";
}

function setActiveStudentOption(index) {
  const dropdown = document.getElementById("student-dropdown");
  if (!dropdown) return;
  const optionEls = Array.from(dropdown.querySelectorAll('[data-student-option="1"]'));
  optionEls.forEach((el) => el.classList.remove("student-option-active"));

  if (!optionEls.length) {
    activeStudentOptionIndex = -1;
    return;
  }
  if (index < 0 || index >= optionEls.length) {
    activeStudentOptionIndex = -1;
    return;
  }

  activeStudentOptionIndex = index;
  const activeEl = optionEls[index];
  activeEl.classList.add("student-option-active");
  activeEl.scrollIntoView({ block: "nearest" });
}

function isTeacherModalOpen() {
  const modal = document.getElementById("teacher-modal");
  return !!modal && !modal.classList.contains("hidden");
}

function scheduleRealtimeRefresh(options = {}) {
  const { reloadBase = false } = options;
  pendingRealtimeRefresh = true;
  pendingRealtimeBaseReload = pendingRealtimeBaseReload || reloadBase;
  if (isTeacherModalOpen()) return;
  if (realtimeRefreshTimer) return;
  realtimeRefreshTimer = setTimeout(() => {
    realtimeRefreshTimer = null;
    flushRealtimeRefresh().catch((err) => {
      console.error(err);
    });
  }, 250);
}

async function flushRealtimeRefresh() {
  if (!pendingRealtimeRefresh || isRealtimeRefreshRunning) return;
  if (isTeacherModalOpen()) return;

  isRealtimeRefreshRunning = true;
  const reloadBase = pendingRealtimeBaseReload;
  pendingRealtimeRefresh = false;
  pendingRealtimeBaseReload = false;

  try {
    if (reloadBase) {
      await loadBaseData({ preserveSelection: true });
      await loadTimetable({ preferEnrolledSubject: true });
    } else {
      await loadTimetable();
    }
  } catch (err) {
    console.error(err);
  } finally {
    isRealtimeRefreshRunning = false;
    if (pendingRealtimeRefresh && !isTeacherModalOpen()) {
      scheduleRealtimeRefresh();
    }
  }
}

function handleRealtimeEvent(payload) {
  if (!payload || payload.type !== "schedule_updated") return;
  if (payload.source_tab_id && payload.source_tab_id === getOrCreateTabId()) return;

  const shouldReloadBase = payload.scope === "global";
  const currentStudentId = state.selectedStudentId;
  const shouldRefreshCurrent =
    shouldReloadBase ||
    payload.student_id == null ||
    Number(payload.student_id) === Number(currentStudentId) ||
    state.isTeacherPanelOpen;

  if (!shouldRefreshCurrent) return;
  scheduleRealtimeRefresh({ reloadBase: shouldReloadBase });
}

function connectRealtimeUpdates() {
  if (realtimeSocket) {
    try {
      realtimeSocket.close();
    } catch (_) {
      // no-op
    }
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socketUrl = `${protocol}//${window.location.host}/ws`;
  realtimeSocket = new WebSocket(socketUrl);

  realtimeSocket.addEventListener("open", () => {
    if (realtimeReconnectTimer) {
      clearTimeout(realtimeReconnectTimer);
      realtimeReconnectTimer = null;
    }
  });

  realtimeSocket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "ping") return;
      handleRealtimeEvent(payload);
    } catch (err) {
      console.error(err);
    }
  });

  realtimeSocket.addEventListener("close", () => {
    realtimeSocket = null;
    if (realtimeReconnectTimer) return;
    realtimeReconnectTimer = setTimeout(() => {
      realtimeReconnectTimer = null;
      connectRealtimeUpdates();
    }, 1500);
  });

  realtimeSocket.addEventListener("error", () => {
    try {
      realtimeSocket.close();
    } catch (_) {
      // no-op
    }
  });
}

async function selectStudentFromDropdown(student) {
  if (!student) return;
  const combo = document.getElementById("student-combo");
  if (combo) combo.value = student.name;
  if (student.id === state.selectedStudentId) {
    hideStudentDropdown();
    return;
  }
  state.selectedStudentId = student.id;
  updateStudentPlaceholder();
  hideStudentDropdown();
  await loadTimetable({ preferEnrolledSubject: true });
}

function renderStudentOptions(filterText, options = {}) {
  const { activateSelected = false } = options;
  const dropdown = document.getElementById("student-dropdown");
  if (!dropdown) return;
  const keyword = (filterText || "").trim();
  const list = keyword
    ? state.students.filter((s) => s.name.includes(keyword))
    : state.students;
  studentDropdownOptions = list;
  activeStudentOptionIndex = -1;
  dropdown.innerHTML = "";
  for (const student of list) {
    const row = document.createElement("div");
    row.className = "student-option";
    row.dataset.studentOption = "1";

    const nameEl = document.createElement("span");
    nameEl.className = "student-option-name";
    const assignmentCount = Number(student.assignment_count || 0);
    nameEl.textContent = `${student.name} (${assignmentCount})`;

    const statusEl = document.createElement("span");
    statusEl.className = `student-status-badge ${studentStatusClass(student.status)}`;
    statusEl.textContent = studentStatusText(student.status);

    row.appendChild(nameEl);
    row.appendChild(statusEl);
    row.addEventListener("mousedown", async (e) => {
      e.preventDefault();
      await selectStudentFromDropdown(student);
    });
    dropdown.appendChild(row);
  }
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "student-option student-option-empty";
    empty.textContent = "該当なし";
    dropdown.appendChild(empty);
  }

  if (activateSelected && list.length > 0) {
    const selectedIndex = list.findIndex((s) => s.id === state.selectedStudentId);
    setActiveStudentOption(selectedIndex >= 0 ? selectedIndex : 0);
  }
}

function showStudentDropdown() {
  const dropdown = document.getElementById("student-dropdown");
  if (!dropdown) return;
  dropdown.classList.remove("hidden");
}

function hideStudentDropdown() {
  const dropdown = document.getElementById("student-dropdown");
  if (!dropdown) return;
  dropdown.classList.add("hidden");
  activeStudentOptionIndex = -1;
}

function isStudentDropdownVisible() {
  const dropdown = document.getElementById("student-dropdown");
  return !!dropdown && !dropdown.classList.contains("hidden");
}

function updateStudentPlaceholder() {
  const combo = document.getElementById("student-combo");
  if (!combo) return;
  const selected = state.students.find((s) => s.id === state.selectedStudentId);
  combo.placeholder = selected
    ? `現在: ${selected.name}（入力して検索）`
    : "生徒名を入力して選択";
}

function studentStatusText(status) {
  if (status === STUDENT_STATUS_COMPLETE) return STUDENT_STATUS_COMPLETE;
  if (status === STUDENT_STATUS_NEEDS_ADJUSTMENT) return STUDENT_STATUS_NEEDS_ADJUSTMENT;
  return STUDENT_STATUS_ADJUSTING;
}

function studentStatusClass(status) {
  if (status === STUDENT_STATUS_COMPLETE) return "student-status-complete";
  if (status === STUDENT_STATUS_NEEDS_ADJUSTMENT) return "student-status-needs-adjustment";
  return "student-status-adjusting";
}

function getSelectedStudent() {
  return state.students.find((s) => s.id === state.selectedStudentId) || null;
}

function toAssignmentSnapshot(assignment, studentId = state.selectedStudentId) {
  if (!assignment) return null;
  return {
    id: assignment.id ?? null,
    student_id: Number(studentId),
    teacher_id:
      assignment.teacher_id === null || assignment.teacher_id === undefined
        ? null
        : Number(assignment.teacher_id),
    table_id: String(assignment.table_id),
    subject: String(assignment.subject),
    date: String(assignment.date),
    period: Number(assignment.period),
  };
}

function pushAssignmentHistory(action) {
  void action;
  if (isApplyingAssignmentHistory) return;
}

function isEditableElement(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return false;
}

async function ensureStudentContext(studentId) {
  if (state.selectedStudentId === studentId) return;
  state.selectedStudentId = studentId;
  const student = state.students.find((s) => s.id === studentId);
  const combo = document.getElementById("student-combo");
  if (combo) combo.value = student ? student.name : "";
  updateStudentPlaceholder();
  await loadTimetable({ preferEnrolledSubject: true });
}

async function createAssignmentFromSnapshot(snapshot) {
  const payload = {
    student_id: snapshot.student_id,
    teacher_id: snapshot.teacher_id,
    table_id: snapshot.table_id,
    subject: snapshot.subject,
    date: snapshot.date,
    period: snapshot.period,
  };
  const created = await api("/api/assignments", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  snapshot.id = created.id;
  return created;
}

async function deleteAssignmentBySnapshot(snapshot) {
  if (!snapshot) return;
  let targetId = snapshot.id;
  if (!targetId) {
    const slot = (state.timetable.assignments || []).find(
      (a) => a.date === snapshot.date && Number(a.period) === Number(snapshot.period)
    );
    targetId = slot ? slot.id : null;
  }
  if (!targetId) return;
  await api(`/api/assignments/${targetId}`, { method: "DELETE" });
}

async function applyAssignmentHistoryAction(action, mode) {
  const target = mode === "undo" ? action.before : action.after;
  const opposite = mode === "undo" ? action.after : action.before;
  const context = target || opposite;
  if (!context) return;

  await ensureStudentContext(context.student_id);
  if (!state.timetable) {
    await loadTimetable({ preferEnrolledSubject: true });
  }

  if (target) {
    await createAssignmentFromSnapshot(target);
  } else {
    await deleteAssignmentBySnapshot(opposite);
  }

  updateStudentPlaceholder();
  await loadTimetable({ preferEnrolledSubject: true });
}

async function undoAssignmentChange() {
  if (!assignmentUndoStack.length) {
    showFlash("取り消せるコマ操作がありません");
    return;
  }
  const action = assignmentUndoStack.pop();
  isApplyingAssignmentHistory = true;
  try {
    await applyAssignmentHistoryAction(action, "undo");
    assignmentRedoStack.push(action);
    showFlash("コマ操作を取り消しました");
  } catch (err) {
    assignmentUndoStack.push(action);
    showFlash(`取り消し失敗: ${err.message}`, "error");
  } finally {
    isApplyingAssignmentHistory = false;
  }
}

async function redoAssignmentChange() {
  if (!assignmentRedoStack.length) {
    showFlash("やり直せるコマ操作がありません");
    return;
  }
  const action = assignmentRedoStack.pop();
  isApplyingAssignmentHistory = true;
  try {
    await applyAssignmentHistoryAction(action, "redo");
    assignmentUndoStack.push(action);
    showFlash("コマ操作をやり直しました");
  } catch (err) {
    assignmentRedoStack.push(action);
    showFlash(`やり直し失敗: ${err.message}`, "error");
  } finally {
    isApplyingAssignmentHistory = false;
  }
}

function syncStudentInState(updatedStudent) {
  const idx = state.students.findIndex((s) => s.id === updatedStudent.id);
  if (idx < 0) return;
  state.students[idx] = { ...state.students[idx], ...updatedStudent };
}

function renderStudentTrashToggle() {
  const btn = document.getElementById("student-note-trash-toggle-btn");
  if (!btn) return;
  const deletedCount = (state.studentNotes || []).filter((n) => Number(n.is_deleted)).length;
  if (isStudentTrashOpen) {
    btn.textContent = `ゴミ箱を隠す (${deletedCount})`;
  } else {
    btn.textContent = `ゴミ箱を表示 (${deletedCount})`;
  }
}

function renderStudentNotesFeed() {
  const feed = document.getElementById("student-note-feed");
  if (!feed) return;
  feed.innerHTML = "";
  renderStudentTrashToggle();

  if (!state.selectedStudentId) {
    const empty = document.createElement("div");
    empty.className = "student-note-empty";
    empty.textContent = "生徒を選択してください。";
    feed.appendChild(empty);
    return;
  }

  if (!state.studentNotes.length) {
    const empty = document.createElement("div");
    empty.className = "student-note-empty";
    empty.textContent = "メモはまだありません。";
    feed.appendChild(empty);
    return;
  }

  const activeNotes = state.studentNotes.filter((n) => !Number(n.is_deleted));
  const deletedNotes = state.studentNotes.filter((n) => Number(n.is_deleted));
  renderStudentTrashToggle();

  const appendSectionTitle = (label) => {
    const title = document.createElement("div");
    title.className = "student-note-section-title";
    title.textContent = label;
    feed.appendChild(title);
  };

  if (activeNotes.length > 0) {
    appendSectionTitle("メモ");
  }
  for (const note of activeNotes) {
    const item = document.createElement("div");
    item.className = "student-note-item";

    const meta = document.createElement("div");
    meta.className = "student-note-meta";
    const time = document.createElement("span");
    time.className = "student-note-time";
    time.textContent = note.created_at || "";
    meta.appendChild(time);

    const right = document.createElement("div");
    right.className = "student-note-actions";
    const edited = document.createElement("span");
    edited.className = "student-note-edited";
    edited.textContent = Number(note.is_edited) ? "編集済み" : "";
    right.appendChild(edited);

    if (editingStudentNoteId !== note.id) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "student-note-action-btn";
      editBtn.textContent = "編集";
      editBtn.addEventListener("click", () => {
        editingStudentNoteId = note.id;
        renderStudentMetaPanel();
      });
      right.appendChild(editBtn);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "student-note-action-btn danger";
      delBtn.textContent = "削除";
      delBtn.addEventListener("click", async () => {
        try {
          await deleteStudentNote(note.id);
          showFlash("メモをゴミ箱に移動しました");
        } catch (err) {
          showFlash(`メモ削除失敗: ${err.message}`, "error");
        }
      });
      right.appendChild(delBtn);
    }
    meta.appendChild(right);
    item.appendChild(meta);

    if (editingStudentNoteId === note.id) {
      const editArea = document.createElement("textarea");
      editArea.className = "student-note-edit-area";
      editArea.maxLength = 500;
      editArea.value = note.body || "";
      item.appendChild(editArea);

      const editActions = document.createElement("div");
      editActions.className = "student-note-edit-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = "キャンセル";
      cancelBtn.addEventListener("click", () => {
        editingStudentNoteId = null;
        renderStudentMetaPanel();
      });
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.textContent = "保存";
      saveBtn.addEventListener("click", async () => {
        const nextBody = editArea.value;
        editingStudentNoteId = null;
        try {
          await editStudentNote(note.id, nextBody);
          showFlash("メモを更新しました");
        } catch (err) {
          editingStudentNoteId = note.id;
          renderStudentMetaPanel();
          showFlash(`メモ更新失敗: ${err.message}`, "error");
        }
      });
      editActions.appendChild(cancelBtn);
      editActions.appendChild(saveBtn);
      item.appendChild(editActions);
    } else {
      const body = document.createElement("div");
      body.className = "student-note-body";
      body.textContent = note.body || "";
      item.appendChild(body);
    }

    feed.appendChild(item);
  }

  if (isStudentTrashOpen) {
    appendSectionTitle(`ゴミ箱 (${deletedNotes.length})`);
    if (!deletedNotes.length) {
      const emptyTrash = document.createElement("div");
      emptyTrash.className = "student-note-empty";
      emptyTrash.textContent = "削除済みメモはありません。";
      feed.appendChild(emptyTrash);
    }
    for (const note of deletedNotes) {
      const item = document.createElement("div");
      item.className = "student-note-item student-note-item-deleted";

      const meta = document.createElement("div");
      meta.className = "student-note-meta";
      const time = document.createElement("span");
      time.className = "student-note-time";
      const deletedAt = note.deleted_at || note.updated_at || "";
      time.textContent = `削除: ${deletedAt}`;
      meta.appendChild(time);

      const right = document.createElement("div");
      right.className = "student-note-actions";
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "student-note-action-btn";
      restoreBtn.textContent = "復元";
      restoreBtn.addEventListener("click", async () => {
        try {
          await restoreStudentNote(note.id);
          showFlash("メモを復元しました");
        } catch (err) {
          showFlash(`メモ復元失敗: ${err.message}`, "error");
        }
      });
      right.appendChild(restoreBtn);

      const hardDeleteBtn = document.createElement("button");
      hardDeleteBtn.type = "button";
      hardDeleteBtn.className = "student-note-action-btn danger";
      hardDeleteBtn.textContent = "完全削除";
      hardDeleteBtn.addEventListener("click", async () => {
        try {
          await hardDeleteStudentNote(note.id);
          showFlash("メモを完全削除しました");
        } catch (err) {
          showFlash(`完全削除失敗: ${err.message}`, "error");
        }
      });
      right.appendChild(hardDeleteBtn);
      meta.appendChild(right);
      item.appendChild(meta);

      const body = document.createElement("div");
      body.className = "student-note-body";
      body.textContent = note.body || "";
      item.appendChild(body);
      feed.appendChild(item);
    }
  }

  feed.scrollTop = feed.scrollHeight;
}

function renderStudentMetaPanel() {
  const statusSelect = document.getElementById("student-status-select");
  const composeInput = document.getElementById("student-note-compose-input");
  const sendBtn = document.getElementById("student-note-send-btn");
  const trashToggleBtn = document.getElementById("student-note-trash-toggle-btn");
  if (!statusSelect || !composeInput || !sendBtn || !trashToggleBtn) return;
  const completeOption = Array.from(statusSelect.options).find((o) => o.value === STUDENT_STATUS_COMPLETE);
  let autoNeedsOption = Array.from(statusSelect.options).find(
    (o) => o.value === STUDENT_STATUS_NEEDS_ADJUSTMENT
  );

  const selected = getSelectedStudent();
  if (!selected) {
    if (completeOption) completeOption.disabled = false;
    if (autoNeedsOption) autoNeedsOption.remove();
    statusSelect.value = STUDENT_STATUS_ADJUSTING;
    statusSelect.disabled = true;
    composeInput.disabled = true;
    sendBtn.disabled = true;
    trashToggleBtn.disabled = true;
    renderStudentNotesFeed();
    return;
  }

  statusSelect.disabled = false;
  composeInput.disabled = false;
  sendBtn.disabled = false;
  trashToggleBtn.disabled = false;
  const hasErrors = selectedStudentHasErrors();
  if (completeOption) completeOption.disabled = hasErrors;
  const isAutoNeedsAdjustment =
    selected.status === STUDENT_STATUS_NEEDS_ADJUSTMENT || hasErrors;
  statusSelect.disabled = isAutoNeedsAdjustment;

  if (selected.status === STUDENT_STATUS_NEEDS_ADJUSTMENT) {
    if (!autoNeedsOption) {
      autoNeedsOption = document.createElement("option");
      autoNeedsOption.value = STUDENT_STATUS_NEEDS_ADJUSTMENT;
      autoNeedsOption.textContent = "要調整（自動）";
      autoNeedsOption.disabled = true;
      statusSelect.appendChild(autoNeedsOption);
    }
    statusSelect.value = STUDENT_STATUS_NEEDS_ADJUSTMENT;
  } else {
    if (autoNeedsOption) autoNeedsOption.remove();
    statusSelect.value = studentStatusText(selected.status);
  }
  renderStudentNotesFeed();
}

function selectedStudentHasErrors() {
  const assignments = (state.timetable && state.timetable.assignments) || [];
  return assignments.some((a) => Boolean(a.has_conflict));
}

async function loadStudentNotes() {
  if (!state.selectedStudentId) {
    state.studentNotes = [];
    editingStudentNoteId = null;
    return;
  }
  state.studentNotes = await api(`/api/students/${state.selectedStudentId}/notes`);
}

async function saveSelectedStudentStatus(status) {
  if (!state.selectedStudentId) return;
  const updated = await api(`/api/students/${state.selectedStudentId}/meta`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
  syncStudentInState(updated);
  if (state.timetable?.student?.id === updated.id) {
    state.timetable.student = { ...state.timetable.student, ...updated };
  }
  const studentCombo = document.getElementById("student-combo");
  renderStudentOptions(studentCombo ? studentCombo.value : "");
  renderContextBar();
}

async function postStudentNote(body) {
  if (!state.selectedStudentId) return;
  await api(`/api/students/${state.selectedStudentId}/notes`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  await loadStudentNotes();
  renderStudentMetaPanel();
}

async function editStudentNote(noteId, body) {
  if (!state.selectedStudentId) return;
  await api(`/api/students/${state.selectedStudentId}/notes/${noteId}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
  await loadStudentNotes();
  renderStudentMetaPanel();
}

async function deleteStudentNote(noteId) {
  if (!state.selectedStudentId) return;
  await api(`/api/students/${state.selectedStudentId}/notes/${noteId}`, {
    method: "DELETE",
  });
  await loadStudentNotes();
  renderStudentMetaPanel();
}

async function restoreStudentNote(noteId) {
  if (!state.selectedStudentId) return;
  await api(`/api/students/${state.selectedStudentId}/notes/${noteId}/restore`, {
    method: "POST",
  });
  await loadStudentNotes();
  renderStudentMetaPanel();
}

async function hardDeleteStudentNote(noteId) {
  if (!state.selectedStudentId) return;
  await api(`/api/students/${state.selectedStudentId}/notes/${noteId}/hard-delete`, {
    method: "DELETE",
  });
  await loadStudentNotes();
  renderStudentMetaPanel();
}

function showFlash(message, type = "info") {
  const el = document.getElementById("flash-message");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("flash-empty", "error");
  if (type === "error") el.classList.add("error");
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
}

function buildSubjectSelect(enrolledSubjects) {
  const subjectSelect = document.getElementById("subject-select");
  if (!subjectSelect) return;
  const all = state.meta.subjects || [];
  const enrolled = new Set((enrolledSubjects || []).filter((s) => all.includes(s)));
  const others = all.filter((s) => !enrolled.has(s));

  subjectSelect.innerHTML = "";
  for (const s of all.filter((x) => enrolled.has(x))) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    opt.style.color = "#111";
    subjectSelect.appendChild(opt);
  }
  if (others.length > 0) {
    const sep = document.createElement("option");
    sep.disabled = true;
    sep.textContent = "---- その他（講習など） ----";
    sep.style.color = "#888";
    subjectSelect.appendChild(sep);
    for (const s of others) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      opt.style.color = "#777";
      subjectSelect.appendChild(opt);
    }
  }
}

function hasSelectableSubjectOption(subject) {
  const subjectSelect = document.getElementById("subject-select");
  if (!subjectSelect || !subject) return false;
  return Array.from(subjectSelect.options).some((option) => option.value === subject);
}

async function loadTimetable(options = {}) {
  const { preferEnrolledSubject = false } = options;
  const previousTimetableStudentId = state.timetable?.student?.id ?? null;
  dragTeacherCache.clear();
  if (!state.selectedStudentId) {
    state.timetable = {
      student: null,
      availability: [],
      assignments: [],
      subject_counts: {},
      enrolled_subjects: [],
    };
    state.studentNotes = [];
    editingStudentNoteId = null;
    state.conflicts = [];
    state.slotSummary = [];
    state.teacherPanel = { teachers: [], selected_teacher_id: null, assignments: [], availability: [] };
    render();
    return;
  }
  state.timetable = await api(`/api/students/${state.selectedStudentId}/timetable`);
  state.students = await api("/api/students");
  const latestSelected = state.students.find((s) => s.id === state.selectedStudentId);
  const studentCombo = document.getElementById("student-combo");
  if (studentCombo && latestSelected) studentCombo.value = latestSelected.name;
  renderStudentOptions(studentCombo ? studentCombo.value : "");
  updateStudentPlaceholder();
  await loadStudentNotes();
  editingStudentNoteId = null;
  const enrolledSubjects = state.timetable.enrolled_subjects || [];
  buildSubjectSelect(enrolledSubjects);
  const subjectSelectEl = document.getElementById("subject-select");
  const firstEnrolled = Array.from(subjectSelectEl.options).find((o) => o.value && !o.disabled);
  const isStudentChanged = Number(previousTimetableStudentId) !== Number(state.selectedStudentId);
  const shouldChooseDefaultSubject =
    !hasSelectableSubjectOption(state.selectedSubject) ||
    (preferEnrolledSubject && (isStudentChanged || !state.selectedSubject));
  if (shouldChooseDefaultSubject) {
    state.selectedSubject = firstEnrolled ? firstEnrolled.value : null;
  }
  document.getElementById("subject-select").value = state.selectedSubject || "";
  await refreshCurrentSubjectView();
}

async function refreshCurrentSubjectView() {
  state.conflicts = await api("/api/conflicts");
  if (!state.selectedSubject) {
    state.slotSummary = [];
    await loadTeacherPanel();
    render();
    return;
  }
  state.slotSummary = await api(
    `/api/slot-teacher-summary?subject=${encodeURIComponent(
      state.selectedSubject
    )}&student_id=${state.selectedStudentId}`
  );
  await loadTeacherPanel();
  render();
}

async function loadTeacherPanel() {
  if (!state.selectedStudentId) {
    state.teacherPanel = { teachers: [], selected_teacher_id: null, assignments: [], availability: [] };
    state.selectedTeacherId = null;
    return;
  }
  const teacherQuery = state.selectedTeacherId ? `&teacher_id=${state.selectedTeacherId}` : "";
  state.teacherPanel = await api(
    `/api/teacher-panel?student_id=${state.selectedStudentId}${teacherQuery}`
  );
  state.selectedTeacherId = state.teacherPanel.selected_teacher_id || null;
  const combo = document.getElementById("teacher-combo");
  if (combo) {
    const selected = (state.teacherPanel.teachers || []).find(
      (t) => t.teacher_id === state.selectedTeacherId
    );
    combo.value = selected ? selected.name : "";
  }
}

function render() {
  renderContextBar();
  renderStudentMetaPanel();
  renderCounts();
  renderTeacherPalette();
  renderConflictBar();
  renderGrid();
  renderTeacherPanel();
}

function renderContextBar() {
  const bar = document.getElementById("context-bar");
  const studentEl = document.getElementById("context-student");
  const subjectEl = document.getElementById("context-subject");
  if (!bar || !studentEl || !subjectEl) return;

  const selected = getSelectedStudent();
  const studentName = state.timetable?.student?.name || "生徒未選択";
  const status = selected ? studentStatusText(selected.status) : "";
  const subjectName = state.selectedSubject || "科目未選択";
  studentEl.textContent = selected ? `${studentName}（${status}）` : studentName;
  subjectEl.textContent = subjectName;

  const c = colorForStudentRef(
    state.selectedStudentId || state.timetable?.student?.name || "default"
  );
  bar.style.background = c.bg;
  bar.style.borderColor = c.border;
  bar.style.color = c.text;
}

function renderCounts() {
  const el = document.getElementById("subject-counts");
  if (!el) return;
  const counts = state.timetable.subject_counts || {};
  const subjectOrder = new Map(
    ((state.meta && state.meta.subjects) || []).map((s, i) => [String(s), i])
  );
  const entries = Object.entries(counts).sort(
    ([s1], [s2]) =>
      (subjectOrder.get(String(s1)) ?? Number.MAX_SAFE_INTEGER) -
        (subjectOrder.get(String(s2)) ?? Number.MAX_SAFE_INTEGER) ||
      String(s1).localeCompare(String(s2))
  );
  el.innerHTML = "";

  const label = document.createElement("span");
  label.className = "counts-label";
  label.textContent = "登録済み:";
  el.appendChild(label);

  if (entries.length === 0) {
    const empty = document.createElement("span");
    empty.textContent = "なし";
    el.appendChild(empty);
    return;
  }

  const list = document.createElement("span");
  list.className = "counts-list";
  for (const [subject, count] of entries) {
    const chip = document.createElement("span");
    chip.className = `count-chip subject-${subjectTone(subject)}`;
    chip.textContent = `${subject}: ${count}コマ`;
    list.appendChild(chip);
  }
  el.appendChild(list);
}

function slotKey(date, period) {
  return `${date}#${period}`;
}

function getTimetableAssignments() {
  return (state.timetable && state.timetable.assignments) || [];
}

function getAssignmentAt(date, period, excludeAssignmentId = null) {
  return getTimetableAssignments().find(
    (a) => a.date === date && Number(a.period) === Number(period) && a.id !== excludeAssignmentId
  );
}

function buildTeacherPalettePairs() {
  const counts = new Map();
  for (const a of getTimetableAssignments()) {
    if (!a.teacher_id || !a.subject) continue;
    const key = `${a.teacher_id}#${a.subject}`;
    if (!counts.has(key)) {
      counts.set(key, {
        teacher_id: Number(a.teacher_id),
        teacher_name: a.teacher_name,
        subject: a.subject,
        used_count: 0,
      });
    }
    counts.get(key).used_count += 1;
  }
  const subjectOrder = new Map(
    ((state.meta && state.meta.subjects) || []).map((s, i) => [String(s), i])
  );
  return [...counts.values()].sort(
    (x, y) =>
      (subjectOrder.get(x.subject) ?? Number.MAX_SAFE_INTEGER) -
        (subjectOrder.get(y.subject) ?? Number.MAX_SAFE_INTEGER) ||
      x.subject.localeCompare(y.subject) ||
      x.teacher_name.localeCompare(y.teacher_name)
  );
}

function renderTeacherPalette() {
  const section = document.getElementById("teacher-palette-section");
  const box = document.getElementById("teacher-palette");
  if (!section || !box) return;

  const pairs = buildTeacherPalettePairs();
  box.innerHTML = "";
  if (!pairs.length) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  for (const pair of pairs) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `teacher-chip subject-${subjectTone(pair.subject)}`;
    chip.innerHTML = `<span class="teacher-chip-name">${pair.teacher_name}</span><span class="teacher-chip-count">${pair.used_count}回</span>`;
    chip.addEventListener("pointerdown", async (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      await startDragFromPalette(pair, e.clientX, e.clientY);
    });
    box.appendChild(chip);
  }
}

async function ensureDragTeacherCache(teacherId) {
  if (dragTeacherCache.has(teacherId)) return dragTeacherCache.get(teacherId);
  if (!state.selectedStudentId) return null;
  const panel = await api(`/api/teacher-panel?student_id=${state.selectedStudentId}&teacher_id=${teacherId}`);
  const availability = new Set((panel.availability || []).map((x) => slotKey(x.date, Number(x.period))));
  const busySlots = new Set((panel.assignments || []).map((x) => slotKey(x.date, Number(x.period))));
  const data = { availability, busySlots };
  dragTeacherCache.set(teacherId, data);
  return data;
}

function clearDragHoverCell() {
  if (!dragState || !dragState.hoverCell) return;
  dragState.hoverCell.classList.remove("drag-drop-ok", "drag-drop-warn", "drag-drop-no");
}

function getWeekNavDirectionFromPoint(clientX, clientY) {
  const els = document.elementsFromPoint(clientX, clientY);
  const nav = els.find(
    (el) => el instanceof HTMLElement && el.dataset && el.dataset.weekNavDir
  );
  return nav ? nav.dataset.weekNavDir : null;
}

function tryNavigateWeekByDrag(direction) {
  if (!state.weeks || !state.weeks.length) return false;
  const prevIndex = state.currentWeekIndex;
  if (direction === "prev" && state.currentWeekIndex > 0) {
    state.currentWeekIndex -= 1;
  } else if (direction === "next" && state.currentWeekIndex < state.weeks.length - 1) {
    state.currentWeekIndex += 1;
  }
  if (state.currentWeekIndex === prevIndex) return false;

  renderGrid();
  renderTeacherGrid();
  return true;
}

function clearDragTeacherBlockedCells() {
  document
    .querySelectorAll(".cell.drag-teacher-blocked")
    .forEach((cell) => cell.classList.remove("drag-teacher-blocked"));
}

function markDragTeacherBlockedCells() {
  clearDragTeacherBlockedCells();
  if (!dragState || !dragState.teacherCache) return;

  const teacherAvailability = dragState.teacherCache.availability;
  if (!teacherAvailability) return;

  const cells = document.querySelectorAll(".cell[data-date][data-period]");
  cells.forEach((cell) => {
    if (
      cell.classList.contains("unavailable") ||
      cell.classList.contains("no-teacher") ||
      cell.classList.contains("no-candidate") ||
      cell.classList.contains("empty-day") ||
      cell.classList.contains("slot-full")
    ) {
      return;
    }
    const date = String(cell.dataset.date || "");
    const period = Number(cell.dataset.period || 0);
    if (!date || !period) return;
    const slot = slotKey(date, period);
    if (!teacherAvailability.has(slot)) {
      cell.classList.add("drag-teacher-blocked");
    }
  });
}

function getCellFromPoint(clientX, clientY) {
  const els = document.elementsFromPoint(clientX, clientY);
  return (
    els.find(
      (el) =>
        el instanceof HTMLElement &&
        el.classList.contains("cell") &&
        el.dataset.date &&
        el.dataset.period
    ) || null
  );
}

function evaluateDropCell(cell) {
  if (!dragState || !cell) return { ok: false, cls: "drag-drop-no", reason: "配置不可" };
  const date = String(cell.dataset.date || "");
  const period = Number(cell.dataset.period || 0);
  const slot = slotKey(date, period);
  const availabilitySet = new Set(
    ((state.timetable && state.timetable.availability) || []).map((x) => slotKey(x.date, Number(x.period)))
  );
  if (!availabilitySet.has(slot)) return { ok: false, cls: "drag-drop-no", reason: "生徒予定外" };

  const existing = getAssignmentAt(date, period, dragState.sourceAssignmentId);
  if (existing) return { ok: false, cls: "drag-drop-no", reason: "既に割当あり" };

  const cache = dragState.teacherCache;
  if (!cache || !cache.availability.has(slot)) {
    return { ok: false, cls: "drag-drop-no", reason: "講師出勤不可" };
  }

  const isBusy = cache.busySlots.has(slot) && slot !== dragState.sourceSlotKey;
  return {
    ok: true,
    cls: isBusy ? "drag-drop-warn" : "drag-drop-ok",
    reason: isBusy ? "講師重複" : "配置可",
    date,
    period,
  };
}

async function getAutoTableId(date, period, excludeAssignmentId = null) {
  const res = await api(`/api/used-tables?date=${encodeURIComponent(date)}&period=${period}`);
  const used = new Set((res.used_table_ids || []).map(String));

  if (excludeAssignmentId != null) {
    const self = getTimetableAssignments().find((a) => a.id === excludeAssignmentId);
    if (self && self.date === date && Number(self.period) === Number(period)) {
      used.delete(String(self.table_id));
    }
  }

  const free = ((state.meta && state.meta.table_ids) || []).find((t) => !used.has(String(t)));
  return free || null;
}

function startDragCommon(pair, sourceAssignmentId, clientX, clientY) {
  if (dragState) cancelDragState();
  const ghost = document.createElement("div");
  ghost.className = `drag-ghost subject-${subjectTone(pair.subject)}`;
  ghost.textContent = `${pair.teacher_name} / ${pair.subject}`;
  ghost.style.left = `${clientX}px`;
  ghost.style.top = `${clientY}px`;
  document.body.appendChild(ghost);

  const sourceAssignment = sourceAssignmentId
    ? getTimetableAssignments().find((a) => a.id === sourceAssignmentId)
    : null;

  dragState = {
    pair,
    teacherCache: null,
    sourceAssignmentId,
    sourceSlotKey: sourceAssignment ? slotKey(sourceAssignment.date, Number(sourceAssignment.period)) : null,
    hoverCell: null,
    ghost,
    startX: clientX,
    startY: clientY,
    moved: false,
    lastNavDirection: null,
  };

  document.addEventListener("pointermove", handleDragPointerMove);
  document.addEventListener("pointerup", handleDragPointerUp, { once: true });
}

async function startDragFromPalette(pair, clientX, clientY) {
  if (!state.selectedStudentId) return;
  startDragCommon(pair, null, clientX, clientY);
  try {
    dragState.teacherCache = await ensureDragTeacherCache(pair.teacher_id);
    markDragTeacherBlockedCells();
  } catch (err) {
    cancelDragState();
    showFlash(`講師情報の取得失敗: ${err.message}`, "error");
  }
}

async function startDragFromAssignment(assignment, clientX, clientY) {
  if (!assignment || !assignment.teacher_id) return;
  const pair = {
    teacher_id: Number(assignment.teacher_id),
    teacher_name: assignment.teacher_name,
    subject: assignment.subject,
  };
  startDragCommon(pair, assignment.id, clientX, clientY);
  try {
    dragState.teacherCache = await ensureDragTeacherCache(pair.teacher_id);
    markDragTeacherBlockedCells();
  } catch (err) {
    cancelDragState();
    showFlash(`講師情報の取得失敗: ${err.message}`, "error");
  }
}

function handleDragPointerMove(e) {
  if (!dragState) return;
  dragState.ghost.style.left = `${e.clientX}px`;
  dragState.ghost.style.top = `${e.clientY}px`;
  if (Math.abs(e.clientX - dragState.startX) > 4 || Math.abs(e.clientY - dragState.startY) > 4) {
    dragState.moved = true;
  }

  const navDirection = getWeekNavDirectionFromPoint(e.clientX, e.clientY);
  if (navDirection) {
    if (dragState.lastNavDirection !== navDirection) {
      dragState.lastNavDirection = navDirection;
      const movedWeek = tryNavigateWeekByDrag(navDirection);
      if (movedWeek) {
        markDragTeacherBlockedCells();
      }
    }
  } else {
    dragState.lastNavDirection = null;
  }

  const cell = getCellFromPoint(e.clientX, e.clientY);
  if (cell !== dragState.hoverCell) {
    clearDragHoverCell();
    dragState.hoverCell = cell;
  }
  if (!cell) return;
  const result = evaluateDropCell(cell);
  cell.classList.remove("drag-drop-ok", "drag-drop-warn", "drag-drop-no");
  cell.classList.add(result.cls);
}

function cancelDragState() {
  if (!dragState) return;
  clearDragHoverCell();
  clearDragTeacherBlockedCells();
  document.removeEventListener("pointermove", handleDragPointerMove);
  if (dragState.ghost) dragState.ghost.remove();
  dragState = null;
}

async function handleDragPointerUp(e) {
  if (!dragState) return;
  const current = dragState;
  const cell = getCellFromPoint(e.clientX, e.clientY);
  const result = cell ? evaluateDropCell(cell) : null;
  cancelDragState();

  try {
    suppressTeacherModal(500);

    if (!cell) return;
    if (!current.moved) return;

    if (!result || !result.ok) {
      showFlash(`配置不可: ${result ? result.reason : "不明"}`, "error");
      return;
    }

    const tableId = await getAutoTableId(result.date, result.period, current.sourceAssignmentId);
    if (!tableId) {
      showFlash("配置不可: 空きテーブルがありません", "error");
      return;
    }

    if (current.sourceAssignmentId) {
      const source = getTimetableAssignments().find((a) => a.id === current.sourceAssignmentId);
      if (!source) return;
      if (source.date === result.date && Number(source.period) === Number(result.period)) {
        return;
      }

      const before = toAssignmentSnapshot(source);
      const created = await api("/api/assignments", {
        method: "POST",
        body: JSON.stringify({
          student_id: state.selectedStudentId,
          teacher_id: current.pair.teacher_id,
          table_id: tableId,
          subject: current.pair.subject,
          date: result.date,
          period: result.period,
        }),
      });

      try {
        await api(`/api/assignments/${source.id}`, { method: "DELETE" });
      } catch (err) {
        await api(`/api/assignments/${created.id}`, { method: "DELETE" }).catch(() => {});
        throw err;
      }

      const after = {
        id: created.id,
        student_id: state.selectedStudentId,
        teacher_id: current.pair.teacher_id,
        table_id: tableId,
        subject: current.pair.subject,
        date: result.date,
        period: result.period,
      };
      pushAssignmentHistory({ before, after });
      await loadTimetable();
      showFlash(
        result.cls === "drag-drop-warn"
          ? "移動しました（講師重複あり）"
          : "移動しました"
      );
      return;
    }

    const created = await api("/api/assignments", {
      method: "POST",
      body: JSON.stringify({
        student_id: state.selectedStudentId,
        teacher_id: current.pair.teacher_id,
        table_id: tableId,
        subject: current.pair.subject,
        date: result.date,
        period: result.period,
      }),
    });
    const after = {
      id: created.id,
      student_id: state.selectedStudentId,
      teacher_id: current.pair.teacher_id,
      table_id: tableId,
      subject: current.pair.subject,
      date: result.date,
      period: result.period,
    };
    pushAssignmentHistory({ before: null, after });
    await loadTimetable();
    showFlash(
      result.cls === "drag-drop-warn"
        ? "割り当てました（講師重複あり）"
        : "割り当てました"
    );
  } catch (err) {
    showFlash(`ドラッグ操作失敗: ${err.message}`, "error");
  }
}

function renderConflictBar() {
  const bar = document.getElementById("conflict-bar");
  if (!state.conflicts.length) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.innerHTML = "";
  const grouped = new Map();
  for (const c of state.conflicts) {
    const students = (c.students || []).map((s) => String(s).trim()).filter(Boolean);
    const studentKey = [...students].sort().join("|");
    const key = `${c.date}#${c.period}#${studentKey}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        date: c.date,
        period: c.period,
        students,
        labels: [],
      });
    }
    const entry = grouped.get(key);
    if (c.type === "table") {
      entry.labels.push(`テーブル${c.table_id}`);
    } else {
      entry.labels.push(c.teacher_name);
    }
  }

  for (const c of grouped.values()) {
    const line = document.createElement("div");
    line.className = "conflict-line";

    const prefix = document.createElement("span");
    prefix.textContent = `⚠ ${formatDate(c.date)} ${c.period}限: ${c.labels.join(" , ")} → `;
    line.appendChild(prefix);

    (c.students || []).forEach((studentName, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "conflict-student";
      btn.textContent = studentName;
      btn.addEventListener("click", async () => {
        await jumpToConflictStudent(c.date, c.period, studentName);
      });
      line.appendChild(btn);
      if (idx < c.students.length - 1) {
        const sep = document.createElement("span");
        sep.textContent = " & ";
        line.appendChild(sep);
      }
    });

    bar.appendChild(line);
  }
  bar.classList.remove("hidden");
}

async function jumpToConflictStudent(date, period, studentName) {
  const targetStudent = (state.students || []).find((s) => s.name === studentName);
  if (!targetStudent) {
    showFlash(`生徒が見つかりません: ${studentName}`, "error");
    return;
  }

  state.selectedStudentId = targetStudent.id;
  const combo = document.getElementById("student-combo");
  if (combo) combo.value = targetStudent.name;
  await loadTimetable({ preferEnrolledSubject: true });

  const assignment =
    (state.timetable.assignments || []).find(
      (a) => a.date === date && Number(a.period) === Number(period)
    ) || null;

  if (assignment && assignment.subject) {
    state.selectedSubject = assignment.subject;
    document.getElementById("subject-select").value = assignment.subject;
  }

  await openTeacherModal(date, period, assignment);
}

async function jumpToStudentFromTeacherPanel(studentName) {
  const targetStudent = (state.students || []).find((s) => s.name === studentName);
  if (!targetStudent) {
    showFlash(`生徒が見つかりません: ${studentName}`, "error");
    return;
  }
  state.selectedStudentId = targetStudent.id;
  const combo = document.getElementById("student-combo");
  if (combo) combo.value = targetStudent.name;
  updateStudentPlaceholder();
  await loadTimetable({ preferEnrolledSubject: true });
  const topGrid = document.querySelector(".grid-wrap");
  if (topGrid) {
    topGrid.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function buildAndAppendWeekTable(container, weekDates, periods, availabilitySet, assignmentMap, slotSummaryMap, originalDatesSet) {
  // Create week wrapper
  const weekWrapper = document.createElement("div");
  weekWrapper.className = "week-table-wrapper";

  // Week label
  const weekLabel = document.createElement("div");
  weekLabel.className = "week-label";
  weekLabel.textContent = buildWeekHeader(weekDates);
  weekWrapper.appendChild(weekLabel);

  // Week table
  const table = document.createElement("table");
  table.className = "week-timetable";

  // 曜日ヘッダー行（例: 月 火 ...）
  const weekdayRow = document.createElement("tr");
  weekdayRow.className = "weekday-header-row";
  const cornerWeek = document.createElement("th");
  cornerWeek.className = "sticky-corner";
  cornerWeek.textContent = "";
  weekdayRow.appendChild(cornerWeek);
  for (const date of weekDates) {
    const th = document.createElement("th");
    th.className = "weekday-cell";
    if (date) {
      const [y, m, d] = date.split("-").map(Number);
      const dow = new Date(y, m - 1, d).getDay();
      const labels = ["日", "月", "火", "水", "木", "金", "土"];
      th.textContent = labels[dow];
      if (dow === 6) th.classList.add("weekday-sat");
      if (dow === 0) th.classList.add("weekday-sun");
    } else {
      th.textContent = "";
    }
    weekdayRow.appendChild(th);
  }
  table.appendChild(weekdayRow);

  // Header row with dates
  const headerRow = document.createElement("tr");
  headerRow.className = "date-header-row";
  headerRow.className = "date-header-row";
  const cornerHeader = document.createElement("th");
  cornerHeader.className = "sticky-corner";
  cornerHeader.textContent = "時限";
  headerRow.appendChild(cornerHeader);
  for (const date of weekDates) {
    const th = document.createElement("th");
    th.className = "date-header";
    th.textContent = formatDate(date);
    headerRow.appendChild(th);
  }
  table.appendChild(headerRow);

  // Period rows
  for (const period of periods) {
    const tr = document.createElement("tr");
    const label = document.createElement("th");
    label.className = "period-header sticky-corner";
    label.textContent = state.meta.period_labels[String(period)] || `${period}限`;
    tr.appendChild(label);

    for (const date of weekDates) {
      const td = document.createElement("td");
      td.className = "cell";

      // カレンダーに存在しない日（元データになければグレーアウト）
      const exists = originalDatesSet ? originalDatesSet.has(date) : true;
      if (!exists) {
        td.classList.add("empty-day");
        td.textContent = "";
        tr.appendChild(td);
        continue;
      }

      td.dataset.date = date;
      td.dataset.period = String(period);
      const key = `${date}#${period}`;
      const available = availabilitySet.has(key);
      const assignment = assignmentMap.get(key);

      if (assignment) {
        td.classList.add("assigned");
        if (
          assignment.has_teacher_conflict ||
          assignment.has_table_conflict ||
          assignment.has_schedule_mismatch ||
          assignment.has_student_schedule_mismatch
        ) {
          td.classList.add("conflict");
        }
        const reasons = [];
        if (assignment.has_teacher_conflict) reasons.push("講師重複");
        if (assignment.has_table_conflict) reasons.push("席重複");
        if (assignment.has_schedule_mismatch) reasons.push("講師予定不一致");
        if (assignment.has_student_schedule_mismatch) reasons.push("生徒予定不一致");
        const titleParts = [`${assignment.subject} / ${assignment.teacher_name} / ${assignment.table_id}`];
        if (reasons.length) titleParts.push(`エラー: ${reasons.join(" / ")}`);
        td.title = titleParts.join("\n");
        const tone = subjectTone(assignment.subject);
        td.innerHTML = `<div class="cell-main"><span class="assignment-pill subject-${tone}"><span class="assignment-name">${assignment.teacher_name}</span><span class="assignment-table">${assignment.table_id}</span></span></div>${
          reasons.length ? `<div class=\"cell-reason\">${reasons.join(" / ")}</div>` : ""
        }`;
        const assignmentPill = td.querySelector(".assignment-pill");
        if (assignmentPill) {
          assignmentPill.style.cursor = "grab";
          assignmentPill.addEventListener("pointerdown", async (e) => {
            if (e.pointerType === "mouse" && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            await startDragFromAssignment(assignment, e.clientX, e.clientY);
          });
        }
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "cell-assignment-delete-btn";
        deleteBtn.textContent = "×";
        deleteBtn.title = "この割り当てを削除";
        deleteBtn.setAttribute("aria-label", "この割り当てを削除");
        deleteBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            const before = toAssignmentSnapshot(assignment);
            await api(`/api/assignments/${assignment.id}`, { method: "DELETE" });
            pushAssignmentHistory({ before, after: null });
            await loadTimetable();
            showFlash("割り当てを削除しました");
          } catch (err) {
            showFlash(`削除失敗: ${err.message}`, "error");
          }
        });
        td.appendChild(deleteBtn);
        td.addEventListener("click", () => openTeacherModal(date, period, assignment));
      } else if (!available) {
        td.classList.add("unavailable");
        td.textContent = "";
      } else if (state.selectedSubject) {
        const summary = slotSummaryMap.get(key) || { free: 0, total: 0 };
        if (summary.free > 0) {
          td.classList.add("available-empty", "has-open-teacher");
          td.innerHTML = `<div class="cell-hint">${summary.free}人対応可</div>`;
          td.addEventListener("click", () => openTeacherModal(date, period, null));
        } else {
          if (summary.total > 0) {
            td.classList.add("slot-full", "no-teacher-clickable");
            td.innerHTML = `<div class="cell-hint">満</div>`;
          } else {
            td.classList.add("no-candidate", "no-teacher-clickable");
            td.innerHTML = `<div class="cell-hint mute">0</div>`;
          }
          td.addEventListener("click", () => openTeacherModal(date, period, null));
        }
      } else {
        td.classList.add("available-empty");
        td.addEventListener("click", () => openTeacherModal(date, period, null));
      }

      tr.appendChild(td);
    }

    table.appendChild(tr);
  }

  weekWrapper.appendChild(table);
  container.appendChild(weekWrapper);
}

function renderGrid() {
  const container = document.getElementById("timetable");
  const dates = state.meta.dates;
  const periods = state.meta.periods;

  const availabilitySet = new Set(
    state.timetable.availability.map((s) => `${s.date}#${s.period}`)
  );

  const assignmentMap = new Map();
  for (const a of state.timetable.assignments) {
    assignmentMap.set(`${a.date}#${a.period}`, a);
  }
  const slotSummaryMap = new Map();
  for (const s of state.slotSummary || []) {
    slotSummaryMap.set(`${s.date}#${s.period}`, {
      free: Number(s.free_teacher_count || 0),
      total: Number(s.total_teacher_count || 0),
    });
  }

  // グループ化と状態を保存
  state.calendarDateSet = new Set(dates || []);
  state.weeks = groupDatesByWeek(dates);
  if (state.currentWeekIndex >= state.weeks.length) {
    state.currentWeekIndex = 0;
  }

  container.innerHTML = "";
  
  // ナビゲーションボタンを追加
  const navBar = document.createElement("div");
  navBar.className = "week-nav-bar";
  navBar.style.marginBottom = "10px";
  navBar.style.display = "flex";
  navBar.style.gap = "10px";
  navBar.style.alignItems = "center";

  const prevBtn = document.createElement("button");
  prevBtn.className = "btn-secondary";
  prevBtn.dataset.weekNavDir = "prev";
  prevBtn.textContent = "< 前の週";
  prevBtn.addEventListener("click", () => {
    if (state.currentWeekIndex > 0) {
      state.currentWeekIndex--;
      renderGrid();
      renderTeacherGrid();
    }
  });

  const nextBtn = document.createElement("button");
  nextBtn.className = "btn-secondary";
  nextBtn.dataset.weekNavDir = "next";
  nextBtn.textContent = "次の週 >";
  nextBtn.addEventListener("click", () => {
    if (state.currentWeekIndex < state.weeks.length - 1) {
      state.currentWeekIndex++;
      renderGrid();
      renderTeacherGrid();
    }
  });

  const weekInfo = document.createElement("span");
  weekInfo.style.fontSize = "14px";
  weekInfo.style.color = "var(--muted)";

  navBar.appendChild(prevBtn);
  navBar.appendChild(weekInfo);
  navBar.appendChild(nextBtn);
  container.appendChild(navBar);

  // 現在の週だけをレンダリング
  if (state.weeks.length > 0) {
    const currentWeek = state.weeks[state.currentWeekIndex];
    weekInfo.textContent = `第${state.currentWeekIndex + 1}週 ${weekRangeLabel(currentWeek)}`;
    buildAndAppendWeekTable(container, currentWeek, periods, availabilitySet, assignmentMap, slotSummaryMap, state.calendarDateSet);
  }
}

function renderTeacherPanel() {
  const combo = document.getElementById("teacher-combo");
  const body = document.getElementById("teacher-panel-body");
  if (!combo || !body) return;
  body.classList.toggle("hidden", !state.isTeacherPanelOpen);
  updateTeacherPanelToggleLabel();
  if (!state.isTeacherPanelOpen) return;
  const filterText = combo.value || "";
  renderTeacherOptions(filterText);
  updateTeacherPlaceholder();
  renderTeacherSubjects();
  renderTeacherMemo();
  renderTeacherGrid();
}

function renderTeacherSubjects() {
  const box = document.getElementById("teacher-subjects");
  if (!box) return;
  const subjects = (state.teacherPanel && state.teacherPanel.subjects) || [];
  if (!subjects.length) {
    box.textContent = "担当科目: なし";
    return;
  }
  box.textContent = `担当科目: ${subjects.join(" / ")}`;
}

function renderTeacherMemo() {
  const box = document.getElementById("teacher-note");
  if (!box) return;
  const teachers = (state.teacherPanel && state.teacherPanel.teachers) || [];
  const selected = teachers.find((t) => t.teacher_id === state.selectedTeacherId);
  const memo = selected && selected.memo ? String(selected.memo).trim() : "";
  if (!memo) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }
  box.textContent = `備考: ${memo}`;
  box.classList.remove("hidden");
}

function updateTeacherPanelToggleLabel() {
  const btn = document.getElementById("teacher-panel-toggle");
  if (!btn) return;
  if (!state.isTeacherPanelOpen) {
    btn.textContent = "講師カレンダーを表示";
    return;
  }
  const teachers = (state.teacherPanel && state.teacherPanel.teachers) || [];
  const selected = teachers.find((t) => t.teacher_id === state.selectedTeacherId);
  btn.textContent = selected
    ? `講師カレンダーを隠す（${selected.name}）`
    : "講師カレンダーを隠す";
}

function renderTeacherOptions(filterText) {
  const dropdown = document.getElementById("teacher-dropdown");
  if (!dropdown) return;
  const teachers = (state.teacherPanel && state.teacherPanel.teachers) || [];
  const keyword = (filterText || "").trim();
  const filtered = keyword ? teachers.filter((t) => t.name.includes(keyword)) : teachers;
  teacherDropdownOptions = filtered;
  activeTeacherOptionIndex = -1;
  const registered = filtered.filter((t) => t.is_registered_for_student);
  const others = filtered.filter((t) => !t.is_registered_for_student);

  dropdown.innerHTML = "";
  const appendGroup = (title, list) => {
    if (!list.length) return;
    const label = document.createElement("div");
    label.className = "teacher-group-label";
    label.textContent = title;
    dropdown.appendChild(label);
    for (const teacher of list) {
      const row = document.createElement("div");
      row.className = "teacher-option";
      row.dataset.teacherOption = "1";
      const suffix = teacher.student_assignment_count > 0 ? `（${teacher.student_assignment_count}回）` : "";
      row.textContent = `${teacher.name}${suffix}`;
      row.addEventListener("mousedown", async (e) => {
        e.preventDefault();
        state.selectedTeacherId = teacher.teacher_id;
        const teacherCombo = document.getElementById("teacher-combo");
        if (teacherCombo) teacherCombo.value = teacher.name;
        hideTeacherDropdown();
        await loadTeacherPanel();
        renderTeacherPanel();
      });
      dropdown.appendChild(row);
    }
  };

  appendGroup("この生徒で登録済み講師", registered);
  appendGroup("その他の講師", others);
  if (!registered.length && !others.length) {
    const empty = document.createElement("div");
    empty.className = "teacher-option";
    empty.textContent = "該当なし";
    dropdown.appendChild(empty);
  }
}

function setActiveTeacherOption(index) {
  const dropdown = document.getElementById("teacher-dropdown");
  if (!dropdown) return;
  const optionEls = Array.from(dropdown.querySelectorAll('[data-teacher-option="1"]'));
  optionEls.forEach((el) => el.classList.remove("teacher-option-active"));
  if (!optionEls.length) {
    activeTeacherOptionIndex = -1;
    return;
  }
  if (index < 0 || index >= optionEls.length) {
    activeTeacherOptionIndex = -1;
    return;
  }
  activeTeacherOptionIndex = index;
  const activeEl = optionEls[index];
  activeEl.classList.add("teacher-option-active");
  activeEl.scrollIntoView({ block: "nearest" });
}

async function selectTeacherFromDropdown(teacher) {
  if (!teacher) return;
  const combo = document.getElementById("teacher-combo");
  if (combo) combo.value = teacher.name;
  if (teacher.teacher_id === state.selectedTeacherId) {
    hideTeacherDropdown();
    return;
  }
  state.selectedTeacherId = teacher.teacher_id;
  updateTeacherPlaceholder();
  hideTeacherDropdown();
  await loadTeacherPanel();
  renderTeacherPanel();
}

function buildAndAppendTeacherWeekTable(container, weekDates, periods, panel, originalDatesSet) {
  // Create week wrapper
  const weekWrapper = document.createElement("div");
  weekWrapper.className = "week-table-wrapper";

  // Week label
  const weekLabel = document.createElement("div");
  weekLabel.className = "week-label";
  weekLabel.textContent = buildWeekHeader(weekDates);
  weekWrapper.appendChild(weekLabel);

  // Build availability and assignment maps
  const availabilitySet = new Set((panel.availability || []).map((a) => `${a.date}#${a.period}`));
  const assignmentMap = new Map();
  const conflictSlotSet = new Set();
  for (const a of panel.assignments || []) {
    const key = `${a.date}#${a.period}`;
    if (!assignmentMap.has(key)) assignmentMap.set(key, []);
    assignmentMap.get(key).push({
      student_name: a.student_name,
      subject: a.subject,
    });
    if (a.has_conflict) conflictSlotSet.add(key);
  }

  // Week table
  const table = document.createElement("table");
  table.className = "week-timetable";

  // 曜日ヘッダー行
  const weekdayRow = document.createElement("tr");
  weekdayRow.className = "weekday-header-row";
  const cornerWeek = document.createElement("th");
  cornerWeek.className = "sticky-corner";
  cornerWeek.textContent = "";
  weekdayRow.appendChild(cornerWeek);
  for (const date of weekDates) {
    const th = document.createElement("th");
    th.className = "weekday-cell";
    if (date) {
      const [y, m, d] = date.split("-").map(Number);
      const dow = new Date(y, m - 1, d).getDay();
      const labels = ["日", "月", "火", "水", "木", "金", "土"];
      th.textContent = labels[dow];
      if (dow === 6) th.classList.add("weekday-sat");
      if (dow === 0) th.classList.add("weekday-sun");
    }
    weekdayRow.appendChild(th);
  }
  table.appendChild(weekdayRow);

  // Header row with dates
  const headerRow = document.createElement("tr");
  const cornerHeader = document.createElement("th");
  cornerHeader.className = "sticky-corner";
  cornerHeader.textContent = "時限";
  headerRow.appendChild(cornerHeader);
  for (const date of weekDates) {
    const th = document.createElement("th");
    th.className = "date-header";
    th.textContent = formatDate(date);
    headerRow.appendChild(th);
  }
  table.appendChild(headerRow);

  // Period rows
  for (const period of periods) {
    const tr = document.createElement("tr");
    const label = document.createElement("th");
    label.className = "period-header sticky-corner";
    label.textContent = state.meta.period_labels[String(period)] || `${period}限`;
    tr.appendChild(label);

    for (const date of weekDates) {
      const td = document.createElement("td");
      td.className = "teacher-cell";

      // 元データにない日付は空にする
      const exists = originalDatesSet ? originalDatesSet.has(date) : true;
      if (!exists) {
        td.classList.add("empty-day");
        td.textContent = "";
        tr.appendChild(td);
        continue;
      }

      const key = `${date}#${period}`;
      const entries = assignmentMap.get(key) || [];
      const available = availabilitySet.has(key);
      if (entries.length > 0) {
        td.classList.add("assigned");
        if (conflictSlotSet.has(key)) {
          td.classList.add("conflict");
        }
        td.innerHTML = "";
        const content = document.createElement("div");
        content.className = "teacher-cell-content";
        entries.forEach((entry, idx) => {
          const student = (state.students || []).find((s) => s.name === entry.student_name);
          const c = colorForStudentRef(student ? student.id : entry.student_name);
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "teacher-cell-student";
          btn.textContent = entry.student_name;
          btn.style.backgroundColor = c.bg;
          btn.style.borderLeftColor = c.border;
          btn.style.color = c.text;
          if (entry.subject) {
            btn.title = `科目: ${entry.subject}`;
          }
          btn.addEventListener("click", async () => {
            await jumpToStudentFromTeacherPanel(entry.student_name);
          });
          content.appendChild(btn);
          if (idx < entries.length - 1) {
            const sep = document.createElement("span");
            sep.className = "teacher-cell-sep";
            sep.textContent = " / ";
            content.appendChild(sep);
          }
        });
        td.appendChild(content);
      } else if (!available) {
        td.classList.add("unavailable");
        td.textContent = "×";
      } else {
        td.textContent = "";
      }
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }

  weekWrapper.appendChild(table);
  container.appendChild(weekWrapper);
}

function renderTeacherGrid() {
  const container = document.getElementById("teacher-timetable");
  if (!container || !state.meta) return;
  const panel = state.teacherPanel || { assignments: [], availability: [] };
  const periods = state.meta.periods;
  const dates = state.meta.dates;

  container.innerHTML = "";
  
  // ナビゲーションボタンを追加（同じweeks状態を使用）
  if (!state.weeks || state.weeks.length === 0) {
    state.calendarDateSet = new Set(dates || []);
    state.weeks = groupDatesByWeek(dates);
  }
  
  const navBar = document.createElement("div");
  navBar.className = "week-nav-bar";
  navBar.style.marginBottom = "10px";
  navBar.style.display = "flex";
  navBar.style.gap = "10px";
  navBar.style.alignItems = "center";

  const prevBtn = document.createElement("button");
  prevBtn.className = "btn-secondary";
  prevBtn.dataset.weekNavDir = "prev";
  prevBtn.textContent = "< 前の週";
  prevBtn.addEventListener("click", () => {
    if (state.currentWeekIndex > 0) {
      state.currentWeekIndex--;
      renderTeacherGrid();
      renderGrid();
    }
  });

  const nextBtn = document.createElement("button");
  nextBtn.className = "btn-secondary";
  nextBtn.dataset.weekNavDir = "next";
  nextBtn.textContent = "次の週 >";
  nextBtn.addEventListener("click", () => {
    if (state.currentWeekIndex < state.weeks.length - 1) {
      state.currentWeekIndex++;
      renderTeacherGrid();
      renderGrid();
    }
  });

  const weekInfo = document.createElement("span");
  weekInfo.style.fontSize = "14px";
  weekInfo.style.color = "var(--muted)";

  navBar.appendChild(prevBtn);
  navBar.appendChild(weekInfo);
  navBar.appendChild(nextBtn);
  container.appendChild(navBar);

  // 現在の週だけをレンダリング
  if (state.weeks.length > 0) {
    const currentWeek = state.weeks[state.currentWeekIndex];
    weekInfo.textContent = `第${state.currentWeekIndex + 1}週 ${weekRangeLabel(currentWeek)}`;
    buildAndAppendTeacherWeekTable(container, currentWeek, periods, panel, state.calendarDateSet);
  }
}

function showTeacherDropdown() {
  const dropdown = document.getElementById("teacher-dropdown");
  if (!dropdown) return;
  dropdown.classList.remove("hidden");
}

function hideTeacherDropdown() {
  const dropdown = document.getElementById("teacher-dropdown");
  if (!dropdown) return;
  dropdown.classList.add("hidden");
  activeTeacherOptionIndex = -1;
}

function isTeacherDropdownVisible() {
  const dropdown = document.getElementById("teacher-dropdown");
  return !!dropdown && !dropdown.classList.contains("hidden");
}

function updateTeacherPlaceholder() {
  const combo = document.getElementById("teacher-combo");
  if (!combo) return;
  const teachers = (state.teacherPanel && state.teacherPanel.teachers) || [];
  const selected = teachers.find((t) => t.teacher_id === state.selectedTeacherId);
  combo.placeholder = selected
    ? `現在: ${selected.name}（入力して検索）`
    : "講師名を入力して選択";
}

async function openTeacherModal(date, period, existingAssignment) {
  if (shouldSuppressTeacherModal()) return;
  state.selectedSlot = { date, period, existingAssignment };

  const modal = document.getElementById("teacher-modal");
  const title = document.getElementById("modal-title");
  const list = document.getElementById("teacher-list");
  const removeBtn = document.getElementById("remove-assignment-btn");
  const tableSelect = document.getElementById("table-select");

  const selectedStudent = getSelectedStudent();
  const studentName = selectedStudent ? selectedStudent.name : "生徒未選択";
  title.textContent = `${formatDate(date)} ${period}限 - ${state.selectedSubject} - ${studentName}`;
  list.innerHTML = "";
  tableSelect.innerHTML = "";

  for (const tableId of state.meta.table_ids || []) {
    const opt = document.createElement("option");
    opt.value = tableId;
    tableSelect.appendChild(opt);
  }
  const usage = await api(`/api/used-tables?date=${date}&period=${period}`);
  const usedTables = new Set(usage.used_table_ids || []);
  for (const opt of tableSelect.options) {
    if (usedTables.has(opt.value)) {
      opt.textContent = `${opt.value} ⚠ 使用中`;
      opt.style.color = "#b22030";
      opt.style.backgroundColor = "#ffe9ec";
    } else {
      opt.textContent = opt.value;
      opt.style.color = "";
      opt.style.backgroundColor = "";
    }
  }
  let defaultTableId = "A";
  if (existingAssignment && existingAssignment.table_id) {
    defaultTableId = existingAssignment.table_id;
  } else {
    const firstFree = (state.meta.table_ids || []).find((t) => !usedTables.has(t));
    if (firstFree) {
      defaultTableId = firstFree;
    }
  }
  tableSelect.value = defaultTableId;

  const teachers = await api(
    `/api/available-teachers?date=${date}&period=${period}&subject=${encodeURIComponent(
      state.selectedSubject
    )}&student_id=${state.selectedStudentId}`
  );

  const uniqueTeachers = [];
  const seenTeacherIds = new Set();

  for (const teacher of teachers) {
    const key = teacher.teacher_id;
    if (seenTeacherIds.has(key)) continue;
    seenTeacherIds.add(key);
    uniqueTeachers.push(teacher);
  }

  for (const teacher of uniqueTeachers) {
    const btn = document.createElement("button");
    btn.className = "teacher-item";
    if (teacher.has_conflict) btn.classList.add("conflict");
    const star = teacher.assignment_count > 0 ? "★ " : "";
    const count = teacher.assignment_count > 0 ? `（${teacher.assignment_count}回）` : "";
    const warning = teacher.has_conflict ? ` ⚠ ${teacher.conflict_with}と重複` : "";
    btn.textContent = `${star}${teacher.name}${count}${warning}`;
    btn.addEventListener("click", async () => {
      closeModal();
      const selectedTableId = tableSelect.value;
      const before = toAssignmentSnapshot(existingAssignment);
      const created = await api("/api/assignments", {
        method: "POST",
        body: JSON.stringify({
          student_id: state.selectedStudentId,
          teacher_id: teacher.teacher_id,
          table_id: selectedTableId,
          subject: state.selectedSubject,
          date,
          period,
        }),
      });
      const after = {
        id: created.id,
        student_id: state.selectedStudentId,
        teacher_id: teacher.teacher_id,
        table_id: selectedTableId,
        subject: state.selectedSubject,
        date,
        period,
      };
      pushAssignmentHistory({ before, after });
      await loadTimetable();
    });
    list.appendChild(btn);
  }

  if (existingAssignment) {
    removeBtn.classList.remove("hidden");
    removeBtn.onclick = async () => {
      const before = toAssignmentSnapshot(existingAssignment);
      await api(`/api/assignments/${existingAssignment.id}`, { method: "DELETE" });
      pushAssignmentHistory({ before, after: null });
      closeModal();
      await loadTimetable();
    };
  } else {
    removeBtn.classList.add("hidden");
    removeBtn.onclick = null;
  }

  modal.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("teacher-modal").classList.add("hidden");
  if (pendingRealtimeRefresh) {
    scheduleRealtimeRefresh();
  }
}

function showConfirmModal(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const msg = document.getElementById("confirm-message");
    const yesBtn = document.getElementById("confirm-yes-btn");
    const noBtn = document.getElementById("confirm-no-btn");
    if (!modal || !msg || !yesBtn || !noBtn) {
      resolve(false);
      return;
    }

    msg.textContent = message;
    modal.classList.remove("hidden");

    const cleanup = () => {
      modal.classList.add("hidden");
      yesBtn.onclick = null;
      noBtn.onclick = null;
    };
    yesBtn.onclick = () => {
      cleanup();
      resolve(true);
    };
    noBtn.onclick = () => {
      cleanup();
      resolve(false);
    };
  });
}

async function syncScheduleFromFile() {
  const input = document.getElementById("schedule-file-input");
  if (!input) {
    showFlash("ファイル選択欄が見つかりません。画面を再読み込みしてください。", "error");
    return;
  }
  if (!input.files || input.files.length === 0) {
    showFlash("取り込む予定表ファイル（CSV/XLSX）を選択してください。", "error");
    return;
  }
  const file = input.files[0];
  const formData = new FormData();
  formData.append("file", file);
  try {
    const previewRes = await fetch("/api/sync-upload", {
      method: "POST",
      headers: getRequestHeaders(),
      body: formData,
    });
    const preview = await previewRes.json();
    if (!previewRes.ok) {
      throw new Error(preview.error || `HTTP ${previewRes.status}`);
    }

    if ((preview.removed_count || 0) > 0) {
      const names = (preview.removed_names || []).join(", ");
      const label = preview.kind === "teacher" ? "講師" : "生徒";
      const msg =
        `予定表から消える${label}がいます。\n` +
        `対象: ${names}\n` +
        `削除${label}数: ${preview.removed_count} / 削除される割り当て: ${preview.removed_assignments}\n\n` +
        `本当に反映しますか？`;
      const ok = await showConfirmModal(msg);
      if (!ok) {
        return;
      }
    }

    const applyFormData = new FormData();
    applyFormData.append("file", file);
    const res = await fetch("/api/sync-upload/apply", {
      method: "POST",
      headers: getRequestHeaders(),
      body: applyFormData,
    });
    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.error || `HTTP ${res.status}`);
    }

    const label = result.kind === "teacher" ? "講師予定" : "生徒予定";
    showFlash(`${label}反映完了: 取込${result.imported_count}件 / 削除${result.removed_count}件`);
    await loadBaseData({ preserveSelection: true });
    await loadTimetable({ preferEnrolledSubject: true });
    input.value = "";
  } catch (err) {
    showFlash(`取り込み失敗: ${err.message}`, "error");
  }
}

async function resetCurrentAssignments() {
  const ok = await showConfirmModal("現在の登録（割り当て）をすべて削除します。よろしいですか？");
  if (!ok) return;
  try {
    const result = await api("/api/assignments/reset", { method: "POST" });
    await loadTimetable({ preferEnrolledSubject: true });
    showFlash(`登録をリセットしました（${result.deleted_assignments}件削除）`);
  } catch (err) {
    showFlash(`リセット失敗: ${err.message}`, "error");
  }
}

function normalizeSubjectForSpreadsheet(subject) {
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
  if (/中学英語|高校英語|英語/.test(s)) return "英語";
  return s;
}

function formatDateForSpreadsheet(isoDate) {
  return String(isoDate || "").replaceAll("-", "/");
}

function formatPeriodForSpreadsheet(period) {
  const label = state.meta?.period_labels?.[String(period)] || `${period}限`;
  return String(label || `${period}限`);
}

function buildSpreadsheetCopyText() {
  const assignments = (state.timetable && state.timetable.assignments) || [];
  const selectedStudent = getSelectedStudent();
  const studentName =
    (state.timetable && state.timetable.student && state.timetable.student.name) ||
    (selectedStudent && selectedStudent.name) ||
    "";

  const sorted = [...assignments].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return Number(a.period) - Number(b.period);
  });

  const rows = sorted.map((a) => {
    return [
      studentName,
      a.teacher_name || "",
      normalizeSubjectForSpreadsheet(a.subject),
      formatDateForSpreadsheet(a.date),
      formatPeriodForSpreadsheet(a.period),
    ];
  });

  return {
    rows,
    text: rows.map((r) => r.join("\t")).join("\n"),
  };
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "readonly");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) {
    throw new Error("クリップボードにコピーできませんでした");
  }
}

async function copyAssignmentsForSpreadsheet() {
  if (!state.selectedStudentId) {
    showFlash("先に生徒を選択してください", "error");
    return;
  }
  const { rows, text } = buildSpreadsheetCopyText();
  if (!rows.length) {
    showFlash("コピー対象の授業がありません", "error");
    return;
  }
  try {
    await copyTextToClipboard(text);
    showFlash(`コピペ用をコピーしました（${rows.length}行）`);
  } catch (err) {
    window.prompt("コピーできなかったので、以下を手動コピーしてください", text);
    showFlash(`手動コピーを表示しました: ${err.message}`, "error");
  }
}

function bindEvents() {
  const studentCombo = document.getElementById("student-combo");
  const studentClearBtn = document.getElementById("student-clear-btn");
  const studentDropdown = document.getElementById("student-dropdown");
  const subjectSelect = document.getElementById("subject-select");
  const teacherCombo = document.getElementById("teacher-combo");
  const teacherClearBtn = document.getElementById("teacher-clear-btn");
  const teacherDropdown = document.getElementById("teacher-dropdown");
  const teacherPanelToggleBtn = document.getElementById("teacher-panel-toggle");
  const cancelBtn = document.getElementById("cancel-modal-btn");
  const modal = document.getElementById("teacher-modal");
  const syncBtn = document.getElementById("sync-upload-btn");
  const copyPasteBtn = document.getElementById("copy-paste-btn");
  const resetBtn = document.getElementById("reset-assignments-btn");
  const studentStatusSelect = document.getElementById("student-status-select");
  const studentNoteComposeInput = document.getElementById("student-note-compose-input");
  const studentNoteSendBtn = document.getElementById("student-note-send-btn");
  const studentNoteTrashToggleBtn = document.getElementById("student-note-trash-toggle-btn");
  const resolveStudentFromInput = async (text) => {
    const value = (text || "").trim();
    if (!value) return;
    const exact = state.students.find((s) => s.name === value);
    const target = exact || state.students.find((s) => s.name.includes(value));
    if (!target) return;
    if (target.id === state.selectedStudentId) return;
    state.selectedStudentId = target.id;
    if (studentCombo) studentCombo.value = target.name;
    updateStudentPlaceholder();
    await loadTimetable({ preferEnrolledSubject: true });
  };

  if (studentCombo) {
    studentCombo.addEventListener("focus", () => {
      renderStudentOptions(studentCombo.value, { activateSelected: true });
      showStudentDropdown();
    });
    studentCombo.addEventListener("input", () => {
      renderStudentOptions(studentCombo.value);
      showStudentDropdown();
    });
    studentCombo.addEventListener("change", async (e) => {
      await resolveStudentFromInput(e.target.value);
    });
    studentCombo.addEventListener("keydown", async (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!isStudentDropdownVisible()) {
          renderStudentOptions(studentCombo.value, { activateSelected: true });
          showStudentDropdown();
        }
        const count = studentDropdownOptions.length;
        if (!count) return;
        const dir = e.key === "ArrowDown" ? 1 : -1;
        let next = activeStudentOptionIndex;
        if (next === -1) {
          next = dir === 1 ? 0 : count - 1;
        } else {
          next = (next + dir + count) % count;
        }
        setActiveStudentOption(next);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (isStudentDropdownVisible() && activeStudentOptionIndex >= 0) {
          const student = studentDropdownOptions[activeStudentOptionIndex];
          await selectStudentFromDropdown(student);
          return;
        }
        await resolveStudentFromInput(e.target.value);
        hideStudentDropdown();
      }
      if (e.key === "Escape") hideStudentDropdown();
    });
    studentCombo.addEventListener("blur", () => {
      setTimeout(() => hideStudentDropdown(), 100);
    });
  }
  if (studentClearBtn) {
    studentClearBtn.addEventListener("mousedown", (e) => {
      // Keep focus on input and avoid blur/focus race when toggling dropdown.
      e.preventDefault();
    });
    studentClearBtn.addEventListener("click", () => {
      if (!studentCombo) return;
      studentCombo.value = "";
      renderStudentOptions("", { activateSelected: true });
      showStudentDropdown();
      updateStudentPlaceholder();
      studentCombo.focus();
    });
  }
  if (studentDropdown) {
    studentDropdown.addEventListener("mousedown", (e) => e.preventDefault());
  }
  document.addEventListener("mousedown", (e) => {
    const target = e.target;
    if (!(target instanceof Node)) return;
    const picker = document.querySelector(".student-picker");
    if (!picker) return;
    if (!picker.contains(target)) {
      hideStudentDropdown();
    }
  });
  if (subjectSelect) {
    subjectSelect.addEventListener("change", async (e) => {
      state.selectedSubject = e.target.value;
      await refreshCurrentSubjectView();
    });
  }

  const resolveTeacherFromInput = async (text) => {
    const value = (text || "").trim();
    if (!value) return;
    const teachers = (state.teacherPanel && state.teacherPanel.teachers) || [];
    const exact = teachers.find((t) => t.name === value);
    const target = exact || teachers.find((t) => t.name.includes(value));
    if (!target) return;
    if (target.teacher_id === state.selectedTeacherId) return;
    state.selectedTeacherId = target.teacher_id;
    if (teacherCombo) teacherCombo.value = target.name;
    updateTeacherPlaceholder();
    await loadTeacherPanel();
    renderTeacherPanel();
  };

  if (teacherCombo) {
    teacherCombo.addEventListener("focus", () => {
      renderTeacherOptions(teacherCombo.value);
      showTeacherDropdown();
    });
    teacherCombo.addEventListener("input", () => {
      renderTeacherOptions(teacherCombo.value);
      showTeacherDropdown();
    });
    teacherCombo.addEventListener("change", async (e) => {
      await resolveTeacherFromInput(e.target.value);
    });
    teacherCombo.addEventListener("keydown", async (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!isTeacherDropdownVisible()) {
          renderTeacherOptions(teacherCombo.value);
          showTeacherDropdown();
        }
        const count = teacherDropdownOptions.length;
        if (!count) return;
        const dir = e.key === "ArrowDown" ? 1 : -1;
        let next = activeTeacherOptionIndex;
        if (next === -1) {
          next = dir === 1 ? 0 : count - 1;
        } else {
          next = (next + dir + count) % count;
        }
        setActiveTeacherOption(next);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (isTeacherDropdownVisible() && activeTeacherOptionIndex >= 0) {
          const teacher = teacherDropdownOptions[activeTeacherOptionIndex];
          await selectTeacherFromDropdown(teacher);
          return;
        }
        await resolveTeacherFromInput(e.target.value);
        hideTeacherDropdown();
      }
      if (e.key === "Escape") hideTeacherDropdown();
    });
    teacherCombo.addEventListener("blur", () => {
      setTimeout(() => hideTeacherDropdown(), 100);
    });
  }
  if (teacherClearBtn) {
    teacherClearBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    teacherClearBtn.addEventListener("click", () => {
      if (!teacherCombo) return;
      teacherCombo.value = "";
      renderTeacherOptions("");
      showTeacherDropdown();
      updateTeacherPlaceholder();
      teacherCombo.focus();
    });
  }
  if (teacherDropdown) {
    teacherDropdown.addEventListener("mousedown", (e) => e.preventDefault());
  }
  if (teacherPanelToggleBtn) {
    teacherPanelToggleBtn.addEventListener("click", () => {
      state.isTeacherPanelOpen = !state.isTeacherPanelOpen;
      renderTeacherPanel();
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener("click", closeModal);
  }
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target.id === "teacher-modal") {
        closeModal();
      }
    });
  }

  if (syncBtn) {
    syncBtn.addEventListener("click", async () => {
      await syncScheduleFromFile();
    });
  }
  if (copyPasteBtn) {
    copyPasteBtn.addEventListener("click", async () => {
      await copyAssignmentsForSpreadsheet();
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      await resetCurrentAssignments();
    });
  }
  if (studentStatusSelect) {
    studentStatusSelect.addEventListener("change", async (e) => {
      try {
        await saveSelectedStudentStatus(e.target.value);
        showFlash(`ステータスを更新しました: ${e.target.value}`);
      } catch (err) {
        showFlash(`ステータス更新失敗: ${err.message}`, "error");
        renderStudentMetaPanel();
      }
    });
  }
  const sendStudentNote = async () => {
    if (!studentNoteComposeInput) return;
    const body = studentNoteComposeInput.value || "";
    if (!body.trim()) return;
    try {
      await postStudentNote(body);
      studentNoteComposeInput.value = "";
      showFlash("メモを投稿しました");
    } catch (err) {
      showFlash(`メモ投稿失敗: ${err.message}`, "error");
    }
  };
  if (studentNoteSendBtn && studentNoteComposeInput) {
    studentNoteSendBtn.addEventListener("click", async () => {
      await sendStudentNote();
    });
    studentNoteComposeInput.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        await sendStudentNote();
      }
    });
  }
  if (studentNoteTrashToggleBtn) {
    studentNoteTrashToggleBtn.addEventListener("click", () => {
      isStudentTrashOpen = !isStudentTrashOpen;
      renderStudentMetaPanel();
    });
  }
}

function bindAutoShutdownOnTabClose() {
  const tabId = getOrCreateTabId();
  const heartbeat = () => {
    try {
      fetch("/api/tab-heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tab_id: tabId }),
      }).catch(() => {});
    } catch (_) {
      // no-op
    }
  };
  const notifyClose = () => {
    if (tabCloseNotified) return;
    tabCloseNotified = true;
    try {
      const payload = JSON.stringify({ tab_id: tabId });
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/tab-close", new Blob([payload], { type: "application/json" }));
      } else {
        fetch("/api/tab-close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    } catch (_) {
      // no-op
    }
  };

  heartbeat();
  if (tabHeartbeatTimer) clearInterval(tabHeartbeatTimer);
  tabHeartbeatTimer = setInterval(heartbeat, 8000);

  window.addEventListener("pagehide", (e) => {
    if (e.persisted) return;
    notifyClose();
  });
  window.addEventListener("beforeunload", () => {
    notifyClose();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      heartbeat();
    }
  });
}

async function main() {
  bindAutoShutdownOnTabClose();
  connectRealtimeUpdates();
  bindEvents();
  await loadBaseData();
  await loadTimetable({ preferEnrolledSubject: true });
}

main().catch((err) => {
  console.error(err);
  showFlash(`初期化エラー: ${err.message}`, "error");
});
