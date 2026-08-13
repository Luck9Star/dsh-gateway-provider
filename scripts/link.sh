#!/usr/bin/env bash
# Link this plugin package's bare imports (@deepseek-ai/*, @deepseek-ai/schemastery)
# to the running DeepSeek Harness profile's node_modules, so the plugin loads the
# EXACT module instances the harness process uses (single-copy instanceof safety).
#
# Usage: bash scripts/link.sh [profile-name]
#   profile-name defaults to "web".
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
# pnpm workspace installs put node_modules at the workspace root (shared by all
# profiles); standalone profile installs nest it inside the profile directory.
TARGET=""
for CANDIDATE in "${DSH_HOME}/profiles/${PROFILE}/node_modules" "${DSH_HOME}/profiles/node_modules"; do
  if [ -d "${CANDIDATE}" ] && [ -d "${CANDIDATE}/@deepseek-ai" ]; then
    TARGET="${CANDIDATE}"
    break
  fi
done
if [ -z "${TARGET}" ]; then
  echo "error: no profile node_modules with @deepseek-ai packages found under ${DSH_HOME}/profiles" >&2
  echo "hint: boot the profile once (dsh --profile ${PROFILE}) or run 'dsh plugin --profile ${PROFILE} install'" >&2
  exit 1
fi

LINK="${HERE}/node_modules"
if [ -L "${LINK}" ] && [ "$(readlink "${LINK}")" = "${TARGET}" ]; then
  echo "already linked: ${LINK} -> ${TARGET}"
  exit 0
fi

rm -rf "${LINK}"
ln -s "${TARGET}" "${LINK}"
echo "linked: ${LINK} -> ${TARGET}"
echo "note: node_modules is gitignored; run 'bash scripts/link.sh' again after cloning."
