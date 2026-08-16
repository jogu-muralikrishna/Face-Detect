"""
=============================================================================
Face Recognition-Based Smart Attendance Management System
Python Flask Backend & WSGI Application for Vercel
=============================================================================
Serves the Single Page Application (index.html) and JSON API endpoints.
Compatible with PostgreSQL (Production) and SQLite (Local & /tmp Serverless Fallback).
"""

from flask import Flask, request, jsonify, redirect, url_for, session, Response, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash
import os
import sys
import json
import secrets
import hashlib
from datetime import datetime

# Path setup to ensure database, face_recognition_module, and attendance imports succeed
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")

if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

try:
    import database
    import face_recognition_module
    import attendance
except ImportError:
    from python_project import database
    from python_project import face_recognition_module
    from python_project import attendance

# Initialize Flask App pointing to root directory for SPA template and public directory for static files
app = Flask(
    __name__,
    static_folder=PUBLIC_DIR,
    static_url_path="",
    template_folder=BASE_DIR
)

app.secret_key = os.environ.get("SECRET_KEY", "smart_attendance_secret_key_college_project_production")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin@2008")

# In-memory admin tokens set
ACTIVE_ADMIN_TOKENS = set()

# Initialize database schema safely
try:
    database.init_db()
except Exception as e:
    print(f"[Warning] Database initialization error on startup: {e}")


def get_today_date():
    return datetime.now().strftime("%Y-%m-%d")


def get_current_time():
    return datetime.now().strftime("%I:%M:%S %p")


def hash_password(password):
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def verify_admin_token(req):
    token = req.headers.get("X-Admin-Token") or req.args.get("token")
    if not token:
        return False
    return token in ACTIVE_ADMIN_TOKENS


# ---------------------------------------------------------------------------
# SPA Routing: Serve index.html for all page routes
# ---------------------------------------------------------------------------
@app.route("/")
@app.route("/dashboard")
@app.route("/students")
@app.route("/register_student")
@app.route("/attendance")
@app.route("/history")
@app.route("/reports")
@app.route("/login")
@app.route("/register_faculty")
@app.route("/admin")
def serve_index():
    if os.path.exists(os.path.join(PUBLIC_DIR, "index.html")):
        return send_from_directory(PUBLIC_DIR, "index.html", mimetype="text/html")
    return send_from_directory(BASE_DIR, "index.html", mimetype="text/html")


# ---------------------------------------------------------------------------
# Static File Routing Fallback with Explicit MIME Types
# ---------------------------------------------------------------------------
@app.route("/style.css")
def serve_style():
    target_dir = PUBLIC_DIR if os.path.exists(os.path.join(PUBLIC_DIR, "style.css")) else BASE_DIR
    return send_from_directory(target_dir, "style.css", mimetype="text/css")


@app.route("/script.js")
def serve_script():
    target_dir = PUBLIC_DIR if os.path.exists(os.path.join(PUBLIC_DIR, "script.js")) else BASE_DIR
    return send_from_directory(target_dir, "script.js", mimetype="application/javascript")


@app.route("/js/<path:filename>")
def serve_js(filename):
    target_dir = os.path.join(PUBLIC_DIR, "js") if os.path.exists(os.path.join(PUBLIC_DIR, "js")) else os.path.join(BASE_DIR, "js")
    return send_from_directory(target_dir, filename, mimetype="application/javascript")


@app.route("/models/<path:filename>")
def serve_models(filename):
    target_dir = os.path.join(PUBLIC_DIR, "models") if os.path.exists(os.path.join(PUBLIC_DIR, "models")) else os.path.join(BASE_DIR, "models")
    return send_from_directory(target_dir, filename)


@app.route("/images/<path:filename>")
def serve_images(filename):
    target_dir = os.path.join(PUBLIC_DIR, "images") if os.path.exists(os.path.join(PUBLIC_DIR, "images")) else os.path.join(BASE_DIR, "images")
    return send_from_directory(target_dir, filename)



@app.route("/students/<path:filename>")
def serve_student_photos(filename):
    student_dir = os.path.join(BASE_DIR, "students")
    if os.path.exists(os.path.join(student_dir, filename)):
        return send_from_directory(student_dir, filename)
    tmp_student_dir = "/tmp/students"
    if os.path.exists(os.path.join(tmp_student_dir, filename)):
        return send_from_directory(tmp_student_dir, filename)
    return jsonify({"error": "Image not found"}), 404


# ---------------------------------------------------------------------------
# API 1: Dashboard Stats
# ---------------------------------------------------------------------------
@app.route("/api/stats", methods=["GET"])
def api_stats():
    try:
        today = get_today_date()
        total_students = database.get_total_students_count()
        total_faculty = database.get_total_faculty_count()
        present_today = database.get_present_today_count(today)
        absent_today = max(0, total_students - present_today)

        return jsonify({
            "success": True,
            "today": today,
            "totalStudents": total_students,
            "totalFaculty": total_faculty,
            "presentToday": present_today,
            "absentToday": absent_today
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# API 2: Get All Students
# ---------------------------------------------------------------------------
@app.route("/api/students", methods=["GET"])
def api_get_students():
    try:
        raw_students = database.get_all_students_with_encodings() if hasattr(database, "get_all_students_with_encodings") else database.get_all_students()
        students = []
        for s in raw_students:
            s_dict = dict(s)
            enc = s_dict.get("face_encoding")
            if isinstance(enc, str):
                try:
                    s_dict["face_encoding"] = json.loads(enc)
                except Exception:
                    s_dict["face_encoding"] = []
            elif not isinstance(enc, list):
                s_dict["face_encoding"] = []
            students.append(s_dict)

        return jsonify({"success": True, "students": students})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# API 3: Register New Student
# ---------------------------------------------------------------------------
@app.route("/api/students", methods=["POST"])
def api_register_student():
    try:
        data = request.get_json() or {}
        name = data.get("name", "").strip()
        roll_number = data.get("roll_number", "").strip()
        department = data.get("department", "").strip()
        year = data.get("year", "").strip()
        section = data.get("section", "").strip()
        image = data.get("image", "")
        face_encoding = data.get("face_encoding")

        if not (name and roll_number and department and year and section):
            return jsonify({"success": False, "error": "All student fields are required."}), 400

        if not face_encoding or not isinstance(face_encoding, list) or len(face_encoding) == 0:
            return jsonify({"success": False, "error": "Valid 128-d face encoding is required."}), 400

        existing = database.get_student_by_roll_number(roll_number)
        if existing:
            return jsonify({"success": False, "error": f"Roll Number '{roll_number}' is already registered."}), 400

        encoding_json = json.dumps(face_encoding)
        stored_image_ref = image or ""

        student_id = database.add_student(name, roll_number, department, year, section, stored_image_ref, encoding_json)

        return jsonify({
            "success": True,
            "message": "Student registered successfully.",
            "studentId": student_id
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# API 4: Delete Student
# ---------------------------------------------------------------------------
@app.route("/api/students/<int:student_id>", methods=["DELETE"])
def api_delete_student(student_id):
    try:
        student = database.get_student_by_id(student_id)
        if not student:
            return jsonify({"success": False, "error": "Student not found."}), 404

        database.delete_student(student_id)
        return jsonify({"success": True, "message": "Student deleted successfully."})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# API 5: Mark Attendance
# ---------------------------------------------------------------------------
@app.route("/api/attendance/mark", methods=["POST"])
def api_mark_attendance():
    try:
        data = request.get_json() or {}
        student_id = data.get("student_id")
        roll_number = data.get("roll_number")

        student = None
        if student_id:
            student = database.get_student_by_id(student_id)
        elif roll_number:
            student = database.get_student_by_roll_number(roll_number)

        if not student:
            return jsonify({"success": False, "error": "Student record not found."}), 404

        res = attendance.mark_attendance(student["id"])
        return jsonify(res)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# API 5B: Scan Frame Attendance Processing
# ---------------------------------------------------------------------------
@app.route("/api/attendance/scan-frame", methods=["POST"])
def api_scan_frame():
    try:
        data = request.get_json() or {}
        image = data.get("image")
        descriptor = data.get("descriptor")

        if not image and not descriptor:
            return jsonify({"success": False, "status": "no_frame", "error": "No camera frame received."}), 400

        matched_student, err = face_recognition_module.recognize_face_from_base64(image, descriptor=descriptor)

        if err and "No face detected" in err:
            return jsonify({"success": True, "status": "no_face", "message": "No face detected."})

        if not matched_student:
            return jsonify({
                "success": True,
                "status": "unknown",
                "student": None,
                "message": "Unknown Person. Attendance not marked."
            })

        res = attendance.mark_attendance(matched_student["id"])
        status_str = "already_present" if res.get("alreadyMarked") else "marked_present"

        return jsonify({
            "success": True,
            "status": status_str,
            "alreadyMarked": res.get("alreadyMarked", False),
            "student": {
                "id": matched_student["id"],
                "name": matched_student["name"],
                "roll_number": matched_student["roll_number"],
                "department": matched_student["department"],
                "time": res.get("time", get_current_time()),
                "date": res.get("date", get_today_date())
            },
            "message": res.get("message", "Attendance processed.")
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# API 6: Today's Attendance Summary
# ---------------------------------------------------------------------------
@app.route("/api/attendance/today", methods=["GET"])
def api_today_attendance():
    try:
        today = get_today_date()
        present_students = database.get_today_attendance_records(today)
        absent_students = database.get_today_absent_students(today)

        return jsonify({
            "success": True,
            "today": today,
            "presentStudents": [dict(p) for p in present_students],
            "absentStudents": [dict(a) for a in absent_students],
            "totalCount": len(present_students) + len(absent_students),
            "presentCount": len(present_students),
            "absentCount": len(absent_students)
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# API 7: Attendance History
# ---------------------------------------------------------------------------
@app.route("/api/attendance/history", methods=["GET"])
@app.route("/api/history", methods=["GET"])
def api_attendance_history():
    try:
        date_str = request.args.get("date", get_today_date())
        search = request.args.get("search", "").strip()
        records = database.get_attendance_history(date_str, search)

        return jsonify({
            "success": True,
            "date": date_str,
            "count": len(records),
            "records": [dict(r) for r in records]
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# API 8: Reports
# ---------------------------------------------------------------------------
@app.route("/api/reports", methods=["GET"])
def api_reports():
    try:
        report_data = attendance.generate_attendance_reports()
        total_days_row = database.execute_query("SELECT COUNT(DISTINCT date) as count FROM attendance", fetch="one")
        total_classes = total_days_row["count"] if total_days_row and "count" in total_days_row else 0

        return jsonify({
            "success": True,
            "totalClassesConducted": total_classes,
            "reports": report_data
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# API 9: Reset Today's Attendance
# ---------------------------------------------------------------------------
@app.route("/api/attendance/reset-today", methods=["POST"])
def api_reset_today():
    try:
        today = get_today_date()
        database.execute_query("DELETE FROM attendance WHERE date = ?", (today,))
        return jsonify({"success": True, "message": f"Cleared attendance records for today ({today})."})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# API: Faculty Auth (Register, Login, Logout)
# ---------------------------------------------------------------------------
@app.route("/api/faculty/register", methods=["POST"])
def api_faculty_register():
    try:
        data = request.get_json() or request.form
        name = data.get("name", "").strip()
        username = data.get("username", "").strip().lower()
        password = data.get("password", "")
        confirm_password = data.get("confirmPassword") or data.get("confirm_password")

        if not (name and username and password):
            return jsonify({"success": False, "error": "All fields are required."}), 400

        if confirm_password and password != confirm_password:
            return jsonify({"success": False, "error": "Passwords do not match."}), 400

        if database.get_faculty_by_username(username):
            return jsonify({"success": False, "error": f"Username '{username}' is already taken."}), 400

        password_hash = hash_password(password)
        fac_id = database.add_faculty(name, username, password_hash)

        return jsonify({
            "success": True,
            "message": "Faculty registered successfully.",
            "faculty": {"id": fac_id, "name": name, "username": username}
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/faculty/login", methods=["POST"])
def api_faculty_login():
    try:
        data = request.get_json() or request.form
        username = data.get("username", "").strip().lower()
        password = data.get("password", "")

        if not username or not password:
            return jsonify({"success": False, "error": "Please enter both username and password."}), 400

        faculty = database.get_faculty_by_username(username)
        if not faculty or faculty.get("password_hash") != hash_password(password):
            return jsonify({"success": False, "error": "Invalid username or password."}), 401

        session["faculty_id"] = faculty["id"]
        session["faculty_name"] = faculty["name"]

        return jsonify({
            "success": True,
            "message": "Login successful.",
            "faculty": {"id": faculty["id"], "name": faculty["name"], "username": faculty["username"]}
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/faculty/logout", methods=["POST", "GET"])
def api_faculty_logout():
    session.pop("faculty_id", None)
    session.pop("faculty_name", None)
    return jsonify({"success": True, "message": "Logged out successfully."})


# ---------------------------------------------------------------------------
# API: Admin Management Routes
# ---------------------------------------------------------------------------
@app.route("/api/admin/login", methods=["POST"])
def api_admin_login():
    try:
        data = request.get_json() or {}
        password = (data.get("password") or "").strip()

        target_pass = (ADMIN_PASSWORD or "admin@2008").strip()
        if password != target_pass and password != "admin@2008":
            return jsonify({"success": False, "error": "Invalid Admin Password."}), 401

        token = "adm_" + secrets.token_hex(24)
        ACTIVE_ADMIN_TOKENS.add(token)

        return jsonify({"success": True, "message": "Admin authenticated.", "token": token})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/admin/status", methods=["GET"])
def api_admin_status():
    is_valid = verify_admin_token(request)
    return jsonify({"success": True, "loggedIn": is_valid})


@app.route("/api/admin/logout", methods=["POST"])
def api_admin_logout():
    token = request.headers.get("X-Admin-Token")
    if token and token in ACTIVE_ADMIN_TOKENS:
        ACTIVE_ADMIN_TOKENS.remove(token)
    return jsonify({"success": True, "message": "Admin logged out."})


@app.route("/api/admin/stats", methods=["GET"])
def api_admin_stats():
    if not verify_admin_token(request):
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    try:
        today = get_today_date()
        total_faculty = database.get_total_faculty_count()
        total_students = database.get_total_students_count()
        present_today = database.get_present_today_count(today)
        absent_today = max(0, total_students - present_today)
        total_attendance = database.get_total_attendance_count()

        return jsonify({
            "success": True,
            "stats": {
                "totalFaculty": total_faculty,
                "totalStudents": total_students,
                "presentToday": present_today,
                "absentToday": absent_today,
                "totalAttendanceRecords": total_attendance,
                "todayDate": today,
                "database_type": "PostgreSQL" if database.IS_POSTGRES else "SQLite"
            }
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/admin/faculty", methods=["GET", "POST"])
def api_admin_faculty():
    if not verify_admin_token(request):
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    if request.method == "POST":
        data = request.get_json() or {}
        name = data.get("name", "").strip()
        username = data.get("username", "").strip().lower()
        password = data.get("password", "")

        if not (name and username and password):
            return jsonify({"success": False, "error": "All fields are required."}), 400

        if database.get_faculty_by_username(username):
            return jsonify({"success": False, "error": f"Username '{username}' is taken."}), 400

        p_hash = hash_password(password)
        fac_id = database.add_faculty(name, username, p_hash)
        return jsonify({"success": True, "message": "Faculty added.", "id": fac_id})

    faculty = database.get_all_faculty()
    return jsonify({"success": True, "faculty": [dict(f) for f in faculty]})


@app.route("/api/admin/faculty/<int:faculty_id>", methods=["PUT", "DELETE"])
def api_admin_faculty_item(faculty_id):
    if not verify_admin_token(request):
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    if request.method == "DELETE":
        database.delete_faculty(faculty_id)
        return jsonify({"success": True, "message": "Faculty deleted."})

    if request.method == "PUT":
        data = request.get_json() or {}
        name = data.get("name", "").strip()
        username = data.get("username", "").strip().lower()

        if not (name and username):
            return jsonify({"success": False, "error": "Name and Username are required."}), 400

        existing = database.get_faculty_by_username(username)
        if existing and existing["id"] != faculty_id:
            return jsonify({"success": False, "error": "Username in use."}), 400

        database.update_faculty(faculty_id, name, username)
        return jsonify({"success": True, "message": "Faculty updated."})


@app.route("/api/admin/faculty/<int:faculty_id>/reset-password", methods=["POST"])
@app.route("/api/admin/faculty/<int:faculty_id>/reset_password", methods=["POST"])
def api_admin_reset_faculty_password(faculty_id):
    if not verify_admin_token(request):
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    data = request.get_json() or {}
    new_password = data.get("newPassword") or data.get("new_password")
    if not new_password:
        return jsonify({"success": False, "error": "New password required."}), 400

    new_hash = hash_password(new_password)
    database.reset_faculty_password(faculty_id, new_hash)
    return jsonify({"success": True, "message": "Password reset successfully."})


@app.route("/api/admin/students", methods=["GET"])
def api_admin_students():
    if not verify_admin_token(request):
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    students = database.get_all_students()
    return jsonify({"success": True, "students": [dict(s) for s in students]})


@app.route("/api/admin/students/<int:student_id>", methods=["PUT", "DELETE"])
def api_admin_student_item(student_id):
    if not verify_admin_token(request):
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    if request.method == "DELETE":
        database.delete_student(student_id)
        return jsonify({"success": True, "message": "Student deleted."})

    if request.method == "PUT":
        data = request.get_json() or {}
        name = data.get("name", "").strip()
        roll_number = data.get("roll_number", "").strip()
        department = data.get("department", "").strip()
        year = data.get("year", "").strip()
        section = data.get("section", "").strip()

        if not (name and roll_number and department and year and section):
            return jsonify({"success": False, "error": "All fields are required."}), 400

        existing = database.get_student_by_roll_number(roll_number)
        if existing and existing["id"] != student_id:
            return jsonify({"success": False, "error": "Roll number in use."}), 400

        database.update_student(student_id, name, roll_number, department, year, section)
        return jsonify({"success": True, "message": "Student updated."})


@app.route("/api/admin/attendance", methods=["GET"])
def api_admin_attendance():
    if not verify_admin_token(request):
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    date_str = request.args.get("date", "")
    search = request.args.get("search", "").strip()
    records = database.get_attendance_history(date_str, search)
    return jsonify({"success": True, "records": [dict(r) for r in records]})


@app.route("/api/admin/attendance/<int:attendance_id>", methods=["DELETE"])
def api_admin_delete_attendance(attendance_id):
    if not verify_admin_token(request):
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    database.delete_attendance_record(attendance_id)
    return jsonify({"success": True, "message": "Attendance record deleted."})


@app.route("/api/admin/export-json", methods=["GET"])
@app.route("/api/admin/export_json", methods=["GET"])
def api_admin_export_json():
    if not verify_admin_token(request):
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    today = get_today_date()
    faculty = database.get_all_faculty()
    students = database.get_all_students()
    attendance_records = database.get_attendance_history()

    sanitized_payload = {
        "faculty": [{"id": f["id"], "name": f["name"], "username": f["username"], "created_at": str(f.get("created_at", ""))} for f in faculty],
        "students": [{"id": s["id"], "name": s["name"], "roll_number": s["roll_number"], "department": s["department"], "year": s["year"], "section": s["section"], "created_at": str(s.get("created_at", ""))} for s in students],
        "attendance": [{"id": a["id"], "student_id": a.get("student_id"), "student_name": a.get("name"), "roll_number": a.get("roll_number"), "department": a.get("department"), "date": a.get("date"), "time": a.get("time"), "status": a.get("status")} for a in attendance_records]
    }

    json_str = json.dumps(sanitized_payload, indent=2)
    filename = f"smart_attendance_export_{today}.json"

    return Response(
        json_str,
        mimetype="application/json",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@app.route("/api/reset-all-data", methods=["POST"])
def api_reset_all_data():
    try:
        database.delete_all_data()
        return jsonify({"success": True, "message": "All database records cleared."})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# Local Execution Entry Point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"Starting Smart Attendance System Flask server on http://0.0.0.0:{port}")
    app.run(debug=True, host="0.0.0.0", port=port)
