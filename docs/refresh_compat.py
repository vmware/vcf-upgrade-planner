#!/usr/bin/env python3
"""
refresh_compat.py
=================
Fetches the latest product versions from the Broadcom Interoperability Matrix
API and updates compat-data.json with current release lists.

The compatibility check itself is done by linking to the Broadcom site:
    https://interopmatrix.broadcom.com/Interoperability?col=<id>&row=<id>

Usage:
    python3 refresh_compat.py            # live update
    python3 refresh_compat.py --dry-run  # preview only

Requirements:
    pip install requests

Authentication:
    The API uses an x-auth-key header. Grab it from DevTools:

    OPTION A - Environment variable:
        export BROADCOM_AUTH_KEY="N31mVcQkL..."
        python3 refresh_compat.py

    OPTION B - Key file:
        echo "N31mVcQkL..." > ~/.broadcom_auth_key
        python3 refresh_compat.py

    OPTION C - Interactive paste (prompted if nothing else found):
        python3 refresh_compat.py

    HOW TO GET YOUR X-Auth-Key (30 seconds):
        1. Open https://interopmatrix.broadcom.com in Chrome/Firefox
        2. Log in with MFA as normal
        3. Open DevTools -> Network tab (F12 or Cmd+Opt+I)
        4. In filter box type: interop.esp
        5. Click any dropdown on the page to trigger a request
        6. Click one of the requests -> Headers tab -> Request Headers
        7. Find "x-auth-key" and copy its full value

    Keys typically expire after ~30 hours.
"""

import json
import os
import re
import sys
import socket
import datetime

try:
    import requests
except ImportError:
    print("Missing dependency: pip install requests")
    sys.exit(1)

# -- Config -----------------------------------------------------------------
API_PRODUCTS = "https://interop.esp.spespg1.vmw.saas.broadcom.com/external/products"
DATA_FILE    = os.path.join(os.path.dirname(os.path.abspath(__file__)), "compat-data.json")
TOKEN_FILE   = os.path.expanduser("~/.broadcom_auth_key")
DRY_RUN      = "--dry-run" in sys.argv
DEBUG        = "--debug"   in sys.argv   # saves raw API responses to debug_*.json

# -- Auth -------------------------------------------------------------------
def get_key():
    """Resolve x-auth-key in priority: env var > file > interactive paste."""
    key = os.environ.get("BROADCOM_AUTH_KEY", "").strip()
    if key:
        print("Using x-auth-key from BROADCOM_AUTH_KEY env var")
        return _validate_key(key)

    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            key = f.read().strip()
        if key:
            print(f"Using x-auth-key from {TOKEN_FILE}")
            return _validate_key(key)

    print("""
+----------------------------------------------------------+
|  HOW TO GET YOUR BROADCOM X-Auth-Key (30 seconds)        |
+----------------------------------------------------------+
|  1. Go to https://interopmatrix.broadcom.com in Chrome   |
|  2. Log in with MFA as normal                            |
|  3. Open DevTools -> Network tab  (F12 or Cmd+Opt+I)     |
|  4. In filter box type: interop.esp                      |
|  5. Click a dropdown on the page to trigger a request    |
|  6. Click a request -> Headers tab -> Request Headers    |
|  7. Find "x-auth-key" and copy its value                 |
+----------------------------------------------------------+

To skip this prompt next time:
    echo "<key>" > ~/.broadcom_auth_key
  or
    export BROADCOM_AUTH_KEY="<key>"
""")
    print("Paste your x-auth-key value and press Enter.")
    key = input("x-auth-key: ").strip()
    if not key:
        print("No key provided -- aborting.")
        sys.exit(1)
    print(f"Key received ({len(key)} characters) -- validating...")
    sys.stdout.flush()

    save = input("Save key to ~/.broadcom_auth_key for next run? [y/N]: ").strip().lower()
    if save == "y":
        with open(TOKEN_FILE, "w") as f:
            f.write(key)
        os.chmod(TOKEN_FILE, 0o600)
        print(f"Key saved to {TOKEN_FILE}")

    return _validate_key(key)


def _validate_key(key):
    # Sanity checks
    if key.startswith("eyJ") and key.count(".") == 2:
        print()
        print("ERROR: That looks like a JWT Bearer token.")
        print("   The interop API uses x-auth-key, not Authorization: Bearer.")
        print("   In DevTools look for the header named 'x-auth-key'.")
        print()
        sys.exit(1)
    if len(key) < 10:
        print("ERROR: Key too short -- copy the full x-auth-key value.")
        sys.exit(1)

    # DNS check
    host = "interop.esp.spespg1.vmw.saas.broadcom.com"
    print(f"Testing connectivity to {host}...")
    sys.stdout.flush()
    try:
        socket.setdefaulttimeout(8)
        socket.getaddrinfo(host, 443)
        print("  DNS resolved OK")
    except socket.gaierror:
        print(f"ERROR: Cannot resolve {host}")
        print("  -> Connect to Broadcom VPN and try again.")
        sys.exit(1)
    finally:
        socket.setdefaulttimeout(None)

    # Test API call
    print(f"Calling API to validate key...")
    sys.stdout.flush()
    try:
        r = requests.get(API_PRODUCTS, headers={"x-auth-key": key, "Accept": "application/json"},
                         params={"size": 1}, timeout=20)
        print(f"  HTTP {r.status_code}")
        if r.status_code == 401:
            print("ERROR: Key rejected (401) -- it may have expired.")
            if os.path.exists(TOKEN_FILE):
                os.remove(TOKEN_FILE)
            sys.exit(1)
        if r.status_code == 403:
            print("ERROR: Key rejected (403 Forbidden).")
            sys.exit(1)
        r.raise_for_status()
        print("Key valid -- API accessible")
        sys.stdout.flush()
        return key
    except requests.exceptions.Timeout:
        print("ERROR: Request timed out -- check VPN/network.")
        sys.exit(1)
    except requests.exceptions.ConnectionError as e:
        print(f"ERROR: Connection failed: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"WARNING: Unexpected error: {e} -- continuing anyway")
        return key


# -- API helpers ------------------------------------------------------------
def fetch_all_products(key):
    """Fetch all products (with embedded releases) from the API."""
    print("Fetching all products from API...")
    sys.stdout.flush()
    r = requests.get(API_PRODUCTS,
                     headers={"x-auth-key": key, "Accept": "application/json"},
                     timeout=60)
    r.raise_for_status()
    products = r.json()
    if not isinstance(products, list):
        products = products.get("content") or products.get("data") or []
    print(f"  Fetched {len(products)} products")
    return products


def find_product(all_products, name_fragment):
    """
    Find best matching product by name. Returns (id, name, releases) or (None, None, []).
    Prefers exact substring match over partial; picks longest matching name to avoid
    grabbing wrong products (e.g. 'ESX' matching 'VMware ESXi' vs 'VMware ESX').
    """
    fragment_lower = name_fragment.lower()
    candidates = [p for p in all_products if fragment_lower in p.get("name", "").lower()]
    if not candidates:
        return None, None, []
    # Prefer shortest name that still matches (most specific)
    candidates.sort(key=lambda p: len(p.get("name", "")))
    best = candidates[0]
    return best["id"], best["name"], best.get("releases", [])


# Maximum versions to keep per product (newest by GA date first).
# Increase this if you need more history.
MAX_VERSIONS_PER_PRODUCT = 25


def infer_group(version):
    """Turn 'v1.33.9+vmware.3-...' -> 'v1.33', '9.1.0' -> '9.1'"""
    v = version.lstrip("v")
    m = re.match(r'(\d+\.\d+)', v)
    prefix = "v" if version.startswith("v") else ""
    return (prefix + m.group(1)) if m else version


def releases_to_versions(releases):
    """Convert API release list to compat-data.json version format.

    Returns versions sorted newest-first (by gaDate), capped at
    MAX_VERSIONS_PER_PRODUCT so the dropdowns stay manageable.
    """
    out = []
    for r in releases:
        ver = r.get("version", "")
        if not ver or r.get("dummy"):
            continue
        # Strip trailing " - Product Name" suffix that the API appends
        ver_clean = re.sub(r' - .+$', '', ver).strip()
        out.append({
            "value":               ver_clean,
            "label":               ver_clean,
            "group":               infer_group(ver_clean),
            "broadcom_release_id": r["id"],
            "ga_date":             r.get("gaDate"),
        })

    # Sort newest GA date first; entries without a date go to the end
    out.sort(key=lambda v: v["ga_date"] or "", reverse=True)

    # Cap to most-recent N versions
    if len(out) > MAX_VERSIONS_PER_PRODUCT:
        print(f"      (trimmed {len(out)} -> {MAX_VERSIONS_PER_PRODUCT} versions)")
        out = out[:MAX_VERSIONS_PER_PRODUCT]

    return out


# Status codes returned by the interoperabilityMatrix API:
#   1 = Compatible
#   2 = Incompatible
#   3 = Compatible (not technically guided)
#   4 = Not Supported
STATUS_MAP = {1: "yes", 2: "no", 3: "yes", 4: "no"}

# Upgrade path status codes (upgradePath endpoint):
#   1 = Supported upgrade path
#   2 = Not supported (red X / Incompatible)
#   3 = Supported (with conditions)
#   4 = Not supported (red X)
#   5 = Not Supported (grey box — back-in-time or N/A path)
#   0 = Not Supported (grey box — some API versions use 0)
# Unknown codes default to "no" via the fallback in fetch_upgrade_path.
UPGRADE_STATUS_MAP = {0: "no", 1: "yes", 2: "no", 3: "yes", 4: "no", 5: "no"}


def _extract_note(rel, footnote_lookup=None):
    """Try common field names the Broadcom API uses for reason/note text.

    Handles:
      - Direct string fields (comment, notes, tooltip, …)
      - footnotes as a list of {text, description, …} objects
      - footnoteRefs / footnoteIds referencing a top-level footnote_lookup dict
    """
    import re as _re

    def _clean(s):
        s = _re.sub(r'<[^>]+>', ' ', s)
        return _re.sub(r'\s+', ' ', s).strip()

    # Direct string fields — 'footnotes' is a plain string in the upgrade path API
    for field in ("footnotes", "comment", "notes", "note", "notesHtml", "noteHtml",
                  "tooltip", "message", "reason", "description",
                  "compatibility_note"):
        val = rel.get(field)
        if val and isinstance(val, str):
            clean = _clean(val)
            if clean:
                return clean

    # Inline footnotes array: [{"text": "..."}, …]
    footnotes = rel.get("footnotes")
    if footnotes and isinstance(footnotes, list):
        texts = []
        for fn in footnotes:
            if isinstance(fn, dict):
                t = fn.get("text") or fn.get("description") or fn.get("message") or ""
                c = _clean(t)
                if c:
                    texts.append(c)
        if texts:
            return " ".join(texts)

    # Footnote refs pointing into top-level footnote_lookup
    if footnote_lookup:
        for ref_field in ("footnoteRefs", "footnoteIds", "footnote_refs", "footnote_id"):
            refs = rel.get(ref_field)
            if not refs:
                continue
            if not isinstance(refs, list):
                refs = [refs]
            texts = []
            for ref in refs:
                ref_id = str(ref) if isinstance(ref, (str, int)) else str(ref.get("id", ""))
                if ref_id and ref_id in footnote_lookup:
                    texts.append(footnote_lookup[ref_id])
            if texts:
                return " ".join(texts)

    return None


def fetch_upgrade_path(key, pid):
    """
    Fetch the upgrade path matrix for a single product.

    POST https://interop.esp.spespg1.vmw.saas.broadcom.com/external/upgrades
    Body (exact shape observed from browser DevTools):
        { "product_id": <int>, "isHidePatch": false,
          "isHideGenSupported": true, "isHideTechSupported": true }

    Returns dict: { from_version: { to_version: 'yes'|'no' } }
    """
    BASE        = API_PRODUCTS.rsplit("/products", 1)[0]
    UPGRADE_URL = BASE + "/upgrades"
    hdrs = {"x-auth-key": key, "Accept": "application/json", "Content-Type": "application/json"}

    body = {
        "product_id":          int(pid),
        "isHidePatch":         False,
        "isHideGenSupported":  True,
        "isHideTechSupported": True,
    }

    try:
        resp = requests.post(UPGRADE_URL, headers=hdrs, json=body, timeout=60)
        print(f"    [upgradePath] HTTP {resp.status_code}")
        if resp.status_code != 200:
            print(f"    [upgradePath] error body: {resp.text[:300]}")
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.HTTPError as e:
        print(f"    WARNING: upgrade path fetch failed: {e}")
        return {}
    except Exception as e:
        print(f"    WARNING: upgrade path fetch error: {e}")
        return {}

    # --debug: dump raw response so we can confirm exact field names
    if DEBUG and isinstance(data, dict):
        debug_file = f"debug_upgrade_{pid}.json"
        with open(debug_file, "w") as _df:
            json.dump(data, _df, indent=2)
        print(f"    [DEBUG] raw response saved -> {debug_file}")
        print(f"    [DEBUG] top-level keys: {list(data.keys())}")
        for _entry in data.get("upgradeProducts", [])[:1]:
            print(f"    [DEBUG] upgradeProduct keys: {list(_entry.keys())}")
            for _rel in _entry.get("releases", [])[:2]:
                print(f"    [DEBUG] release keys: {list(_rel.keys())}")
                print(f"    [DEBUG] release sample: {_rel}")
            break

    # Response structure (from DevTools):
    # {
    #   "id": "2", "name": "VMware vCenter",
    #   "upgradeProducts": [
    #     {
    #       "version": "9.1.0.0100",   <-- FROM version
    #       "releases": [              <-- TO versions
    #         { "version": "9.1.0.0200", "status": 1, ... },
    #         ...
    #       ]
    #     }, ...
    #   ]
    # }
    matrix = {}
    upgrade_products = data.get("upgradeProducts", []) if isinstance(data, dict) else []

    # Build a footnote lookup from the top-level "footnotes" array.
    # Shape observed: [{"id": "1", "text": "Back-in-time issue..."}, …]
    footnote_lookup = {}
    for fn in data.get("footnotes", []) if isinstance(data, dict) else []:
        if not isinstance(fn, dict):
            continue
        fid = str(fn.get("id", "")).strip()
        text = (fn.get("text") or fn.get("description") or fn.get("message") or "").strip()
        if fid and text:
            footnote_lookup[fid] = text

    if footnote_lookup:
        print(f"    [upgradePath] loaded {len(footnote_lookup)} footnote(s) from response")

    for entry in upgrade_products:
        from_ver = re.sub(r' - .+$', '', entry.get("version", "")).strip()
        if not from_ver:
            continue
        for to_rel in entry.get("releases", []):
            if to_rel.get("dummy"):
                continue
            to_ver = re.sub(r' - .+$', '', to_rel.get("version", "")).strip()
            status = to_rel.get("status")
            compat = UPGRADE_STATUS_MAP.get(status, "no")  # unknown codes default to "no"
            if to_ver and compat:
                note = _extract_note(to_rel, footnote_lookup=footnote_lookup)
                val  = {"s": compat, "n": note} if note else compat
                matrix.setdefault(from_ver, {})[to_ver] = val

    return matrix

def fetch_compat_matrix(key, col_pid, row_pid):
    """
    POST to /products/interoperabilityMatrix with all releases (empty arrays).
    Returns dict: { col_version: { row_version: 'yes'|'no'|{'s':..,'n':..} } }
    """
    BASE = API_PRODUCTS.rsplit("/products", 1)[0]
    INTEROP_URL = BASE + "/products/interoperabilityMatrix"
    body = {
        "columns": [{"product": col_pid, "releases": []}],
        "rows":    [{"product": row_pid, "releases": []}],
        "isCollection":        False,
        "isHidePatch":         False,
        "isHideGenSupported":  False,
        "isHideTechSupported": False,
        "isHideCompatible":    False,
        "isHideIncompatible":  False,
        "isHideNTCompatible":  False,
        "isHideNotSupported":  False,
        "col": f"{col_pid},",
        "row": f"{row_pid},",
    }
    hdrs = {"x-auth-key": key, "Accept": "application/json", "Content-Type": "application/json"}
    try:
        resp = requests.post(INTEROP_URL, headers=hdrs, json=body, timeout=60)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"    WARNING: compat matrix fetch failed: {e}")
        return {}

    # --debug: dump raw response so we can confirm exact field names
    if DEBUG:
        debug_file = f"debug_interop_{col_pid}_{row_pid}.json"
        with open(debug_file, "w") as _df:
            json.dump(data, _df, indent=2)
        print(f"    [DEBUG] raw response saved -> {debug_file}")
        if isinstance(data, dict):
            print(f"    [DEBUG] top-level keys: {list(data.keys())}")
            for _pname, _rels in list(data.items())[:1]:
                if isinstance(_rels, list) and _rels:
                    _r = _rels[0]
                    print(f"    [DEBUG] col-release keys: {list(_r.keys())}")
                    _rpm = _r.get("rowProdReleaseMap", {})
                    for _, _rrows in list(_rpm.items())[:1]:
                        if _rrows:
                            print(f"    [DEBUG] row-release keys: {list(_rrows[0].keys())}")
                            print(f"    [DEBUG] row-release sample: {_rrows[0]}")
                        break

    matrix = {}

    # Build top-level footnote lookup if present
    footnote_lookup = {}
    if isinstance(data, dict):
        for fn in data.get("footnotes", []):
            if not isinstance(fn, dict):
                continue
            fid  = str(fn.get("id", "")).strip()
            text = (fn.get("text") or fn.get("description") or fn.get("message") or "").strip()
            if fid and text:
                footnote_lookup[fid] = text

    # Response: { product_name: [ { version, rowProdReleaseMap: {"0": [{version, status}]} } ] }
    iterable = data.items() if isinstance(data, dict) else []
    for prod_name, col_releases in iterable:
        if prod_name in ("footnotes",):
            continue
        if not isinstance(col_releases, list):
            continue
        for col_rel in col_releases:
            col_ver = re.sub(r' - .+$', '', col_rel.get("version", "")).strip()
            if not col_ver or col_rel.get("dummy"):
                continue
            rpm = col_rel.get("rowProdReleaseMap", {})
            for _, row_rels in rpm.items():
                for row_rel in row_rels:
                    row_ver = re.sub(r' - .+$', '', row_rel.get("version", "")).strip()
                    status  = row_rel.get("status")
                    compat  = STATUS_MAP.get(status, "no")  # unknown codes default to "no"
                    if col_ver and row_ver and compat:
                        note = _extract_note(row_rel, footnote_lookup=footnote_lookup)
                        val  = {"s": compat, "n": note} if note else compat
                        matrix.setdefault(col_ver, {})[row_ver] = val
    return matrix


# -- Probe mode -------------------------------------------------------------
def probe_upgrade_path():
    """
    --probe: fetch and print the raw vCenter upgrade path API response.
    Useful for inspecting what fields the API actually returns so you can
    confirm _extract_note() is targeting the right keys.
    Saves output to debug_probe_vcenter.json.
    """
    print("=== PROBE MODE: vCenter Upgrade Path ===")
    key = get_key()
    all_products = fetch_all_products(key)
    pid, name, _ = find_product(all_products, "VMware vCenter")
    if not pid:
        print("ERROR: VMware vCenter not found in product list")
        sys.exit(1)
    print(f"Found: {name} (id={pid})")

    BASE        = API_PRODUCTS.rsplit("/products", 1)[0]
    UPGRADE_URL = BASE + "/upgrades"
    hdrs = {"x-auth-key": key, "Accept": "application/json", "Content-Type": "application/json"}
    body = {"product_id": int(pid), "isHidePatch": False,
            "isHideGenSupported": True, "isHideTechSupported": True}

    resp = requests.post(UPGRADE_URL, headers=hdrs, json=body, timeout=60)
    print(f"HTTP {resp.status_code}")
    resp.raise_for_status()
    data = resp.json()

    out_file = "debug_probe_vcenter.json"
    with open(out_file, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Full response saved to {out_file}")

    # Print key structural info
    if isinstance(data, dict):
        print(f"\nTop-level keys: {list(data.keys())}")
        footnotes = data.get("footnotes", [])
        print(f"Top-level footnotes count: {len(footnotes)}")
        for fn in footnotes[:3]:
            print(f"  footnote sample: {fn}")

        for entry in data.get("upgradeProducts", [])[:2]:
            from_ver = entry.get("version", "?")
            print(f"\nFrom version: {from_ver}")
            print(f"  entry keys: {list(entry.keys())}")
            for rel in entry.get("releases", [])[:3]:
                print(f"  -> to: {rel.get('version','?')}  status: {rel.get('status')}  keys: {list(rel.keys())}")
                # Show any non-standard fields that might carry note text
                extra = {k: v for k, v in rel.items()
                         if k not in ("version", "status", "id", "dummy", "gaDate", "releaseDate")}
                if extra:
                    print(f"     extra fields: {extra}")
    print("\nDone. Review debug_probe_vcenter.json for full details.")
    sys.exit(0)


# -- Main -------------------------------------------------------------------
def main():
    print("=" * 60)
    print("  VCF Compat Data Refresher")
    print(f"  Data file: {DATA_FILE}")
    print(f"  {'DRY RUN -- no file will be written' if DRY_RUN else 'Live run -- will update compat-data.json'}")
    print("=" * 60)

    # Load existing data
    if not os.path.exists(DATA_FILE):
        print(f"ERROR: {DATA_FILE} not found.")
        print("  Make sure refresh_compat.py is in the same folder as compat-data.json")
        sys.exit(1)

    with open(DATA_FILE) as f:
        data = json.load(f)

    key = get_key()
    all_products = fetch_all_products(key)

    products_meta = data.get("products", {})
    versions_out  = data.get("versions", {})

    print(f"\nRefreshing {len(products_meta)} products...\n")

    for prod_key, prod_info in products_meta.items():
        bname = prod_info.get("broadcom_name", prod_key)
        print(f"  {prod_key} -> searching for '{bname}'")
        pid, full_name, releases = find_product(all_products, bname)

        if not pid:
            print(f"    WARNING: Not found in API -- skipping")
            continue

        print(f"    Found: '{full_name}' (id={pid})")
        products_meta[prod_key]["broadcom_product_id"] = pid

        versions = releases_to_versions(releases)
        if versions:
            versions_out[prod_key] = versions
            print(f"    {len(versions)} releases loaded")
        else:
            print(f"    WARNING: No releases found")

    # -- 2. Fetch compatibility matrices per pair --------------------------
    pairs        = data.get("pairs", [])
    compat_out   = data.get("compatibility", {})

    print(f"\nRefreshing {len(pairs)} compatibility pairs...\n")
    for pair in pairs:
        pair_id = pair["id"]
        col_key = pair["col_product"]
        row_key = pair["row_product"]
        col_pid = products_meta.get(col_key, {}).get("broadcom_product_id")
        row_pid = products_meta.get(row_key, {}).get("broadcom_product_id")

        print(f"  {pair['label']}")
        if not col_pid or not row_pid:
            print(f"    SKIP -- missing product IDs (col={col_pid}, row={row_pid})")
            continue

        # Same-product pairs (upgrade path): use the upgradePath endpoint.
        # Different-product pairs: use the interoperabilityMatrix endpoint.
        is_upgrade_pair = (col_key == row_key) or pair.get("_upgrade", False)

        if is_upgrade_pair:
            print(f"    [upgrade pair] calling upgradePath endpoint...")
            matrix = fetch_upgrade_path(key, col_pid)
        else:
            matrix = fetch_compat_matrix(key, col_pid, row_pid)

        if matrix:
            compat_out[pair_id] = matrix
            yes = sum(v == "yes" for row in matrix.values() for v in row.values())
            no  = sum(v == "no"  for row in matrix.values() for v in row.values())
            print(f"    {len(matrix)} col versions, {yes} supported, {no} not supported")
        else:
            print(f"    WARNING: empty matrix -- keeping existing data")

    # Update metadata
    data["products"]      = products_meta
    data["versions"]      = versions_out
    data["compatibility"] = compat_out
    if "_meta" not in data:
        data["_meta"] = {}
    data["_meta"]["last_updated"]    = datetime.date.today().isoformat()
    data["_meta"]["refresh_source"]  = "broadcom_api"

    if DRY_RUN:
        print("[DRY RUN] Would write:")
        print(json.dumps(data, indent=2)[:2000])
        print("...")
    else:
        with open(DATA_FILE, "w") as f:
            json.dump(data, f, indent=2)
        size = os.path.getsize(DATA_FILE)
        print(f"compat-data.json updated ({size:,} bytes)")

    print("\nDone!")


if __name__ == "__main__":
    if "--probe" in sys.argv:
        probe_upgrade_path()
    else:
        main()
