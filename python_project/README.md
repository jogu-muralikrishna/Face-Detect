# Face Recognition-Based Smart Attendance Management System
**College Academic Project**

A simple, beginner-friendly Smart Attendance Management System built with **HTML, CSS, JavaScript, Python, Flask, SQLite, and OpenCV / Pre-trained Face Recognition**.

---

## 1. Project Architecture & File Explanation

```text
smart-attendance/
│
├── python_project/
│   ├── app.py                     # Main Flask web application and routing
│   ├── database.py               # SQLite database helper functions & queries
│   ├── face_recognition_module.py# Pre-trained face detection & 128-d encoding matcher
│   ├── attendance.py             # Attendance business logic & percentage calculation
│   ├── requirements.txt          # Python dependencies
│   └── students_photos/          # Stored registered student images
│
├── attendance.db                 # SQLite database file
├── index.html                    # Clean, semantic Admin Panel HTML
├── public/
│   ├── style.css                 # Clean, responsive CSS styling
│   ├── script.js                 # Vanilla JavaScript client logic & camera handler
│   ├── js/face-api.js            # Pre-trained client-side face recognition engine
│   └── models/                   # Pre-trained neural network weights (SSD Mobilenet)
│
└── server.ts                     # Full-stack Node/Express server for live preview
```

### How Each File Works:

1. **`app.py` (Flask Server)**:
   - Sets up the web server routes (`/`, `/students`, `/register`, `/attendance`, `/history`, `/reports`).
   - Connects the frontend templates with database and AI modules.

2. **`database.py` (SQLite Manager)**:
   - Creates and manages the `attendance.db` SQLite database.
   - Contains 2 tables: `students` and `attendance`.
   - Handles saving student profiles, storing face encodings, checking duplicates, and retrieving history.

3. **`face_recognition_module.py` (Pre-Trained AI Engine)**:
   - Uses a pre-trained face recognition model (ResNet/dlib/SSD MobileNet).
   - Detects face in a photo or camera frame.
   - Converts the face into a **128-dimensional mathematical vector (face encoding)**.
   - Compares the camera's face vector with stored database vectors using **Euclidean Distance**.
   - If `distance < 0.55`, the student is recognized. Otherwise, labeled as `Unknown Person`.

4. **`attendance.py` (Attendance Rules Engine)**:
   - Enforces **Duplicate Attendance Prevention** (only 1 attendance record allowed per student per day).
   - Calculates absent students automatically: `Absent = Total Students - Present Today`.
   - Calculates attendance percentage: `Percentage = (Present / Total Classes) * 100`.

5. **`index.html`, `style.css`, `script.js`**:
   - Single-screen responsive Admin Panel with instant tab switching.
   - Mobile and laptop camera access using `navigator.mediaDevices.getUserMedia()`.
   - Real-time video frame rendering on HTML5 canvas with bounding boxes and names.

---

## 2. Database Schema (SQLite)

### Table 1: `students`
| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Unique student identifier |
| `name` | TEXT | Student full name |
| `roll_number` | TEXT UNIQUE | College Roll Number (e.g. 101) |
| `department` | TEXT | Department (CSE, ECE, etc.) |
| `year` | TEXT | Academic Year (1st, 2nd, 3rd, 4th) |
| `section` | TEXT | Section (A, B, C) |
| `image` | TEXT | Photo path or data URL |
| `face_encoding` | TEXT | JSON string of 128 float numbers |
| `created_at` | TIMESTAMP | Registration timestamp |

### Table 2: `attendance`
| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Attendance record ID |
| `student_id` | INTEGER | Foreign key referencing `students(id)` |
| `date` | TEXT | Date in `YYYY-MM-DD` format |
| `time` | TEXT | Time in `HH:MM:SS AM/PM` format |
| `status` | TEXT | Attendance status (`Present`) |

*Unique Constraint*: `UNIQUE(student_id, date)` guarantees that duplicate attendance entries cannot be created on the same day.

---

## 3. How to Run Locally with Python & Flask

### Step 1: Install Requirements
```bash
pip install -r python_project/requirements.txt
```

### Step 2: Run the Flask Application
```bash
python python_project/app.py
```

### Step 3: Open Browser
Navigate to:
```text
http://127.0.0.1:5000
```

---

## 4. How the Face Recognition Works

1. **Photo Upload / Live Capture**: When a student is registered, their photo is processed by a face detector.
2. **Face Vector Extraction**: 68 facial landmarks (eyes, nose, jawline) are located, and a 128-dimensional embedding vector is generated.
3. **Storage**: The 128 numbers are saved in SQLite with the student profile.
4. **Real-Time Attendance**: The camera continuously detects faces in video frames, generates the 128-d vector, and computes the Euclidean distance $\sqrt{\sum(a_i - b_i)^2}$ against all stored students.
5. **Marking**: If a match is found within tolerance ($< 0.55$), the backend verifies if attendance was already recorded today. If not, it saves the record in SQLite.
