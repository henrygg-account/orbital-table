"""build_ds4.py — round 4 dataset (local): frames already on the laptop + the SAM labels from the labelling VM.

  python cloud/build_ds4.py --labels <dir with r4/ and r3/ label folders> --out <dir>

Writes <out>/ds/{images,labels}/{train,val} (real files, so it can be synced to Cloud Storage) and data.yaml pointing at
/opt/train/data/ds (where train_spot.sh puts it). Validation = every 6th block of 50 consecutive frames per recording.
"""
import argparse, json, shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SEQS = {'r4': HERE / 'data_r4/seq', 'r3': HERE / 'data_tv_pol/seq'}
NAMES = ['earth', 'moon', 'seldon-1', 'seldon-2', 'person']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--labels', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    d = Path(a.out) / 'ds'; shutil.rmtree(d, ignore_errors=True)
    n = {'train': 0, 'val': 0, 'missing': 0}
    for ds, seq in SEQS.items():
        names = json.loads((seq / 'names.json').read_text())
        for i, name in enumerate(names):
            lab = Path(a.labels) / ds / f'{name}.txt'
            if not lab.exists():
                n['missing'] += 1; continue
            s = 'val' if (i // 50) % 6 == 5 else 'train'
            for sub in ('images', 'labels'):
                (d / sub / s).mkdir(parents=True, exist_ok=True)
            shutil.copy(seq / f'{i:05d}.jpg', d / 'images' / s / f'{name}.jpg')
            shutil.copy(lab, d / 'labels' / s / f'{name}.txt')
            n[s] += 1
    (d / 'data.yaml').write_text('path: /opt/train/data/ds\ntrain: images/train\nval: images/val\nnames:\n'
                                 + ''.join(f'  {k}: {v}\n' for k, v in enumerate(NAMES)))
    print(n)


if __name__ == '__main__':
    main()
