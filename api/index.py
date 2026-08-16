"""
=============================================================================
Vercel Serverless WSGI Entry Point for Smart Attendance Management System
=============================================================================
"""
import sys
import os

# Add root directory and python_project to Python sys.path
root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
python_proj_dir = os.path.join(root_dir, "python_project")

if root_dir not in sys.path:
    sys.path.insert(0, root_dir)
if python_proj_dir not in sys.path:
    sys.path.insert(0, python_proj_dir)

from python_project.app import app

# Export both handler and app for Vercel Python Serverless builder
handler = app
