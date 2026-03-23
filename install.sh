#!/usr/bin/env bash
# trust-agent installer
# Usage: curl -fsSL https://raw.githubusercontent.com/your-org/trust-agent/main/install.sh | sh
set -e

REPO="your-org/trust-agent"
INSTALL_DIR="${TRUST_AGENT_INSTALL_DIR:-$HOME/.local/bin}"
BINARY="trust-agent"

# Detect OS and architecture
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64)  TARGET="linux-x64"    ;;
      aarch64) TARGET="linux-arm64"  ;;
      *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    ;;
  Darwin)
    case "$ARCH" in
      x86_64)  TARGET="darwin-x64"   ;;
      arm64)   TARGET="darwin-arm64" ;;
      *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

# Find latest release tag
echo "Finding latest release..."
LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' | sed 's/.*"tag_name": "\(.*\)".*/\1/')

if [ -z "$LATEST" ]; then
  echo "Could not determine latest version"
  exit 1
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST}/trust-agent-${TARGET}"
DEST="${INSTALL_DIR}/${BINARY}"

echo "Installing trust-agent ${LATEST} (${TARGET})..."
mkdir -p "$INSTALL_DIR"
curl -fsSL --progress-bar "$DOWNLOAD_URL" -o "$DEST"
chmod +x "$DEST"

echo ""
echo "Installed trust-agent ${LATEST} to ${DEST}"
echo ""

# Check if INSTALL_DIR is in PATH
case ":$PATH:" in
  *":${INSTALL_DIR}:"*)
    ;;
  *)
    echo "Add to your shell profile:"
    echo "  export PATH=\"\$PATH:${INSTALL_DIR}\""
    echo ""
    ;;
esac

echo "Get started:"
echo "  trust-agent init"
echo "  trust-agent run \"Analyze project structure\""
