#!/bin/bash
# Setup voice message transcription dependencies (ffmpeg + whisper.cpp)

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
CYAN='\033[36m'
RESET='\033[0m'

MODEL_DIR="$HOME/.local/share/whisper.cpp/models"
MODEL_FILE="$MODEL_DIR/ggml-base.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"

MISSING=0

echo ""
echo -e "${BOLD}Teams Bot - Voice Transcription Setup${RESET}"
echo ""

# ── 1. Check ffmpeg ──────────────────────────────────────────────────────────

echo -e "${CYAN}Checking ffmpeg...${RESET}"
if command -v ffmpeg &>/dev/null; then
  echo -e "  ${GREEN}✓${RESET} ffmpeg found: $(command -v ffmpeg)"
else
  echo -e "  ${RED}✗${RESET} ffmpeg not found"
  if [[ "$(uname)" == "Darwin" ]] && command -v brew &>/dev/null; then
    read -p "  Install via Homebrew? [y/N]: " INSTALL_FFMPEG
    INSTALL_FFMPEG="${INSTALL_FFMPEG:-N}"
    if [[ "$INSTALL_FFMPEG" =~ ^[Yy]$ ]]; then
      brew install ffmpeg
      if command -v ffmpeg &>/dev/null; then
        echo -e "  ${GREEN}✓${RESET} ffmpeg installed"
      else
        echo -e "  ${RED}✗${RESET} ffmpeg installation failed"
        MISSING=1
      fi
    else
      echo -e "  ${YELLOW}⚠${RESET} Skipped. Install manually: ${DIM}brew install ffmpeg${RESET}"
      MISSING=1
    fi
  else
    echo -e "  ${YELLOW}⚠${RESET} Install ffmpeg from: ${DIM}https://ffmpeg.org/download.html${RESET}"
    MISSING=1
  fi
fi

echo ""

# ── 2. Check whisper-cli ─────────────────────────────────────────────────────

echo -e "${CYAN}Checking whisper-cli...${RESET}"
if command -v whisper-cli &>/dev/null; then
  echo -e "  ${GREEN}✓${RESET} whisper-cli found: $(command -v whisper-cli)"
else
  echo -e "  ${RED}✗${RESET} whisper-cli not found"
  if [[ "$(uname)" == "Darwin" ]] && command -v brew &>/dev/null; then
    read -p "  Install via Homebrew? [y/N]: " INSTALL_WHISPER
    INSTALL_WHISPER="${INSTALL_WHISPER:-N}"
    if [[ "$INSTALL_WHISPER" =~ ^[Yy]$ ]]; then
      brew install whisper-cpp
      if command -v whisper-cli &>/dev/null; then
        echo -e "  ${GREEN}✓${RESET} whisper-cli installed"
      else
        echo -e "  ${RED}✗${RESET} whisper-cli installation failed"
        MISSING=1
      fi
    else
      echo -e "  ${YELLOW}⚠${RESET} Skipped. Install manually: ${DIM}brew install whisper-cpp${RESET}"
      MISSING=1
    fi
  else
    echo -e "  ${YELLOW}⚠${RESET} Install whisper.cpp from: ${DIM}https://github.com/ggerganov/whisper.cpp${RESET}"
    MISSING=1
  fi
fi

echo ""

# ── 3. Check/download whisper model ─────────────────────────────────────────

echo -e "${CYAN}Checking whisper model...${RESET}"
if [ -f "$MODEL_FILE" ]; then
  echo -e "  ${GREEN}✓${RESET} Model found: $MODEL_FILE"
else
  echo -e "  ${RED}✗${RESET} Model not found at $MODEL_FILE"
  read -p "  Download ggml-base.bin from HuggingFace? (~142 MB) [y/N]: " DOWNLOAD_MODEL
  DOWNLOAD_MODEL="${DOWNLOAD_MODEL:-N}"
  if [[ "$DOWNLOAD_MODEL" =~ ^[Yy]$ ]]; then
    mkdir -p "$MODEL_DIR"
    echo "  Downloading..."
    if curl -L --progress-bar -o "$MODEL_FILE" "$MODEL_URL"; then
      echo -e "  ${GREEN}✓${RESET} Model downloaded to $MODEL_FILE"
    else
      rm -f "$MODEL_FILE"
      echo -e "  ${RED}✗${RESET} Download failed"
      MISSING=1
    fi
  else
    echo -e "  ${YELLOW}⚠${RESET} Skipped. Download manually:"
    echo -e "    ${DIM}mkdir -p $MODEL_DIR${RESET}"
    echo -e "    ${DIM}curl -L -o $MODEL_FILE $MODEL_URL${RESET}"
    MISSING=1
  fi
fi

echo ""

# ── Summary ──────────────────────────────────────────────────────────────────

if [ "$MISSING" -eq 0 ]; then
  echo -e "${GREEN}✓${RESET} ${BOLD}All voice dependencies are installed!${RESET}"
  echo "  Voice message transcription is ready to use."
  echo ""
  exit 0
else
  echo -e "${RED}✗${RESET} ${BOLD}Some dependencies are missing.${RESET}"
  echo "  Voice transcription will not work until all dependencies are installed."
  echo "  Re-run this script after installing the missing dependencies."
  echo ""
  exit 1
fi
