# Face Recognition-Based Smart Attendance Management System

A clean, production-ready, and beginner-friendly Smart Attendance Management System built for college academic projects and institutional deployments.

---

## 🌟 Key Features

- **Dual-Camera Interface:**
  - **Camera 1 (Student Registration):** Captures single face, extracts 128-dimensional facial vector embeddings, and stores student profile permanently.
  - **Camera 2 (Attendance Scanner):** Real-time face detection and matching against enrolled student database.
- **Duplicate Attendance Prevention:** Automatically ensures a student is only marked **Present once per day** with recorded timestamp.
- **Permanent Database Architecture:**
  - **Production (Vercel / Cloud):** Fully compatible with **PostgreSQL** via `DATABASE_URL`.
  - **Local Development:** Defaults seamlessly to local **SQLite** (`attendance.db`).
- **Faculty Authentication:**
  - Secure registration and login with salted and hashed passwords (`generate_password_hash` / `check_password_hash`).
- **Protected Master Admin Portal:**
  - Secured via `ADMIN_PASSWORD` (default: `admin@2008`).
  - Faculty management: Add faculty, Edit details, Reset passwords, and Delete accounts.
  - Student management: View student profiles, Edit records, and Delete embeddings.
  - Attendance management: Filter and remove attendance log records.
  - Privacy-compliant JSON database export and local SQLite `.db` backup.
- **Reporting & Analytics:**
  - Attendance percentages computed dynamically per student.
  - Searchable attendance history by date, student name, and roll number.

---

## 📁 Project Structure

```
├── api/
│   └── index.py            # Vercel Serverless WSGI entry point
├── python_project/
│   ├── app.py              # Main Flask application with PostgreSQL/SQLite routing
│   ├── database.py         # Universal database abstraction layer (PostgreSQL & SQLite)
│   ├── face_recognition_module.py # Face extraction & recognition module
│   ├── attendance.py       # Attendance logic & duplicate check
│   └── requirements.txt    # Python dependencies
├── public/                 # Static frontend assets (HTML, CSS, JS, face-api models)
├── index.html              # Main single-page web UI
├── server.ts               # Node/Express production & local dev server
├── vercel.json             # Vercel deployment configuration
├── package.json            # Node.js build configuration
└── .env.example            # Environment variables template
```

---

## 🚀 Running Locally

### Option 1: Python Flask (Local)
1. Install Python 3.10+:
   ```bash
   pip install -r requirements.txt
   ```
2. Run the application:
   ```bash
   python python_project/app.py
   ```
3. Open `http://localhost:5000` in your web browser.

### Option 2: Node.js / Express (Local)
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the dev server:
   ```bash
   npm run dev
   ```
3. Open `http://localhost:3000` in your web browser.

---

## ☁️ Deploying to Vercel with PostgreSQL

1. **Push your code to GitHub.**
2. **Import the repository into Vercel.**
3. **Configure Environment Variables in Vercel:**
   - `DATABASE_URL`: `postgresql://username:password@hostname:5432/dbname?sslmode=require` (from Supabase, Neon, AWS RDS, or any PostgreSQL provider).
   - `ADMIN_PASSWORD`: Your secret admin portal password (e.g., `admin@2008`).
   - `SECRET_KEY`: A secure random string for Flask session management.
4. **Click Deploy.** Vercel will automatically build using `vercel.json` and initialize all tables on startup.
