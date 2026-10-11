#!/usr/bin/env bash
set -euo pipefail
umask 077
qingsi_deploy_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# This controller never invokes the WSL process manager.
exec node "$qingsi_deploy_dir/cli.js" "$@"
