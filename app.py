from __future__ import annotations

from pathlib import Path
import os
import signal
import webbrowser
from threading import Timer

from flask import Flask, jsonify, render_template, request

from database import (
    DATES,
    PERIOD_LABELS,
    PERIODS,
    SUBJECTS,
    TABLE_IDS,
    get_connection,
    init_db,
    seed_dummy_data,
)
from models import (
    create_assignment,
    delete_assignment,
    get_available_teachers,
    get_teacher_panel,
    get_slot_teacher_summary,
    get_student_timetable,
    get_used_tables,
    import_schedule_from_uploaded_file,
    import_teachers_from_uploaded_file,
    preview_schedule_sync_from_uploaded_file,
    preview_teachers_sync_from_uploaded_file,
    import_teachers,
    list_conflicts,
    list_students,
)

BASE_DIR = Path(__file__).resolve().parent

app = Flask(__name__)


def bootstrap_data() -> None:
    init_db()

    teacher_count = 0
    student_count = 0
    conn = get_connection()
    try:
        teacher_count = conn.execute("SELECT COUNT(*) FROM teachers").fetchone()[0]
        student_count = conn.execute("SELECT COUNT(*) FROM students").fetchone()[0]
    finally:
        conn.close()

    # Prefer spreadsheet/csv teachers over hardcoded sample data.
    # This keeps teacher data aligned with source files during debugging.
    try:
        import_teachers(BASE_DIR / "data")
    except Exception:
        pass

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


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/meta")
def api_meta():
    return jsonify(
        {
            "subjects": SUBJECTS,
            "periods": PERIODS,
            "period_labels": PERIOD_LABELS,
            "dates": DATES,
            "table_ids": TABLE_IDS,
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

    return jsonify(result), 201


@app.route("/api/assignments/<int:assignment_id>", methods=["DELETE"])
def api_delete_assignment(assignment_id: int):
    deleted = delete_assignment(assignment_id)
    if not deleted:
        return jsonify({"error": "assignment not found"}), 404
    return ("", 204)


@app.route("/api/conflicts")
def api_conflicts():
    return jsonify(list_conflicts())


@app.route("/api/sync-schedule", methods=["POST"])
def api_sync_schedule():
    try:
        result = import_teachers(BASE_DIR / "data")
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

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


@app.route("/api/shutdown", methods=["POST"])
def api_shutdown():
    remote = request.remote_addr or ""
    if remote not in {"127.0.0.1", "::1"}:
        return jsonify({"error": "forbidden"}), 403

    shutdown = request.environ.get("werkzeug.server.shutdown")
    if shutdown is not None:
        shutdown()
        return jsonify({"ok": True, "mode": "werkzeug"})

    # Fallback: Flask/Werkzeugの起動形態によってはshutdownハンドラが無い。
    # その場合は子プロセス/親プロセスをSIGTERMで終了する。
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

    Timer(0.2, _fallback_terminate).start()
    return jsonify({"ok": True, "mode": "fallback"})


if __name__ == "__main__":
    # デバッグ時のリローダーで二重起動しないよう、実行プロセス側でのみ開く
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        Timer(1.0, lambda: webbrowser.open("http://127.0.0.1:5000/")).start()

    app.run(debug=True)
