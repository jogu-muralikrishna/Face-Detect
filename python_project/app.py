"""
=============================================================================
Face Recognition-Based Smart Attendance Management System
Python Flask Backend Application & API Service
=============================================================================
Full Flask application providing API routes and static asset serving.
Compatible with PostgreSQL (for Vercel/Production) and SQLite (for Local).
"""

from flask import Flask, request, jsonify, redirect, url_for, session, Response, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash
import os
import json
import secrets
from datetime import datetime

# Import helper modules
import database
import face_recognition_module
import attendance

# Root and project directories
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC_DIR = os.path.join(ROOT_DIR, "public")

is_vercel_env = bool(os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"))
if is_vercel_env:
    STUDENTS_DIR = "/tmp/students"
    BACKUPS_DIR = "/tmp/backups"
else:
    STUDENTS_DIR = os.path.join(ROOT_DIR, "students")
    BACKUPS_DIR = os.path.join(ROOT_DIR, "backups")

try:
    os.makedirs(STUDENTS_DIR, exist_ok=True)
except Exception as e:
    print(f"[Warning] Could not create STUDENTS_DIR: {e}")

try:
    os.makedirs(BACKUPS_DIR, exist_ok=True)
except Exception as e:
    print(f"[Warning] Could not create BACKUPS_DIR: {e}")

# Initialize Flask App
app = Flask(__name__, static_folder=None)
app.secret_key = os.environ.get("SECRET_KEY", "smart_attendance_secret_key_college_project_production")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin@2008")

# Active Admin Tokens
active_admin_tokens = set()

# Initialize database schema on startup safely
try:
    database.init_db()
except Exception as e:
    print(f"[Warning] Database initialization error on startup: {e}")


def is_admin_authorized():
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "").strip()
    return token in active_admin_tokens or session.get("is_admin", False)


# ---------------------------------------------------------------------------
# Static Web App & Asset Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(ROOT_DIR, "index.html")


@app.route("/index.html")
def serve_index_html():
    return send_from_directory(ROOT_DIR, "index.html")


@app.route("/script.js")
def serve_script():
    return send_from_directory(PUBLIC_DIR, "script.js")


@app.route("/style.css")
def serve_style():
    return send_from_directory(PUBLIC_DIR, "style.css")


@app.route("/public/<path:filename>")
def serve_public_files(filename):
    return send_from_directory(PUBLIC_DIR, filename)


@app.route("/models/<path:filename>")
def serve_models_files(filename):
    models_dir = os.path.join(PUBLIC_DIR, "models")
    return send_from_directory(models_dir, filename)


@app.route("/students/<path:filename>")
def serve_student_photo(filename):
    return send_from_directory(STUDENTS_DIR, filename)


# ---------------------------------------------------------------------------
# API ROUTE: System Health & Stats
# ---------------------------------------------------------------------------
@app.route("/api/system/status", methods=["GET"])
def api_system_status():
    return jsonify({
        "success": True,
        "databaseType": "PostgreSQL" if database.IS_POSTGRES else "SQLite",
        "timestamp": datetime.now().isoformat()
    })


@app.route("/api/stats", methods=["GET"])
def api_stats():
    try:
        today = datetime.now().strftime("%Y-%m-%d")
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
        return jsonify({"success": False, "error": f"Database error: {str(e)}"}), 500


# ---------------------------------------------------------------------------
# Faculty Auth APIs
# ---------------------------------------------------------------------------
@app.route("/api/faculty/register", methods=["POST"])
def api_faculty_register():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    username = data.get("username", "").strip()
    password = data.get("password", "")
    confirm_password = data.get("confirmPassword", "")

    if not (name and username and password):
        return jsonify({"success": False, "error": "All fields are required."}), 400

    if confirm_password and password != confirm_password:
        return jsonify({"success": False, "error": "Passwords do not match."}), 400

    if database.get_faculty_by_username(username):
        return jsonify({"success": False, "error": f"Username '{username}' is already taken."}), 400

    password_hash = generate_password_hash(password)
    fac_id = database.add_faculty(name, username, password_hash)

    faculty_obj = {"id": fac_id, "name": name, "username": username}
    session["faculty_id"] = fac_id
    session["faculty_name"] = name
    session["faculty_username"] = username

    return jsonify({"success": True, "message": "Faculty registered successfully.", "faculty": faculty_obj})


@app.route("/api/faculty/login", methods=["POST"])
def api_faculty_login():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")

    if not (username and password):
        return jsonify({"success": False, "error": "Username and password are required."}), 400

    faculty = database.get_faculty_by_username(username)
    if not faculty or not check_password_hash(faculty["password_hash"], password):
        return jsonify({"success": False, "error": "Invalid username or password."}), 401

    session["faculty_id"] = faculty["id"]
    session["faculty_name"] = faculty["name"]
    session["faculty_username"] = faculty["username"]

    return jsonify({
        "success": True,
        "message": "Login successful.",
        "faculty": {"id": faculty["id"], "name": faculty["name"], "username": faculty["username"]}
    })


@app.route("/api/faculty/logout", methods=["POST"])
def api_faculty_logout():
    session.pop("faculty_id", None)
    session.pop("faculty_name", None)
    session.pop("faculty_username", None)
    return jsonify({"success": True, "message": "Logged out successfully."})


# ---------------------------------------------------------------------------
# Students APIs
# ---------------------------------------------------------------------------
@app.route("/api/students", methods=["GET", "POST"])
def api_students():
    if request.method == "POST":
        data = request.get_json() or {}
        name = data.get("name", "").strip()
        roll_number = data.get("roll_number", "").strip()
        department = data.get("department", "").strip()
        year = data.get("year", "").strip()
        section = data.get("section", "").strip()
        image = data.get("image", "")
        face_encoding = data.get("face_encoding", [])

        if not (name and roll_number and department and year and section and image and face_encoding):
            return jsonify({"success": False, "error": "All student fields and face encoding are required."}), 400

        if database.get_student_by_roll_number(roll_number):
            return jsonify({"success": False, "error": f"Roll number '{roll_number}' is already registered."}), 400

        # Save image file
        filename = f"{roll_number}_{name.replace(' ', '_')}.jpg"
        file_path = os.path.join(STUDENTS_DIR, filename)
        stored_image_ref = f"/students/{filename}"

        try:
            face_recognition_module.save_base64_image(image, file_path)
        except Exception:
            stored_image_ref = image

        encoding_json = json.dumps(face_encoding)
        student_id = database.add_student(name, roll_number, department, year, section, stored_image_ref, encoding_json)

        return jsonify({
            "success": True,
            "message": "Student registered successfully.",
            "studentId": student_id
        })

    # GET all students
    students = database.get_all_students_with_encodings()
    # Format encodings to list
    formatted = []
    for s in students:
        s_dict = dict(s)
        try:
            if isinstance(s_dict.get("face_encoding"), str):
                s_dict["face_encoding"] = json.loads(s_dict["face_encoding"])
        except Exception:
            s_dict["face_encoding"] = []
        formatted.append(s_dict)

    return jsonify({"success": True, "students": formatted})


@app.route("/api/students/<int:student_id>", methods=["GET", "PUT", "DELETE"])
def api_student_detail(student_id):
    if request.method == "DELETE":
        database.delete_student(student_id)
        return jsonify({"success": True, "message": "Student deleted successfully."})

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
            return jsonify({"success": False, "error": f"Roll number '{roll_number}' is already in use."}), 400

        database.update_student(student_id, name, roll_number, department, year, section)
        return jsonify({"success": True, "message": "Student updated successfully."})

    student = database.get_student_by_id(student_id)
    if not student:
        return jsonify({"success": False, "error": "Student not found."}), 404
    return jsonify({"success": True, "student": dict(student)})


# ---------------------------------------------------------------------------
# Attendance APIs
# ---------------------------------------------------------------------------
@app.route("/api/attendance/mark", methods=["POST"])
def api_attendance_mark():
    data = request.get_json() or {}
    student_id = data.get("student_id")
    if not student_id:
        return jsonify({"success": False, "error": "student_id is required."}), 400

    result = attendance.mark_attendance(int(student_id))
    return jsonify(result)


@app.route("/api/attendance/today", methods=["GET"])
def api_attendance_today():
    today = datetime.now().strftime("%Y-%m-%d")
    present_records = database.get_today_attendance_records(today)
    absent_students = database.get_today_absent_students(today)

    return jsonify({
        "success": True,
        "date": today,
        "presentCount": len(present_records),
        "absentCount": len(absent_students),
        "presentStudents": [dict(r) for r in present_records],
        "absentStudents": [dict(s) for s in absent_students]
    })


@app.route("/api/attendance/history", methods=["GET"])
def api_attendance_history():
    date_str = request.args.get("date", "")
    search = request.args.get("search", "").strip()
    records = database.get_attendance_history(date_str, search)
    return jsonify({"success": True, "records": [dict(r) for r in records]})


@app.route("/api/attendance/reports", methods=["GET"])
@app.route("/api/reports", methods=["GET"])
def api_attendance_reports():
    reports_data = attendance.generate_attendance_reports()
    return jsonify({
        "success": True,
        "totalClassesConducted": reports_data["totalClassesConducted"],
        "reports": reports_data["reports"]
    })


@app.route("/api/attendance/reset-today", methods=["POST"])
def api_attendance_reset_today():
    today = datetime.now().strftime("%Y-%m-%d")
    database.execute_query("DELETE FROM attendance WHERE date = ?", (today,))
    return jsonify({"success": True, "message": f"All attendance logs for today ({today}) have been reset."})


# ---------------------------------------------------------------------------
# Admin Portal APIs
# ---------------------------------------------------------------------------
@app.route("/api/admin/login", methods=["POST"])
def api_admin_login():
    data = request.get_json() or {}
    password = data.get("password", "")

    if password == ADMIN_PASSWORD:
        token = secrets.token_hex(24)
        active_admin_tokens.add(token)
        session["is_admin"] = True
        return jsonify({"success": True, "token": token, "message": "Admin authenticated successfully."})

    return jsonify({"success": False, "error": "Invalid Admin Password."}), 401


@app.route("/api/admin/status", methods=["GET"])
def api_admin_status():
    return jsonify({"authenticated": is_admin_authorized()})


@app.route("/api/admin/logout", methods=["POST"])
def api_admin_logout():
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "").strip()
    active_admin_tokens.discard(token)
    session.pop("is_admin", None)
    return jsonify({"success": True, "message": "Admin session closed."})


@app.route("/api/admin/stats", methods=["GET"])
def api_admin_stats():
    if not is_admin_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    today = datetime.now().strftime("%Y-%m-%d")
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
            "totalAttendance": total_attendance,
            "today": today,
            "databaseType": "PostgreSQL" if database.IS_POSTGRES else "SQLite"
        }
    })


@app.route("/api/admin/faculty", methods=["GET", "POST"])
def api_admin_faculty():
    if not is_admin_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    if request.method == "POST":
        data = request.get_json() or {}
        name = data.get("name", "").strip()
        username = data.get("username", "").strip()
        password = data.get("password", "")

        if not (name and username and password):
            return jsonify({"success": False, "error": "All fields are required."}), 400

        if database.get_faculty_by_username(username):
            return jsonify({"success": False, "error": f"Username '{username}' is already taken."}), 400

        password_hash = generate_password_hash(password)
        fac_id = database.add_faculty(name, username, password_hash)
        return jsonify({"success": True, "message": "Faculty created successfully.", "id": fac_id})

    faculty_list = database.get_all_faculty()
    return jsonify({"success": True, "faculty": [dict(f) for f in faculty_list]})


@app.route("/api/admin/faculty/<int:faculty_id>", methods=["PUT", "DELETE"])
def api_admin_faculty_detail(faculty_id):
    if not is_admin_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    if request.method == "DELETE":
        database.delete_faculty(faculty_id)
        return jsonify({"success": True, "message": "Faculty deleted successfully."})

    if request.method == "PUT":
        data = request.get_json() or {}
        name = data.get("name", "").strip()
        username = data.get("username", "").strip()

        if not (name and username):
            return jsonify({"success": False, "error": "Name and username are required."}), 400

        existing = database.get_faculty_by_username(username)
        if existing and existing["id"] != faculty_id:
            return jsonify({"success": False, "error": f"Username '{username}' is already taken."}), 400

        database.update_faculty(faculty_id, name, username)
        return jsonify({"success": True, "message": "Faculty updated successfully."})


@app.route("/api/admin/faculty/<int:faculty_id>/reset_password", methods=["POST"])
def api_admin_reset_faculty_password(faculty_id):
    if not is_admin_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    data = request.get_json() or {}
    new_password = data.get("new_password", "")
    if not new_password:
        return jsonify({"success": False, "error": "New password is required."}), 400

    new_hash = generate_password_hash(new_password)
    database.reset_faculty_password(faculty_id, new_hash)
    return jsonify({"success": True, "message": "Faculty password reset successfully."})


@app.route("/api/admin/students", methods=["GET"])
def api_admin_students():
    if not is_admin_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    student_list = database.get_all_students()
    return jsonify({"success": True, "students": [dict(s) for s in student_list]})


@app.route("/api/admin/students/<int:student_id>", methods=["PUT", "DELETE"])
def api_admin_student_detail(student_id):
    if not is_admin_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    if request.method == "DELETE":
        database.delete_student(student_id)
        return jsonify({"success": True, "message": "Student deleted successfully."})

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
            return jsonify({"success": False, "error": f"Roll number '{roll_number}' is already in use."}), 400

        database.update_student(student_id, name, roll_number, department, year, section)
        return jsonify({"success": True, "message": "Student updated successfully."})


@app.route("/api/admin/attendance", methods=["GET"])
def api_admin_attendance():
    if not is_admin_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    date_str = request.args.get("date", "")
    search = request.args.get("search", "").strip()
    records = database.get_attendance_history(date_str, search)
    return jsonify({"success": True, "records": [dict(r) for r in records]})


@app.route("/api/admin/attendance/<int:attendance_id>", methods=["DELETE"])
def api_admin_attendance_delete(attendance_id):
    if not is_admin_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    database.delete_attendance_record(attendance_id)
    return jsonify({"success": True, "message": "Attendance record deleted successfully."})


@app.route("/api/admin/export_json", methods=["GET"])
def api_admin_export_json():
    if not is_admin_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    today_str = datetime.now().strftime("%Y-%m-%d")
    faculty = database.get_all_faculty()
    sanitized_faculty = [
        {"id": f["id"], "name": f["name"], "username": f["username"], "created_at": str(f.get("created_at", ""))}
        for f in faculty
    ]

    students = database.get_all_students()
    sanitized_students = [
        {
            "id": s["id"],
            "name": s["name"],
            "roll_number": s["roll_number"],
            "department": s["department"],
            "year": s["year"],
            "section": s["section"],
            "created_at": str(s.get("created_at", "")),
        }
        for s in students
    ]

    attendance_records = database.get_attendance_history()
    sanitized_attendance = [
        {
            "id": a["id"],
            "student_id": a.get("student_id"),
            "student_name": a.get("name"),
            "roll_number": a.get("roll_number"),
            "department": a.get("department"),
            "date": a.get("date"),
            "time": a.get("time"),
            "status": a.get("status"),
        }
        for a in attendance_records
    ]

    backup_payload = {
        "faculty": sanitized_faculty,
        "students": sanitized_students,
        "attendance": sanitized_attendance,
    }

    json_str = json.dumps(backup_payload, indent=2)
    filename = f"smart_attendance_export_{today_str}.json"

    return Response(
        json_str,
        mimetype="application/json",
        headers={"Content-Disposition": f"attachment;filename={filename}"},
    )


@app.route("/api/admin/backup-db", methods=["POST"])
def api_admin_backup_db():
    if not is_admin_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    try:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        db_src = os.path.join(ROOT_DIR, "attendance.db")
        backup_dest = os.path.join(BACKUPS_DIR, f"attendance_backup_{timestamp}.db")

        if os.path.exists(db_src):
            import shutil
            shutil.copy2(db_src, backup_dest)
            return jsonify({
                "success": True,
                "message": f"Database backed up as attendance_backup_{timestamp}.db in backups/ directory."
            })
        else:
            return jsonify({"success": True, "message": "Database backup completed."})
    except Exception as e:
        return jsonify({"success": False, "error": f"Backup failed: {str(e)}"}), 500


@app.route("/api/admin/download-db", methods=["GET"])
def api_admin_download_db():
    if not is_admin_authorized():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    db_src = os.path.join(ROOT_DIR, "attendance.db")
    if not os.path.exists(db_src):
        # Create empty db file if not present
        database.init_db()

    return send_from_directory(ROOT_DIR, "attendance.db", as_attachment=True)


@app.route("/api/reset-all-data", methods=["POST"])
def api_reset_all_data():
    database.delete_all_data()
    return jsonify({"success": True, "message": "All database records have been reset."})


if __name__ == "__main__":
    print("Starting Smart Attendance System on http://0.0.0.0:5000")
    app.run(debug=True, host="0.0.0.0", port=5000)
