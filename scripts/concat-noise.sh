#!/usr/bin/env bash
# Concatenates all noise_*.raw files in the training-data dir into a single noise.raw.
# Usage:
#   pnpm concat-noise                          # outputs training-data/noise.raw
#   pnpm concat-noise training-data/noise.raw  # explicit output path
#   bash scripts/concat-noise.sh [out.raw] [--dir <dir>]

set -euo pipefail

DIR="training-data"
OUT=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      DIR="$2"
      shift 2
      ;;
    -*)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
    *)
      OUT="$1"
      shift
      ;;
  esac
done

OUT="${OUT:-${DIR}/noise.raw}"

# Find per-driver files (exclude the output file itself if it already exists).
FILES=()
for f in "$DIR"/noise_*.raw; do
  [ -f "$f" ] && FILES+=("$f")
done

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No noise_*.raw files found in ${DIR}/" >&2
  exit 1
fi

echo "Concatenating ${#FILES[@]} file(s) -> ${OUT}"
for f in "${FILES[@]}"; do
  SIZE=$(du -h "$f" | cut -f1)
  echo "  $f  (${SIZE})"
done

# Atomic write: concat to a temp file, then move into place.
TMP="${OUT}.tmp$$"
cat "${FILES[@]}" > "$TMP"
mv "$TMP" "$OUT"

TOTAL=$(du -h "$OUT" | cut -f1)
# Duration: 2 bytes/sample, 48000 samples/sec
BYTES=$(wc -c < "$OUT")
SECS=$(( BYTES / 2 / 48000 ))
MINS=$(( SECS / 60 ))
echo ""
echo "Done: ${OUT}  (${TOTAL}, ~${MINS} min)"
echo ""
echo "Next step (training):"
echo "  cp ${OUT} rnnoise-training/src/noise.raw"
echo "  ffplay -f s16le -ar 48000 -ch_layout mono ${OUT}   # quick listen"
