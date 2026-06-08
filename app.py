from __future__ import annotations

import json
from pathlib import Path
import os
from queue import Empty, Full, Queue
import signal
import socket
import webbrowser
import time
from threading import Timer
from threading import Lock

from flask import Flask, jsonify, render_template, request
from flask_sock import Sock

from database import (
    DATES,
    PERIOD_LABELS,
    PERIODS,
    SUBJECTS,
    TABLE_IDS,
    get_calendar_dates,
    get_connection,
    init_db,
    seed_dummy_data,
)
from models import (
    create_student_note,
    create_assignment,
    delete_student_note,
    hard_delete_student_note,
    delete_assignment,
    get_available_teachers,
    get_teacher_panel,
    get_slot_teacher_summary,
    get_student_timetable,
    get_used_tables,
    import_schedule_from_uploaded_file,
    import_students_from_uploaded_file,
    import_teachers_from_uploaded_file,
    preview_schedule_sync_from_uploaded_file,
    preview_students_sync_from_uploaded_file,
    preview_teachers_sync_from_uploaded_file,
    import_teachers,
    list_student_notes,
    list_conflicts,
    list_students,
    reset_assignments,
    restore_student_note,
    update_student_note,
    update_student_status_and_memo,
)

BASE_DIR = Path(__file__).resolve().parent

app = Flask(__name__)
sock = Sock(app)

ACTIVE_TABS: dict[str, float] = {}
ACTIVE_TABS_LOCK = Lock()
TAB_TTL_SECONDS = 30.0
WS_CLIENTS: set[Queue[str]] = set()
WS_CLIENTS_LOCK = Lock()
WS_QUEUE_MAXSIZE = 64


def _prune_active_tabs(now: float) -> None:
    stale = [tab_id for tab_id, ts in ACTIVE_TABS.items() if now - ts > TAB_TTL_SECONDS]
    for tab_id in stale:
        ACTIVE_TABS.pop(tab_id, None)


def _fallback_terminate() -> None:
    try:
        if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
            parent_pid = os.getppid()
            if parent_pid > 1:
                os.kill(parent_pid, signal.SIGTERM)
    except Exception:
        pass
    try:
        os.kill(os.getpid(), signal.SIGTERM)
    except Exception:
        pass


def _schedule_shutdown_if_no_tabs(delay_seconds: float = 1.5) -> None:
    def _check_and_terminate() -> None:
        now = time.time()
        with ACTIVE_TABS_LOCK:
            _prune_active_tabs(now)
            if ACTIVE_TABS:
                return
        _fallback_terminate()

    Timer(delay_seconds, _check_and_terminate).start()


def _request_tab_id() -> str | None:
    tab_id = str(request.headers.get("X-Tab-Id") or "").strip()
    return tab_id or None


def _broadcast_schedule_event(
    *,
    scope: str,
    student_id: int | None = None,
    reason: str,
    source_tab_id: str | None = None,
) -> None:
    payload = json.dumps(
        {
            "type": "schedule_updated",
            "scope": scope,
            "student_id": student_id,
            "reason": reason,
            "source_tab_id": source_tab_id,
            "sent_at": time.time(),
        },
        ensure_ascii=False,
    )

    with WS_CLIENTS_LOCK:
        stale_clients: list[Queue[str]] = []
        for client_queue in WS_CLIENTS:
            try:
                client_queue.put_nowait(payload)
            except Full:
                stale_clients.append(client_queue)
        for client_queue in stale_clients:
            WS_CLIENTS.discard(client_queue)


def bootstrap_data() -> None:
    init_db()

    conn = get_connection()
    try:
        teacher_count = conn.execute("SELECT COUNT(*) FROM teachers").fetchone()[0]
        student_count = conn.execute("SELECT COUNT(*) FROM students").fetchone()[0]
    finally:
        conn.close()

    if teacher_count == 0 and student_count == 0:
        # Default: do not auto-seed sample teachers.
        # Set USE_SAMPLE_TEACHERS=1 only when you explicitly want sample data.
        if os.environ.get("USE_SAMPLE_TEACHERS") == "1":
            seed_dummy_data()
            return

    # Students are managed from schedule import files. No auto-seed here.


bootstrap_data()


def _detect_lan_ip() -> str | None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        return None
    finally:
        sock.close()
    return None


@sock.route("/ws")
def ws_updates(ws):
    client_queue: Queue[str] = Queue(maxsize=WS_QUEUE_MAXSIZE)
    with WS_CLIENTS_LOCK:
        WS_CLIENTS.add(client_queue)

    try:
        while True:
            try:
                message = client_queue.get(timeout=15.0)
            except Empty:
                message = json.dumps({"type": "ping"})
            ws.send(message)
    finally:
        with WS_CLIENTS_LOCK:
            WS_CLIENTS.discard(client_queue)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/meta")
def api_meta():
    port = int(os.environ.get("APP_PORT", "5000"))
    lan_ip = _detect_lan_ip()
    return jsonify(
        {
            "subjects": SUBJECTS,
            "periods": PERIODS,
            "period_labels": PERIOD_LABELS,
            "dates": get_calendar_dates(),
            "table_ids": TABLE_IDS,
            "lan_ip": lan_ip,
            "lan_url": f"http://{lan_ip}:{port}" if lan_ip else None,
        }
    )


@app.route("/api/students")
def api_students():
    return jsonify(list_students())


@app.route("/api/students/<int:student_id>/timetable")
def api_student_timetable(student_id: int):
    data = get_student_timetable(student_id)
    if data is None:
        return jsonify({"error": "student not found"}), 404
    return jsonify(data)


@app.route("/api/students/<int:student_id>/meta", methods=["PATCH"])
def api_student_meta_update(student_id: int):
    payload = request.get_json(silent=True) or {}
    status_raw = payload.get("status")
    memo_raw = payload.get("memo")
    if status_raw is None and memo_raw is None:
        return jsonify({"error": "status or memo is required"}), 400
    try:
        updated = update_student_status_and_memo(
            student_id,
            status=None if status_raw is None else str(status_raw),
            memo=None if memo_raw is None else str(memo_raw),
        )
    except Exception as exc:
        msg = str(exc)
        if msg == "student not found":
            return jsonify({"error": msg}), 404
        return jsonify({"error": msg}), 400
    return jsonify(updated)


@app.route("/api/students/<int:student_id>/notes")
def api_student_notes(student_id: int):
    try:
        notes = list_student_notes(student_id)
    except Exception as exc:
        msg = str(exc)
        if msg == "student not found":
            return jsonify({"error": msg}), 404
        return jsonify({"error": msg}), 400
    return jsonify(notes)


@app.route("/api/students/<int:student_id>/notes", methods=["POST"])
def api_student_notes_create(student_id: int):
    payload = request.get_json(silent=True) or {}
    body = str(payload.get("body") or "")
    try:
        note = create_student_note(student_id, body)
    except Exception as exc:
        msg = str(exc)
        if msg == "student not found":
            return jsonify({"error": msg}), 404
        return jsonify({"error": msg}), 400
    return jsonify(note), 201


@app.route("/api/students/<int:student_id>/notes/<int:note_id>", methods=["PATCH"])
def api_student_notes_update(student_id: int, note_id: int):
    payload = request.get_json(silent=True) or {}
    body = str(payload.get("body") or "")
    try:
        note = update_student_note(student_id, note_id, body)
    except Exception as exc:
        msg = str(exc)
        if msg in {"student not found", "note not found"}:
            return jsonify({"error": msg}), 404
        return jsonify({"error": msg}), 400
    return jsonify(note)


@app.route("/api/students/<int:student_id>/notes/<int:note_id>", methods=["DELETE"])
def api_student_notes_delete(student_id: int, note_id: int):
    try:
        deleted = delete_student_note(student_id, note_id)
    except Exception as exc:
        msg = str(exc)
        if msg == "student not found":
            return jsonify({"error": msg}), 404
        return jsonify({"error": msg}), 400
    if not deleted:
        return jsonify({"error": "note not found"}), 404
    return ("", 204)


@app.route("/api/students/<int:student_id>/notes/<int:note_id>/restore", methods=["POST"])
def api_student_notes_restore(student_id: int, note_id: int):
    try:
        restored = restore_student_note(student_id, note_id)
    except Exception as exc:
        msg = str(exc)
        if msg == "student not found":
            return jsonify({"error": msg}), 404
        return jsonify({"error": msg}), 400
    if not restored:
        return jsonify({"error": "note not found"}), 404
    return jsonify({"ok": True})


@app.route("/api/students/<int:student_id>/notes/<int:note_id>/hard-delete", methods=["DELETE"])
def api_student_notes_hard_delete(student_id: int, note_id: int):
    try:
        deleted = hard_delete_student_note(student_id, note_id)
    except Exception as exc:
        msg = str(exc)
        if msg == "student not found":
            return jsonify({"error": msg}), 404
        return jsonify({"error": msg}), 400
    if not deleted:
        return jsonify({"error": "note not found"}), 404
    return ("", 204)


@app.route("/api/teacher-panel")
def api_teacher_panel():
    student_id_raw = request.args.get("student_id", "")
    teacher_id_raw = request.args.get("teacher_id", "")
    if not student_id_raw:
        return jsonify({"error": "student_id is required"}), 400
    try:
        student_id = int(student_id_raw)
    except ValueError:
        return jsonify({"error": "invalid student_id"}), 400

    teacher_id = None
    if teacher_id_raw:
        try:
            teacher_id = int(teacher_id_raw)
        except ValueError:
            return jsonify({"error": "invalid teacher_id"}), 400

    return jsonify(get_teacher_panel(student_id=student_id, teacher_id=teacher_id))


@app.route("/api/available-teachers")
def api_available_teachers():
    date = request.args.get("date", "")
    subject = request.args.get("subject", "")
    student_id_raw = request.args.get("student_id", "")
    period_raw = request.args.get("period", "")

    if not (date and subject and student_id_raw and period_raw):
        return jsonify({"error": "date, period, subject, student_id are required"}), 400

    try:
        student_id = int(student_id_raw)
        period = int(period_raw)
    except ValueError:
        return jsonify({"error": "invalid period or student_id"}), 400

    teachers = get_available_teachers(
        date=date,
        period=period,
        subject=subject,
        student_id=student_id,
    )
    return jsonify(teachers)


@app.route("/api/slot-teacher-summary")
def api_slot_teacher_summary():
    subject = request.args.get("subject", "")
    student_id_raw = request.args.get("student_id", "")
    if not (subject and student_id_raw):
        return jsonify({"error": "subject, student_id are required"}), 400
    try:
        student_id = int(student_id_raw)
    except ValueError:
        return jsonify({"error": "invalid student_id"}), 400
    return jsonify(get_slot_teacher_summary(student_id=student_id, subject=subject))


@app.route("/api/used-tables")
def api_used_tables():
    date = request.args.get("date", "")
    period_raw = request.args.get("period", "")
    if not (date and period_raw):
        return jsonify({"error": "date, period are required"}), 400
    try:
        period = int(period_raw)
    except ValueError:
        return jsonify({"error": "invalid period"}), 400
    return jsonify({"used_table_ids": get_used_tables(date=date, period=period)})


@app.route("/api/assignments", methods=["POST"])
def api_create_assignment():
    payload = request.get_json(silent=True) or {}
    required = ["student_id", "table_id", "subject", "date", "period"]
    missing = [key for key in required if key not in payload]
    if missing:
        return jsonify({"error": f"missing fields: {', '.join(missing)}"}), 400

    try:
        teacher_id_raw = payload.get("teacher_id")
        teacher_id = None if teacher_id_raw in (None, "", "null") else int(teacher_id_raw)
        result = create_assignment(
            student_id=int(payload["student_id"]),
            teacher_id=teacher_id,
            table_id=str(payload["table_id"]),
            subject=str(payload["subject"]),
            date=str(payload["date"]),
            period=int(payload["period"]),
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    _broadcast_schedule_event(
        scope="student",
        student_id=int(payload["student_id"]),
        reason="assignment_saved",
        source_tab_id=_request_tab_id(),
    )
    return jsonify(result), 201


@app.route("/api/assignments/<int:assignment_id>", methods=["DELETE"])
def api_delete_assignment(assignment_id: int):
    conn = get_connection()
    row = conn.execute(
        "SELECT student_id FROM assignments WHERE id = ?",
        (assignment_id,),
    ).fetchone()
    conn.close()

    deleted = delete_assignment(assignment_id)
    if not deleted:
        return jsonify({"error": "assignment not found"}), 404
    _broadcast_schedule_event(
        scope="student",
        student_id=None if row is None else int(row["student_id"]),
        reason="assignment_deleted",
        source_tab_id=_request_tab_id(),
    )
    return ("", 204)


@app.route("/api/assignments/reset", methods=["POST"])
def api_reset_assignments():
    deleted_count = reset_assignments()
    _broadcast_schedule_event(
        scope="global",
        reason="assignments_reset",
        source_tab_id=_request_tab_id(),
    )
    return jsonify({"deleted_assignments": deleted_count})


@app.route("/api/conflicts")
def api_conflicts():
    return jsonify(list_conflicts())


@app.route("/api/sync-schedule", methods=["POST"])
def api_sync_schedule():
    try:
        result = import_teachers(BASE_DIR / "data")
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    _broadcast_schedule_event(
        scope="global",
        reason="teacher_schedule_synced",
        source_tab_id=_request_tab_id(),
    )
    return jsonify(
        {
            "imported_teachers": result.teachers,
            "availability_rows": result.availability_rows,
            "removed_teachers": result.removed_teachers,
            "removed_assignments": result.removed_assignments,
        }
    )


@app.route("/api/sync-schedule-upload", methods=["POST"])
def api_sync_schedule_upload_preview():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "ファイルを選択してください"}), 400
    try:
        content = upload.read()
        preview = preview_teachers_sync_from_uploaded_file(upload.filename, content)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(
        {
            "imported_teachers": preview.imported_teachers,
            "removed_teacher_names": preview.removed_teacher_names,
            "removed_teachers": len(preview.removed_teacher_names),
            "removed_assignments": preview.removed_assignments,
        }
    )


@app.route("/api/sync-schedule-upload/apply", methods=["POST"])
def api_sync_schedule_upload():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "ファイルを選択してください"}), 400
    try:
        content = upload.read()
        result = import_teachers_from_uploaded_file(upload.filename, content)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    _broadcast_schedule_event(
        scope="global",
        reason="teacher_schedule_uploaded",
        source_tab_id=_request_tab_id(),
    )
    return jsonify(
        {
            "imported_teachers": result.teachers,
            "availability_rows": result.availability_rows,
            "removed_teachers": result.removed_teachers,
            "removed_assignments": result.removed_assignments,
        }
    )


@app.route("/api/sync-students-upload", methods=["POST"])
def api_sync_students_upload_preview():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "ファイルを選択してください"}), 400
    try:
        content = upload.read()
        preview = preview_students_sync_from_uploaded_file(upload.filename, content)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(
        {
            "imported_students": preview.imported_students,
            "removed_student_names": preview.removed_student_names,
            "removed_students": len(preview.removed_student_names),
            "removed_assignments": preview.removed_assignments,
        }
    )


@app.route("/api/sync-students-upload/apply", methods=["POST"])
def api_sync_students_upload_apply():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "ファイルを選択してください"}), 400
    try:
        content = upload.read()
        result = import_students_from_uploaded_file(upload.filename, content)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    _broadcast_schedule_event(
        scope="global",
        reason="student_schedule_uploaded",
        source_tab_id=_request_tab_id(),
    )
    return jsonify(
        {
            "imported_students": result.students,
            "availability_rows": result.availability_rows,
            "removed_students": result.removed_students,
            "removed_assignments": result.removed_assignments,
        }
    )


@app.route("/api/sync-upload", methods=["POST"])
def api_sync_upload_preview():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "ファイルを選択してください"}), 400
    try:
        content = upload.read()
        preview = preview_schedule_sync_from_uploaded_file(upload.filename, content)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(
        {
            "kind": preview.kind,
            "imported_count": preview.imported_count,
            "removed_names": preview.removed_names,
            "removed_count": len(preview.removed_names),
            "removed_assignments": preview.removed_assignments,
        }
    )


@app.route("/api/sync-upload/apply", methods=["POST"])
def api_sync_upload_apply():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "ファイルを選択してください"}), 400
    try:
        content = upload.read()
        kind, result = import_schedule_from_uploaded_file(upload.filename, content)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    _broadcast_schedule_event(
        scope="global",
        reason=f"{kind}_schedule_uploaded",
        source_tab_id=_request_tab_id(),
    )
    if kind == "teacher":
        return jsonify(
            {
                "kind": "teacher",
                "imported_count": result.teachers,
                "availability_rows": result.availability_rows,
                "removed_count": result.removed_teachers,
                "removed_assignments": result.removed_assignments,
            }
        )
    return jsonify(
        {
            "kind": "student",
            "imported_count": result.students,
            "availability_rows": result.availability_rows,
            "removed_count": result.removed_students,
            "removed_assignments": result.removed_assignments,
        }
    )


@app.route("/api/tab-heartbeat", methods=["POST"])
def api_tab_heartbeat():
    payload = request.get_json(silent=True) or {}
    tab_id = str(payload.get("tab_id") or "").strip()
    if not tab_id:
        return jsonify({"error": "tab_id is required"}), 400
    now = time.time()
    with ACTIVE_TABS_LOCK:
        ACTIVE_TABS[tab_id] = now
        _prune_active_tabs(now)
        active_count = len(ACTIVE_TABS)
    return jsonify({"ok": True, "active_tabs": active_count})


@app.route("/api/tab-close", methods=["POST"])
def api_tab_close():
    tab_id = ""
    payload = request.get_json(silent=True) or {}
    if isinstance(payload, dict):
        tab_id = str(payload.get("tab_id") or "").strip()
    if not tab_id:
        tab_id = str(request.form.get("tab_id") or "").strip()
    if not tab_id:
        tab_id = str(request.args.get("tab_id") or "").strip()

    now = time.time()
    with ACTIVE_TABS_LOCK:
        if tab_id:
            ACTIVE_TABS.pop(tab_id, None)
        _prune_active_tabs(now)
        active_count = len(ACTIVE_TABS)

    if active_count == 0:
        _schedule_shutdown_if_no_tabs()

    return jsonify({"ok": True, "active_tabs": active_count})


@app.route("/api/shutdown", methods=["POST"])
def api_shutdown():
    remote = request.remote_addr or ""
    if remote not in {"127.0.0.1", "::1"}:
        return jsonify({"error": "forbidden"}), 403

    shutdown = request.environ.get("werkzeug.server.shutdown")
    if shutdown is not None:
        shutdown()
        return jsonify({"ok": True, "mode": "werkzeug"})
    Timer(0.2, _fallback_terminate).start()
    return jsonify({"ok": True, "mode": "fallback"})


if __name__ == "__main__":
    host = os.environ.get("APP_HOST", "0.0.0.0")
    port = int(os.environ.get("APP_PORT", "5000"))

    # デバッグ時のリローダーで二重起動しないよう、実行プロセス側でのみ開く
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}/")).start()

    app.run(host=host, port=port, debug=True)
