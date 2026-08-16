"""
Vercel Serverless WSGI Entry Point for Smart Attendance Management System
"""
import os
import sys

# Setup search paths for modules
_api_dir = os.path.dirname(os.path.abspath(__file__))
_root_dir = os.path.dirname(_api_dir)
_proj_dir = os.path.join(_root_dir, "python_project")

if _root_dir not in sys.path:
    sys.path.insert(0, _root_dir)
if _proj_dir not in sys.path:
    sys.path.insert(0, _proj_dir)

# Import the Flask WSGI instance
from python_project.app import app

# Explicit top-level entry points for Vercel Python Runtime
application = app
handler = app
