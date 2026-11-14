#!/bin/sh
# Runs after the Loom .deb is installed.
set -e

# The `loom` command, and the electron binary's sandbox helper (as
# electron-builder's own script does).
ln -sf '/opt/Loom/resources/bin/loom' '/usr/bin/loom'
if [ -f '/opt/Loom/chrome-sandbox' ]; then
  chown root '/opt/Loom/chrome-sandbox' || true
  chmod 4755 '/opt/Loom/chrome-sandbox' || true
fi

# Loom as a terminal for programs that open one (x-terminal-emulator -e …).
if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --install /usr/bin/x-terminal-emulator x-terminal-emulator /usr/bin/loom 20 || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true; fi
