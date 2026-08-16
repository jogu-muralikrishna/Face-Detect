"""
=============================================================================
Face Recognition Module (Pre-Trained Model)
=============================================================================
This module uses the pre-trained `face_recognition` library (built on dlib / ResNet)
and OpenCV.
It detects faces, generates 128-dimensional encodings, and matches faces using
Euclidean distance.
"""

import json
import base64
import numpy as np
import database

# Try importing cv2 safely for serverless environments
try:
    import cv2
except Exception as e:
    print(f"[Warning] OpenCV (cv2) not available or failed to load: {e}")
    cv2 = None

# Try importing face_recognition library
try:
    import face_recognition
except Exception as e:
    print(f"[Warning] face_recognition not available or failed to load: {e}")
    face_recognition = None


def save_base64_image(base64_str, output_path):
    """Saves a base64 encoded image to a local file."""
    try:
        if "," in base64_str:
            base64_str = base64_str.split(",")[1]
        img_bytes = base64.b64decode(base64_str)
        with open(output_path, "wb") as f:
            f.write(img_bytes)
        return True
    except Exception as e:
        print(f"Error saving image: {e}")
        return False


def extract_face_encoding_from_base64(base64_str):
    """
    Extracts a 128-dimensional face encoding directly from a base64 camera image.
    Enforces the single-face validation rule:
      - 0 faces: "No face detected. Please look directly at the camera."
      - >1 faces: "Multiple faces detected. Only one student should be visible."
      - 1 face: returns (encoding, None)
    """
    if face_recognition is None:
        # Fallback simulator for development environment if dlib/face_recognition is unavailable
        return np.random.rand(128).astype(float), None

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
            return None, "Could not compute face encoding. Please try again with better lighting."

        return face_encodings[0], None
    except Exception as e:
        return None, f"Error extracting face: {str(e)}"


def extract_face_encoding(image_path):
    """
    Extracts a 128-dimensional face encoding from an image file.
    Returns (encoding, error_message).
    """
    if face_recognition is None:
        return np.random.rand(128).astype(float), None

    try:
        image = face_recognition.load_image_file(image_path)
        face_locations = face_recognition.face_locations(image)

        if len(face_locations) == 0:
            return None, "No face detected. Please look directly at the camera."

        if len(face_locations) > 1:
            return None, "Multiple faces detected. Only one student should be visible."

        face_encodings = face_recognition.face_encodings(image, face_locations)
        if len(face_encodings) == 0:
            return None, "Could not encode face. Please try another photo."

        return face_encodings[0], None
    except Exception as e:
        return None, f"Error processing image: {str(e)}"


def recognize_face_from_base64(base64_str, tolerance=0.58):
    """
    Decodes a base64 image from web camera, detects face,
    and compares its 128-d encoding against all registered students in SQLite.
    Returns (matched_student_dict, error_message).
    """
    if face_recognition is None:
        return None, "face_recognition library not installed."

    try:
        # Remove header if present (e.g. 'data:image/jpeg;base64,')
        if "," in base64_str:
            base64_str = base64_str.split(",")[1]

        # Decode base64 to numpy image
        img_bytes = base64.b64decode(base64_str)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img_bgr is None:
            return None, "Invalid image data received."

        # Convert BGR to RGB (Crucial for face_recognition / dlib models)
        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)

        # Detect faces in camera frame
        face_locations = face_recognition.face_locations(img_rgb)
        if len(face_locations) == 0:
            print("[Debug] Face detected: NO")
            return None, "No face detected in camera view."

        print(f"[Debug] Face detected: YES ({len(face_locations)} face(s))")

        face_encodings = face_recognition.face_encodings(img_rgb, face_locations)
        if len(face_encodings) == 0:
            return None, "Could not extract face encoding from camera frame."

        camera_encoding = face_encodings[0]
        print(f"[Debug] Face encoding generated, length: {len(camera_encoding)}")

        # Fetch all registered students and their stored encodings from SQLite
        students = database.get_all_students()
        if not students:
            print("[Debug] No registered students in database.")
            return None, "No registered students in database."

        print(f"[Debug] Comparing with {len(students)} registered student(s)...")

        best_match_student = None
        min_distance = 999.0

        for student in students:
            if not student["face_encoding"]:
                continue

            stored_encoding = np.array(json.loads(student["face_encoding"]))
            # Calculate Euclidean distance
            distance = float(np.linalg.norm(stored_encoding - camera_encoding))
            print(f"[Debug] Student: {student['name']} (Roll: {student['roll_number']}) | Distance: {distance:.4f} | Threshold: {tolerance}")

            if distance < tolerance and distance < min_distance:
                min_distance = distance
                best_match_student = student

        if best_match_student is not None:
            print(f"[Debug] >>> MATCH CONFIRMED: {best_match_student['name']} (Distance: {min_distance:.4f})")
            return dict(best_match_student), None
        else:
            print(f"[Debug] >>> UNKNOWN PERSON: Closest distance was {min_distance:.4f} (Threshold: {tolerance})")
            return None, "Unknown person. Attendance not marked."

    except Exception as e:
        print(f"[Debug] Recognition error: {e}")
        return None, f"Recognition error: {str(e)}"
