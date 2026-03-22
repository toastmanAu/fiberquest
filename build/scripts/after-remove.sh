#!/bin/bash
# Post-remove script for FiberQuest .deb package
update-desktop-database /usr/share/applications 2>/dev/null || true
gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true
