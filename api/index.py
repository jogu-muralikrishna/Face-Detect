"""
Vercel Serverless WSGI Entry Point for Smart Attendance Management System
"""
import sys
import os

# Add root directory and python_project to Python sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "python_project"))

from python_project.app import app

# Vercel WSGI entry point
handler = app
