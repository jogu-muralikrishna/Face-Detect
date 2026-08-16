"""
=============================================================================
Attendance Logic Module
=============================================================================
This module handles attendance marking, duplicate prevention, and report calculations.
"""

from datetime import datetime
import database


def mark_attendance(student_id):
    """
    Marks attendance for a student with duplicate prevention.
    Allows only one attendance entry per student per day.
    """
    now = datetime.now()
    today_date = now.strftime("%Y-%m-%d")
    current_time = now.strftime("%I:%M:%S %p")

    # Step 1: Get student details
    student = database.get_student_by_id(student_id)
    if not student:
        return {"success": False, "error": "Student not found in database."}

    # Step 2: Check whether attendance already exists today
    existing = database.check_attendance_exists(student_id, today_date)
    if existing:
        return {
            "success": False,
            "already_marked": True,
            "message": f"Attendance already marked today for {student['name']} at {existing['time']}.",
            "student": dict(student),
        }

    # Step 3: Record attendance in SQLite database
    database.record_attendance(student_id, today_date, current_time, status="Present")

    return {
        "success": True,
        "already_marked": False,
        "message": f"Attendance marked successfully for {student['name']} (Roll: {student['roll_number']})!",
        "student": dict(student),
        "time": current_time,
        "date": today_date,
    }


def generate_attendance_reports():
    """
    Calculates student-wise attendance statistics:
    Attendance Percentage = (Present / Total Classes) * 100
    """
    conn = database.get_db_connection()
    cursor = conn.cursor()

    # Find total unique dates attendance was taken
    cursor.execute("SELECT COUNT(DISTINCT date) as total_days FROM attendance")
    total_days = cursor.fetchone()["total_days"]
    total_classes = max(1, total_days)

    students = database.get_all_students()
    reports = []

    for s in students:
        cursor.execute(
            "SELECT COUNT(*) as present_count FROM attendance WHERE student_id = ?",
            (s["id"],)
        )
        present = cursor.fetchone()["present_count"]
        absent = max(0, total_classes - present)
        percentage = round((present / total_classes) * 100, 1)

        reports.append({
            "id": s["id"],
            "name": s["name"],
            "roll_number": s["roll_number"],
            "department": s["department"],
            "year": s["year"],
            "section": s["section"],
            "total_classes": total_classes,
            "present": present,
            "absent": absent,
            "percentage": percentage,
            "status": "Eligible (>=75%)" if percentage >= 75 else "Shortage (<75%)",
        })

    conn.close()
    return reports
