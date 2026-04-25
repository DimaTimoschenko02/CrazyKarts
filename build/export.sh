#!/usr/bin/env bash
# export.sh — exports both Web and Linux Server builds
# Run from the project root: bash build/export.sh
# Works in Git Bash on Windows and bash on Linux.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Godot binary detection ────────────────────────────────────────────────────

GODOT_BIN=""

# Windows paths (Git Bash)
WIN_CONSOLE="C:/Godot_v4.6.1-stable_win64_console.exe"
WIN_GUI="C:/Godot_v4.6.1-stable_win64.exe"

if [[ -x "${WIN_CONSOLE}" ]]; then
    GODOT_BIN="${WIN_CONSOLE}"
elif [[ -x "${WIN_GUI}" ]]; then
    GODOT_BIN="${WIN_GUI}"
elif command -v godot &>/dev/null; then
    GODOT_BIN="godot"
elif command -v godot4 &>/dev/null; then
    GODOT_BIN="godot4"
fi

if [[ -z "${GODOT_BIN}" ]]; then
    echo "[ERROR] Godot binary not found."
    echo "  - On Windows: expected at ${WIN_CONSOLE}"
    echo "  - On Linux:   'godot' or 'godot4' must be in PATH"
    exit 1
fi

echo "[export.sh] Using Godot: ${GODOT_BIN}"

# ── Pre-check: warn if Godot editor process is running ───────────────────────
# Exporting while the editor has the project open can cause file lock conflicts.

EDITOR_RUNNING=false
if command -v tasklist &>/dev/null; then
    # Windows
    if tasklist 2>/dev/null | grep -qi "Godot_v4"; then
        EDITOR_RUNNING=true
    fi
elif command -v pgrep &>/dev/null; then
    # Linux/macOS
    if pgrep -if "godot" &>/dev/null; then
        EDITOR_RUNNING=true
    fi
fi

if [[ "${EDITOR_RUNNING}" == "true" ]]; then
    echo ""
    echo "[WARNING] Godot editor appears to be running."
    echo "  Exporting while the editor is open may cause file lock issues."
    echo "  Close the Godot editor before running this script."
    echo ""
    read -r -p "  Continue anyway? [y/N] " answer
    if [[ "${answer}" != "y" && "${answer}" != "Y" ]]; then
        echo "Aborting."
        exit 1
    fi
fi

# ── Ensure output directories exist ──────────────────────────────────────────

mkdir -p "${PROJECT_ROOT}/build/web"
mkdir -p "${PROJECT_ROOT}/build/server"

# ── Export Web ────────────────────────────────────────────────────────────────

echo ""
echo "[export.sh] Exporting Web build..."
"${GODOT_BIN}" --headless --export-release "Web" "${PROJECT_ROOT}/build/web/index.html" \
    --path "${PROJECT_ROOT}" 2>&1
echo "[export.sh] Web build done -> build/web/index.html"

# ── Export Linux Server ───────────────────────────────────────────────────────

echo ""
echo "[export.sh] Exporting Linux Server build..."
"${GODOT_BIN}" --headless --export-release "Linux Server" "${PROJECT_ROOT}/build/server/smash-karts-server.x86_64" \
    --path "${PROJECT_ROOT}" 2>&1
echo "[export.sh] Linux Server build done -> build/server/smash-karts-server.x86_64"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "[export.sh] All exports complete."
echo "  Web:    build/web/index.html"
echo "  Server: build/server/smash-karts-server.x86_64"
echo ""
echo "Next steps:"
echo "  1. Test Web build locally:  python build/serve.py"
echo "  2. Deploy to VPS:           see deploy/README.md"
