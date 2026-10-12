#!/bin/bash
# Round 4, GPU VM part 1: install, then label4.py stages on every GPU at once (detect -> fuse -> sam -> review).
# Expects in ~: r4/seq (+ names.json, tags.json, prompts.json), r3/seq (+ names.json), r3/labels_fixed, prev.pt, label4.py
set -e
export PATH=$HOME/.local/bin:$PATH
cd ~
python3 -m pip install -q --upgrade pip
python3 -m pip install -q ultralytics "transformers>=4.45,<5" accelerate
python3 -m pip uninstall -y -q torchaudio || true                 # the image ships a torchaudio built for another torch; nothing here needs it
SAM2_BUILD_CUDA=0 python3 -m pip install -q "git+https://github.com/facebookresearch/sam2.git"
python3 -m pip uninstall -y -q opencv-python || true          # no libGL on the VM: headless OpenCV only
python3 -m pip install -q --force-reinstall --no-deps opencv-python-headless
[ -f sam2.1_hiera_large.pt ] || wget -q https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt
python3 -c "from transformers import AutoModelForZeroShotObjectDetection as M, AutoProcessor as P; P.from_pretrained('IDEA-Research/grounding-dino-base'); M.from_pretrained('IDEA-Research/grounding-dino-base'); print('dino ready')"
N=$(nvidia-smi -L | wc -l); echo "GPUS $N"
stage() {   # run one stage on every GPU, fail if any shard failed
  for k in $(seq 0 $((N - 1))); do CUDA_VISIBLE_DEVICES=$k python3 label4.py $1 --shard $k --nshards $N > log_$1_$k.txt 2>&1 & done
  wait
  if grep -l Traceback log_$1_*.txt; then echo "STAGE_FAILED $1"; exit 1; fi
  echo "STAGE_DONE $1"
}
stage detect
python3 label4.py fuse 2>&1 | tee log_fuse.txt
stage sam
python3 label4.py review 2>&1 | tee log_review.txt
echo LABEL_DONE
