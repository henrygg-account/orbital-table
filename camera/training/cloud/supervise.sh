#!/bin/bash
# Keep one Spot training VM alive until round 4 is trained (gs://.../r4/ALL_DONE). Runs on the laptop.
# Reclaimed -> start it again; no capacity -> delete it and create one in the next zone (8 GPUs first, then 4).
# Every VM runs train_spot.sh as its startup script, so it pulls the data + latest checkpoint and carries on.
P=gengalactic-tools
B=gs://gengalactic-tools-table-cv/r4
HERE="$(cd "$(dirname "$0")" && pwd)"
ZONES=(us-central1-c us-central1-a us-central1-b us-central1-f us-east1-b us-west1-b us-west4-b us-east4-c us-west3-b)
NAME=${NAME:-yolo-train8}; ZONE=${ZONE:-us-central1-c}
log() { echo "$(date +%H:%M:%S) $*"; }
create() {   # $1 machine type, $2 gpus -> sets NAME/ZONE on success
  for z in "${ZONES[@]}"; do
    n="yolo-train-$(date +%H%M%S)"
    out=$(gcloud compute instances create $n --project $P --zone $z --machine-type $1 --accelerator type=nvidia-tesla-a100,count=$2 \
      --provisioning-model=SPOT --instance-termination-action=STOP --maintenance-policy TERMINATE \
      --image-project deeplearning-platform-release --image-family pytorch-2-9-cu129-ubuntu-2204-nvidia-580 \
      --boot-disk-size 200GB --boot-disk-type pd-ssd --metadata install-nvidia-driver=True \
      --metadata-from-file startup-script="$HERE/train_spot.sh" --scopes cloud-platform --tags tools-vm \
      --labels purpose=table-cv-training,owner=henry 2>&1)
    if echo "$out" | grep -q RUNNING; then NAME=$n; ZONE=$z; log "created $n ($1) in $z"; return 0; fi
    log "no $1 in $z"
  done
  return 1
}
while true; do
  if gsutil -q stat $B/ALL_DONE 2>/dev/null; then log "ALL_DONE"; break; fi
  st=$(gcloud compute instances describe $NAME --zone $ZONE --project $P --format="value(status)" 2>/dev/null)
  case "$st" in
    RUNNING|PROVISIONING|STAGING) sleep 120; continue ;;
    TERMINATED|STOPPED|SUSPENDED)
      log "$NAME is $st (reclaimed); starting it again"
      if gcloud compute instances start $NAME --zone $ZONE --project $P >/dev/null 2>&1; then log "restarted $NAME"; sleep 120; continue; fi
      log "no capacity in $ZONE; replacing it"
      gcloud compute instances delete $NAME --zone $ZONE --project $P --quiet >/dev/null 2>&1 ;;
    *) log "$NAME not found ($st)" ;;
  esac
  create a2-highgpu-8g 8 || create a2-highgpu-4g 4 || { log "no Spot A100 capacity anywhere; retrying in 5 min"; sleep 300; }
  sleep 60
done
