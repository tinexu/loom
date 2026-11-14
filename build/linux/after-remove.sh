#!/bin/sh
# Runs after the Loom .deb is removed.
set -e
if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove x-terminal-emulator /usr/bin/loom || true
fi
if [ -L '/usr/bin/loom' ] && [ ! -e '/usr/bin/loom' ]; then rm -f '/usr/bin/loom'; fi
if [ ! -e '/opt/Loom' ]; then rm -f '/usr/bin/loom'; fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
