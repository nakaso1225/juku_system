const state = {
  meta: null,
  students: [],
  selectedStudentId: null,
  selectedSubject: null,
  timetable: null,
  conflicts: [],
  slotSummary: [],
  selectedSlot: null,
};

const subjectAbbrevRules = [
  [/算数/, "算"],
  [/数学/, "M"],
  [/英語/, "E"],
  [/国語/, "国"],
  [/理科/, "理"],
  [/社会/, "社"],
  [/物理/, "物"],
  [/化学/, "化"],
  [/生物/, "生"],
  [/地学/, "地"],
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

function formatDate(isoDate) {
  const [y, m, day] = isoDate.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  const week = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${week})`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
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

async function loadBaseData() {
  state.meta = await api("/api/meta");
  state.students = await api("/api/students");

  const studentSelect = document.getElementById("student-select");
  const subjectSelect = document.getElementById("subject-select");

  studentSelect.innerHTML = "";
  for (const student of state.students) {
    const opt = document.createElement("option");
    opt.value = String(student.id);
    opt.textContent = student.name;
    studentSelect.appendChild(opt);
  }

  if (state.students.length > 0) {
    state.selectedStudentId = state.students[0].id;
    studentSelect.value = String(state.selectedStudentId);
  }
  state.selectedSubject = state.meta.subjects[0] || null;
  buildSubjectSelect([]);
  subjectSelect.value = state.selectedSubject;
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

async function loadTimetable() {
  if (!state.selectedStudentId) return;
  state.timetable = await api(`/api/students/${state.selectedStudentId}/timetable`);
  buildSubjectSelect(state.timetable.enrolled_subjects || []);
  if (
    !state.selectedSubject ||
    !Array.from(document.getElementById("subject-select").options).some(
      (o) => o.value === state.selectedSubject
    )
  ) {
    const first = Array.from(document.getElementById("subject-select").options).find(
      (o) => o.value && !o.disabled
    );
    state.selectedSubject = first ? first.value : null;
  }
  document.getElementById("subject-select").value = state.selectedSubject || "";
  state.conflicts = await api("/api/conflicts");
  if (!state.selectedSubject) {
    state.slotSummary = [];
    render();
    return;
  }
  state.slotSummary = await api(
    `/api/slot-teacher-summary?subject=${encodeURIComponent(
      state.selectedSubject
    )}&student_id=${state.selectedStudentId}`
  );
  render();
}

function render() {
  renderCounts();
  renderConflictBar();
  renderGrid();
}

function renderCounts() {
  const el = document.getElementById("subject-counts");
  const counts = state.timetable.subject_counts || {};
  const parts = Object.entries(counts).map(([subject, count]) => `${subject}: ${count}コマ`);
  el.textContent = parts.length > 0 ? `登録済み: ${parts.join(" / ")}` : "登録済み: なし";
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
    alert(`生徒が見つかりません: ${studentName}`);
    return;
  }

  state.selectedStudentId = targetStudent.id;
  document.getElementById("student-select").value = String(targetStudent.id);
  await loadTimetable();

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

function renderGrid() {
  const table = document.getElementById("timetable");
  const dates = state.meta.dates;
  const periods = state.meta.periods;

  const availabilitySet = new Set(
    state.timetable.availability.map((s) => `${s.date}#${s.period}`)
  );

  const assignmentMap = new Map();
  for (const a of state.timetable.assignments) {
    assignmentMap.set(`${a.date}#${a.period}`, a);
  }
  const hasOpenTeacherSet = new Set(
    state.slotSummary
      .filter((s) => Number(s.free_teacher_count) > 0)
      .map((s) => `${s.date}#${s.period}`)
  );

  table.innerHTML = "";

  const headTr = document.createElement("tr");
  const topLeft = document.createElement("th");
  topLeft.textContent = "時限";
  headTr.appendChild(topLeft);
  for (const date of dates) {
    const th = document.createElement("th");
    th.textContent = formatDate(date);
    headTr.appendChild(th);
  }
  table.appendChild(headTr);

  for (const period of periods) {
    const tr = document.createElement("tr");
    const label = document.createElement("th");
    label.textContent = state.meta.period_labels[String(period)] || `${period}限`;
    tr.appendChild(label);

    for (const date of dates) {
      const td = document.createElement("td");
      td.className = "cell";
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
        td.textContent = `${subjectAbbrev(assignment.subject)} ${assignment.teacher_name} [${assignment.table_id}]`;
        td.addEventListener("click", () => openTeacherModal(date, period, assignment));
      } else if (!available) {
        td.classList.add("unavailable");
        td.textContent = "×";
      } else {
        if (hasOpenTeacherSet.has(key)) {
          td.classList.add("has-open-teacher");
        }
        td.addEventListener("click", () => openTeacherModal(date, period, null));
      }

      tr.appendChild(td);
    }

    table.appendChild(tr);
  }
}

async function syncStudentsFromFile() {
  const input = document.getElementById("student-file-input");
  if (!input || !input.files || input.files.length === 0) {
    alert("取り込む生徒予定表ファイル（CSV/XLSX）を選択してください。");
    return;
  }
  const file = input.files[0];
  const fd = new FormData();
  fd.append("file", file);

  try {
    const pRes = await fetch("/api/sync-students-upload", { method: "POST", body: fd });
    const preview = await pRes.json();
    if (!pRes.ok) throw new Error(preview.error || `HTTP ${pRes.status}`);

    if ((preview.removed_students || 0) > 0) {
      const msg =
        `予定表から消える生徒がいます。\n対象: ${(preview.removed_student_names || []).join(", ")}\n` +
        `削除生徒数: ${preview.removed_students} / 削除される割り当て: ${preview.removed_assignments}\n\n本当に反映しますか？`;
      const ok = await showConfirmModal(msg);
      if (!ok) return;
    }

    const applyFd = new FormData();
    applyFd.append("file", file);
    const res = await fetch("/api/sync-students-upload/apply", {
      method: "POST",
      body: applyFd,
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);

    alert(`生徒予定反映完了: ${JSON.stringify(result)}`);
    await loadBaseData();
    await loadTimetable();
    input.value = "";
  } catch (err) {
    alert(`取り込み失敗: ${err.message}`);
  }
}

async function openTeacherModal(date, period, existingAssignment) {
  state.selectedSlot = { date, period, existingAssignment };

  const modal = document.getElementById("teacher-modal");
  const title = document.getElementById("modal-title");
  const list = document.getElementById("teacher-list");
  const removeBtn = document.getElementById("remove-assignment-btn");
  const tableSelect = document.getElementById("table-select");

  title.textContent = `${formatDate(date)} ${period}限 - ${state.selectedSubject}`;
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

  for (const teacher of teachers) {
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
      await api("/api/assignments", {
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
      await loadTimetable();
    });
    list.appendChild(btn);
  }

  if (existingAssignment) {
    removeBtn.classList.remove("hidden");
    removeBtn.onclick = async () => {
      await api(`/api/assignments/${existingAssignment.id}`, { method: "DELETE" });
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
  const input = document.getElementById("teacher-file-input");
  if (!input) {
    alert("ファイル選択欄が見つかりません。画面を再読み込みしてください。");
    return;
  }
  if (!input.files || input.files.length === 0) {
    alert("取り込む予定表ファイル（CSV/XLSX）を選択してください。");
    return;
  }
  const file = input.files[0];
  const formData = new FormData();
  formData.append("file", file);
  try {
    const previewRes = await fetch("/api/sync-schedule-upload", {
      method: "POST",
      body: formData,
    });
    const preview = await previewRes.json();
    if (!previewRes.ok) {
      throw new Error(preview.error || `HTTP ${previewRes.status}`);
    }

    if ((preview.removed_teachers || 0) > 0) {
      const names = (preview.removed_teacher_names || []).join(", ");
      const msg =
        `予定表から消える講師がいます。\n` +
        `対象: ${names}\n` +
        `削除講師数: ${preview.removed_teachers} / 削除される割り当て: ${preview.removed_assignments}\n\n` +
        `本当に反映しますか？`;
      const ok = await showConfirmModal(msg);
      if (!ok) {
        return;
      }
    }

    const applyFormData = new FormData();
    applyFormData.append("file", file);
    const res = await fetch("/api/sync-schedule-upload/apply", {
      method: "POST",
      body: applyFormData,
    });
    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.error || `HTTP ${res.status}`);
    }

    alert(`予定表反映完了: ${JSON.stringify(result)}`);
    state.students = await api("/api/students");
    await loadBaseData();
    await loadTimetable();
    input.value = "";
  } catch (err) {
    alert(`取り込み失敗: ${err.message}`);
  }
}

function bindEvents() {
  const studentSelect = document.getElementById("student-select");
  const subjectSelect = document.getElementById("subject-select");
  const cancelBtn = document.getElementById("cancel-modal-btn");
  const modal = document.getElementById("teacher-modal");
  const syncBtn = document.getElementById("sync-upload-btn");
  const syncStudentsBtn = document.getElementById("sync-students-btn");

  if (studentSelect) {
    studentSelect.addEventListener("change", async (e) => {
      state.selectedStudentId = Number(e.target.value);
      await loadTimetable();
    });
  }

  if (subjectSelect) {
    subjectSelect.addEventListener("change", async (e) => {
      state.selectedSubject = e.target.value;
      await loadTimetable();
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
  if (syncStudentsBtn) {
    syncStudentsBtn.addEventListener("click", async () => {
      await syncStudentsFromFile();
    });
  }
}

async function main() {
  bindEvents();
  await loadBaseData();
  await loadTimetable();
}

main().catch((err) => {
  console.error(err);
  alert(`初期化エラー: ${err.message}`);
});
