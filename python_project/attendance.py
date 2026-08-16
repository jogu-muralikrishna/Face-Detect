"""
=============================================================================
Attendance Logic Module
=============================================================================
This module handles attendance marking, duplicate prevention, and report calculations.
Compatible with PostgreSQL (for Vercel/Cloud) and SQLite (for Local).
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

    # Step 3: Record attendance in database
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
    row = database.execute_query("SELECT COUNT(DISTINCT date) as total_days FROM attendance", fetch="one")
    total_days = row["total_days"] if row and row.get("total_days") else 0
    total_classes = max(1, total_days)

    students = database.get_all_students()
    reports = []

    for s in students:
        p_row = database.execute_query(
            "SELECT COUNT(*) as present_count FROM attendance WHERE student_id = ?",
            (s["id"],),
            fetch="one"
        )
        present = p_row["present_count"] if p_row and p_row.get("present_count") else 0
        absent = max(0, total_classes - present)
        percentage = round((present / total_classes) * 100, 1) if total_classes > 0 else 0

        reports.append({
            "id": s["id"],
            "name": s["name"],
            "roll_number": s["roll_number"],
            "department": s["department"],
            "year": s["year"],
            "section": s["section"],
            "totalClasses": total_classes,
            "present": present,
            "absent": absent,
            "percentage": percentage,
            "statusBadge": "Eligible (>=75%)" if percentage >= 75 else "Shortage (<75%)",
        })

    return {
        "totalClassesConducted": total_days,
        "reports": reports
    }
