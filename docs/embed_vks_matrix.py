#!/usr/bin/env python3
"""
Embed k8s-upgrade-matrix.json into index.html, vks-upgrade-planner.html, and all VCF planner subpages.

The planner pages must work when opened by double-clicking them (a file:// URL), where browsers block
fetch() of a sibling JSON file — without the inlined copy every version picker or solver comes up empty.
Inlining the matrix into a <script type="application/json"> block sidesteps that entirely. The pages
still fall back to fetching the sibling JSON if the embedded block is missing or malformed.

Run this after every matrix update:

    python3 embed_vks_matrix.py

Idempotent: re-running replaces the previously embedded copy rather than nesting another one.
"""

import argparse
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MATRIX = os.path.join(HERE, "k8s-upgrade-matrix.json")

# Matches the whole data block, whether it still holds the placeholder or a previous embed.
BLOCK_RE = re.compile(
    r'(<script type="application/json" id="matrix-data">)(.*?)(</script>)',
    re.DOTALL,
)


def process_html_file(html_path, blob):
    with open(html_path, "r", encoding="utf-8") as fh:
        html = fh.read()

    # If <script type="application/json" id="matrix-data"> is missing but vks-solver.js is included, inject it right above vks-solver.js
    if not BLOCK_RE.search(html) and '<script src="vks-solver.js"></script>' in html:
        html = html.replace(
            '<script src="vks-solver.js"></script>',
            '<script type="application/json" id="matrix-data"></script>\n<script src="vks-solver.js"></script>'
        )

    if not BLOCK_RE.search(html):
        return False

    html, count = BLOCK_RE.subn(lambda m: m.group(1) + blob + m.group(3), html, count=1)

    with open(html_path, "w", encoding="utf-8") as fh:
        fh.write(html)

    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--html", default=None, help="specific planner HTML to update (default: all HTML files in docs/)")
    ap.add_argument("--matrix", default=DEFAULT_MATRIX, help="matrix JSON to embed (default: %(default)s)")
    args = ap.parse_args()

    with open(args.matrix, "r", encoding="utf-8") as fh:
        matrix = json.load(fh)

    blob = json.dumps(matrix, separators=(",", ":"), sort_keys=False)
    blob = blob.replace("</", "<\\/")

    if args.html:
        files = [os.path.abspath(args.html)]
    else:
        files = sorted(glob.glob(os.path.join(HERE, "*.html")))

    updated_count = 0
    for fpath in files:
        if process_html_file(fpath, blob):
            updated_count += 1
            print(f"embedded {len(blob)} bytes into {os.path.basename(fpath)}", file=sys.stderr)

    print(f"Successfully updated {updated_count} HTML file(s).", file=sys.stderr)


if __name__ == "__main__":
    main()
