#!/bin/bash
set -e

# Resolve the data dir once and hand it to the server, so the two can never
# disagree. An explicit CLOAKBROWSER_DATA_DIR wins; otherwise a Railway volume
# is used wherever it was mounted (Railway exports its path); otherwise /data.
# If the server wrote to the volume while this script cleaned lock files in
# /data, a crash would leave profiles permanently unlaunchable.
DATA_DIR="${CLOAKBROWSER_DATA_DIR:-${RAILWAY_VOLUME_MOUNT_PATH:-/data}}"
export CLOAKBROWSER_DATA_DIR="$DATA_DIR"

# Initialize data directories
mkdir -p "$DATA_DIR/profiles" "$DATA_DIR/fonts"

# Warn when the data dir is not a mount: everything works until the next
# redeploy, which silently wipes every profile, cookie, and session. Warn only —
# a throwaway local run without a volume is legitimate.
if ! mountpoint -q "$DATA_DIR" 2>/dev/null \
    && ! awk -v d="$DATA_DIR" '$2 == d { found = 1 } END { exit !found }' /proc/mounts 2>/dev/null; then
    echo ""
    echo "  WARNING: $DATA_DIR is not a mounted volume."
    echo "  Profiles, cookies, and sessions will be LOST on restart or redeploy."
    echo "  Docker: -v <host-dir>:$DATA_DIR    Railway: attach a volume to this service."
    echo ""
fi

# Register operator-supplied Windows fonts. The image ships none of the
# Microsoft-proprietary set, so a Windows-spoofing profile enumerates Linux
# fonts unless the operator drops their own licensed C:\Windows\Fonts files
# into $DATA_DIR/fonts. Symlink rather than copy: fontconfig follows it, and the
# next restart picks up anything newly added with no rebuild.
# Best-effort — a font problem must never stop the container from booting.
if [ -n "$(ls -A "$DATA_DIR/fonts" 2>/dev/null)" ]; then
    ln -sfn "$DATA_DIR/fonts" /usr/share/fonts/truetype/windows 2>/dev/null || true
    fc-cache -f >/dev/null 2>&1 || true
fi

# Kill stale processes from previous container runs
pkill -f 'Xvnc :[0-9]' 2>/dev/null || true
pkill -f 'cloakbrowser.*chrome' 2>/dev/null || true
pkill -f 'chromium.*fingerprint' 2>/dev/null || true
pkill -f 'camoufox-bin' 2>/dev/null || true
pkill -f xclip 2>/dev/null || true

# Clean Chrome lock files left on the persistent volume
find "$DATA_DIR/profiles" -maxdepth 2 -name 'SingletonLock' -delete 2>/dev/null || true
find "$DATA_DIR/profiles" -maxdepth 2 -name 'SingletonCookie' -delete 2>/dev/null || true
find "$DATA_DIR/profiles" -maxdepth 2 -name 'SingletonSocket' -delete 2>/dev/null || true

# Firefox/Camoufox equivalents. Firefox refuses a profile it believes is still
# open, so a crashed container would otherwise leave the profile unlaunchable.
find "$DATA_DIR/profiles" -maxdepth 2 -name '.parentlock' -delete 2>/dev/null || true
find "$DATA_DIR/profiles" -maxdepth 2 -name 'lock' -delete 2>/dev/null || true

# Remove X11 lock files from previous displays
rm -f /tmp/.X1*-lock 2>/dev/null || true

# Start the Node backend (serves built React + API)
cd /app/server
echo ""
echo "  AstraBrowser Manager running at http://localhost:8080"
echo "  Data dir: $DATA_DIR"
echo ""
exec node dist/index.js
