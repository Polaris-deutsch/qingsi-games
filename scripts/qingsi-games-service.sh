#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  start|stop|status|restart|logs) ;;
  *) echo 'Usage: qingsi-games-service.sh {start|stop|status|restart|logs}' >&2; exit 2 ;;
esac

# Windows invokes a noninteractive WSL login shell. Load the user's default nvm
# version only when Node is absent from its PATH; never install anything.
if ! command -v node >/dev/null 2>&1; then
  qingsi_nvm_script="${NVM_DIR:-${HOME}/.nvm}/nvm.sh"
  if [[ -s "$qingsi_nvm_script" ]]; then
    set +u
    source "$qingsi_nvm_script" --no-use
    nvm use --silent default >/dev/null 2>&1 || true
    set -u
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js is unavailable in WSL. Install or configure Node.js, then try again.' >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  echo 'The WSL flock command is unavailable.' >&2
  exit 1
fi

qingsi_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
qingsi_state_dir="${QINGSI_GAMES_STATE_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/qingsi-games}"
umask 077
mkdir -p -- "$qingsi_state_dir"
exec 9>"$qingsi_state_dir/qingsi-games.lock"
if ! flock -w 5 9; then
  echo 'Another QingSi Games control command is still running. Try again shortly.' >&2
  exit 1
fi
exec node "$qingsi_script_dir/qingsi-games-service.js" "$1" "$qingsi_state_dir"
