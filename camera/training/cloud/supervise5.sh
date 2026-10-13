#!/bin/bash
# Keep one Spot GPU VM running r5_spot.sh until gs://.../r5/markers/ALL_DONE, then delete it. Runs on the laptop.
# Reclaimed -> start it again; no capacity -> delete it and try the next zone / machine (1 A100, then 1 L4).
export PATH="/c/Users/Steven Johnson/AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin:$PATH"
P=gengalactic-tools
B=gs://gengalactic-tools-table-cv/r5
HERE="$(cd "$(dirname "$0")" && pwd)"
ZONES=(us-central1-c us-central1-a us-central1-b us-central1-f us-east1-b us-west1-b us-west4-b us-east4-c)
NAME=${NAME:-}; ZONE=${ZONE:-}
log() { echo "$(date +%H:%M:%S) $*"; }
create() {   # $1 machine type, $2 accelerator type -> sets NAME/ZONE on success
  for z in "${ZONES[@]}"; do
    n="r5-$(date +%H%M%S)"
    out=$(gcloud compute instances create $n --project $P --zone $z --machine-type $1 --accelerator type=$2,count=1 \
      --provisioning-model=SPOT --instance-termination-action=STOP --maintenance-policy TERMINATE \
      --image-project deeplearning-platform-release --image-family pytorch-2-9-cu129-ubuntu-2204-nvidia-580 \
      --boot-disk-size 200GB --boot-disk-type pd-ssd --metadata install-nvidia-driver=True \
      --metadata-from-file startup-script="$HERE/r5_spot.sh" --scopes cloud-platform --tags tools-vm \
      --labels purpose=table-cv-training,owner=henry 2>&1)
    if echo "$out" | grep -q RUNNING; then NAME=$n; ZONE=$z; log "created $n ($1) in $z"; return 0; fi
    log "no $1 in $z: $(echo "$out" | grep -o 'ZONE_RESOURCE_POOL_EXHAUSTED\|QUOTA[A-Z_]*\|[A-Z_]*ERROR[A-Z_]*' | head -1)"
  done
  return 1
}
while true; do
  if gsutil -q stat $B/markers/FAILED 2>/dev/null; then
    log "FAILED: $(gsutil cat $B/markers/FAILED)"; [ -n "$NAME" ] && gcloud compute instances delete $NAME --zone $ZONE --project $P --quiet && log "deleted $NAME"
    break
  fi
  if gsutil -q stat $B/markers/ALL_DONE 2>/dev/null; then
    log "ALL_DONE"; [ -n "$NAME" ] && gcloud compute instances delete $NAME --zone $ZONE --project $P --quiet && log "deleted $NAME"
    break
  fi
  st=$([ -n "$NAME" ] && gcloud compute instances describe $NAME --zone $ZONE --project $P --format="value(status)" 2>/dev/null)
  case "$st" in
    RUNNING|PROVISIONING|STAGING) sleep 120; continue ;;
    TERMINATED|STOPPED|SUSPENDED)
      gsutil -q stat $B/markers/ALL_DONE 2>/dev/null && continue    # it shut itself down when done: delete it at the top
      log "$NAME is $st (reclaimed?); starting it again"
      if gcloud compute instances start $NAME --zone $ZONE --project $P >/dev/null 2>&1; then log "restarted $NAME"; sleep 120; continue; fi
      log "no capacity in $ZONE; replacing it"
      gcloud compute instances delete $NAME --zone $ZONE --project $P --quiet >/dev/null 2>&1 ;;
    *) [ -n "$NAME" ] && log "$NAME not found ($st)" ;;
  esac
  create a2-highgpu-1g nvidia-tesla-a100 || create g2-standard-12 nvidia-l4 || { log "no Spot capacity; retrying in 5 min"; sleep 300; }
  sleep 60
done
