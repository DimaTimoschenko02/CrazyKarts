"""
Kart Physics Parameter Tuner
Run: python tools/param_tuner.py
Open: http://localhost:8070
Edits dev_params.json (desktop hot-reload) AND bakes physics values into
resources/kart_physics_default.tres (used by web exports).
"""
import http.server
import json
import os
import re

PORT = 8070
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARAMS_FILE = os.path.join(ROOT, "dev_params.json")
PHYSICS_TRES = os.path.join(ROOT, "resources", "kart_physics_default.tres")

# dev_params key  ->  field name in KartPhysicsResource (.tres)
# Mirrors mapping in scripts/kart_controller.gd::_on_dev_params_changed
DEV_TO_TRES = {
    "MAX_SPEED": "max_speed",
    "ACCEL_FORCE": "accel_force",
    "K_DRAG": "k_drag",
    "K_ROLLING": "k_rolling",
    "BRAKE_FORCE": "brake_force",
    "REVERSE_RATIO": "reverse_ratio",
    "STEER_SLEW_IN": "steer_slew_rate_in",
    "STEER_SLEW_OUT": "steer_slew_rate_out",
    "THROTTLE_SLEW": "throttle_slew_rate",
    "STEER_VISUAL_RATE": "steer_visual_rate",
    "STEERING_SPEED": "steering_speed",
    "STEER_LOW_MULT": "steer_low_speed_mult",
    "STEER_HIGH_MULT": "steer_high_speed_mult",
    "STEER_SPEED_THRESHOLD": "steer_speed_threshold",
    "STATIONARY_STEER_THRESHOLD": "stationary_steer_threshold",
    "STATIONARY_STEER_SCALE": "stationary_steer_scale",
    "WHEEL_RADIUS": "wheel_radius",
    "HIGH_GRIP": "high_grip_target",
    "LOW_GRIP": "low_grip_target",
    "GRIP_LOSS_RATE": "grip_loss_rate",
    "GRIP_RECOVERY_RATE": "grip_recovery_rate",
    "DRIFT_MIN_SPEED": "drift_min_speed",
    "DRIFT_MAX_SLIP_ANGLE_DEG": "drift_max_slip_angle_deg",
    "SLIP_SMOOTHING": "slip_smoothing",
    "DRIFT_INTENT_MULTIPLIER": "drift_intent_multiplier",
    "DRIFT_INTENT_THRESHOLD": "drift_intent_threshold",
    "GRIP_SLIP_EXPONENT": "grip_slip_exponent",
    "DRIFT_YAW_MULTIPLIER": "drift_yaw_multiplier",
    "DRIFT_ACTIVE_THRESHOLD": "drift_active_threshold",
    "VFX_SMOKE_THRESHOLD": "vfx_smoke_speed_threshold",
    "DRIFT_DRAG_MULTIPLIER": "drift_drag_multiplier",
    "DRIFT_ROLLING_MULTIPLIER": "drift_rolling_multiplier",
    "CORNERING_DRAG_COEFF": "cornering_drag_coeff",
    "VISUAL_DRIFT_MAX_DEG": "visual_drift_max_deg",
    "VISUAL_LEAN_RECOVERY_SPEED": "visual_lean_recovery_speed",
    "GRAVITY": "gravity",
    "FLOOR_ALIGN_SPEED": "floor_align_speed",
    "SLOPE_INFLUENCE": "slope_speed_influence",
}


def _format_tres_value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(float(value))
    if isinstance(value, float):
        s = repr(value)
        return s if "." in s or "e" in s else f"{s}.0"
    return str(value)


def bake_to_tres(dev_params: dict) -> int:
    if not os.path.exists(PHYSICS_TRES):
        return 0
    with open(PHYSICS_TRES, "r", encoding="utf-8") as f:
        text = f.read()

    overrides = {
        DEV_TO_TRES[k]: v
        for k, v in dev_params.items()
        if k in DEV_TO_TRES and not isinstance(v, str)
    }

    written = 0
    for field, value in overrides.items():
        pattern = re.compile(rf"^({re.escape(field)}\s*=\s*).*$", re.MULTILINE)
        new_text, count = pattern.subn(lambda m: f"{m.group(1)}{_format_tres_value(value)}", text, count=1)
        if count:
            text = new_text
            written += 1

    with open(PHYSICS_TRES, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return written


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
                baked = bake_to_tres(data)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')
                live_count = len([k for k in data if not k.startswith('_')])
                print(f"  Saved {live_count} params -> dev_params.json | baked {baked} -> kart_physics_default.tres")
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
    print(f"Editing:    {PARAMS_FILE}")
    print(f"Baking to:  {PHYSICS_TRES}")
    print("Ctrl+C to stop\n")
    server = http.server.HTTPServer(("", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
