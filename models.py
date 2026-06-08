from __future__ import annotations

import csv
import re
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime
from io import BytesIO, StringIO
from pathlib import Path
from typing import Any

from database import DATES, PERIODS, get_connection

STUDENT_STATUSES = {"調整中", "要調整", "完了"}
FORM_NOTE_PREFIX = "【フォーム備考】"


@dataclass
class ImportResult:
    teachers: int = 0
    students: int = 0
    availability_rows: int = 0
    removed_teachers: int = 0
    removed_students: int = 0
    removed_assignments: int = 0


@dataclass
class TeacherSyncPreview:
    imported_teachers: int
    removed_teacher_names: list[str]
    removed_assignments: int


@dataclass
class StudentSyncPreview:
    imported_students: int
    removed_student_names: list[str]
    removed_assignments: int


@dataclass
class UnifiedSyncPreview:
    kind: str
    imported_count: int
    removed_names: list[str]
    removed_assignments: int
    availability_rows: int = 0


def list_students() -> list[dict[str, Any]]:
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT
            s.id,
            s.name,
            s.status,
            s.memo,
            s.memo_updated_at,
            COALESCE(ac.assignment_count, 0) AS assignment_count
        FROM students s
        LEFT JOIN (
            SELECT student_id, COUNT(*) AS assignment_count
            FROM assignments
            GROUP BY student_id
        ) ac ON ac.student_id = s.id
        ORDER BY s.name
        """
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def get_teacher_panel(student_id: int, teacher_id: int | None = None) -> dict[str, Any]:
    conn = get_connection()

    teachers = conn.execute(
        """
        SELECT
            t.id AS teacher_id,
            t.name,
            t.memo,
            COALESCE(sc.student_assignment_count, 0) AS student_assignment_count
        FROM teachers t
        LEFT JOIN (
            SELECT teacher_id, COUNT(*) AS student_assignment_count
            FROM assignments
            WHERE student_id = ?
            GROUP BY teacher_id
        ) sc ON sc.teacher_id = t.id
        ORDER BY
            CASE WHEN COALESCE(sc.student_assignment_count, 0) > 0 THEN 0 ELSE 1 END ASC,
            CASE WHEN t.name_kana IS NULL OR t.name_kana = '' THEN t.name ELSE t.name_kana END ASC
        """,
        (student_id,),
    ).fetchall()

    teacher_list = [
        {
            "teacher_id": row["teacher_id"],
            "name": row["name"],
            "memo": row["memo"] or "",
            "student_assignment_count": row["student_assignment_count"],
            "is_registered_for_student": row["student_assignment_count"] > 0,
        }
        for row in teachers
    ]

    if not teacher_list:
        conn.close()
        return {"teachers": [], "selected_teacher_id": None, "assignments": [], "availability": []}

    teacher_ids = {t["teacher_id"] for t in teacher_list}
    selected_teacher_id = teacher_id if teacher_id in teacher_ids else teacher_list[0]["teacher_id"]

    assignment_rows = conn.execute(
        """
        SELECT
            a.id,
            a.date,
            a.period,
            a.subject,
            a.table_id,
            s.id AS student_id,
            s.name AS student_name,
            EXISTS (
                SELECT 1
                FROM assignments a2
                WHERE a2.date = a.date
                  AND a2.period = a.period
                  AND a2.teacher_id = a.teacher_id
                  AND a2.student_id != a.student_id
            ) AS has_teacher_conflict,
            EXISTS (
                SELECT 1
                FROM assignments a3
                WHERE a3.date = a.date
                  AND a3.period = a.period
                  AND a3.table_id = a.table_id
                  AND a3.student_id != a.student_id
            ) AS has_table_conflict,
            NOT EXISTS (
                SELECT 1
                FROM student_availability sa
                WHERE sa.student_id = a.student_id
                  AND sa.date = a.date
                  AND sa.period = a.period
            ) AS has_student_schedule_mismatch
        FROM assignments a
        JOIN students s ON s.id = a.student_id
        WHERE a.teacher_id = ?
        ORDER BY a.date, a.period, s.name
        """,
        (selected_teacher_id,),
    ).fetchall()
    availability_rows = conn.execute(
        """
        SELECT date, period
        FROM teacher_availability
        WHERE teacher_id = ?
        """,
        (selected_teacher_id,),
    ).fetchall()
    subject_rows = conn.execute(
        """
        SELECT subject
        FROM teacher_subjects
        WHERE teacher_id = ?
        ORDER BY subject
        """,
        (selected_teacher_id,),
    ).fetchall()

    conn.close()
    return {
        "teachers": teacher_list,
        "selected_teacher_id": selected_teacher_id,
        "assignments": [
            {
                **dict(r),
                "has_conflict": bool(
                    r["has_teacher_conflict"]
                    or r["has_table_conflict"]
                    or r["has_student_schedule_mismatch"]
                ),
            }
            for r in assignment_rows
        ],
        "availability": [dict(r) for r in availability_rows],
        "subjects": [r["subject"] for r in subject_rows],
    }


def get_student_timetable(student_id: int) -> dict[str, Any] | None:
    conn = get_connection()
    student = conn.execute(
        "SELECT id, name, status, memo, memo_updated_at FROM students WHERE id = ?",
        (student_id,),
    ).fetchone()
    if not student:
        conn.close()
        return None

    availability = conn.execute(
        "SELECT date, period FROM student_availability WHERE student_id = ?",
        (student_id,),
    ).fetchall()

    assignments = conn.execute(
        """
        SELECT
            a.id,
            a.date,
            a.period,
            a.subject,
            a.teacher_id,
            a.table_id,
            t.name AS teacher_name,
            EXISTS (
                SELECT 1
                FROM assignments a2
                WHERE a2.date = a.date
                  AND a2.period = a.period
                  AND a2.teacher_id = a.teacher_id
                  AND a2.student_id != a.student_id
                  AND a.teacher_id IS NOT NULL
            ) AS has_teacher_conflict,
            EXISTS (
                SELECT 1
                FROM assignments a3
                WHERE a3.date = a.date
                  AND a3.period = a.period
                  AND a3.table_id = a.table_id
                  AND a3.student_id != a.student_id
            ) AS has_table_conflict,
            CASE
                WHEN a.teacher_id IS NULL THEN 0
                WHEN NOT EXISTS (
                    SELECT 1
                    FROM teacher_availability ta
                    WHERE ta.teacher_id = a.teacher_id
                      AND ta.date = a.date
                      AND ta.period = a.period
                ) THEN 1
                ELSE 0
            END AS has_schedule_mismatch_slot,
            CASE
                WHEN a.teacher_id IS NULL THEN 0
                WHEN NOT EXISTS (
                    SELECT 1
                    FROM teacher_subjects ts
                    WHERE ts.teacher_id = a.teacher_id
                      AND ts.subject = a.subject
                ) THEN 1
                ELSE 0
            END AS has_schedule_mismatch_subject,
            NOT EXISTS (
                SELECT 1
                FROM student_availability sa
                WHERE sa.student_id = a.student_id
                  AND sa.date = a.date
                  AND sa.period = a.period
            ) AS has_student_schedule_mismatch
        FROM assignments a
        LEFT JOIN teachers t ON t.id = a.teacher_id
        WHERE a.student_id = ?
        ORDER BY a.date, a.period
        """,
        (student_id,),
    ).fetchall()

    subject_counts_rows = conn.execute(
        """
        SELECT subject, COUNT(*) AS count
        FROM assignments
        WHERE student_id = ?
        GROUP BY subject
        """,
        (student_id,),
    ).fetchall()
    enrolled_subject_rows = conn.execute(
        """
        SELECT subject
        FROM student_subjects
        WHERE student_id = ?
        ORDER BY subject
        """,
        (student_id,),
    ).fetchall()

    conn.close()

    return {
        "student": dict(student),
        "availability": [dict(row) for row in availability],
        "assignments": [
            {
                "id": row["id"],
                "date": row["date"],
                "period": row["period"],
                "subject": row["subject"],
                "teacher_id": row["teacher_id"],
                "table_id": row["table_id"],
                "teacher_name": row["teacher_name"] if row["teacher_name"] else "講師未定",
                "has_teacher_conflict": bool(row["has_teacher_conflict"]),
                "has_table_conflict": bool(row["has_table_conflict"]),
                "has_schedule_mismatch": bool(
                    row["has_schedule_mismatch_slot"] or row["has_schedule_mismatch_subject"]
                ),
                "has_student_schedule_mismatch": bool(row["has_student_schedule_mismatch"]),
                "has_conflict": bool(
                    row["has_teacher_conflict"]
                    or row["has_table_conflict"]
                    or row["has_schedule_mismatch_slot"]
                    or row["has_schedule_mismatch_subject"]
                    or row["has_student_schedule_mismatch"]
                ),
            }
            for row in assignments
        ],
        "subject_counts": {row["subject"]: row["count"] for row in subject_counts_rows},
        "enrolled_subjects": [row["subject"] for row in enrolled_subject_rows],
    }


def get_available_teachers(
    *, date: str, period: int, subject: str, student_id: int
) -> list[dict[str, Any]]:
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT
            t.id AS teacher_id,
            t.name,
            COALESCE(av.availability_count, 0) AS availability_count,
            COALESCE(cnt.assignment_count, 0) AS assignment_count,
            slot.student_name AS conflict_with,
            COALESCE(slot.conflict_count, 0) AS conflict_count
        FROM teachers t
        JOIN teacher_availability ta
          ON ta.teacher_id = t.id
         AND ta.date = ?
         AND ta.period = ?
        JOIN teacher_subjects ts
          ON ts.teacher_id = t.id
         AND ts.subject = ?
        LEFT JOIN (
            SELECT teacher_id, COUNT(*) AS assignment_count
            FROM assignments
            WHERE student_id = ?
            GROUP BY teacher_id
        ) cnt ON cnt.teacher_id = t.id
        LEFT JOIN (
            SELECT teacher_id, COUNT(*) AS availability_count
            FROM teacher_availability
            GROUP BY teacher_id
        ) av ON av.teacher_id = t.id
        LEFT JOIN (
            SELECT
                a.teacher_id,
                MIN(s.name) AS student_name,
                COUNT(*) AS conflict_count
            FROM assignments a
            JOIN students s ON s.id = a.student_id
            WHERE a.date = ?
              AND a.period = ?
              AND a.student_id != ?
            GROUP BY a.teacher_id
        ) slot ON slot.teacher_id = t.id
        ORDER BY availability_count ASC,
                 assignment_count DESC,
                 CASE
                    WHEN t.name_kana IS NULL OR t.name_kana = '' THEN t.name
                    ELSE t.name_kana
                 END ASC
        """,
        (date, period, subject, student_id, date, period, student_id),
    ).fetchall()
    conn.close()

    return [
        {
            "teacher_id": row["teacher_id"],
            "name": row["name"],
            "availability_count": row["availability_count"],
            "assignment_count": row["assignment_count"],
            "has_conflict": row["conflict_with"] is not None,
            "conflict_with": row["conflict_with"],
            "conflict_count": row["conflict_count"] or 0,
        }
        for row in rows
    ]


def get_slot_teacher_summary(*, student_id: int, subject: str) -> list[dict[str, Any]]:
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT
            ta.date,
            ta.period,
            COUNT(*) AS total_teacher_count,
            SUM(CASE WHEN busy.teacher_id IS NULL THEN 1 ELSE 0 END) AS free_teacher_count
        FROM student_availability sa
        JOIN teacher_availability ta
          ON ta.date = sa.date
         AND ta.period = sa.period
        JOIN teacher_subjects ts
          ON ts.teacher_id = ta.teacher_id
         AND ts.subject = ?
        LEFT JOIN (
            SELECT DISTINCT date, period, teacher_id
            FROM assignments
        ) busy
          ON busy.date = ta.date
         AND busy.period = ta.period
         AND busy.teacher_id = ta.teacher_id
        WHERE sa.student_id = ?
        GROUP BY ta.date, ta.period
        """,
        (subject, student_id),
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def get_used_tables(*, date: str, period: int) -> list[str]:
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT DISTINCT table_id
        FROM assignments
        WHERE date = ?
          AND period = ?
          AND table_id IS NOT NULL
          AND table_id != ''
        ORDER BY table_id
        """,
        (date, period),
    ).fetchall()
    conn.close()
    return [row["table_id"] for row in rows]


def create_assignment(
    *,
    student_id: int,
    teacher_id: int | None,
    table_id: str,
    subject: str,
    date: str,
    period: int,
) -> dict[str, Any]:
    conn = get_connection()
    cur = conn.cursor()
    # Same student/date/period should be treated as an update, not duplicate rows.
    cur.execute(
        """
        DELETE FROM assignments
        WHERE student_id = ?
          AND date = ?
          AND period = ?
        """,
        (student_id, date, period),
    )
    cur.execute(
        """
        INSERT INTO assignments(student_id, teacher_id, table_id, subject, date, period)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (student_id, teacher_id, table_id, subject, date, period),
    )
    assignment_id = cur.lastrowid

    if teacher_id is None:
        has_teacher_conflict = 0
    else:
        has_teacher_conflict = cur.execute(
            """
            SELECT EXISTS(
                SELECT 1
                FROM assignments
                WHERE date = ?
                  AND period = ?
                  AND teacher_id = ?
                  AND student_id != ?
            )
            """,
            (date, period, teacher_id, student_id),
        ).fetchone()[0]

    has_table_conflict = cur.execute(
        """
        SELECT EXISTS(
            SELECT 1
            FROM assignments
            WHERE date = ?
              AND period = ?
              AND table_id = ?
              AND student_id != ?
        )
        """,
        (date, period, table_id, student_id),
    ).fetchone()[0]

    _apply_auto_student_status_rules(conn)
    conn.commit()
    conn.close()

    return {
        "id": assignment_id,
        "has_teacher_conflict": bool(has_teacher_conflict),
        "has_table_conflict": bool(has_table_conflict),
        "has_conflict": bool(has_teacher_conflict or has_table_conflict),
    }


def delete_assignment(assignment_id: int) -> bool:
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM assignments WHERE id = ?", (assignment_id,))
    deleted = cur.rowcount > 0
    _apply_auto_student_status_rules(conn)
    conn.commit()
    conn.close()
    return deleted


def update_student_status_and_memo(
    student_id: int,
    *,
    status: str | None = None,
    memo: str | None = None,
) -> dict[str, Any]:
    if status is None and memo is None:
        raise ValueError("status or memo is required")

    if status is not None:
        status = status.strip()
        if status not in STUDENT_STATUSES:
            raise ValueError("invalid status")
        if status == "要調整":
            raise ValueError("要調整はシステムが自動設定します")

    if memo is not None:
        memo = memo.strip()
        if len(memo) > 500:
            raise ValueError("memo must be 500 characters or fewer")

    conn = get_connection()
    row = conn.execute("SELECT id FROM students WHERE id = ?", (student_id,)).fetchone()
    if not row:
        conn.close()
        raise ValueError("student not found")
    has_error = _student_has_error(conn, student_id)
    if status is not None and has_error:
        conn.close()
        raise ValueError("エラー解消まではステータスを変更できません（要調整を確認してください）")

    updates: list[str] = []
    params: list[Any] = []
    if status is not None:
        updates.append("status = ?")
        params.append(status)
    if memo is not None:
        updates.append("memo = ?")
        params.append(memo)
        updates.append("memo_updated_at = ?")
        params.append(datetime.now().strftime("%Y-%m-%d %H:%M"))

    params.append(student_id)
    conn.execute(f"UPDATE students SET {', '.join(updates)} WHERE id = ?", params)
    conn.commit()
    updated = conn.execute(
        """
        SELECT id, name, status, memo, memo_updated_at
        FROM students
        WHERE id = ?
        """,
        (student_id,),
    ).fetchone()
    conn.close()
    return dict(updated)


def list_student_notes(student_id: int) -> list[dict[str, Any]]:
    conn = get_connection()
    exists = conn.execute("SELECT 1 FROM students WHERE id = ?", (student_id,)).fetchone()
    if not exists:
        conn.close()
        raise ValueError("student not found")
    rows = conn.execute(
        """
        SELECT id, student_id, body, created_at, updated_at, is_edited, is_deleted, deleted_at
        FROM student_notes
        WHERE student_id = ?
        ORDER BY id ASC
        """,
        (student_id,),
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def create_student_note(student_id: int, body: str) -> dict[str, Any]:
    body = body.strip()
    if not body:
        raise ValueError("body is required")
    if len(body) > 500:
        raise ValueError("body must be 500 characters or fewer")

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    conn = get_connection()
    exists = conn.execute("SELECT 1 FROM students WHERE id = ?", (student_id,)).fetchone()
    if not exists:
        conn.close()
        raise ValueError("student not found")

    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO student_notes(
            student_id, body, created_at, updated_at, is_edited, is_deleted, deleted_at
        )
        VALUES (?, ?, ?, ?, 0, 0, NULL)
        """,
        (student_id, body, now, now),
    )
    note_id = cur.lastrowid
    note = conn.execute(
        """
        SELECT id, student_id, body, created_at, updated_at, is_edited, is_deleted, deleted_at
        FROM student_notes
        WHERE id = ? AND student_id = ?
        """,
        (note_id, student_id),
    ).fetchone()
    conn.commit()
    conn.close()
    return dict(note)


def update_student_note(student_id: int, note_id: int, body: str) -> dict[str, Any]:
    body = body.strip()
    if not body:
        raise ValueError("body is required")
    if len(body) > 500:
        raise ValueError("body must be 500 characters or fewer")

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    conn = get_connection()
    exists = conn.execute("SELECT 1 FROM students WHERE id = ?", (student_id,)).fetchone()
    if not exists:
        conn.close()
        raise ValueError("student not found")

    existing_note = conn.execute(
        """
        SELECT id, student_id, body, created_at, updated_at, is_edited, is_deleted, deleted_at
        FROM student_notes
        WHERE id = ? AND student_id = ? AND is_deleted = 0
        """,
        (note_id, student_id),
    ).fetchone()
    if not existing_note:
        conn.close()
        raise ValueError("note not found")

    if str(existing_note["body"] or "") == body:
        conn.close()
        return dict(existing_note)

    cur = conn.cursor()
    cur.execute(
        """
        UPDATE student_notes
        SET body = ?, updated_at = ?, is_edited = 1
        WHERE id = ? AND student_id = ?
          AND is_deleted = 0
        """,
        (body, now, note_id, student_id),
    )

    note = conn.execute(
        """
        SELECT id, student_id, body, created_at, updated_at, is_edited, is_deleted, deleted_at
        FROM student_notes
        WHERE id = ? AND student_id = ?
        """,
        (note_id, student_id),
    ).fetchone()
    conn.commit()
    conn.close()
    return dict(note)


def delete_student_note(student_id: int, note_id: int) -> bool:
    conn = get_connection()
    exists = conn.execute("SELECT 1 FROM students WHERE id = ?", (student_id,)).fetchone()
    if not exists:
        conn.close()
        raise ValueError("student not found")

    cur = conn.cursor()
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    cur.execute(
        """
        UPDATE student_notes
        SET is_deleted = 1, deleted_at = ?
        WHERE id = ? AND student_id = ? AND is_deleted = 0
        """,
        (now, note_id, student_id),
    )
    deleted = cur.rowcount > 0
    conn.commit()
    conn.close()
    return deleted


def restore_student_note(student_id: int, note_id: int) -> bool:
    conn = get_connection()
    exists = conn.execute("SELECT 1 FROM students WHERE id = ?", (student_id,)).fetchone()
    if not exists:
        conn.close()
        raise ValueError("student not found")

    cur = conn.cursor()
    cur.execute(
        """
        UPDATE student_notes
        SET is_deleted = 0, deleted_at = NULL
        WHERE id = ? AND student_id = ? AND is_deleted = 1
        """,
        (note_id, student_id),
    )
    restored = cur.rowcount > 0
    conn.commit()
    conn.close()
    return restored


def hard_delete_student_note(student_id: int, note_id: int) -> bool:
    conn = get_connection()
    exists = conn.execute("SELECT 1 FROM students WHERE id = ?", (student_id,)).fetchone()
    if not exists:
        conn.close()
        raise ValueError("student not found")

    cur = conn.cursor()
    cur.execute(
        "DELETE FROM student_notes WHERE id = ? AND student_id = ? AND is_deleted = 1",
        (note_id, student_id),
    )
    deleted = cur.rowcount > 0
    conn.commit()
    conn.close()
    return deleted


def reset_assignments() -> int:
    conn = get_connection()
    cur = conn.cursor()
    deleted_count = cur.execute("SELECT COUNT(*) FROM assignments").fetchone()[0]
    cur.execute("DELETE FROM assignments")
    _apply_auto_student_status_rules(conn)
    conn.commit()
    conn.close()
    return int(deleted_count)


def _student_has_error(conn, student_id: int) -> bool:
    row = conn.execute(
        """
        SELECT EXISTS(
            SELECT 1
            FROM assignments a
            WHERE a.student_id = ?
              AND (
                    (
                        a.teacher_id IS NOT NULL
                        AND EXISTS (
                            SELECT 1
                            FROM assignments a2
                            WHERE a2.date = a.date
                              AND a2.period = a.period
                              AND a2.teacher_id = a.teacher_id
                              AND a2.student_id != a.student_id
                        )
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM assignments a3
                        WHERE a3.date = a.date
                          AND a3.period = a.period
                          AND a3.table_id = a.table_id
                          AND a3.student_id != a.student_id
                    )
                    OR (
                        a.teacher_id IS NOT NULL
                        AND (
                            NOT EXISTS (
                                SELECT 1
                                FROM teacher_availability ta
                                WHERE ta.teacher_id = a.teacher_id
                                  AND ta.date = a.date
                                  AND ta.period = a.period
                            )
                            OR NOT EXISTS (
                                SELECT 1
                                FROM teacher_subjects ts
                                WHERE ts.teacher_id = a.teacher_id
                                  AND ts.subject = a.subject
                            )
                        )
                    )
                    OR NOT EXISTS (
                        SELECT 1
                        FROM student_availability sa
                        WHERE sa.student_id = a.student_id
                          AND sa.date = a.date
                          AND sa.period = a.period
                    )
                )
        ) AS has_error
        """,
        (student_id,),
    ).fetchone()
    return bool(row["has_error"]) if row else False


def _apply_auto_student_status_rules(conn) -> None:
    rows = conn.execute("SELECT id, status FROM students").fetchall()
    for row in rows:
        student_id = int(row["id"])
        status = str(row["status"] or "").strip() or "調整中"
        has_error = _student_has_error(conn, student_id)
        new_status = status
        if has_error and status != "要調整":
            new_status = "要調整"
        elif status == "要調整" and not has_error:
            new_status = "調整中"
        if new_status != status:
            conn.execute(
                "UPDATE students SET status = ? WHERE id = ?",
                (new_status, student_id),
            )


def list_conflicts() -> list[dict[str, Any]]:
    conn = get_connection()
    teacher_rows = conn.execute(
        """
        SELECT
            a.date,
            a.period,
            t.name AS teacher_name,
            GROUP_CONCAT(DISTINCT s.name) AS student_names,
            COUNT(DISTINCT a.student_id) AS student_count
        FROM assignments a
        JOIN teachers t ON t.id = a.teacher_id
        JOIN students s ON s.id = a.student_id
        GROUP BY a.date, a.period, a.teacher_id
        HAVING COUNT(DISTINCT a.student_id) > 1
        ORDER BY a.date, a.period, t.name
        """
    ).fetchall()

    table_rows = conn.execute(
        """
        SELECT
            a.date,
            a.period,
            a.table_id,
            GROUP_CONCAT(DISTINCT s.name) AS student_names
        FROM assignments a
        JOIN students s ON s.id = a.student_id
        GROUP BY a.date, a.period, a.table_id
        HAVING COUNT(DISTINCT a.student_id) > 1
        ORDER BY a.date, a.period, a.table_id
        """
    ).fetchall()

    schedule_rows = conn.execute(
        """
        SELECT
            a.date,
            a.period,
            t.name AS teacher_name,
            GROUP_CONCAT(DISTINCT s.name) AS student_names
        FROM assignments a
        JOIN teachers t ON t.id = a.teacher_id
        JOIN students s ON s.id = a.student_id
        WHERE NOT EXISTS (
                SELECT 1
                FROM teacher_availability ta
                WHERE ta.teacher_id = a.teacher_id
                  AND ta.date = a.date
                  AND ta.period = a.period
            )
           OR NOT EXISTS (
                SELECT 1
                FROM teacher_subjects ts
                WHERE ts.teacher_id = a.teacher_id
                  AND ts.subject = a.subject
            )
        GROUP BY a.date, a.period, a.teacher_id
        ORDER BY a.date, a.period, t.name
        """
    ).fetchall()
    student_schedule_rows = conn.execute(
        """
        SELECT
            a.date,
            a.period,
            GROUP_CONCAT(DISTINCT s.name) AS student_names
        FROM assignments a
        JOIN students s ON s.id = a.student_id
        WHERE NOT EXISTS (
            SELECT 1
            FROM student_availability sa
            WHERE sa.student_id = a.student_id
              AND sa.date = a.date
              AND sa.period = a.period
        )
        GROUP BY a.date, a.period
        ORDER BY a.date, a.period
        """
    ).fetchall()
    conn.close()

    conflicts = []
    for row in teacher_rows:
        students = row["student_names"].split(",") if row["student_names"] else []
        conflicts.append(
            {
                "type": "teacher",
                "date": row["date"],
                "period": row["period"],
                "teacher_name": row["teacher_name"],
                "students": students,
            }
        )
    for row in table_rows:
        students = row["student_names"].split(",") if row["student_names"] else []
        conflicts.append(
            {
                "type": "table",
                "date": row["date"],
                "period": row["period"],
                "table_id": row["table_id"],
                "students": students,
            }
        )
    for row in schedule_rows:
        students = row["student_names"].split(",") if row["student_names"] else []
        conflicts.append(
            {
                "type": "schedule",
                "date": row["date"],
                "period": row["period"],
                "teacher_name": f"{row['teacher_name']}（予定不一致）",
                "students": students,
            }
        )
    for row in student_schedule_rows:
        students = row["student_names"].split(",") if row["student_names"] else []
        conflicts.append(
            {
                "type": "student_schedule",
                "date": row["date"],
                "period": row["period"],
                "teacher_name": "生徒予定（受講不可）",
                "students": students,
            }
        )
    conflicts.sort(key=lambda c: (c["date"], c["period"], c["type"]))
    return conflicts


def import_teachers(data_dir: Path) -> ImportResult:
    teachers_dir = data_dir / "teachers"
    candidates = []
    for pattern in ("*.csv", "*.xlsx", "*.xlsm"):
        candidates.extend(teachers_dir.glob(pattern))
    if not candidates:
        raise FileNotFoundError("data/teachers に CSV/XLSX が見つかりません")
    latest = max(candidates, key=lambda p: p.stat().st_mtime)
    suffix = latest.suffix.lower()
    if suffix == ".csv":
        return _import_teachers_from_csv(latest)
    return _import_teachers_from_xlsx(latest)


def import_teachers_from_uploaded_file(filename: str, content: bytes) -> ImportResult:
    records = _records_from_uploaded_file(filename, content)
    return _import_teachers_records(records)


def preview_teachers_sync_from_uploaded_file(filename: str, content: bytes) -> TeacherSyncPreview:
    records = _records_from_uploaded_file(filename, content)
    if not records:
        raise ValueError("講師データが空です")

    header = records[0]
    _validate_teacher_header(header)
    date_columns = {
        idx: _parse_header_to_date(col_name or "")
        for idx, col_name in enumerate(header)
        if _parse_header_to_date(col_name or "")
    }
    if not date_columns:
        raise ValueError("日付列を検出できませんでした")

    latest_by_name: "OrderedDict[str, list[str]]" = OrderedDict()
    for row in records[1:]:
        if len(row) < 3:
            continue
        name = (row[1] or "").strip()
        if name:
            latest_by_name[name] = row

    imported_names = set(latest_by_name.keys())
    conn = get_connection()
    existing = conn.execute("SELECT id, name FROM teachers").fetchall()
    stale = [row for row in existing if row["name"] not in imported_names]
    stale_ids = [row["id"] for row in stale]
    removed_assignments = 0
    if stale_ids:
        placeholders = ",".join("?" for _ in stale_ids)
        removed_assignments = conn.execute(
            f"SELECT COUNT(*) FROM assignments WHERE teacher_id IN ({placeholders})",
            stale_ids,
        ).fetchone()[0]
    conn.close()

    removed_teacher_names = sorted([row["name"] for row in stale])
    return TeacherSyncPreview(
        imported_teachers=len(imported_names),
        removed_teacher_names=removed_teacher_names,
        removed_assignments=removed_assignments,
    )


def _upsert_teacher(conn, name: str, name_kana: str = "", memo: str | None = None) -> int:
    if memo is None:
        conn.execute(
            """
            INSERT INTO teachers(name, name_kana)
            VALUES (?, ?)
            ON CONFLICT(name)
            DO UPDATE SET name_kana = excluded.name_kana
            """,
            (name, name_kana),
        )
    else:
        conn.execute(
            """
            INSERT INTO teachers(name, name_kana, memo)
            VALUES (?, ?, ?)
            ON CONFLICT(name)
            DO UPDATE SET name_kana = excluded.name_kana, memo = excluded.memo
            """,
            (name, name_kana, memo),
        )
    row = conn.execute("SELECT id FROM teachers WHERE name = ?", (name,)).fetchone()
    return int(row["id"])


def _parse_header_to_date(header: str) -> str | None:
    text = (header or "").strip()
    patterns = (
        r"(?P<year>\d{4})[-/](?P<month>\d{1,2})[-/](?P<day>\d{1,2})",
        r"(?P<month>\d{1,2})/(?P<day>\d{1,2})",
        r"(?P<month>\d{1,2})月(?P<day>\d{1,2})日",
    )
    for pattern in patterns:
        match = re.search(pattern, text)
        if not match:
            continue
        year = int(match.group("year")) if "year" in match.groupdict() and match.group("year") else datetime.now().year
        month = int(match.group("month"))
        day = int(match.group("day"))
        return f"{year:04d}-{month:02d}-{day:02d}"
    return None


def _validate_teacher_header(header: list[str]) -> None:
    if len(header) < 4:
        raise ValueError("ヘッダー列数が不足しています（最低4列必要）")

    joined = "".join(header)
    if "講師名" not in joined:
        raise ValueError("ヘッダーに講師名列が見つかりません")
    if "指導可能科目" not in joined:
        raise ValueError("ヘッダーに指導可能科目列が見つかりません")

    date_cols = [h for h in header if _parse_header_to_date(h or "")]
    if not date_cols:
        raise ValueError("日付列（勤務可能予定）が見つかりません")


def _parse_subjects(cell: str) -> list[str]:
    if not cell:
        return []
    return [s.strip() for s in cell.split(",") if s.strip()]


def _parse_periods(cell: str) -> list[int]:
    if not cell:
        return []
    periods = []
    for token in cell.split(","):
        m = re.search(r"([0-9０-９]+)限", token)
        if not m:
            continue
        digits = m.group(1).translate(str.maketrans("０１２３４５６７８９", "0123456789"))
        period = int(digits)
        if period in PERIODS:
            periods.append(period)
    return sorted(set(periods))


def _find_teacher_note_column(header: list[str]) -> int | None:
    for idx, col_name in enumerate(header):
        name = (col_name or "").strip()
        if "備考" in name:
            return idx
    return None


def _import_teachers_records(records: list[list[str]]) -> ImportResult:
    if not records:
        raise ValueError("講師データが空です")

    header = records[0]
    _validate_teacher_header(header)
    date_columns: dict[int, str] = {}
    for idx, col_name in enumerate(header):
        parsed = _parse_header_to_date(col_name or "")
        if parsed:
            date_columns[idx] = parsed
    note_column = _find_teacher_note_column(header)

    if not date_columns:
        raise ValueError("日付列を検出できませんでした")

    latest_by_name: "OrderedDict[str, list[str]]" = OrderedDict()
    for row in records[1:]:
        if len(row) < 3:
            continue
        name = (row[1] or "").strip()
        if not name:
            continue
        latest_by_name[name] = row

    conn = get_connection()
    cur = conn.cursor()

    teacher_count = 0
    availability_rows = 0
    removed_teachers = 0
    removed_assignments = 0

    imported_names = set(latest_by_name.keys())
    existing = conn.execute("SELECT id, name FROM teachers").fetchall()
    stale_teacher_ids = [row["id"] for row in existing if row["name"] not in imported_names]
    if stale_teacher_ids:
        placeholders = ",".join("?" for _ in stale_teacher_ids)
        removed_assignments = conn.execute(
            f"SELECT COUNT(*) FROM assignments WHERE teacher_id IN ({placeholders})",
            stale_teacher_ids,
        ).fetchone()[0]
        cur.execute(
            f"DELETE FROM assignments WHERE teacher_id IN ({placeholders})",
            stale_teacher_ids,
        )
        cur.execute(
            f"DELETE FROM teachers WHERE id IN ({placeholders})",
            stale_teacher_ids,
        )
        removed_teachers = len(stale_teacher_ids)

    for name, row in latest_by_name.items():
        memo = None
        if note_column is not None:
            memo = row[note_column] if note_column < len(row) else ""
        teacher_id = _upsert_teacher(conn, name, "", None if memo is None else (memo or "").strip())

        cur.execute("DELETE FROM teacher_subjects WHERE teacher_id = ?", (teacher_id,))
        cur.execute("DELETE FROM teacher_availability WHERE teacher_id = ?", (teacher_id,))

        subjects = _parse_subjects(row[2] if len(row) > 2 else "")
        cur.executemany(
            "INSERT INTO teacher_subjects(teacher_id, subject) VALUES (?, ?)",
            [(teacher_id, subject) for subject in subjects],
        )

        rows_to_insert = []
        for col_idx, date in date_columns.items():
            cell = row[col_idx] if col_idx < len(row) else ""
            for period in _parse_periods(cell or ""):
                rows_to_insert.append((teacher_id, date, period))

        cur.executemany(
            """
            INSERT INTO teacher_availability(teacher_id, date, period)
            VALUES (?, ?, ?)
            """,
            rows_to_insert,
        )

        teacher_count += 1
        availability_rows += len(rows_to_insert)

    _apply_auto_student_status_rules(conn)
    conn.commit()
    conn.close()

    return ImportResult(
        teachers=teacher_count,
        availability_rows=availability_rows,
        removed_teachers=removed_teachers,
        removed_assignments=removed_assignments,
    )


def _import_teachers_from_csv(path: Path) -> ImportResult:
    return _import_teachers_records(_records_from_csv_bytes(path.read_bytes()))


def _records_from_uploaded_file(filename: str, content: bytes) -> list[list[str]]:
    suffix = Path(filename).suffix.lower()
    if suffix not in {".csv", ".xlsx", ".xlsm"}:
        raise ValueError("対応ファイルは .csv / .xlsx / .xlsm のみです")
    if suffix == ".csv":
        return _records_from_csv_bytes(content)
    return _records_from_xlsx_bytes(content)


def _records_from_csv_bytes(content: bytes) -> list[list[str]]:
    decoded = None
    for encoding in ("utf-8-sig", "cp932"):
        try:
            decoded = content.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if decoded is None:
        raise ValueError("CSV文字コードを判定できません（utf-8 / cp932 非対応）")
    lines = decoded.splitlines()
    sample = "\n".join(lines[:10])
    delimiter = ","
    if sample:
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
            delimiter = dialect.delimiter
        except csv.Error:
            first = lines[0] if lines else ""
            if "\t" in first and "," not in first:
                delimiter = "\t"
    return list(csv.reader(StringIO(decoded), delimiter=delimiter))


def _import_teachers_from_xlsx(path: Path) -> ImportResult:
    try:
        from openpyxl import load_workbook
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError("openpyxl が未インストールです") from exc

    wb = load_workbook(path, data_only=True)
    ws = wb["フォームの回答 1"] if "フォームの回答 1" in wb.sheetnames else wb[wb.sheetnames[0]]

    records: list[list[str]] = []
    for row in ws.iter_rows(values_only=True):
        values = ["" if v is None else str(v).strip() for v in row]
        if any(values):
            records.append(values)

    return _import_teachers_records(records)


def _records_from_xlsx_bytes(content: bytes) -> list[list[str]]:
    try:
        from openpyxl import load_workbook
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError("openpyxl が未インストールです") from exc

    wb = load_workbook(BytesIO(content), data_only=True)
    ws = wb["フォームの回答 1"] if "フォームの回答 1" in wb.sheetnames else wb[wb.sheetnames[0]]

    records: list[list[str]] = []
    for row in ws.iter_rows(values_only=True):
        values = ["" if v is None else str(v).strip() for v in row]
        if any(values):
            records.append(values)
    return records


def _import_teachers_xlsx_bytes(content: bytes) -> ImportResult:
    return _import_teachers_records(_records_from_xlsx_bytes(content))


def import_students_from_uploaded_file(filename: str, content: bytes) -> ImportResult:
    records = _records_from_uploaded_file(filename, content)
    return _import_students_records(records)


def import_schedule_from_uploaded_file(filename: str, content: bytes) -> tuple[str, ImportResult]:
    records = _records_from_uploaded_file(filename, content)
    kind = _detect_schedule_kind(records)
    if kind == "teacher":
        return kind, _import_teachers_records(records)
    return kind, _import_students_records(records)


def preview_students_sync_from_uploaded_file(filename: str, content: bytes) -> StudentSyncPreview:
    records = _records_from_uploaded_file(filename, content)
    if not records:
        raise ValueError("生徒データが空です")

    header = records[0]
    _validate_student_header(header)
    latest_by_name: "OrderedDict[str, list[str]]" = OrderedDict()
    for row in records[1:]:
        if len(row) < 3:
            continue
        name = (row[1] or "").strip()
        if name:
            latest_by_name[name] = row

    imported_names = set(latest_by_name.keys())
    conn = get_connection()
    existing = conn.execute("SELECT id, name FROM students").fetchall()
    stale = [row for row in existing if row["name"] not in imported_names]
    stale_ids = [row["id"] for row in stale]
    removed_assignments = 0
    if stale_ids:
        placeholders = ",".join("?" for _ in stale_ids)
        removed_assignments = conn.execute(
            f"SELECT COUNT(*) FROM assignments WHERE student_id IN ({placeholders})",
            stale_ids,
        ).fetchone()[0]
    conn.close()

    return StudentSyncPreview(
        imported_students=len(imported_names),
        removed_student_names=sorted([row["name"] for row in stale]),
        removed_assignments=removed_assignments,
    )


def preview_schedule_sync_from_uploaded_file(filename: str, content: bytes) -> UnifiedSyncPreview:
    records = _records_from_uploaded_file(filename, content)
    kind = _detect_schedule_kind(records)
    if kind == "teacher":
        preview = preview_teachers_sync_from_uploaded_file(filename, content)
        return UnifiedSyncPreview(
            kind="teacher",
            imported_count=preview.imported_teachers,
            removed_names=preview.removed_teacher_names,
            removed_assignments=preview.removed_assignments,
        )
    preview = preview_students_sync_from_uploaded_file(filename, content)
    return UnifiedSyncPreview(
        kind="student",
        imported_count=preview.imported_students,
        removed_names=preview.removed_student_names,
        removed_assignments=preview.removed_assignments,
    )


def _validate_student_header(header: list[str]) -> None:
    if len(header) < 4:
        raise ValueError("ヘッダー列数が不足しています（最低4列必要）")
    joined = "".join(header)
    if "氏名" not in joined:
        raise ValueError("ヘッダーに氏名列が見つかりません")
    if "受講科目" not in joined:
        raise ValueError("ヘッダーに受講科目列が見つかりません")
    date_cols = [h for h in header if _parse_header_to_date(h or "")]
    if not date_cols:
        raise ValueError("日付列（受講可能予定）が見つかりません")


def _find_student_note_column(header: list[str]) -> int | None:
    for idx, col_name in enumerate(header):
        name = (col_name or "").strip()
        if "備考" in name:
            return idx
    return None


def _sync_form_note_for_student(
    conn,
    student_id: int,
    note_text: str,
) -> None:
    existing_rows = conn.execute(
        """
        SELECT id
        FROM student_notes
        WHERE student_id = ?
          AND body LIKE ?
        ORDER BY id ASC
        """,
        (student_id, f"{FORM_NOTE_PREFIX}%"),
    ).fetchall()

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    body = f"{FORM_NOTE_PREFIX}{note_text.strip()}" if note_text.strip() else ""

    if not body:
        if existing_rows:
            conn.executemany(
                "DELETE FROM student_notes WHERE id = ?",
                [(row["id"],) for row in existing_rows],
            )
        return

    if existing_rows:
        keep_id = existing_rows[0]["id"]
        conn.execute(
            """
            UPDATE student_notes
            SET body = ?, updated_at = ?, is_edited = 0, is_deleted = 0, deleted_at = NULL
            WHERE id = ?
            """,
            (body, now, keep_id),
        )
        if len(existing_rows) > 1:
            conn.executemany(
                "DELETE FROM student_notes WHERE id = ?",
                [(row["id"],) for row in existing_rows[1:]],
            )
        return

    conn.execute(
        """
        INSERT INTO student_notes(student_id, body, created_at, updated_at, is_edited, is_deleted, deleted_at)
        VALUES (?, ?, ?, ?, 0, 0, NULL)
        """,
        (student_id, body, now, now),
    )


def _detect_schedule_kind(records: list[list[str]]) -> str:
    if not records:
        raise ValueError("データが空です")
    header = records[0]
    teacher_ok = True
    student_ok = True
    try:
        _validate_teacher_header(header)
    except Exception:
        teacher_ok = False
    try:
        _validate_student_header(header)
    except Exception:
        student_ok = False

    if teacher_ok and not student_ok:
        return "teacher"
    if student_ok and not teacher_ok:
        return "student"

    joined = "".join(header)
    if teacher_ok and student_ok:
        if "講師名" in joined:
            return "teacher"
        if "氏名" in joined:
            return "student"
    raise ValueError("ファイル種別を判定できません（講師/生徒フォーマットを確認してください）")


def _import_students_records(records: list[list[str]]) -> ImportResult:
    if not records:
        raise ValueError("生徒データが空です")

    header = records[0]
    _validate_student_header(header)
    date_columns: dict[int, str] = {}
    for idx, col_name in enumerate(header):
        parsed = _parse_header_to_date(col_name or "")
        if parsed:
            date_columns[idx] = parsed
    note_column = _find_student_note_column(header)

    latest_by_name: "OrderedDict[str, list[str]]" = OrderedDict()
    for row in records[1:]:
        if len(row) < 3:
            continue
        name = (row[1] or "").strip()
        if name:
            latest_by_name[name] = row

    conn = get_connection()
    cur = conn.cursor()

    imported_names = set(latest_by_name.keys())
    existing = conn.execute("SELECT id, name FROM students").fetchall()
    stale_ids = [row["id"] for row in existing if row["name"] not in imported_names]

    removed_assignments = 0
    removed_students = 0
    if stale_ids:
        placeholders = ",".join("?" for _ in stale_ids)
        removed_assignments = conn.execute(
            f"SELECT COUNT(*) FROM assignments WHERE student_id IN ({placeholders})",
            stale_ids,
        ).fetchone()[0]
        cur.execute(f"DELETE FROM assignments WHERE student_id IN ({placeholders})", stale_ids)
        cur.execute(f"DELETE FROM students WHERE id IN ({placeholders})", stale_ids)
        removed_students = len(stale_ids)

    student_count = 0
    availability_rows = 0
    for name, row in latest_by_name.items():
        cur.execute(
            """
            INSERT INTO students(name)
            VALUES (?)
            ON CONFLICT(name) DO NOTHING
            """,
            (name,),
        )
        student_id = conn.execute(
            "SELECT id FROM students WHERE name = ?",
            (name,),
        ).fetchone()["id"]

        cur.execute("DELETE FROM student_subjects WHERE student_id = ?", (student_id,))
        cur.execute("DELETE FROM student_availability WHERE student_id = ?", (student_id,))

        subjects = _parse_subjects(row[2] if len(row) > 2 else "")
        cur.executemany(
            "INSERT INTO student_subjects(student_id, subject) VALUES (?, ?)",
            [(student_id, subject) for subject in subjects],
        )

        rows_to_insert = []
        for col_idx, date in date_columns.items():
            cell = row[col_idx] if col_idx < len(row) else ""
            for period in _parse_periods(cell or ""):
                rows_to_insert.append((student_id, date, period))
        note_text = row[note_column] if note_column is not None and note_column < len(row) else ""
        _sync_form_note_for_student(conn, student_id, note_text or "")
        cur.executemany(
            "INSERT INTO student_availability(student_id, date, period) VALUES (?, ?, ?)",
            rows_to_insert,
        )
        student_count += 1
        availability_rows += len(rows_to_insert)

    _apply_auto_student_status_rules(conn)
    conn.commit()
    conn.close()
    return ImportResult(
        students=student_count,
        availability_rows=availability_rows,
        removed_students=removed_students,
        removed_assignments=removed_assignments,
    )


def import_students(data_dir: Path) -> ImportResult:
    try:
        from openpyxl import load_workbook
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError("openpyxl が未インストールです") from exc

    files = sorted((data_dir / "students").glob("*.xlsx"))
    if not files:
        raise FileNotFoundError("data/students/*.xlsx が見つかりません")

    conn = get_connection()
    cur = conn.cursor()

    student_count = 0
    availability_rows = 0

    for path in files:
        student_name = path.stem.strip()

        cur.execute(
            """
            INSERT INTO students(name)
            VALUES (?)
            ON CONFLICT(name)
            DO NOTHING
            """,
            (student_name,),
        )
        student_id = cur.execute(
            "SELECT id FROM students WHERE name = ?", (student_name,)
        ).fetchone()[0]

        cur.execute("DELETE FROM student_availability WHERE student_id = ?", (student_id,))

        wb = load_workbook(path, data_only=True)
        ws = wb[wb.sheetnames[0]]

        date_columns = _extract_date_columns_from_sheet(ws)
        rows_to_insert = []
        for col, date in date_columns.items():
            for row in range(7, 13):
                period_val = ws.cell(row=row, column=2).value
                try:
                    period = int(period_val)
                except (TypeError, ValueError):
                    period = row - 5
                if period not in PERIODS:
                    continue
                cell_val = ws.cell(row=row, column=col).value
                if _student_cell_is_available(cell_val):
                    rows_to_insert.append((student_id, date, period))

        cur.executemany(
            """
            INSERT OR IGNORE INTO student_availability(student_id, date, period)
            VALUES (?, ?, ?)
            """,
            rows_to_insert,
        )

        student_count += 1
        availability_rows += len(rows_to_insert)

    _apply_auto_student_status_rules(conn)
    conn.commit()
    conn.close()

    return ImportResult(students=student_count, availability_rows=availability_rows)


def _extract_date_columns_from_sheet(ws) -> dict[int, str]:
    # row 6 expected to have date labels like 2026-03-26, 3/26, or 3月26日.
    row = 6
    cols: dict[int, str] = {}
    for col in range(1, ws.max_column + 1):
        raw = ws.cell(row=row, column=col).value
        if raw is None:
            continue
        text = str(raw).strip()
        date = _parse_header_to_date(text)
        if not date:
            continue

        cols[col] = date

    return cols


def _student_cell_is_available(value: Any) -> bool:
    if value is None:
        return True
    text = str(value).strip()
    if not text:
        return True
    lowered = text.lower()
    if "休校" in text:
        return False
    if "×" in text or "x" in lowered or "△" in text:
        return False
    return True
