"""Download the try-out typefaces (Google Fonts, SIL Open Font License) into assets/fonts/ and print their @font-face rules.
The table runs offline, so the fonts are files next to the page, not a Google Fonts link.

  python tools/get_fonts.py > fonts.css.txt
"""
import re
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'assets' / 'fonts'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
# family: (weights, subset, the name the page uses). The wide faces have no Greek; 'GG Greek' (Manrope's Greek) supplies the Δ.
FAMILIES = {'Michroma': ((400,), 'latin', 'Michroma'), 'Lexend Zetta': ((300, 400), 'latin', 'Lexend Zetta'),
            'Krona One': ((400,), 'latin', 'Krona One'), 'Syncopate': ((400, 700), 'latin', 'Syncopate'),
            'Orbitron': ((400, 500), 'latin', 'Orbitron'), 'Manrope': ((400, 500), 'greek', 'GG Greek')}


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30).read()


for fam, (weights, subset, alias) in FAMILIES.items():
    for w in weights:
        css = get(f'https://fonts.googleapis.com/css2?family={fam.replace(" ", "+")}:wght@{w}&display=swap').decode()
        block = re.search(r'/\* ' + subset + r' \*/\s*@font-face \{(.*?)\}', css, re.S).group(1)
        url = re.search(r'url\((https://[^)]+\.woff2)\)', block).group(1)
        rng = re.search(r'unicode-range: ([^;]+);', block).group(1)
        name = f'{alias.replace(" ", "")}-{w}.woff2'
        (OUT / name).write_bytes(get(url))
        print(f"@font-face {{ font-family: '{alias}'; src: url('assets/fonts/{name}') format('woff2'); font-weight: {w}; font-display: swap;"
              + (f" unicode-range: {rng};" if subset != 'latin' else '') + " }")
