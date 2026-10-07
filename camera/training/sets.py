"""Datasets: the stand-in objects on the floor, and the printed pieces on the TV.
frames.py, autolabel.py and train.py take --set <name>."""
from pathlib import Path

HERE = Path(__file__).parent
SETS = {
    'standins': dict(dir=HERE / 'data', classes=['ball', 'tape', 'marker'],
                     prompts=['tennis ball', 'yellow and black tape measure', 'red marker pen'],
                     min_conf=[0.15, 0.06, 0.15], max_per_class=[1, 1, 1]),
    # Printed pieces. Prompts/thresholds are first guesses: check data_tv/preview after autolabel and tune.
    # Seldon-1 (yellow wraps) and Seldon-2 (magenta wraps) are separate classes: colour gives identity.
    'tv': dict(dir=HERE / 'data_tv', classes=['earth', 'moon', 'seldon-1', 'seldon-2'],
               prompts=['globe of the Earth', 'small grey moon sphere', 'yellow model satellite', 'pink model satellite'],
               min_conf=[0.10, 0.08, 0.10, 0.10], max_per_class=[1, 1, 1, 1], only_labeled=True),
}
