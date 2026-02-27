#!/usr/bin/env bash
# check-syntax.sh
# worker/src 以下の全 .js ファイルを node --check で構文検査する。
# 1 ファイルでも失敗した場合は exit 1 で終了する（CI/pre-deploy チェック用）。
#
# 使い方:
#   bash scripts/check-syntax.sh
#
# NG 例（while+pipe はサブシェルで変数が失われるため使わない）:
#   find ... | while read f; do node --check "$f"; done  <- exit 0 になりうる
#
# OK: process substitution で現シェルで変数を更新する

set -euo pipefail

WORKER_SRC="${1:-worker/src}"

if [ ! -d "$WORKER_SRC" ]; then
  echo "[ERROR] Directory not found: $WORKER_SRC" >&2
  exit 1
fi

fail=0
checked=0

while IFS= read -r -d '' f; do
  checked=$((checked + 1))
  if ! node --check "$f" 2>&1; then
    echo "[SYNTAX_ERROR] $f" >&2
    fail=$((fail + 1))
  fi
done < <(find "$WORKER_SRC" -name '*.js' -print0 | sort -z)

echo "Checked: ${checked} files, Errors: ${fail}"

if [ "$fail" -ne 0 ]; then
  echo "[FAIL] ${fail} file(s) failed syntax check." >&2
  exit 1
fi

echo "[OK] All syntax checks passed."
