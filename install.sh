#!/usr/bin/env bash
# FiberQuest — Linux installer
# Supports: x86_64 (amd64), aarch64 (arm64)
# Usage: curl -fsSL <url>/install.sh | bash
#        or: bash install.sh [--appimage-only] [--dir <install-dir>]
set -e

APP_NAME="FiberQuest"
GITHUB_REPO="toastmanAu/fiberquest"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
DESKTOP_DIR="${DESKTOP_DIR:-$HOME/.local/share/applications}"
RELEASES_BASE="https://github.com/${GITHUB_REPO}/releases"

# ── Color output ───────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✔${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err()  { echo -e "${RED}✘${NC} $*" >&2; }
info() { echo -e "${CYAN}→${NC} $*"; }
header() { echo -e "\n${BOLD}$*${NC}"; }

# ── Detect architecture ────────────────────────────────────
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)           APPIMAGE_ARCH="x86_64" ;;
  aarch64|arm64)    APPIMAGE_ARCH="arm64"  ;;
  *)
    err "Unsupported architecture: $ARCH"
    err "FiberQuest supports x86_64 and aarch64 (arm64)"
    exit 1
    ;;
esac

header "FiberQuest Installer"
info "Architecture: ${ARCH} → ${APPIMAGE_ARCH}"

# Resolve latest version from GitHub redirect
info "Resolving latest release..."
LATEST_URL=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "${RELEASES_BASE}/latest" 2>/dev/null)
APP_VERSION="${LATEST_URL##*/v}"
if [[ -z "$APP_VERSION" || "$APP_VERSION" == "$LATEST_URL" ]]; then
  err "Could not resolve latest version from GitHub."
  err "Check: ${RELEASES_BASE}/latest"
  exit 1
fi
ok "Latest version: ${APP_VERSION}"

APPIMAGE_FILE="FiberQuest-${APP_VERSION}-linux-${APPIMAGE_ARCH}.AppImage"
APPIMAGE_URL="${RELEASES_BASE}/download/v${APP_VERSION}/${APPIMAGE_FILE}"

# ── Parse args ─────────────────────────────────────────────
APPIMAGE_ONLY=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --appimage-only) APPIMAGE_ONLY=1; shift ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    *) warn "Unknown option: $1"; shift ;;
  esac
done

# ── Dependencies ───────────────────────────────────────────
header "Checking dependencies..."

check_dep() {
  if command -v "$1" &>/dev/null; then ok "$1 found"; return 0
  else warn "$1 not found"; return 1; fi
}

check_dep curl  || { err "curl is required. Install with: sudo apt install curl"; exit 1; }
check_dep fuse  || warn "libfuse2 may be needed for AppImage. Install with: sudo apt install libfuse2"

# ── Download AppImage ──────────────────────────────────────
header "Downloading ${APPIMAGE_FILE}..."
mkdir -p "$INSTALL_DIR"
DEST="${INSTALL_DIR}/fiberquest"

if command -v curl &>/dev/null; then
  curl -L --progress-bar -o "${DEST}.AppImage" "$APPIMAGE_URL"
else
  wget -q --show-progress -O "${DEST}.AppImage" "$APPIMAGE_URL"
fi
chmod +x "${DEST}.AppImage"

# Symlink without extension for convenience
ln -sf "${DEST}.AppImage" "${DEST}" 2>/dev/null || true
ok "Installed to ${DEST}.AppImage"

# ── Desktop entry ──────────────────────────────────────────
if [[ $APPIMAGE_ONLY -eq 0 ]]; then
  header "Creating desktop entry..."
  mkdir -p "$DESKTOP_DIR"
  cat > "${DESKTOP_DIR}/fiberquest.desktop" <<EOF
[Desktop Entry]
Name=FiberQuest
Comment=Retro gaming tournament platform with Fiber Network micropayments
Exec=${DEST}.AppImage
Icon=fiberquest
Terminal=false
Type=Application
Categories=Game;
StartupWMClass=fiberquest
EOF
  ok "Desktop entry created"
fi

# ── RetroArch check ────────────────────────────────────────
header "Checking RetroArch..."
if command -v retroarch &>/dev/null; then
  ok "RetroArch found: $(command -v retroarch)"
else
  warn "RetroArch not found."
  echo ""
  echo "  FiberQuest can launch games locally when RetroArch is installed."
  echo "  Install options:"
  echo ""
  echo "    Snap:    sudo snap install retroarch"
  echo "    Apt:     sudo apt install retroarch"
  echo "    Flatpak: flatpak install flathub org.libretro.RetroArch"
  echo ""

  if [[ $APPIMAGE_ONLY -eq 0 ]]; then
    read -rp "  Install RetroArch via snap now? [y/N] " ans
    if [[ "${ans,,}" == "y" ]]; then
      if command -v snap &>/dev/null; then
        info "Running: snap install retroarch"
        snap install retroarch && ok "RetroArch installed via snap" || warn "snap install failed — install manually"
      else
        warn "snapd not available. Install RetroArch manually using one of the options above."
      fi
    fi
  fi
fi

# ── Done ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}FiberQuest installed!${NC}"
echo ""
echo "  Run:     ${DEST}.AppImage"
echo "  Or:      fiberquest  (if ${INSTALL_DIR} is in your PATH)"
echo ""

# Offer to add to PATH if not already there
if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
  SHELL_RC=""
  [[ -f "$HOME/.bashrc" ]]  && SHELL_RC="$HOME/.bashrc"
  [[ -f "$HOME/.zshrc"  ]]  && SHELL_RC="$HOME/.zshrc"
  if [[ -n "$SHELL_RC" ]]; then
    read -rp "  Add ${INSTALL_DIR} to PATH in ${SHELL_RC}? [Y/n] " ans
    if [[ "${ans,,}" != "n" ]]; then
      echo "" >> "$SHELL_RC"
      echo "export PATH=\"\$PATH:${INSTALL_DIR}\"" >> "$SHELL_RC"
      ok "Added to PATH. Run: source ${SHELL_RC}"
    fi
  fi
fi
