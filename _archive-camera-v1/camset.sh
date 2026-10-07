#!/bin/zsh
# Lock the overhead camera to manual settings for IR tracking.
# Usage: ./camset.sh [exposure_ms] [gain] [focus]
#        ./camset.sh 8.3          8.3 ms exposure (flicker-safe 1/120 s), gain 0, focus unchanged
#        ./camset.sh 4 0 488      shorter exposure for a darker room
# Exposure is set in 0.1 ms steps (1–5000). Gain 0–100. Focus 0–1023.
cd "$(dirname "$0")"
ms=${1:-8.3}; gain=${2:-0}
exp=$(printf "%.0f" $(( ms * 10 )))
args=(-s auto-exposure-mode=1 -s exposure-time-abs=$exp -s gain=$gain -s power-line-frequency=2 -s auto-white-balance-temp=false -s auto-focus=false)
[[ -n $3 ]] && args+=(-s focus-abs=$3)
./uvc-util -I 0 "${args[@]}" >/dev/null
for c in exposure-time-abs gain focus-abs; do ./uvc-util -I 0 -g $c; done
