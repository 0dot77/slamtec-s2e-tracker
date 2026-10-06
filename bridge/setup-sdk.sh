#!/usr/bin/env bash
# Fetches the Slamtec RPLIDAR SDK and builds it together with the S2E bridge.
# The SDK is not committed to this repo (see .gitignore); run this once after cloning.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_DIR="$HERE/third_party/rplidar_sdk"
SDK_URL="https://github.com/Slamtec/rplidar_sdk"
SDK_COMMIT="99478e5fb90de3b4a6db0080acacd373f8b36869"

if [ ! -d "$SDK_DIR" ]; then
  echo "==> Cloning Slamtec SDK into $SDK_DIR"
  git clone --depth 1 "$SDK_URL" "$SDK_DIR"
fi

if [ ! -e "$SDK_DIR/.git" ]; then
  echo "SDK directory is not a Git checkout: $SDK_DIR" >&2
  exit 1
fi

CURRENT_COMMIT="$(git -C "$SDK_DIR" rev-parse HEAD)"
if [ "$CURRENT_COMMIT" != "$SDK_COMMIT" ]; then
  echo "==> Updating SDK from $CURRENT_COMMIT to pinned $SDK_COMMIT"
  git -C "$SDK_DIR" fetch --depth 1 origin "$SDK_COMMIT"
  git -C "$SDK_DIR" checkout --detach "$SDK_COMMIT"
else
  echo "==> SDK already at pinned $SDK_COMMIT"
fi

# The bridge Makefile cleans/rebuilds the SDK when its revision changes.
echo "==> Building s2e_bridge"
make -C "$HERE"

echo "==> Done: $HERE/bin/s2e_bridge"
