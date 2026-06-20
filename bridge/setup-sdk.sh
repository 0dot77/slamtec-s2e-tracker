#!/usr/bin/env bash
# Fetches the Slamtec RPLIDAR SDK and builds it together with the S2E bridge.
# The SDK is not committed to this repo (see .gitignore); run this once after cloning.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_DIR="$HERE/third_party/rplidar_sdk"
SDK_URL="https://github.com/Slamtec/rplidar_sdk"

if [ ! -d "$SDK_DIR" ]; then
  echo "==> Cloning Slamtec SDK into $SDK_DIR"
  git clone --depth 1 "$SDK_URL" "$SDK_DIR"
fi

echo "==> Building Slamtec SDK"
make -C "$SDK_DIR"

echo "==> Building s2e_bridge"
make -C "$HERE"

echo "==> Done: $HERE/s2e_bridge"
