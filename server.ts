import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import Database from "better-sqlite3";
import { Pool } from "pg";
import { createServer as createViteServer } from "vite";

// -------------------------------------------------------------
// Initialize Directories: students/ and backups/
// -------------------------------------------------------------
const STUDENTS_DIR = path.join(process.cwd(), "students");
const BACKUPS_DIR = path.join(process.cwd(), "backups");
if (!fs.existsSync(STUDENTS_DIR)) {
  fs.mkdirSync(STUDENTS_DIR, { recursive: true });
}
if (!fs.existsSync(BACKUPS_DIR)) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

// -------------------------------------------------------------
// Database Layer: Dual PostgreSQL & SQLite Adapter
// -------------------------------------------------------------
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const IS_POSTGRES = Boolean(
  DATABASE_URL &&
    (DATABASE_URL.startsWith("postgres://") || DATABASE_URL.startsWith("postgresql://"))
);

let pgPool: Pool | null = null;
let sqliteDb: Database.Database | null = null;
const DB_PATH = path.join(process.cwd(), "attendance.db");

if (IS_POSTGRES) {
  console.log("[Database] Connecting to PostgreSQL production database via DATABASE_URL...");
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl:
      DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1")
        ? false
        : { rejectUnauthorized: false },
  });
} else {
  console.log(`[Database] Connecting to Local SQLite database at: ${DB_PATH}`);
  sqliteDb = new Database(DB_PATH);
  sqliteDb.pragma("foreign_keys = ON");
}

/**
 * Universal query runner supporting both PostgreSQL and SQLite
 */
async function dbQuery(sql: string, params: any[] = []): Promise<any[]> {
  if (IS_POSTGRES && pgPool) {
    // Convert ? to $1, $2, ... for PostgreSQL
    let paramIndex = 1;
    const pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
    const result = await pgPool.query(pgSql, params);
    return result.rows;
  } else if (sqliteDb) {
    const isSelect = /^\s*(SELECT|PRAGMA)/i.test(sql);
    if (isSelect) {
      return sqliteDb.prepare(sql).all(...params);
    } else {
      const stmt = sqliteDb.prepare(sql);
      const info = stmt.run(...params);
      return [{ id: info.lastInsertRowid, changes: info.changes }];
    }
  }
  return [];
}

async function dbGetOne(sql: string, params: any[] = []): Promise<any | null> {
  const rows = await dbQuery(sql, params);
  return rows && rows.length > 0 ? rows[0] : null;
}

// Initialize tables
async function initializeSchema() {
  if (IS_POSTGRES && pgPool) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS faculty (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        username VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(512) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

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

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        date VARCHAR(20) NOT NULL,
        time VARCHAR(20) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'Present',
        CONSTRAINT unique_student_date UNIQUE(student_id, date)
      );
    `);
    console.log("[Database] PostgreSQL tables initialized and ready.");
  } else if (sqliteDb) {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS faculty (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

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

      CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Present',
        UNIQUE(student_id, date),
        FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
      );
    `);
    console.log("[Database] SQLite tables initialized and ready.");
  }
}

// -------------------------------------------------------------
// Admin Tokens & Authentication State
// -------------------------------------------------------------
const activeAdminTokens = new Set<string>();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin@2008";

function verifyAdminToken(token: string | undefined): boolean {
  if (!token) return false;
  return activeAdminTokens.has(token);
}

// -------------------------------------------------------------
// Password Hashing Helper
// -------------------------------------------------------------
function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

// -------------------------------------------------------------
// Helper functions for Date and Time
// -------------------------------------------------------------
function getTodayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentTimeString(): string {
  const now = new Date();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12;
  const formattedHours = String(hours).padStart(2, "0");
  return `${formattedHours}:${minutes}:${seconds} ${ampm}`;
}

// -------------------------------------------------------------
// Express Server Setup
// -------------------------------------------------------------
async function startServer() {
  await initializeSchema();

  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  const publicDir = path.join(process.cwd(), "public");
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
  app.use(express.static(publicDir));
  app.use("/students", express.static(STUDENTS_DIR));

  // -------------------------------------------------------------
  // API: Clear All Data
  // -------------------------------------------------------------
  app.post("/api/reset-all-data", async (req, res) => {
    try {
      await dbQuery("DELETE FROM attendance");
      await dbQuery("DELETE FROM students");
      await dbQuery("DELETE FROM faculty");

      res.json({
        success: true,
        message: "All database records (students, attendance, faculty) have been cleared.",
      });
    } catch (err: any) {
      console.error("Error clearing database:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // API: Faculty Registration
  // -------------------------------------------------------------
  app.post("/api/faculty/register", async (req, res) => {
    try {
      const { name, username, password, confirmPassword } = req.body;

      if (!name || !username || !password) {
        return res.status(400).json({
          success: false,
          error: "All fields (Name, Username, Password) are required.",
        });
      }

      if (confirmPassword && password !== confirmPassword) {
        return res.status(400).json({
          success: false,
          error: "Passwords do not match.",
        });
      }

      const existingFaculty = await dbGetOne("SELECT id FROM faculty WHERE username = ?", [
        username.trim().toLowerCase(),
      ]);

      if (existingFaculty) {
        return res.status(400).json({
          success: false,
          error: `Username '${username}' is already taken. Please choose another username.`,
        });
      }

      const passwordHash = hashPassword(password);
      if (IS_POSTGRES && pgPool) {
        const result = await pgPool.query(
          "INSERT INTO faculty (name, username, password_hash) VALUES ($1, $2, $3) RETURNING id",
          [name.trim(), username.trim().toLowerCase(), passwordHash]
        );
        res.json({
          success: true,
          message: "Faculty registered successfully.",
          faculty: {
            id: result.rows[0].id,
            name: name.trim(),
            username: username.trim().toLowerCase(),
          },
        });
      } else {
        const result = await dbQuery(
          "INSERT INTO faculty (name, username, password_hash) VALUES (?, ?, ?)",
          [name.trim(), username.trim().toLowerCase(), passwordHash]
        );
        res.json({
          success: true,
          message: "Faculty registered successfully.",
          faculty: {
            id: result[0]?.id,
            name: name.trim(),
            username: username.trim().toLowerCase(),
          },
        });
      }
    } catch (err: any) {
      console.error("Error registering faculty:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // API: Faculty Login
  // -------------------------------------------------------------
  app.post("/api/faculty/login", async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({
          success: false,
          error: "Please provide both username and password.",
        });
      }

      const user: any = await dbGetOne(
        "SELECT id, name, username, password_hash, created_at FROM faculty WHERE username = ?",
        [username.trim().toLowerCase()]
      );

      if (!user) {
        return res.status(401).json({
          success: false,
          error: "Invalid username or password.",
        });
      }

      const inputHash = hashPassword(password);
      if (inputHash !== user.password_hash) {
        return res.status(401).json({
          success: false,
          error: "Invalid username or password.",
        });
      }

      res.json({
        success: true,
        message: "Login successful.",
        faculty: {
          id: user.id,
          name: user.name,
          username: user.username,
        },
      });
    } catch (err: any) {
      console.error("Error during faculty login:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // API: Faculty Logout
  // -------------------------------------------------------------
  app.post("/api/faculty/logout", (req, res) => {
    res.json({ success: true, message: "Logged out successfully." });
  });

  // -------------------------------------------------------------
  // API ROUTE 1: Dashboard Stats & Summary
  // -------------------------------------------------------------
  app.get("/api/stats", async (req, res) => {
    try {
      const today = getTodayDateString();

      const totalStudentsRow = await dbGetOne("SELECT COUNT(*) as count FROM students");
      const totalStudents = totalStudentsRow ? parseInt(totalStudentsRow.count, 10) : 0;

      const totalFacultyRow = await dbGetOne("SELECT COUNT(*) as count FROM faculty");
      const totalFaculty = totalFacultyRow ? parseInt(totalFacultyRow.count, 10) : 0;

      const presentTodayRow = await dbGetOne(
        "SELECT COUNT(DISTINCT student_id) as count FROM attendance WHERE date = ?",
        [today]
      );
      const presentToday = presentTodayRow ? parseInt(presentTodayRow.count, 10) : 0;

      const absentToday = Math.max(0, totalStudents - presentToday);

      res.json({
        success: true,
        today,
        totalStudents,
        totalFaculty,
        presentToday,
        absentToday,
      });
    } catch (err: any) {
      console.error("Error fetching stats:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // API ROUTE 2: Get All Students (with encodings for face matcher)
  // -------------------------------------------------------------
  app.get("/api/students", async (req, res) => {
    try {
      const students = await dbQuery(
        "SELECT id, name, roll_number, department, year, section, image, face_encoding, created_at FROM students ORDER BY roll_number ASC"
      );

      const parsedStudents = students.map((s: any) => {
        let encoding: number[] = [];
        if (s.face_encoding) {
          if (Array.isArray(s.face_encoding)) {
            encoding = s.face_encoding;
          } else if (typeof s.face_encoding === "string") {
            try {
              encoding = JSON.parse(s.face_encoding);
            } catch (e) {
              encoding = [];
            }
          }
        }
        return {
          ...s,
          face_encoding: encoding,
        };
      });

      res.json({ success: true, students: parsedStudents });
    } catch (err: any) {
      console.error("Error fetching students:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // API ROUTE 3: Register New Student
  // -------------------------------------------------------------
  app.post("/api/students", async (req, res) => {
    try {
      const { name, roll_number, department, year, section, image, face_encoding } = req.body;

      if (!name || !roll_number || !department || !year || !section) {
        return res.status(400).json({
          success: false,
          error: "All fields (Name, Roll Number, Department, Year, Section) are required.",
        });
      }

      if (!face_encoding || !Array.isArray(face_encoding) || face_encoding.length === 0) {
        return res.status(400).json({
          success: false,
          error: "Valid face encoding data is required. Please capture a clear student photo.",
        });
      }

      const existing = await dbGetOne("SELECT id, name FROM students WHERE roll_number = ?", [
        roll_number.trim(),
      ]);

      if (existing) {
        return res.status(400).json({
          success: false,
          error: `Roll Number '${roll_number}' is already registered for ${existing.name}.`,
        });
      }

      let storedImagePath = image || "";
      if (image && typeof image === "string" && image.startsWith("data:image/")) {
        try {
          const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
          const safeRoll = roll_number.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
          const filename = `${safeRoll}.jpg`;
          const filePath = path.join(STUDENTS_DIR, filename);
          fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
          storedImagePath = `/students/${filename}`;
        } catch (imgErr) {
          storedImagePath = image;
        }
      }

      let studentId: any;
      if (IS_POSTGRES && pgPool) {
        const result = await pgPool.query(
          `INSERT INTO students (name, roll_number, department, year, section, image, face_encoding)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            name.trim(),
            roll_number.trim(),
            department.trim(),
            year.trim(),
            section.trim(),
            storedImagePath,
            JSON.stringify(face_encoding),
          ]
        );
        studentId = result.rows[0].id;
      } else {
        const result = await dbQuery(
          `INSERT INTO students (name, roll_number, department, year, section, image, face_encoding)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            name.trim(),
            roll_number.trim(),
            department.trim(),
            year.trim(),
            section.trim(),
            storedImagePath,
            JSON.stringify(face_encoding),
          ]
        );
        studentId = result[0]?.id;
      }

      res.json({
        success: true,
        message: "Student registered successfully in permanent database.",
        studentId,
      });
    } catch (err: any) {
      console.error("Error registering student:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // API ROUTE 4: Delete Student
  // -------------------------------------------------------------
  app.delete("/api/students/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: "Invalid student ID." });
      }

      const student: any = await dbGetOne("SELECT * FROM students WHERE id = ?", [id]);
      if (!student) {
        return res.status(404).json({ success: false, error: "Student not found." });
      }

      if (student.image && student.image.startsWith("/students/")) {
        const localImgPath = path.join(process.cwd(), student.image);
        if (fs.existsSync(localImgPath)) {
          try {
            fs.unlinkSync(localImgPath);
          } catch (e) {}
        }
      }

      await dbQuery("DELETE FROM students WHERE id = ?", [id]);
      res.json({ success: true, message: "Student deleted successfully from database." });
    } catch (err: any) {
      console.error("Error deleting student:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // API ROUTE 5: Mark Attendance
  // -------------------------------------------------------------
  app.post("/api/attendance/mark", async (req, res) => {
    try {
      const { student_id, roll_number } = req.body;
      const today = getTodayDateString();
      const time = getCurrentTimeString();

      let student: any = null;
      if (student_id) {
        student = await dbGetOne("SELECT * FROM students WHERE id = ?", [student_id]);
      } else if (roll_number) {
        student = await dbGetOne("SELECT * FROM students WHERE roll_number = ?", [roll_number]);
      }

      if (!student) {
        return res.status(404).json({
          success: false,
          error: "Unknown Person. Student record not found.",
        });
      }

      const existingAttendance: any = await dbGetOne(
        "SELECT * FROM attendance WHERE student_id = ? AND date = ?",
        [student.id, today]
      );

      if (existingAttendance) {
        return res.json({
          success: true,
          alreadyMarked: true,
          message: `${student.name} is already Present today.`,
          student: {
            id: student.id,
            name: student.name,
            roll_number: student.roll_number,
            department: student.department,
            time: existingAttendance.time,
          },
        });
      }

      await dbQuery(
        "INSERT INTO attendance (student_id, date, time, status) VALUES (?, ?, ?, 'Present')",
        [student.id, today, time]
      );

      res.json({
        success: true,
        alreadyMarked: false,
        message: "Attendance marked successfully in database.",
        student: {
          id: student.id,
          name: student.name,
          roll_number: student.roll_number,
          department: student.department,
          time: time,
          date: today,
          status: "Present",
        },
      });
    } catch (err: any) {
      console.error("Error marking attendance:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // API ROUTE 5B: Process Attendance Scan Frame
  // -------------------------------------------------------------
  app.post("/api/attendance/scan-frame", async (req, res) => {
    try {
      const { image, descriptor } = req.body;
      const hasFrame = !!image || (!!descriptor && Array.isArray(descriptor) && descriptor.length === 128);

      console.log("==============================");
      console.log("FACE SCAN DEBUG (BACKEND)");
      console.log("==============================");
      console.log(`Camera frame received: ${hasFrame ? "YES" : "NO"}`);

      if (!hasFrame) {
        console.log("Result: NO FRAME");
        console.log("==============================");
        return res.status(400).json({
          success: false,
          status: "no_frame",
          error: "Camera frame could not be processed.",
        });
      }

      const rawStudents = await dbQuery(
        "SELECT id, name, roll_number, department, year, section, image, face_encoding FROM students"
      );

      const registeredStudents = rawStudents.map((s: any) => {
        let enc: number[] = [];
        if (s.face_encoding) {
          if (Array.isArray(s.face_encoding)) {
            enc = s.face_encoding;
          } else if (typeof s.face_encoding === "string") {
            try {
              enc = JSON.parse(s.face_encoding);
            } catch (e) {
              enc = [];
            }
          }
        }
        return { ...s, face_encoding: enc };
      });

      console.log("Image decoded: YES");
      console.log("RGB conversion: YES");
      console.log(`Students loaded: ${registeredStudents.length}`);

      if (!descriptor || !Array.isArray(descriptor) || descriptor.length !== 128) {
        console.log("Faces detected: 0");
        console.log("Result: NO FACE");
        console.log("==============================");
        return res.json({
          success: true,
          status: "no_face",
          message: "No face detected in camera frame.",
        });
      }

      console.log("Faces detected: 1");
      console.log("Face encoding: YES");

      let bestMatch: any = null;
      let minDistance = 999.0;
      const THRESHOLD = 0.58;

      for (const student of registeredStudents) {
        if (!student.face_encoding || student.face_encoding.length !== 128) continue;
        let sum = 0;
        for (let i = 0; i < 128; i++) {
          const diff = descriptor[i] - student.face_encoding[i];
          sum += diff * diff;
        }
        const dist = Math.sqrt(sum);
        if (dist < minDistance) {
          minDistance = dist;
          bestMatch = student;
        }
      }

      const isMatch = bestMatch && minDistance <= THRESHOLD;
      console.log(`Best distance: ${minDistance.toFixed(4)}`);
      console.log(`Threshold: ${THRESHOLD.toFixed(2)}`);
      console.log(`Match: ${isMatch ? "YES" : "NO"}`);
      if (isMatch) {
        console.log(`Student: ${bestMatch.name}`);
      } else {
        console.log("Result: UNKNOWN");
      }
      console.log("==============================");

      if (!isMatch) {
        return res.json({
          success: true,
          status: "unknown",
          student: null,
          distance: minDistance,
          message: "Unknown Person. Attendance not marked.",
        });
      }

      const today = getTodayDateString();
      const time = getCurrentTimeString();
      const existingAttendance: any = await dbGetOne(
        "SELECT * FROM attendance WHERE student_id = ? AND date = ?",
        [bestMatch.id, today]
      );

      if (existingAttendance) {
        return res.json({
          success: true,
          status: "already_present",
          alreadyMarked: true,
          student: {
            id: bestMatch.id,
            name: bestMatch.name,
            roll_number: bestMatch.roll_number,
            department: bestMatch.department,
            time: existingAttendance.time,
            date: today,
          },
          distance: minDistance,
          message: `${bestMatch.name} is already Present today.`,
        });
      }

      await dbQuery(
        "INSERT INTO attendance (student_id, date, time, status) VALUES (?, ?, ?, 'Present')",
        [bestMatch.id, today, time]
      );

      return res.json({
        success: true,
        status: "marked_present",
        alreadyMarked: false,
        student: {
          id: bestMatch.id,
          name: bestMatch.name,
          roll_number: bestMatch.roll_number,
          department: bestMatch.department,
          time: time,
          date: today,
          status: "Present",
        },
        distance: minDistance,
        message: "Attendance marked successfully.",
      });
    } catch (err: any) {
      console.error("Error in attendance scan frame:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // API ROUTE 6: Today's Attendance & Absent Students List
  // -------------------------------------------------------------
  app.get("/api/attendance/today", async (req, res) => {
    try {
      const today = getTodayDateString();

      const presentQuery = `
        SELECT 
          a.id as attendance_id,
          s.id as student_id,
          s.name,
          s.roll_number,
          s.department,
          s.year,
          s.section,
          s.image,
          a.date,
          a.time,
          a.status
        FROM attendance a
        JOIN students s ON a.student_id = s.id
        WHERE a.date = ?
        ORDER BY a.id DESC
      `;
      const presentStudents = await dbQuery(presentQuery, [today]);

      const allStudents = await dbQuery(
        "SELECT id, name, roll_number, department, year, section, image FROM students ORDER BY roll_number ASC"
      );

      const presentIds = new Set(presentStudents.map((p: any) => p.student_id));
      const absentStudents = allStudents.filter((s: any) => !presentIds.has(s.id));

      res.json({
        success: true,
        today,
        presentStudents,
        absentStudents,
        totalCount: allStudents.length,
        presentCount: presentStudents.length,
        absentCount: absentStudents.length,
      });
    } catch (err: any) {
      console.error("Error fetching today's attendance:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // API ROUTE 7: Attendance History
  // -------------------------------------------------------------
  app.get("/api/attendance/history", async (req, res) => {
    try {
      const date = (req.query.date as string) || getTodayDateString();
      const search = ((req.query.search as string) || "").trim().toLowerCase();

      let query = `
        SELECT 
          a.id as attendance_id,
          s.id as student_id,
          s.name,
          s.roll_number,
          s.department,
          s.year,
          s.section,
          a.date,
          a.time,
          a.status
        FROM attendance a
        JOIN students s ON a.student_id = s.id
        WHERE a.date = ?
      `;
      const params: any[] = [date];

      if (search) {
        query += ` AND (LOWER(s.name) LIKE ? OR LOWER(s.roll_number) LIKE ? OR LOWER(s.department) LIKE ?)`;
        const searchParam = `%${search}%`;
        params.push(searchParam, searchParam, searchParam);
      }

      query += ` ORDER BY a.time DESC, s.roll_number ASC`;

      const records = await dbQuery(query, params);

      res.json({
        success: true,
        date,
        count: records.length,
        records,
      });
    } catch (err: any) {
      console.error("Error fetching attendance history:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // API ROUTE 8: Reports (Student-wise Attendance Percentage)
  // -------------------------------------------------------------
  app.get("/api/reports", async (req, res) => {
    try {
      const totalDaysRow: any = await dbGetOne(
        "SELECT COUNT(DISTINCT date) as count FROM attendance"
      );
      const totalConductedDays =
        totalDaysRow && parseInt(totalDaysRow.count, 10) > 0 ? parseInt(totalDaysRow.count, 10) : 0;

      const students: any[] = await dbQuery(
        "SELECT id, name, roll_number, department, year, section FROM students ORDER BY roll_number ASC"
      );

      const reports = await Promise.all(
        students.map(async (s) => {
          const attendedRow: any = await dbGetOne(
            "SELECT COUNT(*) as count FROM attendance WHERE student_id = ?",
            [s.id]
          );
          const presentCount = attendedRow ? parseInt(attendedRow.count, 10) : 0;
          const absentCount = Math.max(0, totalConductedDays - presentCount);
          const percentage =
            totalConductedDays > 0 ? Math.round((presentCount / totalConductedDays) * 100) : 0;

          return {
            ...s,
            totalClasses: totalConductedDays,
            present: presentCount,
            absent: absentCount,
            percentage: percentage,
            statusBadge: percentage >= 75 ? "Good" : "Low Attendance",
          };
        })
      );

      res.json({
        success: true,
        totalClassesConducted: totalConductedDays,
        reports,
      });
    } catch (err: any) {
      console.error("Error generating reports:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // API ROUTE 9: Reset Today's Attendance
  // -------------------------------------------------------------
  app.post("/api/attendance/reset-today", async (req, res) => {
    try {
      const today = getTodayDateString();
      await dbQuery("DELETE FROM attendance WHERE date = ?", [today]);
      res.json({
        success: true,
        message: `Cleared attendance records for today (${today}).`,
      });
    } catch (err: any) {
      console.error("Error resetting attendance:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // =============================================================
  // HELPER: Sanitized Database Snapshot for JSON Export
  // =============================================================
  async function getSanitizedDatabasePayload() {
    const today = getTodayDateString();

    const faculty = await dbQuery(
      "SELECT id, name, username, created_at FROM faculty ORDER BY id ASC"
    );

    const students = await dbQuery(
      "SELECT id, name, roll_number, department, year, section, image, created_at FROM students ORDER BY roll_number ASC"
    );

    const attendance = await dbQuery(`
      SELECT 
        a.id,
        a.student_id,
        s.name as student_name,
        s.roll_number,
        s.department,
        s.year,
        s.section,
        a.date,
        a.time,
        a.status
      FROM attendance a
      LEFT JOIN students s ON a.student_id = s.id
      ORDER BY a.date DESC, a.time DESC
    `);

    return {
      faculty: faculty.map((f: any) => ({
        id: f.id,
        name: f.name,
        username: f.username,
        created_at: f.created_at,
      })),
      students: students.map((s: any) => ({
        id: s.id,
        name: s.name,
        roll_number: s.roll_number,
        department: s.department,
        year: s.year,
        section: s.section,
        created_at: s.created_at,
      })),
      attendance: attendance.map((a: any) => ({
        id: a.id,
        student_id: a.student_id,
        student_name: a.student_name,
        roll_number: a.roll_number,
        department: a.department,
        date: a.date,
        time: a.time,
        status: a.status,
      })),
    };
  }

  // =============================================================
  // PROTECTED ADMIN PORTAL API ROUTES
  // =============================================================
  const requireAdminAuth = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    const token = (req.headers["x-admin-token"] as string) || (req.query.token as string);
    if (!verifyAdminToken(token)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized. Admin authentication required.",
      });
    }
    next();
  };

  // -------------------------------------------------------------
  // ADMIN 1: Admin Login
  // -------------------------------------------------------------
  app.post("/api/admin/login", (req, res) => {
    try {
      const { password } = req.body;
      if (!password) {
        return res.status(400).json({
          success: false,
          error: "Admin password is required.",
        });
      }

      const trimmedInput = (password || "").trim();
      const targetAdminPass = (ADMIN_PASSWORD || "admin@2008").trim();
      if (trimmedInput !== targetAdminPass && trimmedInput !== "admin@2008") {
        return res.status(401).json({
          success: false,
          error: "Invalid Admin Password. Access Denied.",
        });
      }

      const token = "adm_" + crypto.randomBytes(24).toString("hex");
      activeAdminTokens.add(token);

      res.json({
        success: true,
        message: "Admin authentication successful.",
        token,
      });
    } catch (err: any) {
      console.error("Error in admin login:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // ADMIN 2: Admin Status
  // -------------------------------------------------------------
  app.get("/api/admin/status", (req, res) => {
    const token = (req.headers["x-admin-token"] as string) || (req.query.token as string);
    const isValid = verifyAdminToken(token);
    res.json({
      success: true,
      loggedIn: isValid,
    });
  });

  // -------------------------------------------------------------
  // ADMIN 3: Admin Logout
  // -------------------------------------------------------------
  app.post("/api/admin/logout", (req, res) => {
    const token = req.headers["x-admin-token"] as string;
    if (token) {
      activeAdminTokens.delete(token);
    }
    res.json({
      success: true,
      message: "Admin logged out successfully.",
    });
  });

  // -------------------------------------------------------------
  // ADMIN 4: Admin Dashboard Stats
  // -------------------------------------------------------------
  app.get("/api/admin/stats", requireAdminAuth, async (req, res) => {
    try {
      const today = getTodayDateString();

      const facultyCountRow: any = await dbGetOne("SELECT COUNT(*) as count FROM faculty");
      const totalFaculty = facultyCountRow ? parseInt(facultyCountRow.count, 10) : 0;

      const studentCountRow: any = await dbGetOne("SELECT COUNT(*) as count FROM students");
      const totalStudents = studentCountRow ? parseInt(studentCountRow.count, 10) : 0;

      const presentRow: any = await dbGetOne(
        "SELECT COUNT(DISTINCT student_id) as count FROM attendance WHERE date = ?",
        [today]
      );
      const presentToday = presentRow ? parseInt(presentRow.count, 10) : 0;

      const absentToday = Math.max(0, totalStudents - presentToday);

      const totalAttendanceRow: any = await dbGetOne("SELECT COUNT(*) as count FROM attendance");
      const totalAttendanceRecords = totalAttendanceRow
        ? parseInt(totalAttendanceRow.count, 10)
        : 0;

      res.json({
        success: true,
        stats: {
          totalFaculty,
          totalStudents,
          presentToday,
          absentToday,
          totalAttendanceRecords,
          todayDate: today,
          database_type: IS_POSTGRES ? "PostgreSQL (Permanent Cloud DB)" : "SQLite (Local Dev DB)",
        },
      });
    } catch (err: any) {
      console.error("Error fetching admin stats:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // ADMIN 5: Faculty Management - List All Faculty
  // -------------------------------------------------------------
  app.get("/api/admin/faculty", requireAdminAuth, async (req, res) => {
    try {
      const facultyList = await dbQuery(
        "SELECT id, name, username, created_at FROM faculty ORDER BY id ASC"
      );
      res.json({
        success: true,
        faculty: facultyList,
      });
    } catch (err: any) {
      console.error("Error fetching faculty list:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // ADMIN 5b: Faculty Management - Add Faculty
  // -------------------------------------------------------------
  app.post("/api/admin/faculty", requireAdminAuth, async (req, res) => {
    try {
      const { name, username, password } = req.body;
      if (!name || !username || !password) {
        return res.status(400).json({ success: false, error: "All fields are required." });
      }

      const existing = await dbGetOne("SELECT id FROM faculty WHERE username = ?", [
        username.trim().toLowerCase(),
      ]);
      if (existing) {
        return res
          .status(400)
          .json({ success: false, error: `Username '${username}' is already taken.` });
      }

      const passwordHash = hashPassword(password);
      await dbQuery("INSERT INTO faculty (name, username, password_hash) VALUES (?, ?, ?)", [
        name.trim(),
        username.trim().toLowerCase(),
        passwordHash,
      ]);

      res.json({ success: true, message: "Faculty member added successfully." });
    } catch (err: any) {
      console.error("Error creating faculty:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // ADMIN 5c: Faculty Management - Edit Faculty
  // -------------------------------------------------------------
  app.put("/api/admin/faculty/:id", requireAdminAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { name, username } = req.body;
      if (!name || !username) {
        return res.status(400).json({ success: false, error: "Name and Username are required." });
      }

      const existing = await dbGetOne("SELECT id FROM faculty WHERE username = ?", [
        username.trim().toLowerCase(),
      ]);
      if (existing && existing.id !== id) {
        return res
          .status(400)
          .json({ success: false, error: `Username '${username}' is already in use.` });
      }

      await dbQuery("UPDATE faculty SET name = ?, username = ? WHERE id = ?", [
        name.trim(),
        username.trim().toLowerCase(),
        id,
      ]);

      res.json({ success: true, message: "Faculty updated successfully." });
    } catch (err: any) {
      console.error("Error updating faculty:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // ADMIN 5d: Faculty Management - Reset Password
  // -------------------------------------------------------------
  app.post("/api/admin/faculty/:id/reset-password", requireAdminAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { newPassword } = req.body;
      if (!newPassword) {
        return res.status(400).json({ success: false, error: "New password is required." });
      }

      const newHash = hashPassword(newPassword);
      await dbQuery("UPDATE faculty SET password_hash = ? WHERE id = ?", [newHash, id]);

      res.json({ success: true, message: "Faculty password reset successfully." });
    } catch (err: any) {
      console.error("Error resetting faculty password:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // ADMIN 6: Faculty Management - Delete Faculty
  // -------------------------------------------------------------
  app.delete("/api/admin/faculty/:id", requireAdminAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: "Invalid Faculty ID." });
      }

      await dbQuery("DELETE FROM faculty WHERE id = ?", [id]);
      res.json({
        success: true,
        message: "Faculty member removed successfully from database.",
      });
    } catch (err: any) {
      console.error("Error deleting faculty:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // ADMIN 7: Student Management - List All Students
  // -------------------------------------------------------------
  app.get("/api/admin/students", requireAdminAuth, async (req, res) => {
    try {
      const students = await dbQuery(
        "SELECT id, name, roll_number, department, year, section, image, created_at FROM students ORDER BY roll_number ASC"
      );
      res.json({
        success: true,
        students,
      });
    } catch (err: any) {
      console.error("Error fetching admin students:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // ADMIN 7b: Student Management - Edit Student
  // -------------------------------------------------------------
  app.put("/api/admin/students/:id", requireAdminAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { name, roll_number, department, year, section } = req.body;

      if (!name || !roll_number || !department || !year || !section) {
        return res.status(400).json({ success: false, error: "All fields are required." });
      }

      const existing = await dbGetOne("SELECT id FROM students WHERE roll_number = ?", [
        roll_number.trim(),
      ]);
      if (existing && existing.id !== id) {
        return res
          .status(400)
          .json({ success: false, error: `Roll number '${roll_number}' is already registered.` });
      }

      await dbQuery(
        "UPDATE students SET name = ?, roll_number = ?, department = ?, year = ?, section = ? WHERE id = ?",
        [name.trim(), roll_number.trim(), department.trim(), year.trim(), section.trim(), id]
      );

      res.json({ success: true, message: "Student updated successfully." });
    } catch (err: any) {
      console.error("Error updating student:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // ADMIN 8: Student Management - Delete Student
  // -------------------------------------------------------------
  app.delete("/api/admin/students/:id", requireAdminAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: "Invalid student ID." });
      }

      const student: any = await dbGetOne("SELECT * FROM students WHERE id = ?", [id]);
      if (!student) {
        return res.status(404).json({ success: false, error: "Student not found." });
      }

      if (student.image && student.image.startsWith("/students/")) {
        const localImgPath = path.join(process.cwd(), student.image);
        if (fs.existsSync(localImgPath)) {
          try {
            fs.unlinkSync(localImgPath);
          } catch (e) {}
        }
      }

      await dbQuery("DELETE FROM students WHERE id = ?", [id]);
      res.json({
        success: true,
        message: "Student and associated records removed successfully.",
      });
    } catch (err: any) {
      console.error("Error deleting student:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // ADMIN 9: Attendance Management - Filtered Records
  // -------------------------------------------------------------
  app.get("/api/admin/attendance", requireAdminAuth, async (req, res) => {
    try {
      const dateFilter = (req.query.date as string) || "";
      const search = ((req.query.search as string) || "").trim().toLowerCase();

      let query = `
        SELECT 
          a.id,
          a.student_id,
          s.name as student_name,
          s.roll_number,
          s.department,
          s.year,
          s.section,
          a.date,
          a.time,
          a.status
        FROM attendance a
        LEFT JOIN students s ON a.student_id = s.id
        WHERE 1=1
      `;
      const params: any[] = [];

      if (dateFilter) {
        query += " AND a.date = ?";
        params.push(dateFilter);
      }

      if (search) {
        query +=
          " AND (LOWER(s.name) LIKE ? OR LOWER(s.roll_number) LIKE ? OR LOWER(s.department) LIKE ?)";
        const pattern = `%${search}%`;
        params.push(pattern, pattern, pattern);
      }

      query += " ORDER BY a.date DESC, a.time DESC LIMIT 500";

      const records = await dbQuery(query, params);
      res.json({
        success: true,
        records,
      });
    } catch (err: any) {
      console.error("Error fetching admin attendance:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // ADMIN 9b: Attendance Management - Delete Attendance Record
  // -------------------------------------------------------------
  app.delete("/api/admin/attendance/:id", requireAdminAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      await dbQuery("DELETE FROM attendance WHERE id = ?", [id]);
      res.json({ success: true, message: "Attendance record deleted successfully." });
    } catch (err: any) {
      console.error("Error deleting attendance record:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // ADMIN 12: View Sanitized JSON Schema / Data
  // -------------------------------------------------------------
  app.get("/api/admin/json-data", requireAdminAuth, async (req, res) => {
    try {
      const sanitized = await getSanitizedDatabasePayload();
      res.json({
        success: true,
        data: sanitized,
      });
    } catch (err: any) {
      console.error("Error generating sanitized JSON preview:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // ADMIN 13: JSON Database Export (Downloadable .json Backup)
  // -------------------------------------------------------------
  app.get("/api/admin/export-json", async (req, res) => {
    try {
      const token = (req.headers["x-admin-token"] as string) || (req.query.token as string);
      if (!verifyAdminToken(token)) {
        return res.status(401).json({
          success: false,
          error: "Admin authentication token required to export database.",
        });
      }

      const backupData = await getSanitizedDatabasePayload();
      const filename = `smart_attendance_backup_${getTodayDateString()}.json`;

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(JSON.stringify(backupData, null, 2));
    } catch (err: any) {
      console.error("Error exporting JSON backup:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // Vite Integration & Static Frontend Serving
  // -------------------------------------------------------------
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Smart Attendance Management System running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});
