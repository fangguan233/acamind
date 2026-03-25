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
Usage: ./scripts/start.sh [--app <file.py>] [--watch] [--daemon] [--log <file>] [--pidfile <file>] [--stop] [--status] [-- <extra chainlit args...>]

Examples:
  ./scripts/start.sh
  ./scripts/start.sh --watch
  ./scripts/start.sh --app demo_openai_compatible_httpx.py --watch
  ./scripts/start.sh --daemon
  ./scripts/start.sh --daemon --log /var/log/sci_chat.log
  ./scripts/start.sh --status
  ./scripts/start.sh --stop
  ./scripts/start.sh -- --port 8000

Notes:
  - This runs Chainlit from the local backend source with the backend config in backend/.chainlit/config.toml.
  - If you use backend/.chainlit/config.toml UI.custom_build = "../frontend/dist", make sure frontend/dist exists.
  - --daemon uses nohup so the process keeps running after you close the terminal.
EOF
}

APP_FILE="demo_openai_compatible_httpx.py"
WATCH=0
DAEMON=0
LOG_FILE=""
PID_FILE=""
DO_STOP=0
DO_STATUS=0
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      [[ $# -ge 2 ]] || die "--app requires a file path"
      APP_FILE="$2"
      shift 2
      ;;
    -w|--watch)
      WATCH=1
      shift
      ;;
    -d|--daemon)
      DAEMON=1
      shift
      ;;
    --log)
      [[ $# -ge 2 ]] || die "--log requires a file path"
      LOG_FILE="$2"
      shift 2
      ;;
    --pidfile)
      [[ $# -ge 2 ]] || die "--pidfile requires a file path"
      PID_FILE="$2"
      shift 2
      ;;
    --stop)
      DO_STOP=1
      shift
      ;;
    --status)
      DO_STATUS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      EXTRA_ARGS+=("$@")
      break
      ;;
    *)
      die "Unknown argument: $1 (use --help)"
      ;;
  esac
done

if [[ ! -f "${ROOT_DIR}/backend/${APP_FILE}" ]]; then
  die "App file not found: backend/${APP_FILE}"
fi

if [[ ! -f "${ROOT_DIR}/frontend/dist/index.html" ]]; then
  log "WARN: frontend/dist/index.html not found."
  log "      If you rely on backend/.chainlit/config.toml UI.custom_build = \"../frontend/dist\", run: ./scripts/install.sh"
fi

PYTHON_BIN=""
if [[ -x "${ROOT_DIR}/backend/.venv/bin/python" ]]; then
  PYTHON_BIN="${ROOT_DIR}/backend/.venv/bin/python"
elif has_cmd python3; then
  PYTHON_BIN="python3"
elif has_cmd python; then
  PYTHON_BIN="python"
else
  die "Python not found. Please install Python >= 3.10."
fi

cd "${ROOT_DIR}/backend"

DEFAULT_PIDFILE="${ROOT_DIR}/backend/.chainlit/chainlit.pid"
DEFAULT_LOGFILE="${ROOT_DIR}/backend/.chainlit/chainlit.log"
PID_FILE="${PID_FILE:-${DEFAULT_PIDFILE}}"
LOG_FILE="${LOG_FILE:-${DEFAULT_LOGFILE}}"

mkdir -p "$(dirname "${PID_FILE}")" "$(dirname "${LOG_FILE}")"

is_running() {
  local pid="$1"
  [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1
}

read_pid() {
  if [[ -f "${PID_FILE}" ]]; then
    tr -d ' \t\r\n' < "${PID_FILE}" || true
  fi
}

if [[ "${DO_STATUS}" -eq 1 ]]; then
  pid="$(read_pid)"
  if [[ -z "${pid}" ]]; then
    log "Not running (no pidfile: ${PID_FILE})"
    exit 0
  fi
  if is_running "${pid}"; then
    log "Running (pid=${pid})"
    log "Log: ${LOG_FILE}"
    exit 0
  fi
  log "Not running (stale pidfile: ${PID_FILE}, pid=${pid})"
  exit 1
fi

if [[ "${DO_STOP}" -eq 1 ]]; then
  pid="$(read_pid)"
  if [[ -z "${pid}" ]]; then
    log "Nothing to stop (no pidfile: ${PID_FILE})"
    exit 0
  fi

  if is_running "${pid}"; then
    log "-- Stopping (pid=${pid})"
    kill "${pid}" || true
    for _ in {1..30}; do
      if ! is_running "${pid}"; then
        break
      fi
      sleep 1
    done
    if is_running "${pid}"; then
      log "WARN: Process still running, sending SIGKILL"
      kill -9 "${pid}" || true
    fi
  else
    log "WARN: Stale pidfile, process not running (pid=${pid})"
  fi

  rm -f "${PID_FILE}"
  exit 0
fi

CMD=(run "${APP_FILE}")
if [[ "${WATCH}" -eq 1 ]]; then
  CMD+=(-w)
fi
CMD+=("${EXTRA_ARGS[@]}")

if [[ "${DAEMON}" -eq 1 ]]; then
  existing_pid="$(read_pid)"
  if [[ -n "${existing_pid}" && "${existing_pid}" =~ ^[0-9]+$ ]] && is_running "${existing_pid}"; then
    die "Already running (pid=${existing_pid}). Use --status or --stop."
  fi

  log "-- Starting in background"
  log "Log: ${LOG_FILE}"
  log "Pidfile: ${PID_FILE}"

  nohup "${PYTHON_BIN}" -m chainlit "${CMD[@]}" >"${LOG_FILE}" 2>&1 < /dev/null &
  new_pid="$!"
  echo "${new_pid}" > "${PID_FILE}"
  log "Started (pid=${new_pid})"
  exit 0
fi

exec "${PYTHON_BIN}" -m chainlit "${CMD[@]}"
