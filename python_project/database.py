"""
=============================================================================
Smart Attendance Management System - Database Module
=============================================================================
Supports PostgreSQL (for permanent production on Vercel/Cloud) and SQLite
(for offline local development) using DATABASE_URL environment variable.
"""

import os
import json
from datetime import datetime

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
IS_POSTGRES = bool(DATABASE_URL and (DATABASE_URL.startswith("postgres://") or DATABASE_URL.startswith("postgresql://")))

if IS_POSTGRES:
    # Fix postgres:// URL prefix for psycopg2 if needed
    if DATABASE_URL.startswith("postgres://"):
        DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)
    import psycopg2
    from psycopg2.extras import RealDictCursor
else:
    import sqlite3
    DB_PATH = os.path.join(os.path.dirname(__file__), "attendance.db")


def get_db_connection():
    """Returns a PostgreSQL or SQLite connection with dict-like row access."""
    if IS_POSTGRES:
        conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
        conn.autocommit = True
        return conn
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        return conn


def get_cursor(conn):
    """Returns a cursor compatible with both databases."""
    return conn.cursor()


def execute_query(query_sql, params=None, fetch="none"):
    """
    Helper to execute parameterized queries on PostgreSQL or SQLite.
    Automatically adapts placeholders (? for SQLite, %s for PostgreSQL).
    """
    conn = get_db_connection()
    cursor = get_cursor(conn)

    adapted_sql = query_sql
    if IS_POSTGRES:
        # Replace ? with %s for PostgreSQL
        adapted_sql = query_sql.replace("?", "%s")
    else:
        # SQLite uses ?
        pass

    if params is None:
        cursor.execute(adapted_sql)
    else:
        cursor.execute(adapted_sql, params)

    result = None
    if fetch == "one":
        row = cursor.fetchone()
        result = dict(row) if row else None
    elif fetch == "all":
        rows = cursor.fetchall()
        result = [dict(r) for r in rows] if rows else []
    elif fetch == "lastrowid":
        if IS_POSTGRES:
            # PostgreSQL last row ID from RETURNING
            try:
                row = cursor.fetchone()
                result = row["id"] if row and "id" in row else None
            except Exception:
                result = None
        else:
            result = cursor.lastrowid
            conn.commit()

    if not IS_POSTGRES:
        conn.commit()

    cursor.close()
    conn.close()
    return result


def init_db():
    """Initializes tables in PostgreSQL or SQLite if they don't already exist."""
    conn = get_db_connection()
    cursor = get_cursor(conn)

    if IS_POSTGRES:
        print("[Database] Initializing PostgreSQL database schema...")
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS faculty (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                username VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(512) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS students (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                roll_number VARCHAR(100) UNIQUE NOT NULL,
                department VARCHAR(100) NOT NULL,
                year VARCHAR(50) NOT NULL,
                section VARCHAR(50) NOT NULL,
                image TEXT NOT NULL,
                face_encoding TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS attendance (
                id SERIAL PRIMARY KEY,
                student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
                date VARCHAR(20) NOT NULL,
                time VARCHAR(20) NOT NULL,
                status VARCHAR(50) NOT NULL DEFAULT 'Present',
                CONSTRAINT unique_student_date UNIQUE(student_id, date)
            );
        """)
        print("[Database] PostgreSQL tables verified and ready.")
    else:
        print(f"[Database] Initializing SQLite database schema at {DB_PATH}...")
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS faculty (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS students (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                roll_number TEXT UNIQUE NOT NULL,
                department TEXT NOT NULL,
                year TEXT NOT NULL,
                section TEXT NOT NULL,
                image TEXT NOT NULL,
                face_encoding TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS attendance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id INTEGER NOT NULL,
                date TEXT NOT NULL,
                time TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'Present',
                UNIQUE(student_id, date),
                FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
            );
        """)
        conn.commit()
        print("[Database] SQLite database tables verified and ready.")

    cursor.close()
    conn.close()


# ---------------------------------------------------------------------------
# Faculty Operations
# ---------------------------------------------------------------------------
def add_faculty(name, username, password_hash):
    if IS_POSTGRES:
        sql = "INSERT INTO faculty (name, username, password_hash) VALUES (?, ?, ?) RETURNING id"
        return execute_query(sql, (name.strip(), username.lower().strip(), password_hash), fetch="lastrowid")
    else:
        sql = "INSERT INTO faculty (name, username, password_hash) VALUES (?, ?, ?)"
        return execute_query(sql, (name.strip(), username.lower().strip(), password_hash), fetch="lastrowid")


def get_faculty_by_username(username):
    sql = "SELECT * FROM faculty WHERE username = ?"
    return execute_query(sql, (username.lower().strip(),), fetch="one")


def get_faculty_by_id(faculty_id):
    sql = "SELECT id, name, username, created_at FROM faculty WHERE id = ?"
    return execute_query(sql, (faculty_id,), fetch="one")


def get_all_faculty():
    sql = "SELECT id, name, username, created_at FROM faculty ORDER BY id ASC"
    return execute_query(sql, fetch="all")


def update_faculty(faculty_id, name, username):
    sql = "UPDATE faculty SET name = ?, username = ? WHERE id = ?"
    execute_query(sql, (name.strip(), username.lower().strip(), faculty_id))
    return True


def reset_faculty_password(faculty_id, new_password_hash):
    sql = "UPDATE faculty SET password_hash = ? WHERE id = ?"
    execute_query(sql, (new_password_hash, faculty_id))
    return True


def delete_faculty(faculty_id):
    sql = "DELETE FROM faculty WHERE id = ?"
    execute_query(sql, (faculty_id,))
    return True


def get_total_faculty_count():
    sql = "SELECT COUNT(*) as count FROM faculty"
    row = execute_query(sql, fetch="one")
    return row["count"] if row else 0


# ---------------------------------------------------------------------------
# Student Operations
# ---------------------------------------------------------------------------
def add_student(name, roll_number, department, year, section, image, face_encoding_json):
    if IS_POSTGRES:
        sql = """
            INSERT INTO students (name, roll_number, department, year, section, image, face_encoding)
            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
        """
        return execute_query(
            sql,
            (name.strip(), roll_number.strip(), department.strip(), year.strip(), section.strip(), image, face_encoding_json),
            fetch="lastrowid"
        )
    else:
        sql = """
            INSERT INTO students (name, roll_number, department, year, section, image, face_encoding)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """
        return execute_query(
            sql,
            (name.strip(), roll_number.strip(), department.strip(), year.strip(), section.strip(), image, face_encoding_json),
            fetch="lastrowid"
        )


def update_student(student_id, name, roll_number, department, year, section):
    sql = """
        UPDATE students
        SET name = ?, roll_number = ?, department = ?, year = ?, section = ?
        WHERE id = ?
    """
    execute_query(sql, (name.strip(), roll_number.strip(), department.strip(), year.strip(), section.strip(), student_id))
    return True


def delete_student(student_id):
    sql = "DELETE FROM students WHERE id = ?"
    execute_query(sql, (student_id,))
    return True


def get_all_students():
    sql = "SELECT id, name, roll_number, department, year, section, image, created_at FROM students ORDER BY roll_number ASC"
    return execute_query(sql, fetch="all")


def get_all_students_with_encodings():
    sql = "SELECT id, name, roll_number, department, year, section, image, face_encoding, created_at FROM students ORDER BY roll_number ASC"
    return execute_query(sql, fetch="all")


def get_student_by_roll_number(roll_number):
    sql = "SELECT * FROM students WHERE roll_number = ?"
    return execute_query(sql, (roll_number.strip(),), fetch="one")


def get_student_by_id(student_id):
    sql = "SELECT * FROM students WHERE id = ?"
    return execute_query(sql, (student_id,), fetch="one")


def get_total_students_count():
    sql = "SELECT COUNT(*) as count FROM students"
    row = execute_query(sql, fetch="one")
    return row["count"] if row else 0


# ---------------------------------------------------------------------------
# Attendance Operations
# ---------------------------------------------------------------------------
def check_attendance_exists(student_id, date_str):
    sql = "SELECT * FROM attendance WHERE student_id = ? AND date = ?"
    return execute_query(sql, (student_id, date_str), fetch="one")


def record_attendance(student_id, date_str, time_str, status="Present"):
    sql = "INSERT INTO attendance (student_id, date, time, status) VALUES (?, ?, ?, ?)"
    execute_query(sql, (student_id, date_str, time_str, status))
    return True


def delete_attendance_record(record_id):
    sql = "DELETE FROM attendance WHERE id = ?"
    execute_query(sql, (record_id,))
    return True


def get_present_today_count(today_str):
    sql = "SELECT COUNT(DISTINCT student_id) as count FROM attendance WHERE date = ?"
    row = execute_query(sql, (today_str,), fetch="one")
    return row["count"] if row else 0


def get_total_attendance_count():
    sql = "SELECT COUNT(*) as count FROM attendance"
    row = execute_query(sql, fetch="one")
    return row["count"] if row else 0


def get_today_attendance_records(today_str):
    sql = """
        SELECT a.id, s.id as student_id, s.name, s.roll_number, s.department, s.year, s.section, s.image, a.date, a.time, a.status
        FROM attendance a
        JOIN students s ON a.student_id = s.id
        WHERE a.date = ?
        ORDER BY a.id DESC
    """
    return execute_query(sql, (today_str,), fetch="all")


def get_today_absent_students(today_str):
    sql = """
        SELECT s.id, s.name, s.roll_number, s.department, s.year, s.section, s.image
        FROM students s
        WHERE s.id NOT IN (
            SELECT student_id FROM attendance WHERE date = ?
        )
        ORDER BY s.roll_number ASC
    """
    return execute_query(sql, (today_str,), fetch="all")


def get_attendance_history(date_str="", search_query=""):
    params = []
    sql = """
        SELECT a.id, a.student_id, s.name, s.roll_number, s.department, s.year, s.section, a.date, a.time, a.status
        FROM attendance a
        JOIN students s ON a.student_id = s.id
        WHERE 1=1
    """
    if date_str:
        sql += " AND a.date = ?"
        params.append(date_str)
    if search_query:
        sql += " AND (LOWER(s.name) LIKE ? OR LOWER(s.roll_number) LIKE ? OR LOWER(s.department) LIKE ?)"
        pattern = f"%{search_query.lower()}%"
        params.extend([pattern, pattern, pattern])

    sql += " ORDER BY a.date DESC, a.time DESC LIMIT 500"
    return execute_query(sql, tuple(params) if params else None, fetch="all")


def delete_all_data():
    execute_query("DELETE FROM attendance")
    execute_query("DELETE FROM students")
    execute_query("DELETE FROM faculty")
    return True
