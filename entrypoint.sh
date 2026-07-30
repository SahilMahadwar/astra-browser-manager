#!/bin/bash
set -e

# Initialize data directories
mkdir -p /data/profiles /data/fonts

# Register operator-supplied Windows fonts. The image ships none of the
# Microsoft-proprietary set, so a Windows-spoofing profile enumerates Linux
# fonts unless the operator drops their own licensed C:\Windows\Fonts files
# into /data/fonts. Symlink rather than copy: fontconfig follows it, and the
# next restart picks up anything newly added with no rebuild.
# Best-effort — a font problem must never stop the container from booting.
if [ -n "$(ls -A /data/fonts 2>/dev/null)" ]; then
    ln -sfn /data/fonts /usr/share/fonts/truetype/windows 2>/dev/null || true
    fc-cache -f >/dev/null 2>&1 || true
fi

# Kill stale processes from previous container runs
pkill -f 'Xvnc :[0-9]' 2>/dev/null || true
pkill -f 'cloakbrowser.*chrome' 2>/dev/null || true
pkill -f 'chromium.*fingerprint' 2>/dev/null || true
pkill -f xclip 2>/dev/null || true

# Clean Chrome lock files left on the persistent volume
find /data/profiles -maxdepth 2 -name 'SingletonLock' -delete 2>/dev/null || true
find /data/profiles -maxdepth 2 -name 'SingletonCookie' -delete 2>/dev/null || true
find /data/profiles -maxdepth 2 -name 'SingletonSocket' -delete 2>/dev/null || true

# Remove X11 lock files from previous displays
rm -f /tmp/.X1*-lock 2>/dev/null || true

# Start the Node backend (serves built React + API)
cd /app/server
echo ""
echo "  AstraBrowser Manager running at http://localhost:8080"
echo ""
exec node dist/index.js
