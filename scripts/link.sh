#!/usr/bin/env bash
# Link this plugin package's harness imports (@deepseek-ai/*) to the running
# DeepSeek Harness profile's node_modules, so the loads use the EXACT module
# instances the harness process uses (single-copy instanceof safety for cordis,
# dsh-llm LlmError, schemastery schemas, …).
#
# pi-ai is intentionally NOT linked: the plugin ships its own pinned copy under
# node_modules/@earendil-works/pi-ai (a direct dependency), independent of the
# pi-ai version bundled with the harness. The plugin↔harness boundary passes
# plain data (GenerateOptions in, StreamChunks out; the pi-bridge layer never
# leaks pi-ai objects across it), so the two copies coexist safely.
#
# Layout after this script:
#   node_modules/@deepseek-ai/<pkg>   -> $PROFILE_NODE_MODULES/@deepseek-ai/<pkg>  (symlinks)
#   node_modules/@earendil-works/…    =  real directories (plugin-owned, pinned)
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
  # Not an error: CI and other harness-less environments have no profile to
  # link against (their npm-installed peer copies are exactly what the
  # offline test suites need). Only a boot on a harness machine completes it.
  echo "skip: no profile node_modules under ${DSH_HOME}/profiles — leaving @deepseek-ai/* as installed (CI / harness-less environment)"
  exit 0
fi

# The plugin must ship its own pi-ai; restore it if node_modules was wiped.
if [ ! -f "${HERE}/node_modules/@earendil-works/pi-ai/package.json" ]; then
  echo "error: plugin-owned pi-ai missing under ${HERE}/node_modules/@earendil-works" >&2
  echo "hint: run 'npm install' in the plugin root (pi-ai is a direct dependency)" >&2
  exit 1
fi

# Harness packages resolved from the profile via symlink (single copy).
PACKAGES=(cordis dsh-credentials dsh-launch-environment dsh-llm dsh-settings dsh-timeout schemastery)
for PKG in "${PACKAGES[@]}"; do
  LINK="${HERE}/node_modules/@deepseek-ai/${PKG}"
  mkdir -p "${HERE}/node_modules/@deepseek-ai"
  if [ -L "${LINK}" ] && [ "$(readlink "${LINK}")" = "${TARGET}/@deepseek-ai/${PKG}" ]; then
    continue
  fi
  rm -rf "${LINK}"
  ln -s "${TARGET}/@deepseek-ai/${PKG}" "${LINK}"
  echo "linked: node_modules/@deepseek-ai/${PKG} -> ${TARGET}/@deepseek-ai/${PKG}"
done

echo "node_modules ready: @deepseek-ai/* linked to profile, pi-ai pinned locally"
echo "note: node_modules is gitignored; 'pnpm install' re-creates everything (prepare runs this script)."
