import json, sys
from common import R
split = sys.argv[1]; tag = sys.argv[2] if len(sys.argv) > 2 else ''
r = json.load(open(R + rf'\colour\result_{split}{tag}.json'))
extra = {k: r.pop(k) for k in list(r) if k.startswith('_')}
cls = ['earth', 'moon', 'seldon-1', 'seldon-2', 'all']


def g(m, k, f): return r[m].get(k, {}).get(f, 0) or 0


fr = r[next(iter(r))]['all']['frames']
print('frames', fr)
print('METHOD | class | n | recall | id-err | seldon swaps | phantoms/1000fr | precision | err med mm | mean mm')
for m in r:
    for k in cls:
        n = g(m, k, 'n'); tp = g(m, k, 'tp'); ph = g(m, k, 'ph'); idc = g(m, k, 'id')
        prec = tp / max(1, tp + ph + idc); e = r[m].get(k, {})
        em = (e.get('err_med') or 0) * 1.75; ea = (e.get('err_mean') or 0) * 1.75
        print(f"{m} | {k} | {n:.0f} | {tp / max(1, n):.3f} | {idc:.0f} | {g(m, k, 'seldon_swap'):.0f} | {1000 * ph / fr:.0f} | {prec:.3f} | {em:.1f} | {ea:.1f}")
print()
print('CONDITIONS: recall (n)')
for m in r:
    row = []
    for c in ('hand', 'free', 'bright', 'dark'):
        n = g(m, 'all|' + c, 'n'); row.append(f"{c} {g(m, 'all|' + c, 'tp') / max(1, n):.3f} (n={n:.0f})")
    ph = g(m, 'all', 'ph')
    print(m, '|', ' | '.join(row), f"| phantoms near hand {g(m, 'all', 'ph_hand'):.0f}/{ph:.0f}, on bright {g(m, 'all', 'ph_bright'):.0f}/{ph:.0f}")
print()
print('per class hand/free recall, (hand n)')
for m in r:
    print(m, ' '.join(f"{k}:{g(m, k + '|hand', 'tp') / max(1, g(m, k + '|hand', 'n')):.2f}/{g(m, k + '|free', 'tp') / max(1, g(m, k + '|free', 'n')):.2f}" for k in cls[:4]))
print('hand n per class', {k: g('model>=0.25', k + '|hand', 'n') for k in cls[:4]}, 'bright n', {k: g('model>=0.25', k + '|bright', 'n') for k in cls[:4]})
print(extra.get('_conf'))
ph = extra.get('_phantoms_model25', [])
from collections import Counter
print('model@0.25 phantoms by class', Counter(p[1] for p in ph), 'n', len(ph))
