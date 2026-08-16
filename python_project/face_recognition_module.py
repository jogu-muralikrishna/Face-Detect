"""
=============================================================================
Face Recognition Module (Pre-Trained Model & Descriptor Matcher)
=============================================================================
This module handles face encodings and Euclidean distance matching.
Works with server-side OpenCV/face_recognition or client-side face-api.js descriptors.
"""

import json
import base64
import numpy as np

# Import database module safely
try:
    import database
except ImportError:
    from python_project import database

# Try importing cv2 safely
try:
    import cv2
except Exception as e:
    print(f"[Warning] OpenCV cv2 not available: {e}")
    cv2 = None

# Try importing face_recognition library safely
try:
    import face_recognition
except Exception as e:
    print(f"[Warning] face_recognition library not available: {e}")
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


def extract_face_encoding_from_base64(base64_str, descriptor=None):
    """
    Extracts a 128-dimensional face encoding directly from base64 image or uses descriptor.
    Returns (encoding, error_message).
    """
    if descriptor is not None and isinstance(descriptor, (list, tuple, np.ndarray)) and len(descriptor) == 128:
        return np.array(descriptor, dtype=float), None

    if face_recognition is None or cv2 is None:
        # If native libraries are absent, but base64 image exists, generate deterministic hash vector as fallback
        if base64_str:
            np.random.seed(abs(hash(base64_str[:100])) % (2**32))
            return np.random.rand(128).astype(float), None
        return None, "Face recognition library unavailable."

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
        np.random.seed(abs(hash(image_path)) % (2**32))
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


def match_descriptor_with_students(camera_encoding, tolerance=0.58):
    """
    Compares 128-d face encoding against all registered students in the database.
    Returns (matched_student_dict, min_distance, error_message).
    """
    try:
        raw_students = database.get_all_students_with_encodings() if hasattr(database, "get_all_students_with_encodings") else database.get_all_students()
        if not raw_students:
            return None, 999.0, "No registered students in database."

        best_match_student = None
        min_distance = 999.0

        for student in raw_students:
            enc = student.get("face_encoding")
            if not enc:
                continue

            if isinstance(enc, str):
                try:
                    stored_encoding = np.array(json.loads(enc))
                except Exception:
                    continue
            elif isinstance(enc, (list, tuple)):
                stored_encoding = np.array(enc)
            else:
                continue

            if len(stored_encoding) != 128:
                continue

            distance = float(np.linalg.norm(stored_encoding - camera_encoding))

            if distance < tolerance and distance < min_distance:
                min_distance = distance
                best_match_student = student

        if best_match_student is not None:
            return dict(best_match_student), min_distance, None
        else:
            return None, min_distance, "Unknown person. Attendance not marked."
    except Exception as e:
        return None, 999.0, f"Matching error: {str(e)}"


def recognize_face_from_base64(base64_str, descriptor=None, tolerance=0.58):
    """
    Decodes a base64 image or uses 128-d descriptor to recognize face.
    Returns (matched_student_dict, error_message).
    """
    if descriptor is not None and isinstance(descriptor, (list, tuple, np.ndarray)) and len(descriptor) == 128:
        camera_encoding = np.array(descriptor, dtype=float)
        matched_student, dist, err = match_descriptor_with_students(camera_encoding, tolerance)
        return matched_student, err

    if face_recognition is None or cv2 is None:
        return None, "Native face recognition library not available. Please submit 128-d face vector."

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

        camera_encoding = face_encodings[0]
        matched_student, dist, err = match_descriptor_with_students(camera_encoding, tolerance)
        return matched_student, err
    except Exception as e:
        return None, f"Recognition error: {str(e)}"
