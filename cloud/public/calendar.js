// 予定入力カレンダー（講師ページ・管理画面で共通）
// 週ごと（月曜始まり）に「日付 × 時限」の表を縦に並べる。
//   ・マスをタップ → ○ / 空 の切り替え
//   ・日付をタップ → その日を全部○（全部○なら全部消す）
//   ・パソコンではマウスでなぞってまとめて塗れる
import { DOW, dowOf, el, fmtDate } from "./common.js";

export const slotKey = (date, period) => `${date}#${period}`;

export function keysToSlots(keys) {
  return [...keys]
    .map((k) => {
      const [date, period] = k.split("#");
      return { date, period: Number(period) };
    })
    .sort((a, b) => (a.date === b.date ? a.period - b.period : a.date < b.date ? -1 : 1));
}

function groupByWeek(dates) {
  const weeks = [];
  let current = null;
  for (const date of dates) {
    if (!current || dowOf(date) === 1) {
      current = [];
      weeks.push(current);
    }
    current.push(date);
  }
  return weeks;
}

/**
 * @param {HTMLElement} root
 * @param {object} term   termForClient の形（dates, periods, period_times, closed_dates）
 * @param {Set<string>} selected  選択中のコマ（slotKey の集合）。編集時はこの Set を直接書き換える
 * @param {{editable?: boolean, onChange?: (selected: Set<string>) => void, highlight?: Set<string>}} options
 */
export function renderCalendar(root, term, selected, { editable = false, onChange = () => {}, highlight = new Set() } = {}) {
  // 同じ root に描き直したとき、前回のイベント登録を外す
  root._calendarAbort?.abort();
  const listeners = new AbortController();
  root._calendarAbort = listeners;
  const { signal } = listeners;

  root.innerHTML = "";
  const closed = new Set(term.closed_dates);
  const cells = new Map(); // key -> td

  root.append(
    el(
      "div",
      { class: "cal-legend" },
      el("span", { class: "lg-on" }, "○ 来られる"),
      el("span", { class: "lg-closed" }, "休校"),
      editable ? el("em", {}, "日付を押すとその日をまとめて切り替え") : null,
    ),
  );

  const refreshCell = (key) => {
    const td = cells.get(key);
    if (!td) return;
    const on = selected.has(key);
    td.classList.toggle("on", on);
    td.textContent = on ? "○" : "";
    td.setAttribute("aria-pressed", on ? "true" : "false");
  };

  const setSlot = (key, on) => {
    if (on) selected.add(key);
    else selected.delete(key);
    refreshCell(key);
  };

  const openKeysOf = (dates) =>
    dates.filter((d) => !closed.has(d)).flatMap((d) => term.periods.map((p) => slotKey(d, p)));

  const toggleGroup = (keys) => {
    const allOn = keys.length > 0 && keys.every((k) => selected.has(k));
    keys.forEach((k) => setSlot(k, !allOn));
    onChange(selected);
  };

  for (const weekDates of groupByWeek(term.dates)) {
    const weekKeys = openKeysOf(weekDates);
    const head = el(
      "div",
      { class: "cal-week-head" },
      el("span", {}, `${fmtDate(weekDates[0])} 〜 ${fmtDate(weekDates[weekDates.length - 1])}`),
      editable && weekKeys.length
        ? el(
            "button",
            {
              type: "button",
              class: "btn-small",
              onclick: () => {
                weekKeys.forEach((k) => setSlot(k, false));
                onChange(selected);
              },
            },
            "この週をクリア",
          )
        : null,
    );

    const headerRow = el(
      "tr",
      {},
      el("th", { class: "cal-daycol" }),
      term.periods.map((p) =>
        el("th", {}, `${p}限`, term.period_times?.[p] ? el("small", {}, term.period_times[p].start) : null),
      ),
    );

    const rows = weekDates.map((date) => {
      const dow = dowOf(date);
      const isClosed = closed.has(date);
      const label = el("span", { class: `dow-${dow}` }, fmtDate(date));
      const dayCell = el(
        "td",
        {},
        editable && !isClosed
          ? el("button", { type: "button", class: "cal-day", onclick: () => toggleGroup(openKeysOf([date])) }, label)
          : el("span", { class: "cal-day" }, label),
      );
      const periodCells = term.periods.map((period) => {
        if (isClosed) return el("td", { class: "cal-cell closed" }, "休");
        const key = slotKey(date, period);
        const td = el("td", {
          class: `cal-cell${editable ? " editable" : ""}${highlight.has(key) ? " added" : ""}`,
          role: editable ? "button" : null,
          "aria-label": `${fmtDate(date)} ${period}限`,
          dataset: { key },
        });
        cells.set(key, td);
        refreshCell(key);
        return td;
      });
      return el("tr", {}, dayCell, periodCells);
    });

    root.append(el("div", { class: "cal-week" }, head, el("table", { class: "cal-table" }, el("thead", {}, headerRow), el("tbody", {}, rows))));
  }

  if (!editable) return;

  // タップ（タッチ）は click で、マウスは押したままなぞって塗れるようにする
  let paint = null; // { on: boolean }
  let lastMouseDown = 0;

  root.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const key = e.target.closest?.(".cal-cell.editable")?.dataset.key;
    if (!key) return;
    e.preventDefault();
    lastMouseDown = Date.now();
    paint = { on: !selected.has(key) };
    setSlot(key, paint.on);
  }, { signal });
  root.addEventListener("pointerover", (e) => {
    if (!paint) return;
    const key = e.target.closest?.(".cal-cell.editable")?.dataset.key;
    if (key && selected.has(key) !== paint.on) setSlot(key, paint.on);
  }, { signal });
  const endPaint = () => {
    if (paint) {
      paint = null;
      onChange(selected);
    }
  };
  window.addEventListener("pointerup", endPaint, { signal });
  window.addEventListener("pointercancel", endPaint, { signal });

  root.addEventListener("click", (e) => {
    const key = e.target.closest?.(".cal-cell.editable")?.dataset.key;
    if (!key || Date.now() - lastMouseDown < 600) return;
    setSlot(key, !selected.has(key));
    onChange(selected);
  }, { signal });
}

export { DOW };
