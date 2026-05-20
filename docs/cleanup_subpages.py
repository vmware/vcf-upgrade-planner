#!/usr/bin/env python3
"""
cleanup_subpages.py
Reprocesses docs_inline.js in-place to fix subpages:
  - TechDocs pages: keep ONLY direct children of the current URL
    (removes the full book-level TOC sidebar entries that pollute the sidebar)
  - knowledge.broadcom.com KB articles: keep all subpages as-is
    (no book-wide TOC sidebar on KB pages; all links are body content refs)
"""

import json
import re
from urllib.parse import urlparse

INPUT_FILE  = 'docs_inline.js'
OUTPUT_FILE = 'docs_inline.js'


def is_direct_child(child_url: str, parent_url: str) -> bool:
    """Return True if child_url is exactly one path level below parent_url."""
    try:
        parent_path = urlparse(parent_url.split('#')[0]).path.rstrip('/')
        if parent_path.endswith('.html'):
            parent_path = parent_path[:-5]
        child_prefix = parent_path + '/'

        child_path = urlparse(child_url.split('#')[0]).path
        if not child_path.startswith(child_prefix):
            return False
        remainder = child_path[len(child_prefix):]
        # Strip extension to get the path stem
        stem = remainder.rsplit('.', 1)[0] if '.' in remainder else remainder.rstrip('/')
        # A direct child has no further '/' in its stem
        return '/' not in stem and bool(stem)
    except Exception:
        return False


def main():
    print(f"Reading {INPUT_FILE}...")
    with open(INPUT_FILE, 'r', encoding='utf-8') as f:
        content = f.read()

    # Strip JS wrapper: window.INLINE_DOCS = {...};
    json_str = re.sub(r'^window\.INLINE_DOCS\s*=\s*', '', content.strip())
    if json_str.endswith(';'):
        json_str = json_str[:-1]

    print("Parsing JSON (large file — please wait)...")
    data = json.loads(json_str)
    print(f"Loaded {len(data)} entries")

    total_before = 0
    total_after  = 0
    changed      = 0

    for url, entry in data.items():
        subpages = entry.get('subpages', [])
        if not subpages:
            continue

        total_before += len(subpages)

        # KB articles have no book-wide TOC — all subpages are body content refs, keep them
        if 'knowledge.broadcom.com' in url:
            total_after += len(subpages)
            continue

        # TechDocs: keep only direct children of this URL
        filtered = [sp for sp in subpages if is_direct_child(sp['url'], url)]
        total_after += len(filtered)

        if len(filtered) != len(subpages):
            entry['subpages'] = filtered
            changed += 1

    removed = total_before - total_after
    print(f"\nResults:")
    print(f"  Entries modified : {changed}")
    print(f"  Subpages before  : {total_before}")
    print(f"  Subpages after   : {total_after}")
    print(f"  Subpages removed : {removed}")

    print(f"\nWriting {OUTPUT_FILE}...")
    js_content = 'window.INLINE_DOCS = ' + json.dumps(data, ensure_ascii=False, indent=2) + ';'
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write(js_content)

    import os
    size = os.path.getsize(OUTPUT_FILE)
    print(f"Done. Written {size:,} bytes to {OUTPUT_FILE}")


if __name__ == '__main__':
    main()