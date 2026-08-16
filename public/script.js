/**
 * =============================================================================
 * Face Recognition-Based Smart Attendance Management System
 * Plain Vanilla JavaScript Client Logic (HTML + CSS + JS + SQLite + Face-API)
 * =============================================================================
 */

// Global State
let modelsLoaded = false;
let registeredStudents = []; // Cache of enrolled students with face descriptors
let currentScannerFacing = "user"; // 'user' (front) or 'environment' (back)

// Camera 1 (Registration) Stream & State
let regStream = null;
let regCapturedBase64 = null;
let regCapturedDescriptor = null;

// Camera 2 (Attendance Scanner) Stream & State
let scannerStream = null;
let isScannerRunning = false;
let scannerInterval = null;
let lastMarkedStudentId = null;
let lastMarkedTimestamp = 0;

// Audio Feedback Helper (Beep when attendance is marked)
function playSuccessBeep() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, audioCtx.currentTime); // 880Hz (A5)
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.2);
  } catch (e) {
    // Audio context may be restricted by browser until user gesture
  }
}

// -----------------------------------------------------------------------------
// Initialization on Page Load
// -----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  setupLiveClock();
  setupNavigation();
  initAuthUI();
  loadFaceApiModels();
  fetchDashboardData();
  fetchStudentsData();
  
  // Set default history date to today
  const historyDateInput = document.getElementById("historyDateInput");
  if (historyDateInput) {
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    historyDateInput.value = todayStr;
    fetchHistoryData();
  }
});

// Live Digital Clock
function setupLiveClock() {
  const clockEl = document.getElementById("liveClock");
  function updateTime() {
    const now = new Date();
    if (clockEl) {
      clockEl.textContent =
        now.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        }) + " | " + now.toLocaleTimeString();
    }
  }
  updateTime();
  setInterval(updateTime, 1000);
}

// Tab Navigation & Mobile Sidebar Setup
function setupNavigation() {
  const navTabs = document.querySelectorAll(".nav-tab");
  navTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetViewId = tab.getAttribute("data-view");
      switchView(targetViewId);

      // Close mobile sidebar if open
      const sidebar = document.querySelector(".app-sidebar");
      if (sidebar && sidebar.classList.contains("mobile-open")) {
        sidebar.classList.remove("mobile-open");
      }
    });
  });

  // Mobile sidebar toggle button
  const toggleBtn = document.getElementById("sidebarToggle");
  const sidebar = document.querySelector(".app-sidebar");
  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener("click", () => {
      sidebar.classList.toggle("mobile-open");
    });
  }
}

const VIEW_HEADINGS = {
  "view-dashboard": "System Overview",
  "view-students": "Registered Students",
  "view-register": "Student Registration (Camera 1)",
  "view-attendance": "Attendance Scanner (Camera 2)",
  "view-history": "Attendance History",
  "view-reports": "Attendance Reports & Analytics",
  "view-faculty-auth": "Faculty Authentication",
  "view-admin": "Master Admin Portal",
};

function switchView(viewId) {
  // If moving away from registration camera, stop registration camera
  if (viewId !== "view-register") {
    stopRegCamera();
  }

  // If moving away from attendance scanner, stop attendance scanner
  if (viewId !== "view-attendance") {
    stopScannerCamera();
  }

  // Hide all view sections
  const sections = document.querySelectorAll(".view-section");
  sections.forEach((sec) => sec.classList.remove("active"));

  // Deactivate all nav tabs
  const tabs = document.querySelectorAll(".nav-tab");
  tabs.forEach((tab) => tab.classList.remove("active"));

  // Activate selected view
  const targetSection = document.getElementById(viewId);
  if (targetSection) {
    targetSection.classList.add("active");
  }

  // Activate corresponding tab
  const matchingTab = document.querySelector(`.nav-tab[data-view="${viewId}"]`);
  if (matchingTab) {
    matchingTab.classList.add("active");
  }

  // Update topbar heading
  const heading = document.getElementById("pageMainHeading");
  if (heading && VIEW_HEADINGS[viewId]) {
    heading.textContent = VIEW_HEADINGS[viewId];
  }

  // Refresh view-specific data
  if (viewId === "view-dashboard") fetchDashboardData();
  if (viewId === "view-students") fetchStudentsData();
  if (viewId === "view-attendance") fetchStudentsData();
  if (viewId === "view-history") fetchHistoryData();
  if (viewId === "view-reports") fetchReportsData();
  if (viewId === "view-admin") checkAdminSessionAndRender();
}

// -----------------------------------------------------------------------------
// AI Models Loader (Pre-trained face-api.js models)
// -----------------------------------------------------------------------------
let modelsLoadingPromise = null;

async function ensureFaceApiModelsLoaded() {
  if (modelsLoaded && typeof faceapi !== "undefined") return true;
  if (!modelsLoadingPromise) {
    modelsLoadingPromise = loadFaceApiModels();
  }
  const success = await modelsLoadingPromise;
  if (!success) {
    // Clear promise to allow re-attempting
    modelsLoadingPromise = null;
  }
  return success;
}

async function loadFaceApiModels() {
  const statusEl = document.getElementById("modelLoadingStatus");
  const healthBadge = document.getElementById("healthModelBadge");

  try {
    // Step 1: Ensure faceapi library is loaded
    if (typeof faceapi === "undefined") {
      if (statusEl) statusEl.textContent = "Loading Face-API library...";
      await new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/dist/face-api.js";
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
      });
    }

    if (typeof faceapi === "undefined") {
      console.warn("[Face Recognition] Face-API library unavailable.");
      if (statusEl) statusEl.textContent = "AI Model: Offline";
      return false;
    }

    if (statusEl) statusEl.textContent = "Loading Face AI Models...";

    // Step 2: Try local /models directory first, then CDN fallbacks
    const candidateUrls = [
      "/models",
      "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model",
      "https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights"
    ];

    let isSuccess = false;
    for (const url of candidateUrls) {
      try {
        console.log(`[Face Recognition] Attempting to load neural weights from: ${url}`);
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri(url),
          faceapi.nets.tinyFaceDetector.loadFromUri(url),
          faceapi.nets.faceLandmark68Net.loadFromUri(url),
          faceapi.nets.faceLandmark68TinyNet.loadFromUri(url),
          faceapi.nets.faceRecognitionNet.loadFromUri(url),
        ]);
        isSuccess = true;
        console.log(`[Face Recognition] Neural network models successfully loaded from: ${url}`);
        break;
      } catch (loadErr) {
        console.warn(`[Face Recognition] Failed loading weights from ${url}:`, loadErr);
      }
    }

    if (isSuccess) {
      modelsLoaded = true;
      if (statusEl) {
        statusEl.textContent = "AI Models: Ready";
        statusEl.style.backgroundColor = "var(--emerald-bg)";
        statusEl.style.color = "var(--emerald)";
      }
      if (healthBadge) {
        healthBadge.textContent = "LOADED";
        healthBadge.className = "health-badge active";
      }
      return true;
    } else {
      throw new Error("Unable to load model weights from any candidate source.");
    }
  } catch (err) {
    console.warn("[Face Recognition] Could not load face-api models:", err);
    if (statusEl) statusEl.textContent = "AI Model: Standby";
    if (healthBadge) healthBadge.textContent = "STANDBY";
    return false;
  }
}

// -----------------------------------------------------------------------------
// Toast Notifications
// -----------------------------------------------------------------------------
function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// -----------------------------------------------------------------------------
// Faculty Authentication State & Handlers
// -----------------------------------------------------------------------------
function getFacultySession() {
  try {
    const raw = localStorage.getItem("smart_attendance_faculty");
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function setFacultySession(faculty) {
  localStorage.setItem("smart_attendance_faculty", JSON.stringify(faculty));
  initAuthUI();
}

function clearFacultySession() {
  localStorage.removeItem("smart_attendance_faculty");
  initAuthUI();
}

function initAuthUI() {
  const session = getFacultySession();
  const nameEl = document.getElementById("topbarFacultyName");
  const avatarEl = document.getElementById("topbarFacultyAvatar");
  const authStatusText = document.getElementById("authStatusText");
  const authDot = document.getElementById("authIndicatorDot");

  if (session && session.name) {
    if (nameEl) nameEl.textContent = `Prof. ${session.name}`;
    if (avatarEl) {
      const initials = session.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .substring(0, 2);
      avatarEl.innerHTML = `<span>${initials || "FC"}</span>`;
    }
    if (authStatusText) authStatusText.textContent = `${session.name} (Active)`;
    if (authDot) authDot.className = "status-indicator-dot";
  } else {
    if (nameEl) nameEl.textContent = "Faculty Portal";
    if (avatarEl) avatarEl.innerHTML = `<span>FP</span>`;
    if (authStatusText) authStatusText.textContent = "Not Logged In";
    if (authDot) authDot.className = "status-indicator-dot offline";
  }
}

async function handleFacultyLogin(e) {
  e.preventDefault();
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;

  if (!username || !password) {
    showToast("Please enter both username and password.", "error");
    return;
  }

  try {
    const res = await fetch("/api/faculty/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();
    if (data.success) {
      setFacultySession(data.faculty);
      showToast("Login successful.", "success");
      document.getElementById("facultyLoginForm").reset();
      fetchDashboardData();
      switchView("view-dashboard");
    } else {
      showToast(data.error || "Invalid username or password.", "error");
    }
  } catch (err) {
    console.error("Login error:", err);
    showToast("Server connection error during login.", "error");
  }
}

async function handleFacultyRegister(e) {
  e.preventDefault();
  const name = document.getElementById("regFacultyName").value.trim();
  const username = document.getElementById("regFacultyUsername").value.trim();
  const password = document.getElementById("regFacultyPassword").value;
  const confirmPassword = document.getElementById("regFacultyConfirmPassword").value;

  if (!name || !username || !password) {
    showToast("All fields are required.", "error");
    return;
  }

  if (password !== confirmPassword) {
    showToast("Passwords do not match.", "error");
    return;
  }

  try {
    const res = await fetch("/api/faculty/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, username, password, confirmPassword }),
    });

    const data = await res.json();
    if (data.success) {
      setFacultySession(data.faculty);
      showToast("Faculty registered successfully.", "success");
      document.getElementById("facultyRegisterForm").reset();
      fetchDashboardData();
      switchView("view-dashboard");
    } else {
      showToast(data.error || "Failed to register faculty.", "error");
    }
  } catch (err) {
    console.error("Registration error:", err);
    showToast("Server error registering faculty.", "error");
  }
}

function handleLogout() {
  clearFacultySession();
  showToast("Logged out successfully.", "info");
  switchView("view-faculty-auth");
}

// -----------------------------------------------------------------------------
// CAMERA 1: STUDENT REGISTRATION CAMERA
// -----------------------------------------------------------------------------
async function startRegCamera() {
  const video = document.getElementById("regVideo");
  const placeholder = document.getElementById("regCameraPlaceholder");
  const capturedImg = document.getElementById("regCapturedImg");
  const startBtn = document.getElementById("regStartCameraBtn");
  const stopBtn = document.getElementById("regStopCameraBtn");
  const captureBtn = document.getElementById("regCaptureBtn");
  const retakeBtn = document.getElementById("regRetakeBtn");

  try {
    if (regStream) {
      regStream.getTracks().forEach((t) => t.stop());
    }

    regStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
    });

    video.srcObject = regStream;
    video.style.display = "block";
    if (placeholder) placeholder.style.display = "none";
    if (capturedImg) capturedImg.style.display = "none";

    startBtn.style.display = "none";
    stopBtn.style.display = "inline-flex";
    captureBtn.style.display = "inline-flex";
    retakeBtn.style.display = "none";

    setRegValidationStatus("Look directly at the camera with only one person in frame.", "info");
  } catch (err) {
    console.error("Camera access error:", err);
    showToast("Unable to access camera: " + err.message, "error");
  }
}

function stopRegCamera() {
  const video = document.getElementById("regVideo");
  const placeholder = document.getElementById("regCameraPlaceholder");
  const startBtn = document.getElementById("regStartCameraBtn");
  const stopBtn = document.getElementById("regStopCameraBtn");
  const captureBtn = document.getElementById("regCaptureBtn");

  if (regStream) {
    regStream.getTracks().forEach((t) => t.stop());
    regStream = null;
  }

  if (video) video.style.display = "none";
  if (placeholder && !regCapturedBase64) placeholder.style.display = "flex";

  if (startBtn) startBtn.style.display = "inline-flex";
  if (stopBtn) stopBtn.style.display = "none";
  if (captureBtn) captureBtn.style.display = "none";
}

async function captureRegPhoto() {
  const video = document.getElementById("regVideo");
  const canvas = document.getElementById("regCanvas");
  const capturedImg = document.getElementById("regCapturedImg");
  const stopBtn = document.getElementById("regStopCameraBtn");
  const captureBtn = document.getElementById("regCaptureBtn");
  const retakeBtn = document.getElementById("regRetakeBtn");

  if (!video || !regStream) return;

  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const base64 = canvas.toDataURL("image/jpeg", 0.9);
  regCapturedBase64 = base64;

  // Stop active video track & show snapshot
  stopRegCamera();
  if (capturedImg) {
    capturedImg.src = base64;
    capturedImg.style.display = "block";
  }

  retakeBtn.style.display = "inline-flex";

  // Validate single face and compute 128-d face encoding
  await validateAndEncodeRegistrationFace(canvas);
}

function retakeRegPhoto() {
  regCapturedBase64 = null;
  regCapturedDescriptor = null;

  const capturedImg = document.getElementById("regCapturedImg");
  if (capturedImg) capturedImg.style.display = "none";

  const retakeBtn = document.getElementById("regRetakeBtn");
  if (retakeBtn) retakeBtn.style.display = "none";

  setRegValidationStatus("Look directly at the camera with only one person in frame.", "info");
  startRegCamera();
}

async function handleRegFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64 = e.target.result;
    regCapturedBase64 = base64;

    const img = new Image();
    img.onload = async () => {
      const canvas = document.getElementById("regCanvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      stopRegCamera();

      const capturedImg = document.getElementById("regCapturedImg");
      const placeholder = document.getElementById("regCameraPlaceholder");
      if (placeholder) placeholder.style.display = "none";
      if (capturedImg) {
        capturedImg.src = base64;
        capturedImg.style.display = "block";
      }

      const retakeBtn = document.getElementById("regRetakeBtn");
      if (retakeBtn) retakeBtn.style.display = "inline-flex";

      await validateAndEncodeRegistrationFace(canvas);
    };
    img.src = base64;
  };
  reader.readAsDataURL(file);
}

async function validateAndEncodeRegistrationFace(imageOrCanvas) {
  setRegValidationStatus("Analyzing face with AI neural network...", "info");

  try {
    const isLoaded = await ensureFaceApiModelsLoaded();

    if (!isLoaded || !modelsLoaded || typeof faceapi === "undefined") {
      // Automatic immediate retry
      const retrySuccess = await loadFaceApiModels();
      if (!retrySuccess && (!modelsLoaded || typeof faceapi === "undefined")) {
        setRegValidationStatus("Face recognition AI model is loading. Please wait a moment and retake.", "invalid");
        showToast("Face AI models are still initializing. Please try again in a few seconds.", "error");
        regCapturedDescriptor = null;
        return;
      }
    }

    // Pass 1: SSD MobileNet V1
    let detections = await faceapi
      .detectAllFaces(imageOrCanvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    // Pass 2: Fallback to TinyFaceDetector if 0 faces found
    if (!detections || detections.length === 0) {
      detections = await faceapi
        .detectAllFaces(imageOrCanvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.25 }))
        .withFaceLandmarks()
        .withFaceDescriptors();
    }

    if (!detections || detections.length === 0) {
      regCapturedDescriptor = null;
      setRegValidationStatus("No face detected. Please look directly at the camera with good lighting.", "invalid");
      showToast("No face detected. Please look directly at the camera.", "error");
      console.log("================ REGISTRATION FACE DEBUG ================");
      console.log("Face detected: NO (0 faces found in photo)");
      console.log("=========================================================");
      return;
    }

    if (detections.length > 1) {
      regCapturedDescriptor = null;
      setRegValidationStatus("Multiple faces detected. Only one student should be in frame.", "invalid");
      showToast("Multiple faces detected. Only one student should be in frame.", "error");
      console.log("================ REGISTRATION FACE DEBUG ================");
      console.log(`Multiple faces detected: ${detections.length}`);
      console.log("=========================================================");
      return;
    }

    // Exactly 1 face detected
    const descriptor = Array.from(detections[0].descriptor);
    regCapturedDescriptor = descriptor;

    console.log("================ REGISTRATION FACE DEBUG ================");
    console.log("Face detected: YES");
    console.log("Face encoding generated: YES");
    console.log("Encoding size:", descriptor.length);
    console.log("Encoding saved: Ready to save");
    console.log("=========================================================");

    setRegValidationStatus("Face detected and verified successfully! Ready to register.", "valid");
  } catch (err) {
    console.error("[Registration] Face detection error:", err);
    regCapturedDescriptor = null;
    setRegValidationStatus("Error analyzing face. Please try again.", "invalid");
    showToast("Face detection error: " + err.message, "error");
  }
}

function setRegValidationStatus(text, state) {
  const box = document.getElementById("regValidationBox");
  const textEl = document.getElementById("regValidationText");
  const iconEl = document.getElementById("regValidationIcon");

  if (!box || !textEl) return;

  textEl.textContent = text;
  box.className = `face-validation-box ${state}`;

  if (iconEl) {
    if (state === "valid") iconEl.innerHTML = "&#10004;";
    else if (state === "invalid") iconEl.innerHTML = "&#10008;";
    else iconEl.innerHTML = "&bull;";
  }
}

async function handleStudentRegisterSubmit(e) {
  e.preventDefault();

  const name = document.getElementById("regName").value.trim();
  const roll_number = document.getElementById("regRollNumber").value.trim();
  const department = document.getElementById("regDept").value;
  const year = document.getElementById("regYear").value;
  const section = document.getElementById("regSection").value.trim();

  if (!name || !roll_number || !department || !year || !section) {
    showToast("Please fill all required fields.", "error");
    return;
  }

  if (!regCapturedBase64 || !regCapturedDescriptor || regCapturedDescriptor.length !== 128) {
    showToast("Please capture or upload a verified student face photo with 1 detected face.", "error");
    return;
  }

  const submitBtn = document.getElementById("regSubmitBtn");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving Student...";
  }

  try {
    const payload = {
      name,
      roll_number,
      department,
      year,
      section,
      image: regCapturedBase64,
      face_encoding: regCapturedDescriptor,
    };

    const res = await fetch("/api/students", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (data.success) {
      showToast(`Student ${name} (Roll: ${roll_number}) registered successfully.`, "success");
      console.log(`[Student Registered] Name: ${name}, Roll: ${roll_number}, Face encoding length: ${regCapturedDescriptor.length}`);

      document.getElementById("registerStudentForm").reset();
      regCapturedBase64 = null;
      regCapturedDescriptor = null;

      const capturedImg = document.getElementById("regCapturedImg");
      if (capturedImg) capturedImg.style.display = "none";
      const placeholder = document.getElementById("regCameraPlaceholder");
      if (placeholder) placeholder.style.display = "flex";

      setRegValidationStatus("Look directly at the camera with only one person in frame.", "info");

      await fetchStudentsData();
      await fetchDashboardData();
    } else {
      showToast(data.error || "Failed to register student.", "error");
    }
  } catch (err) {
    console.error("Student registration error:", err);
    showToast("Network error while saving student.", "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Register Student";
    }
  }
}

// -----------------------------------------------------------------------------
// CAMERA 2: ATTENDANCE SCANNER CAMERA (WITH DUPLICATE PREVENTION & 6 STATES)
// -----------------------------------------------------------------------------
function updateScannerStateUI({
  camera = "Camera not started",
  cameraRunning = false,
  face = "No face detected",
  recognition = "Waiting for scanner...",
  attendance = "Standby",
  attendanceType = "default", // 'success', 'warning', 'error', 'default'
}) {
  const cameraText = document.getElementById("stateCameraText");
  const cameraDot = document.getElementById("scannerStatusDot");
  const faceText = document.getElementById("stateFaceText");
  const recognitionText = document.getElementById("stateRecognitionText");
  const attendanceBadge = document.getElementById("stateAttendanceStatus");

  if (cameraText) cameraText.textContent = camera;
  if (cameraDot) {
    cameraDot.className = cameraRunning ? "status-dot active" : "status-dot";
  }

  if (faceText) {
    faceText.textContent = face;
    if (face.startsWith("Face detected")) {
      faceText.style.color = "var(--emerald)";
    } else if (face.includes("Multiple")) {
      faceText.style.color = "#d97706";
    } else {
      faceText.style.color = "var(--text-muted)";
    }
  }

  if (recognitionText) {
    recognitionText.textContent = recognition;
    if (recognition === "Unknown person" || recognition === "Unknown Person") {
      recognitionText.style.color = "var(--rose)";
    } else if (recognition.includes("Waiting") || recognition.includes("Scanning")) {
      recognitionText.style.color = "var(--text-muted)";
    } else {
      recognitionText.style.color = "var(--brand-blue)";
    }
  }

  if (attendanceBadge) {
    attendanceBadge.textContent = attendance;
    if (attendanceType === "success") {
      attendanceBadge.className = "status-badge present";
      attendanceBadge.style = "";
    } else if (attendanceType === "warning") {
      attendanceBadge.className = "status-badge warning";
      attendanceBadge.style = "";
    } else if (attendanceType === "error") {
      attendanceBadge.className = "status-badge absent";
      attendanceBadge.style = "";
    } else {
      attendanceBadge.className = "status-badge";
      attendanceBadge.style.background = "var(--bg-surface)";
      attendanceBadge.style.color = "var(--text-muted)";
      attendanceBadge.style.border = "1px solid var(--border-default)";
    }
  }
}

async function startScannerCamera() {
  const video = document.getElementById("scannerVideo");
  const placeholder = document.getElementById("scannerPlaceholder");
  const startBtn = document.getElementById("startScannerBtn");
  const stopBtn = document.getElementById("stopScannerBtn");
  const modeBadge = document.getElementById("scannerModeBadge");

  try {
    updateScannerStateUI({
      camera: "Starting...",
      cameraRunning: false,
      face: "No face detected",
      recognition: "Waiting for camera...",
      attendance: "Standby",
      attendanceType: "default",
    });

    await ensureFaceApiModelsLoaded();
    await fetchStudentsData();

    console.log("================ CAMERA DEBUG ================");
    console.log("Camera opened: INITIALIZING");
    console.log(`Registered students loaded: ${registeredStudents.length}`);
    registeredStudents.forEach((s) => {
      console.log(`Loaded student: Name: ${s.name} | Roll: ${s.roll_number} | Face encoding: ${s.face_encoding && s.face_encoding.length === 128 ? "available (128-d)" : "missing/invalid"}`);
    });
    console.log("=============================================");

    if (registeredStudents.length === 0) {
      showToast("Note: No students are currently registered in database. Register students first.", "info");
    }

    if (scannerStream) {
      scannerStream.getTracks().forEach((t) => t.stop());
      scannerStream = null;
    }

    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: currentScannerFacing,
      },
    });

    video.srcObject = scannerStream;
    video.style.display = "block";
    if (placeholder) placeholder.style.display = "none";

    try {
      await video.play();
    } catch (playErr) {
      console.log("[Scanner] Video play caught:", playErr);
    }

    // Wait until video has valid dimensions before marking camera running
    await new Promise((resolve) => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        resolve(true);
      } else {
        const onLoaded = () => {
          video.removeEventListener("loadedmetadata", onLoaded);
          video.removeEventListener("playing", onLoaded);
          resolve(true);
        };
        video.addEventListener("loadedmetadata", onLoaded);
        video.addEventListener("playing", onLoaded);
        setTimeout(resolve, 800);
      }
    });

    startBtn.style.display = "none";
    stopBtn.style.display = "inline-flex";

    if (modeBadge) {
      modeBadge.textContent = "Camera Running";
      modeBadge.className = "status-badge good";
    }

    // State: Camera running
    updateScannerStateUI({
      camera: "Running",
      cameraRunning: true,
      face: "No face detected",
      recognition: "Waiting for face...",
      attendance: "Scanning...",
      attendanceType: "default",
    });

    isScannerRunning = true;

    // Start recognition loop
    if (scannerInterval) clearInterval(scannerInterval);
    scannerInterval = setInterval(runScannerRecognitionLoop, 500);
  } catch (err) {
    console.error("Attendance scanner error:", err);
    let cameraStatus = "Unavailable";
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      cameraStatus = "Permission denied";
    }

    updateScannerStateUI({
      camera: cameraStatus,
      cameraRunning: false,
      face: "No face detected",
      recognition: cameraStatus,
      attendance: "Standby",
      attendanceType: "error",
    });
    showToast("Camera error: " + err.message, "error");
  }
}

function stopScannerCamera() {
  const video = document.getElementById("scannerVideo");
  const placeholder = document.getElementById("scannerPlaceholder");
  const canvas = document.getElementById("scannerCanvas");
  const startBtn = document.getElementById("startScannerBtn");
  const stopBtn = document.getElementById("stopScannerBtn");
  const modeBadge = document.getElementById("scannerModeBadge");

  isScannerRunning = false;
  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
  }

  if (scannerStream) {
    scannerStream.getTracks().forEach((t) => t.stop());
    scannerStream = null;
  }

  if (video) video.style.display = "none";
  if (placeholder) placeholder.style.display = "flex";
  if (canvas) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  if (startBtn) startBtn.style.display = "inline-flex";
  if (stopBtn) stopBtn.style.display = "none";

  if (modeBadge) {
    modeBadge.textContent = "Scanner Inactive";
    modeBadge.className = "status-badge warning";
  }

  // State 1: Camera not started
  updateScannerStateUI({
    camera: "Camera not started",
    cameraRunning: false,
    face: "No face detected",
    recognition: "Waiting for camera...",
    attendance: "Standby",
    attendanceType: "default",
  });
}

function flipScannerFacingMode() {
  currentScannerFacing = currentScannerFacing === "user" ? "environment" : "user";
  const label = document.getElementById("flipBtnLabel");
  if (label) {
    label.textContent = currentScannerFacing === "user" ? "Flip Camera (Front)" : "Flip Camera (Rear)";
  }

  if (isScannerRunning) {
    startScannerCamera();
  }
}

// Reusable offscreen capture canvas for clean frame grabbing
let scannerCaptureCanvas = null;

async function runScannerRecognitionLoop() {
  if (!isScannerRunning) return;

  const video = document.getElementById("scannerVideo");
  const canvas = document.getElementById("scannerCanvas");

  if (!video || video.readyState < 2) return;

  const videoWidth = video.videoWidth || video.clientWidth || 640;
  const videoHeight = video.videoHeight || video.clientHeight || 480;

  if (videoWidth === 0 || videoHeight === 0) return;

  canvas.width = videoWidth;
  canvas.height = videoHeight;
  const displaySize = { width: videoWidth, height: videoHeight };
  faceapi.matchDimensions(canvas, displaySize);

  if (!scannerCaptureCanvas) {
    scannerCaptureCanvas = document.createElement("canvas");
  }
  scannerCaptureCanvas.width = videoWidth;
  scannerCaptureCanvas.height = videoHeight;
  const captureCtx = scannerCaptureCanvas.getContext("2d");
  captureCtx.drawImage(video, 0, 0, videoWidth, videoHeight);

  try {
    // Multi-pass face detection for high accuracy across lighting & angles
    let detections = [];
    try {
      detections = await faceapi
        .detectAllFaces(scannerCaptureCanvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.25 }))
        .withFaceLandmarks()
        .withFaceDescriptors();
    } catch (e1) {
      // ignore
    }

    if (!detections || detections.length === 0) {
      try {
        detections = await faceapi
          .detectAllFaces(scannerCaptureCanvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.2 }))
          .withFaceLandmarks()
          .withFaceDescriptors();
      } catch (e2) {
        // ignore
      }
    }

    if (!detections || detections.length === 0) {
      try {
        detections = await faceapi
          .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.2 }))
          .withFaceLandmarks()
          .withFaceDescriptors();
      } catch (e3) {
        // ignore
      }
    }

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Case 1: No Face Detected -> STRICT: DO NOT display "Unknown Person"
    if (!detections || detections.length === 0) {
      updateScannerStateUI({
        camera: "Running",
        cameraRunning: true,
        face: "No face detected",
        recognition: "Waiting for face...",
        attendance: "Scanning...",
        attendanceType: "default",
      });

      console.log("==============================");
      console.log("FACE SCAN DEBUG");
      console.log("==============================");
      console.log("Camera frame: YES");
      console.log("Image decoded: YES");
      console.log("Faces detected: 0");
      console.log("Result: NO FACE");
      console.log("==============================");
      return;
    }

    // Case 2: Multiple Faces Detected
    if (detections.length > 1) {
      updateScannerStateUI({
        camera: "Running",
        cameraRunning: true,
        face: `Multiple faces detected (${detections.length} faces)`,
        recognition: "Multiple faces detected. Please scan one person at a time.",
        attendance: "Not Marked",
        attendanceType: "warning",
      });

      const resizedDetections = faceapi.resizeResults(detections, displaySize);
      for (const d of resizedDetections) {
        const box = d.detection.box;
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#f59e0b";
        ctx.strokeRect(box.x, box.y, box.width, box.height);

        ctx.fillStyle = "#f59e0b";
        const labelText = "Scan 1 person at a time";
        ctx.font = "bold 13px sans-serif";
        const textWidth = ctx.measureText(labelText).width;
        ctx.fillRect(box.x, Math.max(0, box.y - 24), textWidth + 14, 24);

        ctx.fillStyle = "#ffffff";
        ctx.fillText(labelText, box.x + 6, Math.max(16, box.y - 7));
      }
      return;
    }

    // Case 3: Exactly 1 Face Detected -> Proceed to Face Recognition
    const resizedDetections = faceapi.resizeResults(detections, displaySize);
    const detection = resizedDetections[0];
    const descriptor = Array.from(detections[0].descriptor);
    const box = detection.detection.box;

    const match = matchDescriptorWithDatabase(descriptor);

    if (match && match.student) {
      // Face recognized
      const student = match.student;

      // Draw GREEN bounding box around face
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#10b981";
      ctx.strokeRect(box.x, box.y, box.width, box.height);

      // Header badge with student name and roll number
      ctx.fillStyle = "#10b981";
      const labelText = `${student.name} (${student.roll_number})`;
      ctx.font = "bold 14px sans-serif";
      const textWidth = ctx.measureText(labelText).width;
      ctx.fillRect(box.x, Math.max(0, box.y - 28), textWidth + 16, 28);

      ctx.fillStyle = "#ffffff";
      ctx.fillText(labelText, box.x + 8, Math.max(18, box.y - 9));

      updateScannerStateUI({
        camera: "Running",
        cameraRunning: true,
        face: "Face detected",
        recognition: `${student.name}`,
        attendance: "Processing...",
        attendanceType: "success",
      });

      // Throttle repeated API calls for the same student within 4 seconds
      const now = Date.now();
      if (lastMarkedStudentId === student.id && now - lastMarkedTimestamp < 4000) {
        return;
      }

      lastMarkedStudentId = student.id;
      lastMarkedTimestamp = now;

      await sendMarkAttendance(student);
    } else {
      // Face detected but not matched -> Unknown Person
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ef4444";
      ctx.strokeRect(box.x, box.y, box.width, box.height);

      ctx.fillStyle = "#ef4444";
      const labelText = "Unknown Person";
      ctx.font = "bold 14px sans-serif";
      const textWidth = ctx.measureText(labelText).width;
      ctx.fillRect(box.x, Math.max(0, box.y - 28), textWidth + 16, 28);

      ctx.fillStyle = "#ffffff";
      ctx.fillText(labelText, box.x + 8, Math.max(18, box.y - 9));

      updateScannerStateUI({
        camera: "Running",
        cameraRunning: true,
        face: "Face detected",
        recognition: "Unknown Person",
        attendance: "Not Marked",
        attendanceType: "error",
      });

      displayRecognitionAlert(
        "Unknown Person. This person is not registered. Attendance NOT marked.",
        "error"
      );
    }
  } catch (err) {
    console.error("[Attendance Scanner] Detection loop error:", err);
  }
}

// -----------------------------------------------------------------------------
// Face Descriptor Matching against Database
// -----------------------------------------------------------------------------
function matchDescriptorWithDatabase(cameraDescriptor) {
  const FACE_MATCH_THRESHOLD = 0.58;

  if (!registeredStudents || registeredStudents.length === 0) {
    console.log("==============================");
    console.log("FACE SCAN DEBUG");
    console.log("==============================");
    console.log("Camera frame: YES");
    console.log("Image decoded: YES");
    console.log("RGB conversion: YES");
    console.log("Faces detected: 1");
    console.log("Face encoding: YES");
    console.log("Students loaded: 0");
    console.log("Result: NO REGISTERED STUDENTS IN DATABASE");
    console.log("==============================");
    return null;
  }

  let bestMatch = null;
  let minDistance = 999.0;

  for (const student of registeredStudents) {
    if (!student.face_encoding || !Array.isArray(student.face_encoding) || student.face_encoding.length !== 128) {
      continue;
    }

    const dist = euclideanDistance(cameraDescriptor, student.face_encoding);
    if (dist < minDistance) {
      minDistance = dist;
      bestMatch = student;
    }
  }

  const isMatch = bestMatch && minDistance <= FACE_MATCH_THRESHOLD;

  console.log("==============================");
  console.log("FACE SCAN DEBUG");
  console.log("==============================");
  console.log("Camera frame: YES");
  console.log("Image decoded: YES");
  console.log("RGB conversion: YES");
  console.log("Faces detected: 1");
  console.log("Face encoding: YES");
  console.log(`Students loaded: ${registeredStudents.length}`);
  console.log(`Best distance: ${minDistance.toFixed(4)}`);
  console.log(`Threshold: ${FACE_MATCH_THRESHOLD.toFixed(2)}`);
  console.log(`Match: ${isMatch ? "YES" : "NO"}`);
  if (isMatch) {
    console.log(`Student: ${bestMatch.name}`);
  } else {
    console.log("Result: UNKNOWN");
  }
  console.log("==============================");

  if (isMatch) {
    return { student: bestMatch, distance: minDistance };
  } else {
    return null;
  }
}

function euclideanDistance(arr1, arr2) {
  let sum = 0;
  const len = Math.min(arr1.length, arr2.length);
  for (let i = 0; i < len; i++) {
    const diff = arr1[i] - arr2[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// -----------------------------------------------------------------------------
// Test Photo File in Attendance Scanner (Verification Tool)
// -----------------------------------------------------------------------------
async function handleScannerTestFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const canvas = document.getElementById("scannerCanvas");
  const video = document.getElementById("scannerVideo");
  const placeholder = document.getElementById("scannerPlaceholder");

  try {
    await ensureFaceApiModelsLoaded();
    await fetchStudentsData();

    if (video) video.style.display = "none";
    if (placeholder) placeholder.style.display = "none";

    const reader = new FileReader();
    reader.onload = async () => {
      const img = new Image();
      img.onload = async () => {
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        showToast("Analyzing test image with face recognition model...", "info");

        let detections = [];
        try {
          detections = await faceapi
            .detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
            .withFaceLandmarks()
            .withFaceDescriptors();
        } catch (e1) {
          // ignore
        }

        if (!detections || detections.length === 0) {
          try {
            detections = await faceapi
              .detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.25 }))
              .withFaceLandmarks()
              .withFaceDescriptors();
          } catch (e2) {
            // ignore
          }
        }

        if (!detections || detections.length === 0) {
          updateScannerStateUI({
            camera: "Photo Test Mode",
            cameraRunning: true,
            face: "No face detected. Please position face in photo.",
            recognition: "No face detected",
            attendance: "Not Marked",
            attendanceType: "warning",
          });
          showToast("No face detected in test photo.", "error");
          return;
        }

        if (detections.length > 1) {
          updateScannerStateUI({
            camera: "Photo Test Mode",
            cameraRunning: true,
            face: `Multiple faces detected (${detections.length} faces)`,
            recognition: "Multiple faces detected. Please scan one student at a time.",
            attendance: "Not Marked",
            attendanceType: "warning",
          });
          return;
        }

        const detection = detections[0];
        const descriptor = Array.from(detection.descriptor);
        const box = detection.detection.box;

        const match = matchDescriptorWithDatabase(descriptor);

        if (match && match.student) {
          const student = match.student;
          ctx.lineWidth = 4;
          ctx.strokeStyle = "#10b981";
          ctx.strokeRect(box.x, box.y, box.width, box.height);

          ctx.fillStyle = "#10b981";
          const labelText = `${student.name} (${student.roll_number})`;
          ctx.font = "bold 16px sans-serif";
          const textWidth = ctx.measureText(labelText).width;
          ctx.fillRect(box.x, Math.max(0, box.y - 32), textWidth + 20, 32);

          ctx.fillStyle = "#ffffff";
          ctx.fillText(labelText, box.x + 10, Math.max(22, box.y - 10));

          updateScannerStateUI({
            camera: "Photo Test Mode",
            cameraRunning: true,
            face: "Face detected",
            recognition: `${student.name}`,
            attendance: "Processing...",
            attendanceType: "success",
          });

          await sendMarkAttendance(student);
        } else {
          ctx.lineWidth = 4;
          ctx.strokeStyle = "#ef4444";
          ctx.strokeRect(box.x, box.y, box.width, box.height);

          ctx.fillStyle = "#ef4444";
          const labelText = "Unknown Person";
          ctx.font = "bold 16px sans-serif";
          const textWidth = ctx.measureText(labelText).width;
          ctx.fillRect(box.x, Math.max(0, box.y - 32), textWidth + 20, 32);

          ctx.fillStyle = "#ffffff";
          ctx.fillText(labelText, box.x + 10, Math.max(22, box.y - 10));

          updateScannerStateUI({
            camera: "Photo Test Mode",
            cameraRunning: true,
            face: "Face detected",
            recognition: "Unknown Person",
            attendance: "Not Marked",
            attendanceType: "error",
          });

          displayRecognitionAlert(
            "Unknown Person. This person is not registered. Attendance NOT marked.",
            "error"
          );
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  } catch (err) {
    console.error("Test photo error:", err);
    showToast("Error processing test photo: " + err.message, "error");
  }
}

async function sendMarkAttendance(student) {
  try {
    const res = await fetch("/api/attendance/mark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ student_id: student.id }),
    });

    const data = await res.json();

    if (data.alreadyMarked) {
      updateScannerStateUI({
        camera: isScannerRunning ? "Running" : "Photo Test Mode",
        cameraRunning: true,
        face: "Face detected",
        recognition: `${student.name}`,
        attendance: "Already Present Today",
        attendanceType: "warning",
      });

      displayRecognitionAlert(
        `${student.name} is already Present today.`,
        "duplicate"
      );
    } else if (data.success) {
      playSuccessBeep();

      updateScannerStateUI({
        camera: isScannerRunning ? "Running" : "Photo Test Mode",
        cameraRunning: true,
        face: "Face detected",
        recognition: `${student.name}`,
        attendance: `Present (${data.student.time})`,
        attendanceType: "success",
      });

      displayRecognitionAlert(
        `Attendance marked successfully. ${student.name} Present Time: ${data.student.time}`,
        "success"
      );

      // Add to real-time attendance feed in view
      addFeedRow(data.student);

      // Update dashboard numbers
      await fetchDashboardData();
    } else {
      displayRecognitionAlert(data.error || "Attendance could not be marked.", "error");
    }
  } catch (err) {
    console.error("Mark attendance API error:", err);
  }
}

function displayRecognitionAlert(message, type) {
  const box = document.getElementById("recognitionAlertBox");
  if (!box) return;

  box.textContent = message;
  box.className = `recognition-alert-box ${type}`;
  box.style.display = "block";

  setTimeout(() => {
    if (box) box.style.display = "none";
  }, 4000);
}

function addFeedRow(student) {
  const feedBody = document.getElementById("liveAttendanceFeedBody");
  if (!feedBody) return;

  const emptyState = feedBody.querySelector(".empty-state");
  if (emptyState) {
    feedBody.innerHTML = "";
  }

  const row = document.createElement("tr");
  row.innerHTML = `
    <td><strong>${escapeHtml(student.roll_number)}</strong></td>
    <td>${escapeHtml(student.name)}</td>
    <td>${escapeHtml(student.time)}</td>
    <td style="text-align: right;"><span class="status-badge good">Present</span></td>
  `;

  feedBody.prepend(row);
}

// -----------------------------------------------------------------------------
// DASHBOARD & METRICS DATA FETCHER
// -----------------------------------------------------------------------------
async function fetchDashboardData() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();

    const dbBadge = document.getElementById("healthDatabaseBadge");

    if (data.success) {
      if (dbBadge) {
        dbBadge.className = "health-badge active";
        dbBadge.textContent = "Connected";
      }

      document.getElementById("statTotalStudents").textContent = data.totalStudents || 0;
      document.getElementById("statTotalFaculty").textContent = data.totalFaculty || 0;
      document.getElementById("statPresentToday").textContent = data.presentToday || 0;
      document.getElementById("statAbsentToday").textContent = data.absentToday || 0;
      document.getElementById("todayDateLabel").textContent = data.today || "-";

      const total = data.totalStudents || 0;
      const present = data.presentToday || 0;
      const absent = data.absentToday || 0;

      const presentPct = total > 0 ? Math.round((present / total) * 100) : 0;
      const absentPct = total > 0 ? Math.round((absent / total) * 100) : 0;

      const presentBar = document.getElementById("presentProgressBar");
      const absentBar = document.getElementById("absentProgressBar");

      if (presentBar) presentBar.style.width = `${presentPct}%`;
      if (absentBar) absentBar.style.width = `${absentPct}%`;
    } else {
      if (dbBadge) {
        dbBadge.className = "health-badge error";
        dbBadge.textContent = "Error";
      }
      showToast(data.error || "Unable to load database metrics.", "error");
    }

    // Fetch today's present and absent tables
    fetchTodayAttendanceList();
  } catch (err) {
    console.error("Error fetching dashboard data:", err);
    const dbBadge = document.getElementById("healthDatabaseBadge");
    if (dbBadge) {
      dbBadge.className = "health-badge error";
      dbBadge.textContent = "Offline";
    }
  }
}

async function fetchTodayAttendanceList() {
  try {
    const res = await fetch("/api/attendance/today");
    const data = await res.json();

    if (data.success) {
      renderTodayPresentTable(data.presentStudents || []);
      renderTodayAbsentTable(data.absentStudents || []);

      const presentBadge = document.getElementById("presentCountBadge");
      const absentBadge = document.getElementById("absentCountBadge");

      if (presentBadge) presentBadge.textContent = `${data.presentCount || 0} Present`;
      if (absentBadge) absentBadge.textContent = `${data.absentCount || 0} Absent`;
    }
  } catch (err) {
    console.error("Error fetching today's attendance:", err);
  }
}

function renderTodayPresentTable(records) {
  const tbody = document.getElementById("todayAttendanceTableBody");
  if (!tbody) return;

  if (records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No attendance records marked yet today.</td></tr>`;
    return;
  }

  tbody.innerHTML = records
    .map(
      (r) => `
      <tr>
        <td><strong>${escapeHtml(r.roll_number)}</strong></td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.department)}</td>
        <td>${escapeHtml(r.time)}</td>
        <td style="text-align: right;"><span class="status-badge good">Present</span></td>
      </tr>
    `
    )
    .join("");
}

function renderTodayAbsentTable(students) {
  const tbody = document.getElementById("absentStudentsTableBody");
  if (!tbody) return;

  if (students.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No absent students today.</td></tr>`;
    return;
  }

  tbody.innerHTML = students
    .map(
      (s) => `
      <tr>
        <td><strong>${escapeHtml(s.roll_number)}</strong></td>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.department)}</td>
        <td>${escapeHtml(s.year)} - ${escapeHtml(s.section)}</td>
        <td style="text-align: right;"><span class="status-badge absent">Absent</span></td>
      </tr>
    `
    )
    .join("");
}

// -----------------------------------------------------------------------------
// STUDENTS VIEW (LIST & DELETE)
// -----------------------------------------------------------------------------
async function fetchStudentsData() {
  try {
    const res = await fetch("/api/students");
    const data = await res.json();

    if (data.success) {
      registeredStudents = data.students || [];
      renderStudentsTable(registeredStudents);

      const countBadge = document.getElementById("studentsCountBadge");
      if (countBadge) countBadge.textContent = `${registeredStudents.length} Students`;
    }
  } catch (err) {
    console.error("Error fetching students:", err);
  }
}

function renderStudentsTable(students) {
  const tbody = document.getElementById("studentsTableBody");
  if (!tbody) return;

  if (students.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No students registered yet. Click "Register Student" to enroll.</td></tr>`;
    return;
  }

  tbody.innerHTML = students
    .map((s) => {
      const initials = s.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .substring(0, 2);

      const photoHtml = s.image
        ? `<img src="${s.image}" class="student-thumbnail-img" alt="${escapeHtml(s.name)}" />`
        : `<div class="student-thumbnail-fallback">${initials}</div>`;

      return `
        <tr>
          <td>${photoHtml}</td>
          <td><strong>${escapeHtml(s.roll_number)}</strong></td>
          <td>${escapeHtml(s.name)}</td>
          <td>${escapeHtml(s.department)}</td>
          <td>${escapeHtml(s.year)} (${escapeHtml(s.section)})</td>
          <td>${s.created_at ? s.created_at.split(" ")[0] : "-"}</td>
          <td style="text-align: right;">
            <button class="btn-icon-danger" onclick="handleDeleteStudent(${s.id}, '${escapeHtml(s.name)}')">
              Delete
            </button>
          </td>
        </tr>
      `;
    })
    .join("");
}

async function handleDeleteStudent(studentId, studentName) {
  const confirmed = confirm(`Are you sure you want to delete student "${studentName}"?\nAll associated attendance records will also be removed.`);
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/students/${studentId}`, { method: "DELETE" });
    const data = await res.json();

    if (data.success) {
      showToast("Student deleted successfully.", "success");
      fetchStudentsData();
      fetchDashboardData();
    } else {
      showToast(data.error || "Failed to delete student.", "error");
    }
  } catch (err) {
    console.error("Delete student error:", err);
    showToast("Network error deleting student.", "error");
  }
}

// -----------------------------------------------------------------------------
// ATTENDANCE HISTORY
// -----------------------------------------------------------------------------
async function fetchHistoryData() {
  const dateInput = document.getElementById("historyDateInput");
  const searchInput = document.getElementById("historySearchInput");
  const countLabel = document.getElementById("historyCountLabel");
  const tbody = document.getElementById("historyTableBody");

  const date = dateInput ? dateInput.value : "";
  const search = searchInput ? searchInput.value.trim() : "";

  try {
    const params = new URLSearchParams();
    if (date) params.append("date", date);
    if (search) params.append("search", search);

    const res = await fetch(`/api/attendance/history?${params.toString()}`);
    const data = await res.json();

    if (data.success) {
      const records = data.records || [];
      if (countLabel) countLabel.textContent = `${records.length} Records`;

      if (records.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No attendance records found for date "${date}".</td></tr>`;
        return;
      }

      tbody.innerHTML = records
        .map(
          (r) => `
          <tr>
            <td><strong>${escapeHtml(r.roll_number)}</strong></td>
            <td>${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.department)}</td>
            <td>${escapeHtml(r.date)}</td>
            <td>${escapeHtml(r.time)}</td>
            <td style="text-align: right;"><span class="status-badge good">Present</span></td>
          </tr>
        `
        )
        .join("");
    }
  } catch (err) {
    console.error("History fetch error:", err);
  }
}

function exportHistoryCsv() {
  const dateInput = document.getElementById("historyDateInput");
  const date = dateInput ? dateInput.value : "attendance";

  const rows = [["Roll Number", "Student Name", "Department", "Date", "Time", "Status"]];

  const tableRows = document.querySelectorAll("#historyTableBody tr");
  tableRows.forEach((tr) => {
    const cols = tr.querySelectorAll("td");
    if (cols.length >= 6) {
      rows.push([
        cols[0].innerText.trim(),
        cols[1].innerText.trim(),
        cols[2].innerText.trim(),
        cols[3].innerText.trim(),
        cols[4].innerText.trim(),
        cols[5].innerText.trim(),
      ]);
    }
  });

  if (rows.length <= 1) {
    showToast("No attendance records to export.", "info");
    return;
  }

  const csvContent = "data:text/csv;charset=utf-8," + rows.map((e) => e.join(",")).join("\n");
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `attendance_report_${date}.csv`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  showToast("CSV report exported.", "success");
}

// -----------------------------------------------------------------------------
// ATTENDANCE REPORTS & PERCENTAGES
// -----------------------------------------------------------------------------
async function fetchReportsData() {
  try {
    const res = await fetch("/api/reports");
    const data = await res.json();

    if (data.success) {
      const reports = data.reports || [];
      const totalClasses = data.totalClassesConducted || 0;

      document.getElementById("reportTotalDays").textContent = totalClasses;

      // Calculate overall average attendance percentage
      let avgPct = 0;
      if (reports.length > 0) {
        const sumPct = reports.reduce((acc, r) => acc + (r.percentage || 0), 0);
        avgPct = Math.round(sumPct / reports.length);
      }

      document.getElementById("reportAvgPercentage").textContent = `${avgPct}%`;
      const avgBar = document.getElementById("reportAvgProgressBar");
      if (avgBar) avgBar.style.width = `${avgPct}%`;

      renderReportsTable(reports);
    }
  } catch (err) {
    console.error("Reports fetch error:", err);
  }
}

function renderReportsTable(reports) {
  const tbody = document.getElementById("reportsTableBody");
  if (!tbody) return;

  if (reports.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No student records available for reporting.</td></tr>`;
    return;
  }

  tbody.innerHTML = reports
    .map((r) => {
      const badgeClass = r.percentage >= 75 ? "good" : "absent";
      return `
        <tr>
          <td><strong>${escapeHtml(r.roll_number)}</strong></td>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.department)} (${escapeHtml(r.year)})</td>
          <td>${r.totalClasses}</td>
          <td><span class="text-emerald" style="font-weight: 600;">${r.present}</span></td>
          <td><span class="text-rose" style="font-weight: 600;">${r.absent}</span></td>
          <td><strong>${r.percentage}%</strong></td>
          <td style="text-align: right;"><span class="status-badge ${badgeClass}">${r.statusBadge}</span></td>
        </tr>
      `;
    })
    .join("");
}

// -----------------------------------------------------------------------------
// RESET HELPERS
// -----------------------------------------------------------------------------
async function resetTodayAttendance() {
  const confirmed = confirm("Are you sure you want to reset and clear today's attendance logs?");
  if (!confirmed) return;

  try {
    const res = await fetch("/api/attendance/reset-today", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, "success");
      fetchDashboardData();
    }
  } catch (err) {
    showToast("Error resetting attendance.", "error");
  }
}

async function confirmClearAllData() {
  const confirmed = confirm("WARNING: This will completely reset all students, attendance records, and faculty accounts.\n\nDo you want to proceed?");
  if (!confirmed) return;

  try {
    const res = await fetch("/api/reset-all-data", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      clearFacultySession();
      showToast("All database records cleared successfully.", "success");
      fetchDashboardData();
      fetchStudentsData();
      switchView("view-dashboard");
    }
  } catch (err) {
    showToast("Error clearing database.", "error");
  }
}

// Helper: Escape HTML string to prevent XSS
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// -----------------------------------------------------------------------------
// FACULTY AUTHENTICATION TOGGLE (Login vs Register)
// -----------------------------------------------------------------------------
function toggleFacultyAuthMode(mode) {
  const loginCard = document.getElementById("facultyLoginCard");
  const regCard = document.getElementById("facultyRegisterCard");
  const loginBtn = document.getElementById("authToggleLogin");
  const regBtn = document.getElementById("authToggleRegister");

  if (mode === "register") {
    if (loginCard) loginCard.style.display = "none";
    if (regCard) regCard.style.display = "block";
    if (loginBtn) loginBtn.classList.remove("active");
    if (regBtn) regBtn.classList.add("active");
  } else {
    if (loginCard) loginCard.style.display = "block";
    if (regCard) regCard.style.display = "none";
    if (loginBtn) loginBtn.classList.add("active");
    if (regBtn) regBtn.classList.remove("active");
  }
}

// -----------------------------------------------------------------------------
// MASTER ADMIN PORTAL & DATABASE ENGINE
// -----------------------------------------------------------------------------
let adminToken = localStorage.getItem("smart_attendance_admin_token") || null;
let currentAdminTab = "admin-tab-overview";

function getAdminAuthHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (adminToken) {
    headers["x-admin-token"] = adminToken;
  }
  return headers;
}

async function checkAdminSessionAndRender() {
  const lockedState = document.getElementById("adminLockedState");
  const unlockedState = document.getElementById("adminUnlockedState");

  if (!adminToken) {
    if (lockedState) lockedState.style.display = "block";
    if (unlockedState) unlockedState.style.display = "none";
    return;
  }

  try {
    const res = await fetch("/api/admin/status", {
      headers: { "x-admin-token": adminToken },
    });
    const data = await res.json();
    if (data.loggedIn) {
      if (lockedState) lockedState.style.display = "none";
      if (unlockedState) unlockedState.style.display = "block";
      refreshAdminActiveTab();
    } else {
      localStorage.removeItem("smart_attendance_admin_token");
      adminToken = null;
      if (lockedState) lockedState.style.display = "block";
      if (unlockedState) unlockedState.style.display = "none";
    }
  } catch (err) {
    if (lockedState) lockedState.style.display = "block";
    if (unlockedState) unlockedState.style.display = "none";
  }
}

async function handleAdminLogin(event) {
  event.preventDefault();
  const passwordInput = document.getElementById("adminPasswordInput");
  const password = passwordInput ? passwordInput.value : "";
  const submitBtn = document.getElementById("adminLoginBtn");

  if (!password) {
    showToast("Please enter the admin password.", "error");
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span>Verifying...</span>`;
  }

  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();

    if (data.success && data.token) {
      adminToken = data.token;
      localStorage.setItem("smart_attendance_admin_token", adminToken);
      showToast("Master Admin Authentication Successful.", "success");
      if (passwordInput) passwordInput.value = "";
      checkAdminSessionAndRender();
    } else {
      showToast(data.error || "Invalid Admin Password.", "error");
    }
  } catch (err) {
    showToast("Failed to connect to authentication server.", "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<span>Unlock Admin Portal</span>`;
    }
  }
}

async function handleAdminLogout() {
  if (adminToken) {
    try {
      await fetch("/api/admin/logout", {
        method: "POST",
        headers: { "x-admin-token": adminToken },
      });
    } catch (e) {}
  }
  localStorage.removeItem("smart_attendance_admin_token");
  adminToken = null;
  showToast("Admin session ended.", "info");
  checkAdminSessionAndRender();
}

function switchAdminTab(tabId) {
  currentAdminTab = tabId;
  const tabBtns = document.querySelectorAll(".admin-nav-btn");
  tabBtns.forEach((btn) => {
    if (btn.dataset.tab === tabId) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  const tabPanes = document.querySelectorAll(".admin-tab-pane");
  tabPanes.forEach((pane) => {
    if (pane.id === tabId) {
      pane.classList.add("active");
    } else {
      pane.classList.remove("active");
    }
  });

  refreshAdminActiveTab();
}

function refreshAdminActiveTab() {
  if (!adminToken) return;

  if (currentAdminTab === "admin-tab-overview") {
    fetchAdminOverviewStats();
  } else if (currentAdminTab === "admin-tab-faculty") {
    fetchAdminFacultyList();
  } else if (currentAdminTab === "admin-tab-students") {
    fetchAdminStudentsList();
  } else if (currentAdminTab === "admin-tab-attendance") {
    fetchAdminAttendance();
  } else if (currentAdminTab === "admin-tab-database") {
    fetchAdminOverviewStats();
    loadAndDisplayAdminJson();
  }
}

async function fetchAdminOverviewStats() {
  try {
    const res = await fetch("/api/admin/stats", {
      headers: getAdminAuthHeaders(),
    });
    const data = await res.json();
    if (data.success && data.stats) {
      const s = data.stats;
      const elFac = document.getElementById("adminTotalFaculty");
      const elStu = document.getElementById("adminTotalStudents");
      const elPres = document.getElementById("adminPresentToday");
      const elAbs = document.getElementById("adminAbsentToday");
      const elTot = document.getElementById("adminTotalAttendance");
      const elDbDesc = document.getElementById("adminDatabaseStatusDesc");

      if (elFac) elFac.textContent = s.totalFaculty;
      if (elStu) elStu.textContent = s.totalStudents;
      if (elPres) elPres.textContent = s.presentToday;
      if (elAbs) elAbs.textContent = s.absentToday;
      if (elTot) elTot.textContent = s.totalAttendanceRecords;

      if (elDbDesc) {
        elDbDesc.innerHTML = `<span style="color: #059669; font-weight: 600;">Active Central Database:</span> ${s.database_file || "attendance.db"} &bull; 100% Offline-First &bull; Authoritative`;
      }
    }
  } catch (err) {
    console.error("Error fetching admin stats:", err);
  }
}

// -------------------------------------------------------------
// Admin Modal Helpers
// -------------------------------------------------------------
function openModal(modalId) {
  const m = document.getElementById(modalId);
  if (m) m.style.display = "flex";
}

function closeModal(modalId) {
  const m = document.getElementById(modalId);
  if (m) m.style.display = "none";
}

// -------------------------------------------------------------
// Admin Faculty Management Functions
// -------------------------------------------------------------
function openAddFacultyModal() {
  const form = document.getElementById("formAddFaculty");
  if (form) form.reset();
  openModal("modalAddFaculty");
}

async function submitAddFaculty(event) {
  event.preventDefault();
  const name = (document.getElementById("addFacultyName")?.value || "").trim();
  const username = (document.getElementById("addFacultyUsername")?.value || "").trim();
  const password = document.getElementById("addFacultyPassword")?.value || "";

  if (!name || !username || !password) {
    showToast("Please fill all fields.", "error");
    return;
  }

  const submitBtn = document.getElementById("btnAddFacultySubmit");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating...";
  }

  try {
    const res = await fetch("/api/admin/faculty", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAdminAuthHeaders(),
      },
      body: JSON.stringify({ name, username, password }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || "Faculty created successfully.", "success");
      closeModal("modalAddFaculty");
      fetchAdminFacultyList();
      fetchAdminOverviewStats();
    } else {
      showToast(data.error || "Failed to create faculty.", "error");
    }
  } catch (err) {
    showToast("Network error creating faculty.", "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create Faculty";
    }
  }
}

function openEditFacultyModal(id, name, username) {
  const idEl = document.getElementById("editFacultyId");
  const nameEl = document.getElementById("editFacultyName");
  const userEl = document.getElementById("editFacultyUsername");
  if (idEl) idEl.value = id;
  if (nameEl) nameEl.value = name;
  if (userEl) userEl.value = username;
  openModal("modalEditFaculty");
}

async function submitEditFaculty(event) {
  event.preventDefault();
  const id = document.getElementById("editFacultyId")?.value;
  const name = (document.getElementById("editFacultyName")?.value || "").trim();
  const username = (document.getElementById("editFacultyUsername")?.value || "").trim();

  if (!id || !name || !username) {
    showToast("All fields are required.", "error");
    return;
  }

  try {
    const res = await fetch(`/api/admin/faculty/${id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...getAdminAuthHeaders(),
      },
      body: JSON.stringify({ name, username }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || "Faculty updated.", "success");
      closeModal("modalEditFaculty");
      fetchAdminFacultyList();
    } else {
      showToast(data.error || "Failed to update faculty.", "error");
    }
  } catch (err) {
    showToast("Network error updating faculty.", "error");
  }
}

function openResetFacultyPasswordModal(id, name) {
  const idEl = document.getElementById("resetFacultyId");
  const descEl = document.getElementById("resetFacultyDesc");
  const passEl = document.getElementById("resetFacultyNewPassword");
  if (idEl) idEl.value = id;
  if (descEl) descEl.textContent = `Enter a new password for faculty member "${name}".`;
  if (passEl) passEl.value = "";
  openModal("modalResetFacultyPassword");
}

async function submitResetFacultyPassword(event) {
  event.preventDefault();
  const id = document.getElementById("resetFacultyId")?.value;
  const newPassword = document.getElementById("resetFacultyNewPassword")?.value || "";

  if (!id || !newPassword) {
    showToast("Please enter a new password.", "error");
    return;
  }

  try {
    const res = await fetch(`/api/admin/faculty/${id}/reset-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAdminAuthHeaders(),
      },
      body: JSON.stringify({ newPassword }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || "Password updated.", "success");
      closeModal("modalResetFacultyPassword");
    } else {
      showToast(data.error || "Failed to reset password.", "error");
    }
  } catch (err) {
    showToast("Network error resetting password.", "error");
  }
}

async function fetchAdminFacultyList() {
  const tbody = document.getElementById("adminFacultyTableBody");
  const badge = document.getElementById("adminFacultyCountBadge");
  if (!tbody) return;

  try {
    const res = await fetch("/api/admin/faculty", {
      headers: getAdminAuthHeaders(),
    });
    const data = await res.json();
    if (data.success && Array.isArray(data.faculty)) {
      if (badge) badge.textContent = `${data.faculty.length} Faculty`;
      if (data.faculty.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No faculty members registered in database yet.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.faculty
        .map(
          (f) => `
          <tr>
            <td>#${f.id}</td>
            <td><strong>${escapeHtml(f.name)}</strong></td>
            <td><code>${escapeHtml(f.username)}</code></td>
            <td>${escapeHtml(f.created_at || "N/A")}</td>
            <td style="text-align: right; white-space: nowrap;">
              <button class="btn btn-secondary btn-sm" style="margin-right: 4px;" onclick="openEditFacultyModal(${f.id}, '${escapeHtml(f.name).replace(/'/g, "\\'")}', '${escapeHtml(f.username).replace(/'/g, "\\'")}')">
                Edit
              </button>
              <button class="btn btn-secondary btn-sm" style="margin-right: 4px;" onclick="openResetFacultyPasswordModal(${f.id}, '${escapeHtml(f.name).replace(/'/g, "\\'")}')">
                Reset Pwd
              </button>
              <button class="btn btn-secondary btn-sm" style="color: var(--status-absent); border-color: rgba(225,29,72,0.3);" onclick="deleteFacultyMember(${f.id}, '${escapeHtml(f.name).replace(/'/g, "\\'")}')">
                Delete
              </button>
            </td>
          </tr>
        `
        )
        .join("");
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state" style="color: var(--status-absent);">Failed to load faculty list.</td></tr>`;
  }
}

async function deleteFacultyMember(id, name) {
  const confirmed = confirm(`Are you sure you want to delete faculty member "${name}"?`);
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/admin/faculty/${id}`, {
      method: "DELETE",
      headers: getAdminAuthHeaders(),
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || "Faculty deleted.", "success");
      fetchAdminFacultyList();
      fetchAdminOverviewStats();
    } else {
      showToast(data.error || "Failed to delete faculty member.", "error");
    }
  } catch (err) {
    showToast("Error deleting faculty member.", "error");
  }
}

// -------------------------------------------------------------
// Admin Student Management Functions
// -------------------------------------------------------------
let adminStudentsCache = [];

async function fetchAdminStudentsList() {
  const tbody = document.getElementById("adminStudentsTableBody");
  const badge = document.getElementById("adminStudentCountBadge");
  if (!tbody) return;

  try {
    const res = await fetch("/api/admin/students", {
      headers: getAdminAuthHeaders(),
    });
    const data = await res.json();
    if (data.success && Array.isArray(data.students)) {
      adminStudentsCache = data.students;
      if (badge) badge.textContent = `${data.students.length} Students`;
      if (data.students.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No students enrolled yet.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.students
        .map(
          (s) => `
          <tr>
            <td>
              <img src="${s.image || '/images/default-avatar.svg'}" alt="${escapeHtml(s.name)}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border-default);" onerror="this.onerror=null; this.src='/images/default-avatar.svg'" />
            </td>
            <td>#${s.id}</td>
            <td><strong>${escapeHtml(s.roll_number)}</strong></td>
            <td>${escapeHtml(s.name)}</td>
            <td>${escapeHtml(s.department)}</td>
            <td>${escapeHtml(s.year)} - ${escapeHtml(s.section)}</td>
            <td>${escapeHtml(s.created_at || "N/A")}</td>
            <td style="text-align: right; white-space: nowrap;">
              <button class="btn btn-secondary btn-sm" style="margin-right: 4px;" onclick="openViewStudentModal(${s.id})">
                View
              </button>
              <button class="btn btn-secondary btn-sm" style="margin-right: 4px;" onclick="openEditStudentModal(${s.id}, '${escapeHtml(s.name).replace(/'/g, "\\'")}', '${escapeHtml(s.roll_number).replace(/'/g, "\\'")}', '${escapeHtml(s.department).replace(/'/g, "\\'")}', '${escapeHtml(s.year).replace(/'/g, "\\'")}', '${escapeHtml(s.section).replace(/'/g, "\\'")}')">
                Edit
              </button>
              <button class="btn btn-secondary btn-sm" style="color: var(--status-absent); border-color: rgba(225,29,72,0.3);" onclick="deleteAdminStudent(${s.id}, '${escapeHtml(s.name).replace(/'/g, "\\'")}')">
                Delete
              </button>
            </td>
          </tr>
        `
        )
        .join("");
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state" style="color: var(--status-absent);">Failed to load students.</td></tr>`;
  }
}

function openViewStudentModal(id) {
  const s = adminStudentsCache.find((item) => item.id === id);
  if (!s) return;

  const imgEl = document.getElementById("viewStudentImg");
  const nameEl = document.getElementById("viewStudentName");
  const rollEl = document.getElementById("viewStudentRoll");
  const deptEl = document.getElementById("viewStudentDept");
  const ysEl = document.getElementById("viewStudentYearSection");
  const createdEl = document.getElementById("viewStudentCreated");

  if (imgEl) imgEl.src = s.image || "/images/default-avatar.png";
  if (nameEl) nameEl.textContent = s.name;
  if (rollEl) rollEl.textContent = `Roll No: ${s.roll_number}`;
  if (deptEl) deptEl.textContent = `Department: ${s.department}`;
  if (ysEl) ysEl.textContent = `Year ${s.year}, Section ${s.section}`;
  if (createdEl) createdEl.textContent = s.created_at || "N/A";

  openModal("modalViewStudent");
}

function openEditStudentModal(id, name, roll, dept, year, section) {
  const idEl = document.getElementById("editStudentId");
  const nameEl = document.getElementById("editStudentName");
  const rollEl = document.getElementById("editStudentRoll");
  const deptEl = document.getElementById("editStudentDept");
  const yearEl = document.getElementById("editStudentYear");
  const secEl = document.getElementById("editStudentSection");

  if (idEl) idEl.value = id;
  if (nameEl) nameEl.value = name;
  if (rollEl) rollEl.value = roll;
  if (deptEl) deptEl.value = dept;
  if (yearEl) yearEl.value = year;
  if (secEl) secEl.value = section;

  openModal("modalEditStudent");
}

async function submitEditStudent(event) {
  event.preventDefault();
  const id = document.getElementById("editStudentId")?.value;
  const name = (document.getElementById("editStudentName")?.value || "").trim();
  const roll_number = (document.getElementById("editStudentRoll")?.value || "").trim();
  const department = (document.getElementById("editStudentDept")?.value || "").trim();
  const year = (document.getElementById("editStudentYear")?.value || "").trim();
  const section = (document.getElementById("editStudentSection")?.value || "").trim();

  if (!id || !name || !roll_number || !department || !year || !section) {
    showToast("All student fields are required.", "error");
    return;
  }

  const submitBtn = document.getElementById("btnEditStudentSubmit");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving...";
  }

  try {
    const res = await fetch(`/api/admin/students/${id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...getAdminAuthHeaders(),
      },
      body: JSON.stringify({ name, roll_number, department, year, section }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || "Student updated.", "success");
      closeModal("modalEditStudent");
      fetchAdminStudentsList();
      fetchStudentsData();
    } else {
      showToast(data.error || "Failed to update student.", "error");
    }
  } catch (err) {
    showToast("Network error updating student.", "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Update Student";
    }
  }
}

async function deleteAdminStudent(id, name) {
  const confirmed = confirm(`Are you sure you want to remove student "${name}" and their facial embeddings?`);
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/admin/students/${id}`, {
      method: "DELETE",
      headers: getAdminAuthHeaders(),
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || "Student deleted.", "success");
      fetchAdminStudentsList();
      fetchAdminOverviewStats();
      fetchStudentsData();
    } else {
      showToast(data.error || "Failed to remove student.", "error");
    }
  } catch (err) {
    showToast("Error deleting student.", "error");
  }
}

// -------------------------------------------------------------
// Admin Attendance Records
// -------------------------------------------------------------
async function fetchAdminAttendance() {
  const tbody = document.getElementById("adminAttendanceTableBody");
  if (!tbody) return;

  const dateInput = document.getElementById("adminAttendanceDateFilter");
  const searchInput = document.getElementById("adminAttendanceSearch");

  const date = dateInput ? dateInput.value : "";
  const search = searchInput ? searchInput.value : "";

  const queryParams = new URLSearchParams();
  if (date) queryParams.set("date", date);
  if (search) queryParams.set("search", search);

  try {
    const res = await fetch(`/api/admin/attendance?${queryParams.toString()}`, {
      headers: getAdminAuthHeaders(),
    });
    const data = await res.json();
    if (data.success && Array.isArray(data.records)) {
      if (data.records.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No attendance records match the current filter.</td></tr>`;
        return;
      }

      tbody.innerHTML = data.records
        .map(
          (r) => `
          <tr>
            <td>#${r.id}</td>
            <td><strong>${escapeHtml(r.roll_number || "N/A")}</strong></td>
            <td>${escapeHtml(r.student_name || "Unknown")}</td>
            <td>${escapeHtml(r.department || "N/A")}</td>
            <td>${escapeHtml(r.date)}</td>
            <td><code>${escapeHtml(r.time)}</code></td>
            <td style="text-align: right;">
              <button class="btn btn-secondary btn-sm" style="color: var(--status-absent); border-color: rgba(225,29,72,0.3);" onclick="deleteAdminAttendanceRecord(${r.id})">
                Delete Log
              </button>
            </td>
          </tr>
        `
        )
        .join("");
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state" style="color: var(--status-absent);">Failed to load attendance logs.</td></tr>`;
  }
}

async function deleteAdminAttendanceRecord(id) {
  const confirmed = confirm("Are you sure you want to delete this attendance log entry?");
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/admin/attendance/${id}`, {
      method: "DELETE",
      headers: getAdminAuthHeaders(),
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || "Attendance log deleted.", "success");
      fetchAdminAttendance();
      fetchAdminOverviewStats();
    } else {
      showToast(data.error || "Failed to delete attendance log.", "error");
    }
  } catch (err) {
    showToast("Error deleting attendance log.", "error");
  }
}

// -------------------------------------------------------------
// Admin Database Backup & JSON Export
// -------------------------------------------------------------
async function handleCreateDatabaseBackup() {
  const backupBtn = document.getElementById("adminBackupDbBtn");
  if (backupBtn) {
    backupBtn.disabled = true;
    backupBtn.innerHTML = `<span>Creating .db Backup...</span>`;
  }

  try {
    const res = await fetch("/api/admin/backup-db", {
      method: "POST",
      headers: getAdminAuthHeaders(),
    });
    const data = await res.json();

    if (data.success) {
      showToast(data.message || "Database backed up successfully.", "success");
      fetchAdminOverviewStats();
    } else {
      showToast(data.error || "Failed to create database backup.", "error");
    }
  } catch (err) {
    showToast("Error creating database backup.", "error");
  } finally {
    if (backupBtn) {
      backupBtn.disabled = false;
      backupBtn.innerHTML = `
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" width="16" height="16" class="btn-icon">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
        </svg>
        <span>Backup Database (.db)</span>
      `;
    }
  }
}

function handleDownloadDbFile() {
  if (!adminToken) {
    showToast("Admin authentication token required.", "error");
    return;
  }
  window.location.href = `/api/admin/download-db?token=${encodeURIComponent(adminToken)}`;
}

async function loadAndDisplayAdminJson() {
  const pre = document.getElementById("adminJsonPreviewCode");
  if (!pre) return;

  pre.textContent = "Loading sanitized database snapshot...";

  try {
    const res = await fetch("/api/admin/json-data", {
      headers: getAdminAuthHeaders(),
    });
    const data = await res.json();
    if (data.success && data.data) {
      pre.textContent = JSON.stringify(data.data, null, 2);
    } else {
      pre.textContent = "// Error loading database JSON schema.";
    }
  } catch (err) {
    pre.textContent = `// Error loading JSON export: ${err.message}`;
  }
}

function downloadAdminJsonExport() {
  if (!adminToken) {
    showToast("Admin authentication token required.", "error");
    return;
  }
  window.location.href = `/api/admin/export-json?token=${encodeURIComponent(adminToken)}`;
}

function copyJsonToClipboard() {
  const pre = document.getElementById("adminJsonPreviewCode");
  if (!pre) return;

  navigator.clipboard.writeText(pre.textContent).then(
    () => showToast("JSON database schema copied to clipboard.", "success"),
    () => showToast("Failed to copy JSON.", "error")
  );
}

