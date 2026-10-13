import json, sys
from common import R
lam = sys.argv[1]
d = {}
for role in ('earth', 'moon', 'seldon-1', 'seldon-2'):
    p = json.load(open(R + rf'\colour\params_{role}_{lam}.json'))[role]
    for k in ('h', 's', 'area'):
        if p[k] is not None: p[k] = tuple(p[k])
    d[role] = p
json.dump(d, open(R + rf'\colour\params_all_{lam}.json', 'w'))
print(d)
