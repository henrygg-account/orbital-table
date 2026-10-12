#!/bin/bash
# Re-vote and re-outline the new recording after a review (detections are kept), then the review time-lapse.
set -e
export PATH=$HOME/.local/bin:$PATH
cd ~
python3 label4.py fuse 2>&1 | tee log_fuse.txt
rm -rf labels/r4
N=$(nvidia-smi -L | wc -l)
for k in $(seq 0 $((N - 1))); do CUDA_VISIBLE_DEVICES=$k python3 label4.py sam --shard $k --nshards $N > log_sam_$k.txt 2>&1 & done
wait
if grep -l Traceback log_sam_*.txt; then echo "STAGE_FAILED sam"; exit 1; fi
python3 label4.py review 2>&1 | tee log_review.txt
ffmpeg -y -loglevel error -i review_r4.mp4 -c:v libx264 -crf 26 -preset veryfast -pix_fmt yuv420p review_r4_h264.mp4
echo RERUN_DONE
