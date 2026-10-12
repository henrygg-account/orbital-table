#!/bin/bash
# Re-vote, then re-outline only the r4 chunks whose prompts changed, then the review time-lapse.
set -e
export PATH=$HOME/.local/bin:$PATH
cd ~
cp work/r4/prompts.json work/r4/prompts_prev.json
python3 label4.py fuse 2>&1 | tee log_fuse.txt
python3 - <<'PY'
import json
from pathlib import Path
a = json.loads(Path('work/r4/prompts_prev.json').read_text()); b = json.loads(Path('work/r4/prompts.json').read_text())
names = json.loads(Path('r4/seq/names.json').read_text()); changed = 0
for c0 in range(0, len(names), 150):
    idx = range(c0, min(len(names), c0 + 150))
    if any(a.get(str(i)) != b.get(str(i)) for i in idx):
        changed += 1
        for i in idx:
            Path(f'labels/r4/{names[i]}.txt').unlink(missing_ok=True)
print('chunks to redo:', changed, 'of', (len(names) + 149) // 150)
PY
N=$(nvidia-smi -L | wc -l)
for k in $(seq 0 $((N - 1))); do CUDA_VISIBLE_DEVICES=$k python3 label4.py sam --shard $k --nshards $N > log_sam_$k.txt 2>&1 & done
wait
if grep -l Traceback log_sam_*.txt; then echo "STAGE_FAILED sam"; exit 1; fi
python3 label4.py review 2>&1 | tee log_review.txt
ffmpeg -y -loglevel error -i review_r4.mp4 -c:v libx264 -crf 26 -preset veryfast -pix_fmt yuv420p review_r4_h264.mp4
echo RERUN_DONE
