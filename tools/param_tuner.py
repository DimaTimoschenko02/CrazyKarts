"""
Kart Physics Parameter Tuner
Run: python tools/param_tuner.py
Open: http://localhost:8070
Edits dev_params.json directly — Godot hot-reloads in 0.5s.
"""
import http.server
import json
import os
import sys

PORT = 8070
PARAMS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dev_params.json")

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            html_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "param_tuner.html")
            with open(html_path, "r", encoding="utf-8") as f:
                self.wfile.write(f.read().encode("utf-8"))
        elif self.path == "/params":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            with open(PARAMS_FILE, "r", encoding="utf-8") as f:
                self.wfile.write(f.read().encode("utf-8"))
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == "/params":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            try:
                data = json.loads(body)
                with open(PARAMS_FILE, "w", encoding="utf-8", newline="\n") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                    f.write("\n")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')
                print(f"  Saved {len([k for k in data if not k.startswith('_')])} params")
            except json.JSONDecodeError as e:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(f'{{"error":"{e}"}}'.encode())
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        if "/params" in str(args):
            super().log_message(format, *args)

if __name__ == "__main__":
    print(f"Param Tuner: http://localhost:{PORT}")
    print(f"Editing: {PARAMS_FILE}")
    print("Ctrl+C to stop\n")
    server = http.server.HTTPServer(("", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
