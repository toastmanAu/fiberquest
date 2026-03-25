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

# Resolve latest version via GitHub API (works for pre-releases too)
info "Resolving latest release..."
API_URL="https://api.github.com/repos/${GITHUB_REPO}/releases"
APP_VERSION=$(curl -fsSL "$API_URL" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name":[[:space:]]*"v\([^"]*\)".*/\1/')
if [[ -z "$APP_VERSION" ]]; then
  err "Could not resolve latest version from GitHub."
  err "Check: https://github.com/${GITHUB_REPO}/releases"
  exit 1
fi
ok "Latest version: ${APP_VERSION}"

# electron-builder names: arm64 → ProductName-version-arm64.AppImage
#                          x64  → ProductName-version.AppImage (no arch suffix)
if [[ "$APPIMAGE_ARCH" == "arm64" ]]; then
  APPIMAGE_FILE="FiberQuest-${APP_VERSION}-arm64.AppImage"
else
  APPIMAGE_FILE="FiberQuest-${APP_VERSION}.AppImage"
fi
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

check_dep curl || { err "curl is required. Install with: sudo apt install curl"; exit 1; }

# AppImage requires libfuse2 — check the actual library, not the fuse binary
check_fuse() {
  ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2' && return 0
  [[ -f /usr/lib/aarch64-linux-gnu/libfuse.so.2 ]] && return 0
  [[ -f /usr/lib/x86_64-linux-gnu/libfuse.so.2  ]] && return 0
  return 1
}

if check_fuse; then
  ok "libfuse2 found"
else
  warn "libfuse2 not found — required for AppImage"
  if command -v apt-get &>/dev/null; then
    info "Installing libfuse2..."
    # Ubuntu 24.04+ renamed libfuse2 → libfuse2t64; try both
    sudo apt-get install -y libfuse2t64 2>/dev/null || sudo apt-get install -y libfuse2
    check_fuse && ok "libfuse2 installed" || {
      err "Failed to install libfuse2. Try manually: sudo apt install libfuse2t64"
      exit 1
    }
  elif command -v dnf &>/dev/null; then
    info "Installing fuse-libs..."
    sudo dnf install -y fuse-libs && ok "fuse-libs installed" || {
      err "Failed to install fuse-libs. Try manually: sudo dnf install fuse-libs"
      exit 1
    }
  elif command -v pacman &>/dev/null; then
    info "Installing fuse2..."
    sudo pacman -S --noconfirm fuse2 && ok "fuse2 installed" || {
      err "Failed to install fuse2. Try manually: sudo pacman -S fuse2"
      exit 1
    }
  else
    err "Cannot auto-install libfuse2 — unknown package manager."
    err "Install it manually then re-run this script."
    exit 1
  fi
fi

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

# ── Fix missing libz.so symlink on arm64 (Pi OS / Ubuntu 24.04) ────────────
# Some ARM64 distros ship libz.so.1 but not the unversioned libz.so,
# which causes the AppImage Chromium to fail with "libz.so: not found"
if [[ "$APPIMAGE_ARCH" == "arm64" ]]; then
  LIBZ_SO="/usr/lib/aarch64-linux-gnu/libz.so"
  LIBZ_SO1="/usr/lib/aarch64-linux-gnu/libz.so.1"
  if [[ ! -f "$LIBZ_SO" && -f "$LIBZ_SO1" ]]; then
    info "Creating missing libz.so symlink (required for AppImage on ARM64)..."
    sudo ln -sf "$LIBZ_SO1" "$LIBZ_SO" && ok "libz.so symlink created" || warn "Could not create libz.so symlink — app may fail to start"
  fi
fi

# Wrapper script — adds --no-sandbox for Pi/ARM compatibility
# Also handles Wayland (Pi OS Bookworm default) vs X11 automatically
# (use printf, not heredoc — heredocs break when script is run via curl | bash)
printf '#!/usr/bin/env bash\n# Auto-detect Wayland vs X11\nif [ -n "$WAYLAND_DISPLAY" ] || [ "$XDG_SESSION_TYPE" = "wayland" ]; then\n  OZONE="--ozone-platform=wayland --enable-features=WaylandWindowDecorations"\nelse\n  OZONE=""\nfi\nexec "%s.AppImage" --no-sandbox $OZONE "$@"\n' "${DEST}" > "${DEST}"
chmod +x "${DEST}"
ok "Installed to ${DEST}.AppImage"

# ── Icon ───────────────────────────────────────────────────
header "Installing icon..."
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
mkdir -p "$ICON_DIR"
ICON_URL="https://raw.githubusercontent.com/${GITHUB_REPO}/main/build/icon.png"
if curl -fsSL "$ICON_URL" -o "${ICON_DIR}/fiberquest.png" 2>/dev/null; then
  ok "Icon installed"
  gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
else
  warn "Could not download icon (non-fatal)"
fi

# ── Desktop entry ──────────────────────────────────────────
if [[ $APPIMAGE_ONLY -eq 0 ]]; then
  header "Creating desktop entry..."
  mkdir -p "$DESKTOP_DIR"
  cat > "${DESKTOP_DIR}/fiberquest.desktop" <<EOF
[Desktop Entry]
Name=FiberQuest
Comment=Retro gaming tournament platform with Fiber Network micropayments
Exec=${DEST}
Icon=${ICON_DIR}/fiberquest.png
Terminal=false
Type=Application
Categories=Game;
StartupWMClass=fiberquest
EOF
  ok "Desktop entry created"
fi

# ── RetroArch (flatpak) ─────────────────────────────────────
header "Setting up RetroArch..."

# FiberQuest requires the flatpak version of RetroArch (1.22+).
# The PPA/apt version (1.21 and below) segfaults when launched with -L from Electron.
RA_INSTALLED=0
if flatpak info org.libretro.RetroArch &>/dev/null 2>&1; then
  ok "RetroArch (flatpak) already installed"
  RA_INSTALLED=1
else
  info "FiberQuest requires RetroArch via Flatpak (avoids GPU conflicts with Electron)"

  # Ensure flatpak is installed
  if ! command -v flatpak &>/dev/null; then
    info "Installing flatpak..."
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y flatpak && ok "flatpak installed" || { warn "flatpak install failed"; }
    fi
  fi

  if command -v flatpak &>/dev/null; then
    # Ensure flathub remote exists
    flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo 2>/dev/null

    if [[ $APPIMAGE_ONLY -eq 0 ]]; then
      read -rp "  Install RetroArch via flatpak now? [Y/n] " ans
      if [[ "${ans,,}" != "n" ]]; then
        info "Installing RetroArch (this may take a few minutes)..."
        flatpak install -y flathub org.libretro.RetroArch && {
          ok "RetroArch installed via flatpak"
          RA_INSTALLED=1
        } || warn "flatpak install failed — install manually: flatpak install flathub org.libretro.RetroArch"
      fi
    fi
  else
    warn "flatpak not available. Install RetroArch manually:"
    echo "    flatpak install flathub org.libretro.RetroArch"
  fi
fi

# ── RetroArch config for FiberQuest ─────────────────────────
RA_CFG="$HOME/.var/app/org.libretro.RetroArch/config/retroarch/retroarch.cfg"
if [[ -f "$RA_CFG" ]]; then
  header "Configuring RetroArch for FiberQuest..."
  # pause_nonactive: game must keep running when FiberQuest window has focus
  # network_cmd_enable + port: UDP RAM polling for game state reading
  PATCHED=0
  patch_ra() {
    local key="$1" val="$2"
    if grep -q "^${key} " "$RA_CFG"; then
      sed -i "s|^${key} .*|${key} = \"${val}\"|" "$RA_CFG"
    else
      echo "${key} = \"${val}\"" >> "$RA_CFG"
    fi
  }
  patch_ra "pause_nonactive" "false"
  patch_ra "network_cmd_enable" "true"
  patch_ra "network_cmd_port" "55355"
  ok "RetroArch config patched (pause_nonactive=false, network_cmd=true:55355)"
elif [[ $RA_INSTALLED -eq 1 ]]; then
  info "RetroArch config will be auto-configured on first game launch"
fi

# ── Install RetroArch cores ──────────────────────────────────
if [[ $RA_INSTALLED -eq 1 ]]; then
  header "Installing RetroArch cores..."
  RA_CORES_DIR="$HOME/.var/app/org.libretro.RetroArch/config/retroarch/cores"
  mkdir -p "$RA_CORES_DIR"

  # Determine core source dir — bundled in the FiberQuest repo per architecture
  case "$ARCH" in
    x86_64)        CORE_ARCH="x86_64" ;;
    aarch64|arm64) CORE_ARCH="aarch64" ;;
    *)             CORE_ARCH="" ;;
  esac

  # Try bundled cores first (from fiberquest/cores/<arch>/)
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  BUNDLED_DIR="${SCRIPT_DIR}/cores/${CORE_ARCH}"
  CORES_INSTALLED=0

  if [[ -d "$BUNDLED_DIR" ]]; then
    info "Installing bundled cores from ${BUNDLED_DIR}..."
    for core_file in "$BUNDLED_DIR"/*_libretro.so; do
      [[ -f "$core_file" ]] || continue
      core_name="$(basename "$core_file" _libretro.so)"
      cp "$core_file" "$RA_CORES_DIR/"
      ok "${core_name} installed"
      CORES_INSTALLED=$((CORES_INSTALLED + 1))
    done
    ok "${CORES_INSTALLED} cores installed from bundle"
  else
    # Fallback: download from GitHub release assets
    CORES_URL="https://github.com/${GITHUB_REPO}/releases/download/v${APP_VERSION}/cores-${CORE_ARCH}.tar.gz"
    info "Downloading cores for ${CORE_ARCH}..."
    TMP_CORES="/tmp/fq-cores.tar.gz"
    if curl -fsSL "$CORES_URL" -o "$TMP_CORES" 2>/dev/null; then
      tar xzf "$TMP_CORES" -C "$RA_CORES_DIR" && {
        CORES_INSTALLED=$(ls "$RA_CORES_DIR"/*_libretro.so 2>/dev/null | wc -l)
        ok "${CORES_INSTALLED} cores installed from release"
      } || warn "Core extraction failed"
      rm -f "$TMP_CORES"
    else
      warn "Could not download cores — install via RetroArch > Online Updater > Core Downloader"
    fi
  fi
fi

# ── Remove old apt/snap RetroArch (if present) ──────────────
if dpkg -l retroarch 2>/dev/null | grep -q "^ii"; then
  warn "Found old apt RetroArch — this version can crash with Electron"
  read -rp "  Remove apt retroarch? (flatpak version is preferred) [Y/n] " ans
  if [[ "${ans,,}" != "n" ]]; then
    sudo apt remove -y retroarch && ok "Old retroarch removed" || warn "Could not remove — do it manually: sudo apt remove retroarch"
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
