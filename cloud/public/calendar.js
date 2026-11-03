// 予定入力カレンダー（講師ページ・管理画面で共通）
// ふつうのカレンダーと同じく、1週間ごとに「横＝月〜日（曜日の位置は固定）、縦＝時限」の表を並べる。
//   ・マスをタップ → ○ / 空 の切り替え
//   ・日付をタップ → その日を全部○（全部○なら全部消す）
//   ・時限をタップ → その週のその時限を全部○（全部○なら全部消す）
//   ・パソコンではマウスでなぞってまとめて塗れる
import { DOW, el, fmtDate } from "./common.js";

export const slotKey = (date, period) => `${date}#${period}`;

export function keysToSlots(keys) {
  return [...keys]
    .map((k) => {
      const [date, period] = k.split("#");
      return { date, period: Number(period) };
    })
    .sort((a, b) => (a.date === b.date ? a.period - b.period : a.date < b.date ? -1 : 1));
}

/** 講習の日付を月曜始まりの週に分ける。各週は必ず7日分（期間外の日は null） */
function groupByWeek(dates) {
  const inTerm = new Set(dates);
  const weeks = [];
  if (!dates.length) return weeks;
  const cursor = new Date(`${dates[0]}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7)); // その週の月曜
  const last = dates[dates.length - 1];
  while (cursor.toISOString().slice(0, 10) <= last) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const iso = cursor.toISOString().slice(0, 10);
      week.push(inTerm.has(iso) ? iso : null);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/**
 * @param {HTMLElement} root
 * @param {object} term   termForClient の形（dates, periods, period_times, closed_dates）
 * @param {Set<string>} selected  選択中のコマ（slotKey の集合）。編集時はこの Set を直接書き換える
 * @param {{editable?: boolean, onChange?: (selected: Set<string>) => void, highlight?: Set<string>, removed?: Set<string>}} options
 *   highlight: 枠を強調するコマ（事務の確認後に増えたコマ）
 *   removed:   × で示すコマ（事務の確認後に来られなくなったコマ）
 */
export function renderCalendar(
  root,
  term,
  selected,
  { editable = false, onChange = () => {}, highlight = new Set(), removed = new Set() } = {},
) {
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
      removed.size ? el("span", { class: "lg-removed" }, "× 来られなくなった") : null,
      highlight.size ? el("span", { class: "lg-added" }, "増えた") : null,
      editable ? el("em", {}, "日付・時限を押すとまとめて切り替え") : null,
    ),
  );

  const refreshCell = (key) => {
    const td = cells.get(key);
    if (!td) return;
    const on = selected.has(key);
    const wasRemoved = !on && removed.has(key);
    td.classList.toggle("on", on);
    td.classList.toggle("removed", wasRemoved);
    td.textContent = on ? "○" : wasRemoved ? "×" : "";
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

  for (const week of groupByWeek(term.dates)) {
    const weekDates = week.filter(Boolean);
    const weekKeys = openKeysOf(weekDates);
    const head = el(
      "div",
      { class: "cal-week-head" },
      el("span", {}, `${fmtDate(weekDates[0], false)} 〜 ${fmtDate(weekDates[weekDates.length - 1], false)}`),
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

    // 見出し行：月〜日（期間外の日は空欄）
    const headerRow = el(
      "tr",
      {},
      el("th", { class: "cal-periodcol" }),
      week.map((date, i) => {
        const dow = (i + 1) % 7; // 0=日
        if (!date) return el("th", { class: "cal-date out" }, el("span", { class: `dow dow-${dow}` }, DOW[dow]));
        const day = Number(date.slice(8, 10));
        const label = [el("span", { class: `dow dow-${dow}` }, DOW[dow]), el("span", { class: "day" }, String(day))];
        const isClosed = closed.has(date);
        return el(
          "th",
          { class: `cal-date${isClosed ? " closed" : ""}` },
          editable && !isClosed
            ? el(
                "button",
                { type: "button", class: "cal-date-btn", "aria-label": `${fmtDate(date)}をまとめて切り替え`, onclick: () => toggleGroup(openKeysOf([date])) },
                label,
              )
            : label,
        );
      }),
    );

    // 各行：時限 × 月〜日
    const rows = term.periods.map((period) => {
      const time = term.period_times?.[period];
      const periodLabel = [el("span", { class: "p" }, `${period}限`), time ? el("small", {}, time.start) : null];
      const rowKeys = weekDates.filter((d) => !closed.has(d)).map((d) => slotKey(d, period));
      const labelCell = el(
        "th",
        { class: "cal-period" },
        editable && rowKeys.length
          ? el(
              "button",
              { type: "button", class: "cal-period-btn", "aria-label": `この週の${period}限をまとめて切り替え`, onclick: () => toggleGroup(rowKeys) },
              periodLabel,
            )
          : periodLabel,
      );
      const dayCells = week.map((date) => {
        if (!date) return el("td", { class: "cal-cell out" });
        if (closed.has(date)) return el("td", { class: "cal-cell closed" }, period === term.periods[0] ? "休" : "");
        const key = slotKey(date, period);
        const td = el("td", {
          class: `cal-cell${editable ? " editable" : ""}${highlight.has(key) ? " added" : ""}`,
          role: editable ? "button" : null,
          tabindex: editable ? "0" : null,
          "aria-label": `${fmtDate(date)} ${period}限`,
          dataset: { key },
        });
        cells.set(key, td);
        refreshCell(key);
        return td;
      });
      return el("tr", {}, labelCell, dayCells);
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

  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const key = e.target.closest?.(".cal-cell.editable")?.dataset.key;
    if (!key) return;
    e.preventDefault();
    setSlot(key, !selected.has(key));
    onChange(selected);
  }, { signal });
}

export { DOW };
