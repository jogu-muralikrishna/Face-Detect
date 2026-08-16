"""
Vercel Serverless WSGI Entry Point for Smart Attendance Management System
"""
import sys
import os
import traceback

# Add root directory and python_project to Python sys.path
root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
python_proj_dir = os.path.join(root_dir, "python_project")

if root_dir not in sys.path:
    sys.path.insert(0, root_dir)
if python_proj_dir not in sys.path:
    sys.path.insert(0, python_proj_dir)

try:
    from python_project.app import app
except Exception as e:
    print(f"[Vercel Handler Crash] Failed to import app: {e}")
    traceback.print_exc()
    from flask import Flask, jsonify
    app = Flask(__name__)
    err_str = str(e)
    tb_str = traceback.format_exc()

    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def catch_all(path):
        return jsonify({
            "error": "Serverless Function Startup Error",
            "message": err_str,
            "traceback": tb_str
        }), 500

# Vercel WSGI entry points (supports both standard 'handler' and 'app')
handler = app
