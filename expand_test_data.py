from __future__ import annotations

import argparse
import csv
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterable

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"

STUDENT_PREFIX = "テスト生徒"
TEACHER_PREFIX = "テスト講師"

STUDENT_SUBJECT_PATTERNS = [
    "算数（受験除く）, 中学受験社会, 倫政",
    "中学英語, 中学数学, 高校英語",
    "数学Ⅰ・A, 数学Ⅱ・B, 数学Ⅲ・C",
    "現代文, 古文, 漢文",
    "物理, 化学, 生物",
]

TEACHER_SUBJECT_PATTERNS = [
    "算数（受験除く）, 算数（受験含む）, 中学数学, 数学Ⅰ・A, 数学Ⅱ・B",
    "中学英語, 高校英語, 現代文, 古文",
    "中学理科, 物理, 化学, 生物",
    "中学社会, 日本史, 世界史, 地理, 倫政, 公共",
    "中学数学, 数学Ⅱ・B, 数学Ⅲ・C, 情報",
]


@dataclass
class CsvTable:
    path: Path
    rows: list[list[str]]
    encoding: str
    newline: str


def _detect_encoding(content: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "cp932"):
        try:
            content.decode(encoding)
            return encoding
        except UnicodeDecodeError:
            continue
    raise ValueError("CSV の文字コードを判定できませんでした")


def _detect_newline(text: str) -> str:
    if "\r\n" in text:
        return "\r\n"
    if "\r" in text:
        return "\r"
    return "\n"


def _load_csv(path: Path) -> CsvTable:
    content = path.read_bytes()
    encoding = _detect_encoding(content)
    text = content.decode(encoding)
    newline = _detect_newline(text)
    rows = list(csv.reader(text.splitlines()))
    if not rows:
        raise ValueError(f"{path} が空です")
    return CsvTable(path=path, rows=rows, encoding=encoding, newline=newline)


def _write_csv(table: CsvTable) -> None:
    with table.path.open("w", encoding=table.encoding, newline="") as fh:
        writer = csv.writer(fh, lineterminator=table.newline)
        writer.writerows(table.rows)


def _find_latest_csv(directory: Path) -> Path:
    candidates = sorted(directory.glob("*.csv"), key=lambda p: p.stat().st_mtime)
    if not candidates:
        raise FileNotFoundError(f"{directory} に CSV が見つかりません")
    return candidates[-1]


def _existing_names(rows: Iterable[list[str]]) -> set[str]:
    names: set[str] = set()
    for row in rows:
        if len(row) > 1 and row[1].strip():
            names.add(row[1].strip())
    return names


def _next_serial(existing: set[str], prefix: str) -> int:
    max_serial = 0
    for name in existing:
        if not name.startswith(prefix):
            continue
        suffix = name[len(prefix) :]
        if suffix.isdigit():
            max_serial = max(max_serial, int(suffix))
    return max_serial + 1


def _rotate_availability(cell: str, index: int) -> str:
    parts = [part.strip() for part in cell.split(",") if part.strip()]
    if len(parts) <= 1:
        return cell
    shift = index % len(parts)
    rotated = parts[shift:] + parts[:shift]
    keep = max(1, len(parts) - (index % 2))
    return ", ".join(rotated[:keep])


def _clone_rows(
    table: CsvTable,
    *,
    count: int,
    prefix: str,
    subject_patterns: list[str],
    note_factory,
) -> int:
    if count <= 0:
        return 0
    if len(table.rows) < 2:
        raise ValueError(f"{table.path.name} に複製元のデータ行がありません")

    header = table.rows[0]
    base_rows = [row for row in table.rows[1:] if len(row) > 1 and row[1].strip()]
    if not base_rows:
        raise ValueError(f"{table.path.name} に有効なデータ行がありません")

    date_column_indexes = list(range(3, len(header) - 1))
    note_column_index = len(header) - 1
    existing = _existing_names(base_rows)
    serial = _next_serial(existing, prefix)
    added = 0

    for i in range(count):
        source = base_rows[i % len(base_rows)]
        row = deepcopy(source)
        row[0] = (datetime(2026, 6, 19, 9, 0, 0) + timedelta(minutes=serial + i)).strftime(
            "%Y/%m/%d %H:%M:%S"
        )
        row[1] = f"{prefix}{serial + i:02d}"
        row[2] = subject_patterns[i % len(subject_patterns)]
        for offset, col_idx in enumerate(date_column_indexes):
            cell = row[col_idx] if col_idx < len(row) else ""
            if not cell:
                continue
            row[col_idx] = _rotate_availability(cell, serial + i + offset)
        if note_column_index < len(row):
            row[note_column_index] = note_factory(serial + i)
        table.rows.append(row)
        added += 1

    return added


def main() -> None:
    parser = argparse.ArgumentParser(description="テスト用の生徒・講師 CSV を増量します")
    parser.add_argument("--students", type=int, default=20, help="追加する生徒数")
    parser.add_argument("--teachers", type=int, default=10, help="追加する講師数")
    args = parser.parse_args()

    student_csv = _load_csv(_find_latest_csv(DATA_DIR / "students"))
    teacher_csv = _load_csv(_find_latest_csv(DATA_DIR / "teachers"))

    added_students = _clone_rows(
        student_csv,
        count=args.students,
        prefix=STUDENT_PREFIX,
        subject_patterns=STUDENT_SUBJECT_PATTERNS,
        note_factory=lambda serial: f"テスト用の追加データです（希望 {8 + (serial % 6)} コマ）",
    )
    added_teachers = _clone_rows(
        teacher_csv,
        count=args.teachers,
        prefix=TEACHER_PREFIX,
        subject_patterns=TEACHER_SUBJECT_PATTERNS,
        note_factory=lambda serial: f"テスト用の追加データです（複製元 {serial:02d}）",
    )

    _write_csv(student_csv)
    _write_csv(teacher_csv)

    print(f"students_added={added_students} file={student_csv.path}")
    print(f"teachers_added={added_teachers} file={teacher_csv.path}")


if __name__ == "__main__":
    main()
