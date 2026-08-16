"""
=============================================================================
Face Recognition-Based Smart Attendance Management System
Python Flask Backend Application
=============================================================================
This is the main Flask entry point for the Smart Attendance System.
Compatible with PostgreSQL (for Vercel/Production) and SQLite (for Local).
"""

from flask import Flask, render_template, request, jsonify, redirect, url_for, session, Response
from werkzeug.security import generate_password_hash, check_password_hash
import os
import json
from datetime import datetime

# Import helper modules
import database
import face_recognition_module
import attendance

# Initialize Flask App
app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "smart_attendance_secret_key_college_project_production")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin@2008")

# Ensure uploads directory exists
UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), "students")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER

# Initialize database schema on startup
database.init_db()


def is_logged_in():
    """Helper to check if faculty is logged in."""
    return "faculty_id" in session


def is_admin_logged_in():
    """Helper to check if admin is logged in."""
    return session.get("is_admin", False)


# ---------------------------------------------------------------------------
# Route: Faculty Login
# ---------------------------------------------------------------------------
@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        if not username or not password:
            return render_template("login.html", error="Please enter both username and password.")

        faculty = database.get_faculty_by_username(username)
        if not faculty or not check_password_hash(faculty["password_hash"], password):
            return render_template("login.html", error="Invalid username or password.")

        # Set session
        session["faculty_id"] = faculty["id"]
        session["faculty_name"] = faculty["name"]
        session["faculty_username"] = faculty["username"]

        return redirect(url_for("dashboard"))

    return render_template("login.html")


# ---------------------------------------------------------------------------
# Route: Faculty Registration
# ---------------------------------------------------------------------------
@app.route("/register_faculty", methods=["GET", "POST"])
def register_faculty():
    if request.method == "POST":
        name = request.form.get("name", "").strip()
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        confirm_password = request.form.get("confirm_password", "")

        if not (name and username and password):
            return render_template("register_faculty.html", error="All fields are required.")

        if confirm_password and password != confirm_password:
            return render_template("register_faculty.html", error="Passwords do not match.")

        if database.get_faculty_by_username(username):
            return render_template("register_faculty.html", error=f"Username '{username}' is already taken.")

        password_hash = generate_password_hash(password)
        database.add_faculty(name, username, password_hash)

        return render_template("login.html", success="Faculty registered successfully. Please login.")

    return render_template("register_faculty.html")


# ---------------------------------------------------------------------------
# Route: Faculty Logout
# ---------------------------------------------------------------------------
@app.route("/logout")
def logout():
    session.pop("faculty_id", None)
    session.pop("faculty_name", None)
    session.pop("faculty_username", None)
    return redirect(url_for("login"))


# ---------------------------------------------------------------------------
# Route 1: Faculty Dashboard
# ---------------------------------------------------------------------------
@app.route("/")
@app.route("/dashboard")
def dashboard():
    if not is_logged_in():
        return redirect(url_for("login"))

    today = datetime.now().strftime("%Y-%m-%d")
    total_students = database.get_total_students_count()
    total_faculty = database.get_total_faculty_count()
    present_today_count = database.get_present_today_count(today)
    absent_today_count = max(0, total_students - present_today_count)

    today_records = database.get_today_attendance_records(today)
    absent_students = database.get_today_absent_students(today)

    return render_template(
        "dashboard.html",
        faculty_name=session.get("faculty_name", "Faculty"),
        total_students=total_students,
        total_faculty=total_faculty,
        present_today=present_today_count,
        absent_today=absent_today_count,
        today=today,
        records=today_records,
        absent_students=absent_students,
    )


# ---------------------------------------------------------------------------
# Route 2: View All Registered Students
# ---------------------------------------------------------------------------
@app.route("/students")
def students():
    if not is_logged_in():
        return redirect(url_for("login"))

    student_list = database.get_all_students()
    return render_template("students.html", students=student_list)


# ---------------------------------------------------------------------------
# Route 3: Delete Student
# ---------------------------------------------------------------------------
@app.route("/students/delete/<int:student_id>", methods=["POST"])
def delete_student_route(student_id):
    if not is_logged_in() and not is_admin_logged_in():
        return redirect(url_for("login"))

    database.delete_student(student_id)
    return redirect(url_for("students"))


# ---------------------------------------------------------------------------
# Route 4: CAMERA 1 - Student Registration Page
# ---------------------------------------------------------------------------
@app.route("/register_student", methods=["GET", "POST"])
def register_student():
    if not is_logged_in():
        return redirect(url_for("login"))

    if request.method == "POST":
        name = request.form.get("name", "").strip()
        roll_number = request.form.get("roll_number", "").strip()
        department = request.form.get("department", "").strip()
        year = request.form.get("year", "").strip()
        section = request.form.get("section", "").strip()
        image_data = request.form.get("image_data", "")

        # Validation
        if not (name and roll_number and department and year and section and image_data):
            return render_template("register_student.html", error="All fields and a captured face photo are required.")

        # Check if roll number already exists
        if database.get_student_by_roll_number(roll_number):
            return render_template("register_student.html", error=f"Roll Number '{roll_number}' is already registered.")

        # Extract Face Encoding & Validate Exactly One Face
        encoding, error_msg = face_recognition_module.extract_face_encoding_from_base64(image_data)
        if error_msg:
            return render_template("register_student.html", error=error_msg)

        # Store persistent reference (data URL or saved file)
        filename = f"{roll_number}_{name}.jpg"
        file_path = os.path.join(app.config["UPLOAD_FOLDER"], filename)
        try:
            face_recognition_module.save_base64_image(image_data, file_path)
            stored_image_ref = f"/students/{filename}"
        except Exception:
            stored_image_ref = image_data

        # Save to Database
        encoding_json = json.dumps(encoding.tolist())
        database.add_student(name, roll_number, department, year, section, stored_image_ref, encoding_json)

        return render_template("register_student.html", success="Student registered successfully.")

    return render_template("register_student.html")


# ---------------------------------------------------------------------------
# Route 5: CAMERA 2 - Take Attendance Page (Scanner Camera)
# ---------------------------------------------------------------------------
@app.route("/attendance")
def attendance_page():
    if not is_logged_in():
        return redirect(url_for("login"))

    return render_template("attendance.html")


# ---------------------------------------------------------------------------
# Route 6: API to Recognize and Mark Attendance from Face Camera Frame
# ---------------------------------------------------------------------------
@app.route("/api/recognize_and_mark", methods=["POST"])
def recognize_and_mark():
    data = request.get_json()
    if not data or "image" not in data:
        return jsonify({"success": False, "error": "No image frame received."})

    # Recognize face from registered students in database
    student, error_msg = face_recognition_module.recognize_face_from_base64(data["image"])
    if error_msg:
        return jsonify({"success": False, "error": error_msg})

    if not student:
        return jsonify({
            "success": False,
            "error": "Unknown Person. This person is not registered. Attendance NOT marked."
        })

    # Mark attendance with duplicate prevention
    result = attendance.mark_attendance(student["id"])
    return jsonify(result)


# ---------------------------------------------------------------------------
# Route 7: Attendance History Page
# ---------------------------------------------------------------------------
@app.route("/history")
def history():
    if not is_logged_in():
        return redirect(url_for("login"))

    selected_date = request.args.get("date", datetime.now().strftime("%Y-%m-%d"))
    search_query = request.args.get("search", "").strip()
    records = database.get_attendance_history(selected_date, search_query)
    return render_template("history.html", selected_date=selected_date, records=records, search_query=search_query)


# ---------------------------------------------------------------------------
# Route 8: Reports Page (Percentage calculation)
# ---------------------------------------------------------------------------
@app.route("/reports")
def reports():
    if not is_logged_in():
        return redirect(url_for("login"))

    report_data = attendance.generate_attendance_reports()
    return render_template("reports.html", reports=report_data)


# ---------------------------------------------------------------------------
# Admin Routes & Protected Management Portal
# ---------------------------------------------------------------------------
@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if request.method == "POST":
        password = request.form.get("password", "")
        if password == ADMIN_PASSWORD:
            session["is_admin"] = True
            return redirect(url_for("admin_dashboard"))
        else:
            return render_template("admin_login.html", error="Invalid Admin Password.")
    return render_template("admin_login.html")


@app.route("/admin/logout")
def admin_logout():
    session.pop("is_admin", None)
    return redirect(url_for("admin_login"))


@app.route("/admin")
@app.route("/admin/dashboard")
def admin_dashboard():
    if not is_admin_logged_in():
        return redirect(url_for("admin_login"))

    today_str = datetime.now().strftime("%Y-%m-%d")
    total_faculty = database.get_total_faculty_count()
    total_students = database.get_total_students_count()
    present_today = database.get_present_today_count(today_str)
    absent_today = max(0, total_students - present_today)
    total_attendance = database.get_total_attendance_count()

    return render_template(
        "admin_dashboard.html",
        total_faculty=total_faculty,
        total_students=total_students,
        present_today=present_today,
        absent_today=absent_today,
        total_attendance=total_attendance,
        today=today_str,
        database_type="PostgreSQL" if database.IS_POSTGRES else "SQLite",
    )


# ---------------------------------------------------------------------------
# Admin API: Faculty Management (List, Add, Edit, Reset Password, Delete)
# ---------------------------------------------------------------------------
@app.route("/api/admin/faculty", methods=["GET", "POST"])
def api_admin_faculty():
    if not is_admin_logged_in():
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
    return jsonify({"success": True, "faculty": faculty_list})


@app.route("/api/admin/faculty/<int:faculty_id>", methods=["PUT", "DELETE"])
def api_admin_faculty_item(faculty_id):
    if not is_admin_logged_in():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    if request.method == "DELETE":
        database.delete_faculty(faculty_id)
        return jsonify({"success": True, "message": "Faculty deleted successfully."})

    if request.method == "PUT":
        data = request.get_json() or {}
        name = data.get("name", "").strip()
        username = data.get("username", "").strip()
        if not (name and username):
            return jsonify({"success": False, "error": "Name and Username are required."}), 400

        existing = database.get_faculty_by_username(username)
        if existing and existing["id"] != faculty_id:
            return jsonify({"success": False, "error": f"Username '{username}' is already in use."}), 400

        database.update_faculty(faculty_id, name, username)
        return jsonify({"success": True, "message": "Faculty updated successfully."})


@app.route("/api/admin/faculty/<int:faculty_id>/reset_password", methods=["POST"])
def api_admin_reset_faculty_password(faculty_id):
    if not is_admin_logged_in():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    data = request.get_json() or {}
    new_password = data.get("new_password", "")
    if not new_password:
        return jsonify({"success": False, "error": "New password is required."}), 400

    new_hash = generate_password_hash(new_password)
    database.reset_faculty_password(faculty_id, new_hash)
    return jsonify({"success": True, "message": "Faculty password reset successfully."})


# ---------------------------------------------------------------------------
# Admin API: Student Management (List, Edit, Delete)
# ---------------------------------------------------------------------------
@app.route("/api/admin/students", methods=["GET"])
def api_admin_students():
    if not is_admin_logged_in():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    student_list = database.get_all_students()
    return jsonify({"success": True, "students": student_list})


@app.route("/api/admin/students/<int:student_id>", methods=["PUT", "DELETE"])
def api_admin_student_item(student_id):
    if not is_admin_logged_in():
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


# ---------------------------------------------------------------------------
# Admin API: Attendance Management
# ---------------------------------------------------------------------------
@app.route("/api/admin/attendance", methods=["GET"])
def api_admin_attendance():
    if not is_admin_logged_in():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    date_str = request.args.get("date", "")
    search = request.args.get("search", "").strip()
    records = database.get_attendance_history(date_str, search)
    return jsonify({"success": True, "records": records})


@app.route("/api/admin/attendance/<int:attendance_id>", methods=["DELETE"])
def api_admin_delete_attendance(attendance_id):
    if not is_admin_logged_in():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    database.delete_attendance_record(attendance_id)
    return jsonify({"success": True, "message": "Attendance record deleted successfully."})


# ---------------------------------------------------------------------------
# Admin API: Privacy-Compliant JSON Export (No passwords, hashes, or secrets)
# ---------------------------------------------------------------------------
@app.route("/api/admin/export_json", methods=["GET"])
def api_admin_export_json():
    if not is_admin_logged_in():
        return jsonify({"success": False, "error": "Unauthorized"}), 401

    today_str = datetime.now().strftime("%Y-%m-%d")
    faculty = database.get_all_faculty()
    # Ensure sensitive fields are stripped
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


# ---------------------------------------------------------------------------
# Run Flask Server (Local Development)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("Starting Smart Attendance System on http://0.0.0.0:5000")
    app.run(debug=True, host="0.0.0.0", port=5000)
