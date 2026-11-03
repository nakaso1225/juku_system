from __future__ import annotations

import json
import os
import signal
import socket
import time
import webbrowser
from pathlib import Path
from queue import Empty, Full, Queue
from threading import Lock, Timer
from typing import Any, Callable, TypeVar

from flask import Flask, jsonify, render_template, request
from flask_sock import Sock

from database import (
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
    ImportResult,
    create_assignment,
    create_student_note,
    delete_assignment,
    delete_student_note,
    get_available_teachers,
    get_slot_teacher_summary,
    get_student_timetable,
    get_teacher_panel,
    get_used_tables,
    hard_delete_student_note,
    import_schedule_from_uploaded_file,
    import_students_from_uploaded_file,
    import_teachers,
    import_teachers_from_uploaded_file,
    list_conflicts,
    list_student_notes,
    list_students,
    preview_schedule_sync_from_uploaded_file,
    preview_students_sync_from_uploaded_file,
    preview_teachers_sync_from_uploaded_file,
    reset_assignments,
    restore_student_note,
    update_student_note,
    update_student_status_and_memo,
)

T = TypeVar("T")

BASE_DIR = Path(__file__).resolve().parent

app = Flask(__name__)
sock = Sock(app)

# models 層が投げる例外メッセージのうち、404 として返すもの
NOT_FOUND_MESSAGES = frozenset({"student not found", "note not found"})
LOCAL_ADDRESSES = frozenset({"127.0.0.1", "::1"})

ACTIVE_TABS: dict[str, float] = {}
ACTIVE_TABS_LOCK = Lock()
TAB_TTL_SECONDS = 30.0

WS_CLIENTS: set[Queue[str]] = set()
WS_CLIENTS_LOCK = Lock()
WS_QUEUE_MAXSIZE = 64
WS_PING_INTERVAL_SECONDS = 15.0


# ---------------------------------------------------------------------------
# 起動時の初期化
# ---------------------------------------------------------------------------


def bootstrap_data() -> None:
    init_db()

    conn = get_connection()
    try:
        teacher_count = conn.execute("SELECT COUNT(*) FROM teachers").fetchone()[0]
        student_count = conn.execute("SELECT COUNT(*) FROM students").fetchone()[0]
    finally:
        conn.close()

    # サンプル講師データは USE_SAMPLE_TEACHERS=1 のときだけ投入する。
    # 生徒は予定表ファイルの取り込みで管理するため、ここでは自動投入しない。
    if teacher_count == 0 and student_count == 0 and os.environ.get("USE_SAMPLE_TEACHERS") == "1":
        seed_dummy_data()


bootstrap_data()


def _app_port() -> int:
    return int(os.environ.get("APP_PORT", "5000"))


def _detect_lan_ip() -> str | None:
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        udp.connect(("8.8.8.8", 80))
        ip = udp.getsockname()[0]
    except OSError:
        return None
    finally:
        udp.close()
    if ip and not ip.startswith("127."):
        return ip
    return None


# ---------------------------------------------------------------------------
# API 共通ヘルパー
# ---------------------------------------------------------------------------


class ApiError(Exception):
    """ルート内で raise すると {"error": message} の JSON レスポンスになる。"""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


@app.errorhandler(ApiError)
def _handle_api_error(exc: ApiError):
    return jsonify({"error": exc.message}), exc.status


def _call_model(func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """models の関数を呼び、例外を ApiError（404 または 400）に変換する。"""
    try:
        return func(*args, **kwargs)
    except Exception as exc:
        message = str(exc)
        status = 404 if message in NOT_FOUND_MESSAGES else 400
        raise ApiError(message, status) from exc


def _json_body() -> dict[str, Any]:
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else {}


def _require_args(*names: str) -> list[str]:
    """クエリ文字列から必須パラメータを取り出す。1つでも空なら 400。"""
    values = [request.args.get(name, "") for name in names]
    if not all(values):
        verb = "is" if len(names) == 1 else "are"
        raise ApiError(f"{', '.join(names)} {verb} required")
    return values


def _parse_int(raw: str, error_message: str) -> int:
    try:
        return int(raw)
    except ValueError:
        raise ApiError(error_message) from None


def _uploaded_file() -> tuple[str, bytes]:
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        raise ApiError("ファイルを選択してください")
    return upload.filename, upload.read()


def _process_upload(func: Callable[[str, bytes], T]) -> T:
    filename, content = _uploaded_file()
    return _call_model(func, filename, content)


def _ensure_found(found: bool, message: str) -> None:
    if not found:
        raise ApiError(message, 404)


# ---------------------------------------------------------------------------
# WebSocket によるリアルタイム通知
# ---------------------------------------------------------------------------


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


def _notify_schedule_updated(
    reason: str,
    *,
    scope: str = "global",
    student_id: int | None = None,
) -> None:
    """操作したタブの ID を添えて、他タブへ予定の更新を通知する。"""
    _broadcast_schedule_event(
        scope=scope,
        student_id=student_id,
        reason=reason,
        source_tab_id=_request_tab_id(),
    )


def _request_tab_id() -> str | None:
    tab_id = str(request.headers.get("X-Tab-Id") or "").strip()
    return tab_id or None


@sock.route("/ws")
def ws_updates(ws):
    client_queue: Queue[str] = Queue(maxsize=WS_QUEUE_MAXSIZE)
    with WS_CLIENTS_LOCK:
        WS_CLIENTS.add(client_queue)

    try:
        while True:
            try:
                message = client_queue.get(timeout=WS_PING_INTERVAL_SECONDS)
            except Empty:
                message = json.dumps({"type": "ping"})
            ws.send(message)
    finally:
        with WS_CLIENTS_LOCK:
            WS_CLIENTS.discard(client_queue)


# ---------------------------------------------------------------------------
# 画面・メタ情報
# ---------------------------------------------------------------------------


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/meta")
def api_meta():
    lan_ip = _detect_lan_ip()
    return jsonify(
        {
            "subjects": SUBJECTS,
            "periods": PERIODS,
            "period_labels": PERIOD_LABELS,
            "dates": get_calendar_dates(),
            "table_ids": TABLE_IDS,
            "lan_ip": lan_ip,
            "lan_url": f"http://{lan_ip}:{_app_port()}" if lan_ip else None,
        }
    )


# ---------------------------------------------------------------------------
# 生徒・生徒メモ
# ---------------------------------------------------------------------------


@app.route("/api/students")
def api_students():
    return jsonify(list_students())


@app.route("/api/students/<int:student_id>/timetable")
def api_student_timetable(student_id: int):
    data = get_student_timetable(student_id)
    if data is None:
        raise ApiError("student not found", 404)
    return jsonify(data)


@app.route("/api/students/<int:student_id>/meta", methods=["PATCH"])
def api_student_meta_update(student_id: int):
    payload = _json_body()
    status_raw = payload.get("status")
    memo_raw = payload.get("memo")
    if status_raw is None and memo_raw is None:
        raise ApiError("status or memo is required")
    updated = _call_model(
        update_student_status_and_memo,
        student_id,
        status=None if status_raw is None else str(status_raw),
        memo=None if memo_raw is None else str(memo_raw),
    )
    return jsonify(updated)


@app.route("/api/students/<int:student_id>/notes")
def api_student_notes(student_id: int):
    return jsonify(_call_model(list_student_notes, student_id))


@app.route("/api/students/<int:student_id>/notes", methods=["POST"])
def api_student_notes_create(student_id: int):
    body = str(_json_body().get("body") or "")
    return jsonify(_call_model(create_student_note, student_id, body)), 201


@app.route("/api/students/<int:student_id>/notes/<int:note_id>", methods=["PATCH"])
def api_student_notes_update(student_id: int, note_id: int):
    body = str(_json_body().get("body") or "")
    return jsonify(_call_model(update_student_note, student_id, note_id, body))


@app.route("/api/students/<int:student_id>/notes/<int:note_id>", methods=["DELETE"])
def api_student_notes_delete(student_id: int, note_id: int):
    _ensure_found(_call_model(delete_student_note, student_id, note_id), "note not found")
    return ("", 204)


@app.route("/api/students/<int:student_id>/notes/<int:note_id>/restore", methods=["POST"])
def api_student_notes_restore(student_id: int, note_id: int):
    _ensure_found(_call_model(restore_student_note, student_id, note_id), "note not found")
    return jsonify({"ok": True})


@app.route("/api/students/<int:student_id>/notes/<int:note_id>/hard-delete", methods=["DELETE"])
def api_student_notes_hard_delete(student_id: int, note_id: int):
    _ensure_found(_call_model(hard_delete_student_note, student_id, note_id), "note not found")
    return ("", 204)


# ---------------------------------------------------------------------------
# 講師・空き状況
# ---------------------------------------------------------------------------


@app.route("/api/teacher-panel")
def api_teacher_panel():
    (student_id_raw,) = _require_args("student_id")
    student_id = _parse_int(student_id_raw, "invalid student_id")

    teacher_id_raw = request.args.get("teacher_id", "")
    teacher_id = _parse_int(teacher_id_raw, "invalid teacher_id") if teacher_id_raw else None

    return jsonify(get_teacher_panel(student_id=student_id, teacher_id=teacher_id))


@app.route("/api/available-teachers")
def api_available_teachers():
    date, period_raw, subject, student_id_raw = _require_args(
        "date", "period", "subject", "student_id"
    )
    error_message = "invalid period or student_id"
    teachers = get_available_teachers(
        date=date,
        period=_parse_int(period_raw, error_message),
        subject=subject,
        student_id=_parse_int(student_id_raw, error_message),
    )
    return jsonify(teachers)


@app.route("/api/slot-teacher-summary")
def api_slot_teacher_summary():
    subject, student_id_raw = _require_args("subject", "student_id")
    student_id = _parse_int(student_id_raw, "invalid student_id")
    return jsonify(get_slot_teacher_summary(student_id=student_id, subject=subject))


@app.route("/api/used-tables")
def api_used_tables():
    date, period_raw = _require_args("date", "period")
    period = _parse_int(period_raw, "invalid period")
    return jsonify({"used_table_ids": get_used_tables(date=date, period=period)})


# ---------------------------------------------------------------------------
# 割り当て
# ---------------------------------------------------------------------------


def _assignment_student_id(assignment_id: int) -> int | None:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT student_id FROM assignments WHERE id = ?",
            (assignment_id,),
        ).fetchone()
    finally:
        conn.close()
    return None if row is None else int(row["student_id"])


@app.route("/api/assignments", methods=["POST"])
def api_create_assignment():
    payload = _json_body()
    required = ["student_id", "table_id", "subject", "date", "period"]
    missing = [key for key in required if key not in payload]
    if missing:
        raise ApiError(f"missing fields: {', '.join(missing)}")

    try:
        teacher_id_raw = payload.get("teacher_id")
        teacher_id = None if teacher_id_raw in (None, "", "null") else int(teacher_id_raw)
        student_id = int(payload["student_id"])
        period = int(payload["period"])
    except (TypeError, ValueError, OverflowError) as exc:
        raise ApiError(str(exc)) from exc

    result = _call_model(
        create_assignment,
        student_id=student_id,
        teacher_id=teacher_id,
        table_id=str(payload["table_id"]),
        subject=str(payload["subject"]),
        date=str(payload["date"]),
        period=period,
    )
    _notify_schedule_updated("assignment_saved", scope="student", student_id=student_id)
    return jsonify(result), 201


@app.route("/api/assignments/<int:assignment_id>", methods=["DELETE"])
def api_delete_assignment(assignment_id: int):
    student_id = _assignment_student_id(assignment_id)
    _ensure_found(delete_assignment(assignment_id), "assignment not found")
    _notify_schedule_updated("assignment_deleted", scope="student", student_id=student_id)
    return ("", 204)


@app.route("/api/assignments/reset", methods=["POST"])
def api_reset_assignments():
    deleted_count = reset_assignments()
    _notify_schedule_updated("assignments_reset")
    return jsonify({"deleted_assignments": deleted_count})


@app.route("/api/conflicts")
def api_conflicts():
    return jsonify(list_conflicts())


# ---------------------------------------------------------------------------
# 予定表の取り込み（講師 / 生徒 / 自動判別）
# ---------------------------------------------------------------------------


def _teacher_import_response(result: ImportResult) -> dict[str, int]:
    return {
        "imported_teachers": result.teachers,
        "availability_rows": result.availability_rows,
        "removed_teachers": result.removed_teachers,
        "removed_assignments": result.removed_assignments,
    }


def _student_import_response(result: ImportResult) -> dict[str, int]:
    return {
        "imported_students": result.students,
        "availability_rows": result.availability_rows,
        "removed_students": result.removed_students,
        "removed_assignments": result.removed_assignments,
    }


def _unified_import_response(kind: str, result: ImportResult) -> dict[str, Any]:
    is_teacher = kind == "teacher"
    return {
        "kind": "teacher" if is_teacher else "student",
        "imported_count": result.teachers if is_teacher else result.students,
        "availability_rows": result.availability_rows,
        "removed_count": result.removed_teachers if is_teacher else result.removed_students,
        "removed_assignments": result.removed_assignments,
    }


@app.route("/api/sync-schedule", methods=["POST"])
def api_sync_schedule():
    result = _call_model(import_teachers, BASE_DIR / "data")
    _notify_schedule_updated("teacher_schedule_synced")
    return jsonify(_teacher_import_response(result))


@app.route("/api/sync-schedule-upload", methods=["POST"])
def api_sync_schedule_upload_preview():
    preview = _process_upload(preview_teachers_sync_from_uploaded_file)
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
    result = _process_upload(import_teachers_from_uploaded_file)
    _notify_schedule_updated("teacher_schedule_uploaded")
    return jsonify(_teacher_import_response(result))


@app.route("/api/sync-students-upload", methods=["POST"])
def api_sync_students_upload_preview():
    preview = _process_upload(preview_students_sync_from_uploaded_file)
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
    result = _process_upload(import_students_from_uploaded_file)
    _notify_schedule_updated("student_schedule_uploaded")
    return jsonify(_student_import_response(result))


@app.route("/api/sync-upload", methods=["POST"])
def api_sync_upload_preview():
    preview = _process_upload(preview_schedule_sync_from_uploaded_file)
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
    kind, result = _process_upload(import_schedule_from_uploaded_file)
    _notify_schedule_updated(f"{kind}_schedule_uploaded")
    return jsonify(_unified_import_response(kind, result))


# ---------------------------------------------------------------------------
# タブ管理と自動終了（全タブが閉じられたらサーバーを止める）
# ---------------------------------------------------------------------------


def _prune_active_tabs(now: float) -> None:
    stale = [tab_id for tab_id, ts in ACTIVE_TABS.items() if now - ts > TAB_TTL_SECONDS]
    for tab_id in stale:
        ACTIVE_TABS.pop(tab_id, None)


def _fallback_terminate() -> None:
    try:
        # デバッグ用リローダー配下では親プロセスも止める
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
        with ACTIVE_TABS_LOCK:
            _prune_active_tabs(time.time())
            if ACTIVE_TABS:
                return
        _fallback_terminate()

    Timer(delay_seconds, _check_and_terminate).start()


def _tab_id_from_request() -> str:
    """tab-close は sendBeacon 等から来るため、JSON / form / クエリの順に探す。"""
    sources = (_json_body(), request.form, request.args)
    for source in sources:
        tab_id = str(source.get("tab_id") or "").strip()
        if tab_id:
            return tab_id
    return ""


@app.route("/api/tab-heartbeat", methods=["POST"])
def api_tab_heartbeat():
    tab_id = str(_json_body().get("tab_id") or "").strip()
    if not tab_id:
        raise ApiError("tab_id is required")
    now = time.time()
    with ACTIVE_TABS_LOCK:
        ACTIVE_TABS[tab_id] = now
        _prune_active_tabs(now)
        active_count = len(ACTIVE_TABS)
    return jsonify({"ok": True, "active_tabs": active_count})


@app.route("/api/tab-close", methods=["POST"])
def api_tab_close():
    tab_id = _tab_id_from_request()
    with ACTIVE_TABS_LOCK:
        if tab_id:
            ACTIVE_TABS.pop(tab_id, None)
        _prune_active_tabs(time.time())
        active_count = len(ACTIVE_TABS)

    if active_count == 0:
        _schedule_shutdown_if_no_tabs()

    return jsonify({"ok": True, "active_tabs": active_count})


@app.route("/api/shutdown", methods=["POST"])
def api_shutdown():
    if (request.remote_addr or "") not in LOCAL_ADDRESSES:
        raise ApiError("forbidden", 403)

    shutdown = request.environ.get("werkzeug.server.shutdown")
    if shutdown is not None:
        shutdown()
        return jsonify({"ok": True, "mode": "werkzeug"})
    Timer(0.2, _fallback_terminate).start()
    return jsonify({"ok": True, "mode": "fallback"})


if __name__ == "__main__":
    host = os.environ.get("APP_HOST", "0.0.0.0")
    port = _app_port()

    # デバッグ時のリローダーで二重起動しないよう、実行プロセス側でのみ開く
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}/")).start()

    app.run(host=host, port=port, debug=True)
