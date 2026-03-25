#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf '%s\n' "$*"
}

die() {
  log "ERROR: $*"
  exit 1
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [--registry <url>] [--skip-copilot] [--build-copilot] [--skip-ui] [--skip-python]

Installs dependencies and builds the UI for this repo.

Options:
  --registry <url>  Override npm registry for pnpm (e.g. https://registry.npmjs.org/)
  --skip-copilot    Skip building libs/copilot (use prebuilt dist if present)
  --build-copilot   Force building libs/copilot even if prebuilt dist exists
  --skip-ui      Skip pnpm install/build (frontend)
  --skip-python  Skip Python environment setup (backend)

Env:
  NPM_REGISTRY   Same as --registry (useful in CI)
  SKIP_COPILOT   Same as --skip-copilot (useful in CI)
EOF
}

SKIP_UI=0
SKIP_PYTHON=0
REGISTRY=""
SKIP_COPILOT="${SKIP_COPILOT:-0}"
FORCE_BUILD_COPILOT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry)
      [[ $# -ge 2 ]] || die "--registry requires a URL"
      REGISTRY="$2"
      shift 2
      ;;
    --skip-copilot) SKIP_COPILOT=1; shift ;;
    --build-copilot) FORCE_BUILD_COPILOT=1; shift ;;
    --skip-ui) SKIP_UI=1; shift ;;
    --skip-python) SKIP_PYTHON=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

if [[ "${SKIP_UI}" -eq 0 ]]; then
  PNPM_CMD=()
  if has_cmd pnpm; then
    PNPM_CMD=(pnpm)
  elif has_cmd corepack; then
    PNPM_CMD=(corepack pnpm)
  else
    die "pnpm not found. Install Node.js (>=18) and enable corepack, or install pnpm."
  fi

  if [[ -z "${REGISTRY}" && -n "${NPM_REGISTRY:-}" ]]; then
    REGISTRY="${NPM_REGISTRY}"
  fi

  if [[ -z "${REGISTRY}" ]]; then
    CURRENT_REGISTRY="$("${PNPM_CMD[@]}" config get registry 2>/dev/null || true)"
    if [[ "${CURRENT_REGISTRY}" == *"nodejs-release"* ]]; then
      log "WARN: pnpm registry looks misconfigured: ${CURRENT_REGISTRY}"
      log "      Falling back to https://registry.npmjs.org/ (override with --registry)"
      REGISTRY="https://registry.npmjs.org/"
    fi
  fi

  if [[ -n "${REGISTRY}" ]]; then
    export NPM_CONFIG_REGISTRY="${REGISTRY}"
    export npm_config_registry="${REGISTRY}"
    log "-- Using npm registry: ${REGISTRY}"
  else
    CURRENT_REGISTRY="$("${PNPM_CMD[@]}" config get registry 2>/dev/null || true)"
    if [[ -n "${CURRENT_REGISTRY}" ]]; then
      log "-- Using npm registry: ${CURRENT_REGISTRY}"
    fi
  fi

  log "-- Installing Node dependencies (pnpm)"
  cd "${ROOT_DIR}"
  "${PNPM_CMD[@]}" install --frozen-lockfile

  log "-- Building UI (react-client)"
  "${PNPM_CMD[@]}" -C libs/react-client run build

  COPILOT_PREBUILT=0
  if [[ -f "${ROOT_DIR}/libs/copilot/dist/index.js" ]] || [[ -f "${ROOT_DIR}/libs/copilot/dist/index.html" ]] || [[ -f "${ROOT_DIR}/backend/chainlit/copilot/dist/index.js" ]]; then
    COPILOT_PREBUILT=1
  fi

  if [[ "${SKIP_COPILOT}" -eq 1 ]]; then
    log "-- Skipping UI (copilot) (--skip-copilot)"
  elif [[ "${COPILOT_PREBUILT}" -eq 1 && "${FORCE_BUILD_COPILOT}" -eq 0 ]]; then
    log "-- Skipping UI (copilot) (prebuilt dist found; use --build-copilot to rebuild)"
  else
    log "-- Building UI (copilot)"
    if ! "${PNPM_CMD[@]}" -C libs/copilot run build; then
      log "WARN: Copilot build failed (often OOM on small machines)."
      if [[ "${COPILOT_PREBUILT}" -eq 1 ]]; then
        log "      Using prebuilt copilot assets already in the repo."
        log "      To rebuild on low-memory machines, add swap or run with more RAM."
      else
        die "Copilot build failed and no prebuilt dist was found."
      fi
    fi
  fi

  log "-- Building UI (frontend)"
  FRONTEND_PREBUILT=0
  if [[ -f "${ROOT_DIR}/backend/chainlit/frontend/dist/index.html" ]]; then
    FRONTEND_PREBUILT=1
  fi

  if ! "${PNPM_CMD[@]}" -C frontend run build; then
    log "WARN: Frontend build failed (often OOM on small machines)."
    if [[ "${FRONTEND_PREBUILT}" -eq 1 ]]; then
      log "      Using prebuilt frontend assets already in the repo."
      log "      To build the customized UI, add swap or run with more RAM, then copy frontend/dist to this machine."
    else
      die "Frontend build failed and no prebuilt frontend dist was found."
    fi
  fi

  if [[ ! -f "${ROOT_DIR}/frontend/dist/index.html" ]]; then
    if [[ -f "${ROOT_DIR}/backend/chainlit/frontend/dist/index.html" ]]; then
      log "WARN: frontend/dist/index.html not found; falling back to backend/chainlit/frontend/dist."
    else
      die "UI build completed but frontend/dist/index.html was not found."
    fi
  fi
fi

if [[ "${SKIP_PYTHON}" -eq 0 ]]; then
  PYTHON_BIN=""
  if has_cmd python3; then
    PYTHON_BIN="python3"
  elif has_cmd python; then
    PYTHON_BIN="python"
  else
    die "Python not found. Please install Python >= 3.10."
  fi

  log "-- Setting up Python environment (backend)"
  cd "${ROOT_DIR}/backend"

  if has_cmd uv; then
    log "-- Using uv (fast, uses backend/uv.lock)"
    uv sync --frozen --no-install-project --no-editable
  else
    log "-- uv not found, falling back to venv + pip (slower)"
    "${PYTHON_BIN}" -m venv .venv
    # shellcheck disable=SC1091
    source .venv/bin/activate
    python -m pip install --upgrade pip
    CHAINLIT_SKIP_UI_BUILD="${CHAINLIT_SKIP_UI_BUILD:-1}" python -m pip install -e .
  fi

  if [[ ! -x "${ROOT_DIR}/backend/.venv/bin/python" ]]; then
    log "WARN: backend/.venv/bin/python not found (your environment may use a different venv path)."
  fi
fi

log "-- Done"
