"""
=============================================================================
Face Recognition Module (Safe Pre-Trained & Browser Model Integration)
=============================================================================
Provides face encoding comparison and image storage.
Designed to be lightweight and serverless-friendly with pure-Python fallback.
"""

import json
import base64
import math
import os
import database

# Optional imports for local advanced development
try:
    import numpy as np
except Exception:
    np = None

try:
    import cv2
except Exception:
    cv2 = None

try:
    import face_recognition
except Exception:
    face_recognition = None


def save_base64_image(base64_str, output_path):
    """Saves a base64 encoded image to a local file."""
    try:
        if "," in base64_str:
            base64_str = base64_str.split(",")[1]
        img_bytes = base64.b64decode(base64_str)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "wb") as f:
            f.write(img_bytes)
        return True
    except Exception as e:
        print(f"Error saving image: {e}")
        return False


def calculate_euclidean_distance(v1, v2):
    """Computes Euclidean distance between two vectors in pure Python."""
    if not v1 or not v2 or len(v1) != len(v2):
        return 999.0
    return math.sqrt(sum((float(a) - float(b)) ** 2 for a, b in zip(v1, v2)))


def extract_face_encoding_from_base64(base64_str):
    """
    Extracts a 128-dimensional face encoding directly from a base64 camera image.
    Uses face_recognition if available, otherwise returns None.
    """
    if face_recognition is None or cv2 is None or np is None:
        return None, "Server-side dlib is not installed. Face recognition is handled by the client browser."

    try:
        if "," in base64_str:
            base64_str = base64_str.split(",")[1]
        img_bytes = base64.b64decode(base64_str)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img_bgr is None:
            return None, "Invalid image data."

        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        face_locations = face_recognition.face_locations(img_rgb)

        if len(face_locations) == 0:
            return None, "No face detected. Please look directly at the camera."

        if len(face_locations) > 1:
            return None, "Multiple faces detected. Only one student should be visible."

        face_encodings = face_recognition.face_encodings(img_rgb, face_locations)
        if len(face_encodings) == 0:
            return None, "Could not compute face encoding."

        return list(face_encodings[0]), None
    except Exception as e:
        return None, f"Error extracting face: {str(e)}"


def recognize_face_from_base64(base64_str, tolerance=0.58):
    """
    Decodes a base64 image from web camera, detects face,
    and compares its 128-d encoding against all registered students in the database.
    """
    if face_recognition is None or cv2 is None or np is None:
        return None, "Server-side face_recognition not installed. Biometrics are verified via client AI."

    try:
        if "," in base64_str:
            base64_str = base64_str.split(",")[1]

        img_bytes = base64.b64decode(base64_str)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img_bgr is None:
            return None, "Invalid image data received."

        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        face_locations = face_recognition.face_locations(img_rgb)
        if len(face_locations) == 0:
            return None, "No face detected in camera view."

        face_encodings = face_recognition.face_encodings(img_rgb, face_locations)
        if len(face_encodings) == 0:
            return None, "Could not extract face encoding from camera frame."

        camera_encoding = list(face_encodings[0])
        students = database.get_all_students()
        if not students:
            return None, "No registered students in database."

        best_match_student = None
        min_distance = 999.0

        for student in students:
            if not student.get("face_encoding"):
                continue

            try:
                stored_encoding = json.loads(student["face_encoding"]) if isinstance(student["face_encoding"], str) else student["face_encoding"]
                distance = calculate_euclidean_distance(stored_encoding, camera_encoding)

                if distance < tolerance and distance < min_distance:
                    min_distance = distance
                    best_match_student = student
            except Exception:
                continue

        if best_match_student is not None:
            return dict(best_match_student), None
        else:
            return None, "Unknown person. Attendance not marked."

    except Exception as e:
        return None, f"Recognition error: {str(e)}"
