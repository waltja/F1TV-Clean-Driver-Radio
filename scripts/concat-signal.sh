#!/usr/bin/env bash
# Concatenates signal_*.raw files + optional LibriSpeech raw into a single signal.raw
# for RNNoise training.
#
# Usage:
#   pnpm concat-signal                              # signal_*.raw only
#   pnpm concat-signal --librispeech path/to/dev-clean-signal.raw
#   pnpm concat-signal --out rnnoise-training/src/signal.raw --librispeech ...
#   bash scripts/concat-signal.sh [--dir <dir>] [--out <out.raw>] [--librispeech <file>]

set -euo pipefail

DIR="training-data"
OUT=""
LIBRISPEECH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      DIR="$2"
      shift 2
      ;;
    --out)
      OUT="$2"
      shift 2
      ;;
    --librispeech)
      LIBRISPEECH="$2"
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

OUT="${OUT:-${DIR}/signal.raw}"

# Find per-session F1 radio signal files.
F1_FILES=()
for f in "$DIR"/signal_*.raw; do
  [ -f "$f" ] && F1_FILES+=("$f")
done

if [[ ${#F1_FILES[@]} -eq 0 && -z "$LIBRISPEECH" ]]; then
  echo "No signal_*.raw files found in ${DIR}/ and no --librispeech provided." >&2
  exit 1
fi

echo "Building signal.raw -> ${OUT}"

if [[ ${#F1_FILES[@]} -gt 0 ]]; then
  echo ""
  echo "F1 TeamRadio clips:"
  for f in "${F1_FILES[@]}"; do
    SIZE=$(du -h "$f" | cut -f1)
    BYTES=$(wc -c < "$f")
    SECS=$(( BYTES / 2 / 48000 ))
    echo "  $f  (${SIZE}, ~${SECS}s)"
  done
fi

if [[ -n "$LIBRISPEECH" ]]; then
  if [[ ! -f "$LIBRISPEECH" ]]; then
    echo "LibriSpeech file not found: $LIBRISPEECH" >&2
    exit 1
  fi
  SIZE=$(du -h "$LIBRISPEECH" | cut -f1)
  BYTES=$(wc -c < "$LIBRISPEECH")
  SECS=$(( BYTES / 2 / 48000 ))
  MINS=$(( SECS / 60 ))
  echo ""
  echo "LibriSpeech:"
  echo "  $LIBRISPEECH  (${SIZE}, ~${MINS} min)"
fi

echo ""

# Build source list.
SOURCES=()
for f in "${F1_FILES[@]+"${F1_FILES[@]}"}"; do
  SOURCES+=("$f")
done
if [[ -n "$LIBRISPEECH" ]]; then
  SOURCES+=("$LIBRISPEECH")
fi

TMP="${OUT}.tmp$$"
cat "${SOURCES[@]}" > "$TMP"
mv "$TMP" "$OUT"

TOTAL_SIZE=$(du -h "$OUT" | cut -f1)
TOTAL_BYTES=$(wc -c < "$OUT")
TOTAL_SECS=$(( TOTAL_BYTES / 2 / 48000 ))
TOTAL_MINS=$(( TOTAL_SECS / 60 ))

echo "Done: ${OUT}  (${TOTAL_SIZE}, ~${TOTAL_MINS} min)"
echo ""
echo "Next step (training):"
echo "  cp ${OUT} rnnoise-training/src/signal.raw"
echo "  ffplay -f s16le -ar 48000 -ac 1 ${OUT}   # quick listen"
