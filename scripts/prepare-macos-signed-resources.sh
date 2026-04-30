#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "prepare-macos-signed-resources.sh must run on macOS." >&2
  exit 1
fi

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "APPLE_SIGNING_IDENTITY is required." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/src-tauri/resources"
PATCH_TAURI_CONFIG=false

if [[ "${1:-}" == "--patch-tauri-config" ]]; then
  PATCH_TAURI_CONFIG=true
  shift
fi

OUTPUT_DIR="${1:-$ROOT_DIR/src-tauri/target/signed-resources}"
CONFIG_PATH="$OUTPUT_DIR/tauri.signed-resources.json"
WORK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

sign_file() {
  local path="$1"
  echo "Signing $path"
  codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$path"
}

is_macho_file() {
  local path="$1"
  /usr/bin/file -b "$path" | grep -q "Mach-O"
}

sign_macho_tree() {
  local root="$1"

  while IFS= read -r -d '' path; do
    if is_macho_file "$path"; then
      sign_file "$path"
    fi
  done < <(find "$root" -type f -print0)
}

rewrite_wheel_record() {
  local wheel_root="$1"

  python3 - "$wheel_root" <<'PY'
import base64
import csv
import hashlib
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
records = list(root.glob("*.dist-info/RECORD"))
if len(records) != 1:
    raise SystemExit(f"Expected exactly one wheel RECORD file, found {len(records)}")

record = records[0]
record_rel = record.relative_to(root).as_posix()
rows = []

for path in sorted(p for p in root.rglob("*") if p.is_file()):
    rel = path.relative_to(root).as_posix()
    if rel == record_rel:
        rows.append([rel, "", ""])
        continue

    data = path.read_bytes()
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    rows.append([rel, f"sha256={digest}", str(len(data))])

with record.open("w", newline="") as handle:
    csv.writer(handle).writerows(rows)
PY
}

sign_tar_archive() {
  local archive="$1"
  local name
  local extract_dir
  local tmp_archive

  name="$(basename "$archive")"
  extract_dir="$WORK_DIR/${name}.extract"
  tmp_archive="$WORK_DIR/${name}.signed"

  mkdir -p "$extract_dir"
  tar -xzf "$archive" -C "$extract_dir"
  sign_macho_tree "$extract_dir"

  COPYFILE_DISABLE=1 tar -czf "$tmp_archive" -C "$extract_dir" .
  mv "$tmp_archive" "$archive"
}

sign_wheel_archive() {
  local wheel="$1"
  local name
  local extract_dir
  local tmp_wheel

  name="$(basename "$wheel")"
  extract_dir="$WORK_DIR/${name}.extract"
  tmp_wheel="$WORK_DIR/${name}.signed"

  mkdir -p "$extract_dir"
  unzip -q "$wheel" -d "$extract_dir"
  sign_macho_tree "$extract_dir"
  rewrite_wheel_record "$extract_dir"

  (
    cd "$extract_dir"
    COPYFILE_DISABLE=1 zip -q -r "$tmp_wheel" .
  )
  mv "$tmp_wheel" "$wheel"
}

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

ditto "$SOURCE_DIR/litert-runtime" "$OUTPUT_DIR/litert-runtime"
ditto "$SOURCE_DIR/litert-python" "$OUTPUT_DIR/litert-python"
ditto "$SOURCE_DIR/searxng" "$OUTPUT_DIR/searxng"

sign_macho_tree "$OUTPUT_DIR/litert-runtime"

while IFS= read -r -d '' archive; do
  sign_tar_archive "$archive"
done < <(find "$OUTPUT_DIR/litert-python" -type f -name "*.tar.gz" -print0)

while IFS= read -r -d '' wheel; do
  sign_wheel_archive "$wheel"
done < <(find "$OUTPUT_DIR/litert-python" -type f -name "*.whl" -print0)

cat > "$CONFIG_PATH" <<JSON
{
  "bundle": {
    "resources": {
      "$OUTPUT_DIR/litert-runtime/": "litert-runtime/",
      "$OUTPUT_DIR/litert-python/": "litert-python/",
      "$OUTPUT_DIR/searxng/": "searxng/"
    }
  }
}
JSON

if [[ "$PATCH_TAURI_CONFIG" == "true" ]]; then
  node - "$ROOT_DIR" "$OUTPUT_DIR" <<'NODE'
const fs = require("fs");
const path = require("path");

const rootDir = process.argv[2];
const outputDir = process.argv[3];
const configPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

config.bundle.resources = {
  [`${path.join(outputDir, "litert-runtime")}/`]: "litert-runtime/",
  [`${path.join(outputDir, "litert-python")}/`]: "litert-python/",
  [`${path.join(outputDir, "searxng")}/`]: "searxng/",
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE
  echo "Patched src-tauri/tauri.conf.json to use signed macOS resources"
fi

echo "Prepared signed macOS resources at $OUTPUT_DIR"
echo "Tauri config override: $CONFIG_PATH"
