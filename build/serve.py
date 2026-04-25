#!/usr/bin/env python3
"""
HTTP server for Godot 4 HTML5 exports.
Adds required Cross-Origin Isolation headers.
"""
import http.server
import socketserver
import sys
from pathlib import Path

PORT = 8060

class GodotHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Required headers for SharedArrayBuffer and Godot 4 threading
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        # Cache control for development
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def log_message(self, format, *args):
        # Custom log format
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), format % args))

if __name__ == '__main__':
    # Change to web directory
    import os
    script_dir = Path(__file__).parent
    web_dir = script_dir / 'web'
    
    if web_dir.exists() and web_dir.is_dir():
        os.chdir(str(web_dir))
        print(f"Serving from: {web_dir.absolute()}")
    else:
        print(f"ERROR: {web_dir} not found!")
        print(f"Script location: {script_dir.absolute()}")
        sys.exit(1)
    
    class ThreadedHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
        allow_reuse_address = True
        daemon_threads = True

    with ThreadedHTTPServer(("", PORT), GodotHTTPRequestHandler) as httpd:
        print(f"Server running at http://localhost:{PORT}")
        print(f"Open http://localhost:{PORT}/index.html in your browser")
        print("Press Ctrl+C to stop")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped")
