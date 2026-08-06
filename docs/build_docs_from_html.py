#!/usr/bin/env python3
"""
Auto-sync documentation builder
Reads vsphere-no-vcf.html, extracts URLs, scrapes content, generates docs_inline.js
Run this whenever you change the HTML file!
"""

import re
import json
import sys
import argparse
import concurrent.futures
import requests
from bs4 import BeautifulSoup
from pathlib import Path

# Configuration
JSON_FILE = ['vsphere-no-vcf-data.json', 'vsphere-to-vcf-no-automation-data.json', 'vsphere-to-vcf-with-automation-data.json', 'vcf-5.2-to-9.1-no-automation-data.json', 'vcf-5.2-to-9.1-with-automation-data.json', 'vcf-9.0-to-9.1-with-automation-data.json', 'vcf-9.0-to-9.1-no-automation-data.json', 'vcf-9.0-to-9.1-with-automation-data.json', 'vcf-9.1-to-9.1.0100-no-automation-data.json', 'vcf-9.1-to-9.1.0100-with-automation-data.json']
OUTPUT_FILE = 'docs_inline.js'
MAX_CONTENT_SIZE = 100000  # 100KB per doc
MAX_DEEP_URLS = 1000 # Max sub-pages to deep-scrape per run

# Manual URLs — add any external links here that are not referenced in the JSON files
MANUAL_URLS = [
    'https://williamlam.com/2026/05/vcf-9-1-additional-ip-allocation-options-for-vcf-management-services-vcfms-in-vcf-installer-and-sddc-manager.html',
    'https://knowledge.broadcom.com/external/article/433175/what-actions-should-be-taken-for-vmware.html',  # add this

]

# Collects (url, reason) tuples for every link that fails during the run
BAD_LINKS = []
# Tracks where each URL originated.
# Keys are URLs; values are lists of source strings, e.g.:
#   'json:vsphere-no-vcf-data.json'  → direct link found in a JSON file
#   'manual'                          → listed in MANUAL_URLS
#   'toc-subpage:<parent_url>'        → TOC sidebar child of a scraped page
#   'deep-L1:<parent_url>'            → link found inside a level-1 scraped page
#   'deep-L2:<parent_url>'            → link found inside a level-2 scraped page
URL_ORIGINS = {}   # url -> list[str]

def _tag_url(url, source):
    """Record that `url` was discovered from `source` (deduplicates per source)."""
    URL_ORIGINS.setdefault(url, [])
    if source not in URL_ORIGINS[url]:
        URL_ORIGINS[url].append(source)


def report_url_origins(urls, output_file='url_origins_report.txt'):
    """Print and save a comparison of direct JSON links vs sub/deep links.

    Groups every URL into one of:
      • Direct JSON link  – appeared as an href in at least one JSON data file
      • Manual URL        – listed in MANUAL_URLS
      • TOC sub-page only – only discovered as a sidebar child (never in JSON)
      • Deep-scraped only – only discovered by following body links
    """
    direct_json  = []
    manual_only  = []
    toc_only     = []
    deep_only    = []
    mixed        = []   # in JSON AND also a sub/deep link

    for url in sorted(urls):
        origins = URL_ORIGINS.get(url, [])
        is_json   = any(o.startswith('json:')    for o in origins)
        is_manual = any(o == 'manual'            for o in origins)
        is_toc    = any(o.startswith('toc-')     for o in origins)
        is_deep   = any(o.startswith('deep-')    for o in origins)

        if is_json and (is_toc or is_deep):
            mixed.append((url, origins))
        elif is_json:
            direct_json.append((url, origins))
        elif is_manual:
            manual_only.append((url, origins))
        elif is_toc:
            toc_only.append((url, origins))
        elif is_deep:
            deep_only.append((url, origins))
        else:
            direct_json.append((url, origins))   # fallback

    lines = []

    def _section(title, items):
        lines.append(f"\n{'='*80}")
        lines.append(f"  {title}  ({len(items)})")
        lines.append('='*80)
        for url, origins in items:
            lines.append(f"  {url}")
            for o in origins:
                lines.append(f"      ↳ {o}")

    print("\n" + "="*80)
    print("📊 URL ORIGINS REPORT")
    print("="*80)
    print(f"  Direct JSON links   : {len(direct_json)}")
    print(f"  Manual URLs         : {len(manual_only)}")
    print(f"  TOC sub-pages only  : {len(toc_only)}")
    print(f"  Deep-scraped only   : {len(deep_only)}")
    print(f"  In JSON + sub/deep  : {len(mixed)}")
    print(f"  TOTAL               : {len(urls)}")

    _section("DIRECT JSON LINKS", direct_json)
    _section("MANUAL URLS", manual_only)
    _section("TOC SUB-PAGES ONLY (not in JSON)", toc_only)
    _section("DEEP-SCRAPED ONLY (not in JSON)", deep_only)
    _section("IN JSON AND ALSO A SUB/DEEP LINK", mixed)

    report_text = "\n".join(lines)
    for line in lines:
        print(line)

    Path(output_file).write_text(
        "# URL Origins Report\n"
        "# Shows whether each URL was a direct JSON link, manual, TOC sub-page, or deep-scraped\n"
        + report_text + "\n",
        encoding='utf-8'
    )
    print(f"\n📄 URL origins report saved to: {output_file}")



def check_link(url, timeout=10):
    """HEAD request (GET fallback) to verify a URL is reachable.
    Returns (ok: bool, reason: str).
    """
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                      'AppleWebKit/537.36 (KHTML, like Gecko) '
                      'Chrome/120.0.0.0 Safari/537.36',
    }
    try:
        r = requests.head(url, headers=headers, timeout=timeout,
                          allow_redirects=True)
        if r.status_code == 405:          # HEAD not allowed → try GET
            r = requests.get(url, headers=headers, timeout=timeout,
                             stream=True, allow_redirects=True)
            r.close()
        if r.status_code == 200:
            return True, 'OK'
        return False, f'HTTP {r.status_code}'
    except requests.exceptions.Timeout:
        return False, 'Timeout'
    except requests.exceptions.ConnectionError as e:
        return False, f'ConnectionError: {e}'
    except Exception as e:
        return False, str(e)


def run_link_check(urls, workers=10):
    """Check all URLs in parallel and populate BAD_LINKS.
    Returns a list of (url, reason) for bad links only.
    """
    print(f"\n🔍 Checking {len(urls)} URLs for broken links ({workers} workers)…")
    bad = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        future_to_url = {pool.submit(check_link, u): u for u in urls}
        for i, future in enumerate(
                concurrent.futures.as_completed(future_to_url), 1):
            url = future_to_url[future]
            ok, reason = future.result()
            status = "✅" if ok else "❌"
            print(f"  [{i}/{len(urls)}] {status} {url}"
                  + (f"  → {reason}" if not ok else ""))
            if not ok:
                bad.append((url, reason))
    BAD_LINKS.extend(bad)
    return bad


def report_bad_links(bad, output_file='bad_links.txt'):
    """Print a formatted summary and save bad links to a file."""
    if not bad:
        print("\n✅ All links are reachable — no bad links found.")
        return
    print(f"\n{'='*80}")
    print(f"⚠️  BAD LINKS FOUND: {len(bad)}")
    print(f"{'='*80}")
    lines = []
    for url, reason in sorted(bad, key=lambda x: x[1]):
        line = f"  ❌ [{reason}]  {url}"
        print(line)
        lines.append(f"{reason}\t{url}")
    Path(output_file).write_text(
        "# Bad links report\n"
        "# Format: REASON<TAB>URL\n\n" +
        "\n".join(lines) + "\n",
        encoding='utf-8'
    )
    print(f"\n📄 Bad links saved to: {output_file}")


def extract_urls_from_json(json_path):
    """Extract all documentation URLs from the JSON data file"""
    print(f"📖 Reading {json_path}...")
    
    with open(json_path, 'r', encoding='utf-8') as f:
        json_content = f.read()
    
    # Find all hrefs in the JSON
    url_pattern = r'href=[\'"]([^\'">]+)[\'"]'
    all_urls = re.findall(url_pattern, json_content)
    
    # Filter to only documentation URLs
    doc_urls = set()
    for url in all_urls:
        if any(domain in url for domain in ['techdocs.broadcom.com', 'knowledge.broadcom.com', 'dell.com/support', 'interopmatrix.broadcom.com']):
            # Clean URL (remove fragments for cleaner scraping)
            clean_url = url.split('#')[0] if '#' in url else url
            doc_urls.add(clean_url)
    
    print(f"🔗 Found {len(doc_urls)} unique documentation URLs in JSON data")
    return sorted(doc_urls)

def decode_cf_emails(html):
    """Decode Cloudflare-obfuscated email addresses in HTML.

    Cloudflare replaces plain-text addresses (including non-standard ones like
    admin@vsp.local) with:
        <a class="__cf_email__" data-cfemail="<hex>" href="...cdn-cgi...">[email protected]</a>

    The encoding is a simple XOR: the first byte is the key; every subsequent
    byte is XOR'd with it to recover the original character.
    """
    pattern = re.compile(
        r'<a[^>]+class="__cf_email__"[^>]+data-cfemail="([0-9a-fA-F]+)"[^>]*>.*?</a>',
        re.IGNORECASE | re.DOTALL,
    )

    def _decode(m):
        encoded = m.group(1)
        try:
            key = int(encoded[:2], 16)
            return ''.join(
                chr(int(encoded[i:i+2], 16) ^ key)
                for i in range(2, len(encoded), 2)
            )
        except Exception:
            return m.group(0)  # leave unchanged if decoding fails

    return pattern.sub(_decode, html)


def scrape_documentation(url):
    """Scrape documentation content from a URL"""
    print(f"  🔄 Fetching: {url}")
    
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://techdocs.broadcom.com/',
            'Connection': 'keep-alive'
        }
        
        response = requests.get(url, headers=headers, timeout=15)
        
        if response.status_code != 200:
            reason = f'HTTP {response.status_code}'
            print(f"    ❌ Failed: {reason}")
            BAD_LINKS.append((url, reason))
            return None
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Extract title
        title_tag = soup.find('title')
        title = title_tag.text.strip() if title_tag else 'Documentation'
        title = re.sub(r'\s*\|\s*VMware.*$', '', title).strip()
        
        # Interop Matrix is a JavaScript SPA — serve it in an iframe so the user
        # can interact with the live page directly inside the inline docs modal.
        if 'interopmatrix.broadcom.com' in url:
            from urllib.parse import urlparse as _up, parse_qs as _pqs
            _p = _up(url)
            _params = _pqs(_p.query)
            _product_id = _params.get('productId', [''])[0]
            _endpoint = _p.path.strip('/').replace('-', ' ').title() or 'Interoperability Matrix'
            _label = f'{_endpoint} — Product ID {_product_id}' if _product_id else _endpoint

            stub_html = (
                f'<div style="display:flex; flex-direction:column; height:100%;">'
                f'<p style="margin:0 0 8px 0; font-size:0.85rem; color:#666;">'
                f'Can\'t see the matrix below? '
                f'<a href="{url}" target="_blank" rel="noopener noreferrer">Open in a new tab ↗</a>'
                f'</p>'
                f'<iframe src="{url}" style="width:100%; height:700px; border:1px solid #ddd; border-radius:4px; flex:1;" '
                f'title="VMware Interoperability Matrix" loading="lazy"></iframe>'
                f'</div>'
            )
            print(f'    ✅ Stub created for interop matrix page ({_label})')
            return {
                'title': f'VMware Interoperability Matrix — {_label}',
                'content': stub_html,
                'url': url,
                'subpages': []
            }

        # Extract main content — KB articles use a different structure to TechDocs
        if 'knowledge.broadcom.com' in url:
            main_content = (
                soup.find('div', class_=re.compile(r'wolken-content-container')) or
                soup.find('div', class_=re.compile(r'article-container')) or
                soup.find('main')
            )
        elif 'williamlam.com' in url:
            # William Lam's blog: post body is in .post or .entry-content
            main_content = (
                soup.find('div', class_=re.compile(r'entry-content|post-body|post-content')) or
                soup.find('article') or
                soup.find('div', class_=re.compile(r'post')) or
                soup.find('main')
            )
        else:
            # TechDocs: main-content is the correct selector for most pages
            main_content = (
                soup.find('div', class_='main-content') or
                soup.find('div', class_=re.compile(r'article-body|content-body|cmp-text|topic-body|article-content')) or
                soup.find('article') or
                soup.find('div', attrs={'role': 'main'}) or
                soup.find('main')
            )

        if not main_content:
            print(f"    ⚠️ No main content found")
            return None

        # --- Extract sub-pages from TOC and body links BEFORE stripping ---
        subpages = []
        base_url = 'https://knowledge.broadcom.com' if 'knowledge.broadcom.com' in url else 'https://techdocs.broadcom.com'
        seen_hrefs = set([url.split('#')[0]])
        allowed_domains = ['techdocs.broadcom.com', 'knowledge.broadcom.com']

        # Compute the "direct child prefix" for the current page.
        # For a URL like  .../upgrade-backup-and-restore.html  the prefix is
        # .../upgrade-backup-and-restore/  — a direct child must start with
        # that prefix and have no additional path segments beneath it.
        from urllib.parse import urlparse as _urlparse
        _parsed_url = _urlparse(url.split('#')[0])
        _current_path = _parsed_url.path.rstrip('/')
        if _current_path.endswith('.html'):
            _current_path = _current_path[:-5]
        _child_prefix = _current_path + '/'

        def _is_direct_child(href_clean):
            """Return True only if href_clean is a direct child page of the current URL."""
            try:
                child_path = _urlparse(href_clean).path
                if not child_path.startswith(_child_prefix):
                    return False
                remainder = child_path[len(_child_prefix):]
                stem = remainder.rsplit('.', 1)[0] if '.' in remainder else remainder.rstrip('/')
                return '/' not in stem and bool(stem)
            except Exception:
                return False

        # 1. Pull ONLY direct children from TOC sidebar.
        # TechDocs embeds the entire book-level TOC on every page. Without filtering
        # we'd capture 40+ unrelated top-level entries. Restrict to direct children only.
        toc_div = soup.find('div', class_=re.compile(r'cmp-tableofcontents|main-left-toc'))
        if toc_div:
            for a in toc_div.find_all('a', href=True):
                href = a['href']
                if href.startswith('/'):
                    href = base_url + href
                href_clean = href.split('#')[0]
                label = a.get_text(strip=True)
                if (label and href_clean
                        and href_clean not in seen_hrefs
                        and any(d in href_clean for d in allowed_domains)
                        and _is_direct_child(href_clean)):
                    seen_hrefs.add(href_clean)
                    subpages.append({'label': label, 'url': href_clean})

        # Note: body content links are NOT added to subpages — they are already
        # clickable in the rendered HTML and are intercepted by the modal click handler.
        # Subpages (sidebar navigation) should only contain direct TOC children.

        # Remove scripts, styles, nav, footer, TOC sidebars, search bars
        for tag in main_content.find_all(['script', 'style', 'nav', 'footer', 'button']):
            tag.decompose()
        for tag in main_content.find_all('div', class_=re.compile(r'tableofcontents|toc|sidebar|breadcrumb|search-bar|search-button')):
            tag.decompose()

        # Remove linklist / relatedlinks nav blocks — produce run-on text in the modal
        # without TechDocs CSS loaded.
        for tag in main_content.find_all(class_=re.compile(r'linklist|relatedlinks|linkpool')):
            tag.decompose()

        # TechDocs wraps every block element in <div style="display:inline">.
        # Strip that style so list items, paragraphs etc. render as separate lines.
        # EXCEPTION: skip elements whose direct parent is an inline tag (e.g.
        # <span class="keyword"><div style="display:inline">VCF Operations</div></span>)
        # — removing inline there makes the div block and breaks mid-sentence text.
        BLOCK_TAGS = {
            'div', 'p', 'li', 'ul', 'ol', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'table', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot',
            'article', 'aside', 'blockquote', 'figure', 'figcaption',
            'header', 'main', 'details', 'summary', 'dl', 'dt', 'dd',
            'pre', 'hr', 'fieldset', 'form'
        }
        INLINE_PARENTS = {
            'span', 'a', 'b', 'i', 'em', 'strong', 'code', 'kbd', 'label',
            'cite', 'abbr', 'big', 'small', 'sub', 'sup', 'var', 'q', 's', 'u'
        }
        for tag in main_content.find_all(True):
            if tag.name in BLOCK_TAGS:
                if tag.parent and tag.parent.name in INLINE_PARENTS:
                    continue
                style = tag.get('style', '')
                if 'display' in style:
                    new_style = re.sub(
                        r'(?:^|;)\s*display\s*:\s*inline\s*(?=;|$)', '', style
                    ).strip().lstrip(';').strip()
                    if new_style:
                        tag['style'] = new_style
                    else:
                        del tag['style']

        # Rewrite relative links to absolute so they work inside the inline modal
        # (prevents relative /us/en/... links from resolving against localhost)
        # Only rewrite for Broadcom docs pages — not Dell or other third-party pages
        if 'knowledge.broadcom.com' in url:
            link_base = 'https://knowledge.broadcom.com'
        elif 'techdocs.broadcom.com' in url:
            link_base = 'https://techdocs.broadcom.com'
        else:
            link_base = ''  # Don't rewrite links on third-party pages (e.g. Dell)
        if link_base:
            for a in main_content.find_all('a', href=True):
                href = a['href']
                if href.startswith('/'):
                    a['href'] = link_base + href

        # Get cleaned HTML
        content_html = str(main_content)

        # Decode Cloudflare-obfuscated email addresses (e.g. admin@vsp.local)
        content_html = decode_cf_emails(content_html)

        # Truncate if too large
        if len(content_html) > MAX_CONTENT_SIZE:
            content_html = content_html[:MAX_CONTENT_SIZE] + '<p><em>... (content truncated for PDF)</em></p>'
        
        print(f"    ✅ Success: {len(content_html)} chars")
        
        return {
            'title': title,
            'content': content_html,
            'url': url,
            'subpages': subpages
        }
        
    except requests.exceptions.Timeout:
        print(f"    ❌ Timeout after 15s")
        BAD_LINKS.append((url, 'Timeout'))
        return None
    except Exception as e:
        reason = f'Error: {str(e)}'
        print(f"    ❌ {reason}")
        BAD_LINKS.append((url, reason))
        return None

def extract_linked_urls_from_content(html_content, source_url=''):
    """Extract all documentation links from scraped HTML content (deep-scrape support).
    Only follows links to techdocs.broadcom.com or knowledge.broadcom.com.
    Relative links are resolved against the source_url domain, not a hardcoded base.
    """
    soup = BeautifulSoup(html_content, 'html.parser')
    linked = set()
    # Determine base domain from source URL for relative link resolution
    allowed_domains = ['techdocs.broadcom.com', 'knowledge.broadcom.com']
    source_base = ''
    for d in allowed_domains:
        if d in source_url:
            source_base = 'https://' + d
            break

    for a in soup.find_all('a', href=True):
        href = a['href']
        # Only resolve relative URLs if the source is a known docs domain
        if href.startswith('/') and source_base:
            href = source_base + href
        # Strip fragments
        href = href.split('#')[0]
        # Only keep techdocs or knowledge links (no cross-domain relative resolution)
        if any(d in href for d in allowed_domains):
            if href:
                linked.add(href)
    return linked


def generate_docs_file(docs, output_path):
    """Generate docs_inline.js file"""
    print(f"\n📝 Generating {output_path}...")
    
    # Create JavaScript object
    docs_dict = {doc['url']: {
        'title': doc['title'],
        'content': doc['content'],
        'url': doc['url'],
        'subpages': doc.get('subpages', [])
    } for doc in docs}
    
    js_content = 'window.INLINE_DOCS = ' + json.dumps(docs_dict, ensure_ascii=False, indent=2) + ';'
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(js_content)
    
    file_size = Path(output_path).stat().st_size
    print(f"  ✅ Generated: {output_path} ({file_size:,} bytes)")

def main():
    parser = argparse.ArgumentParser(
        description='Auto-sync documentation builder')
    parser.add_argument(
        '--check-only', action='store_true',
        help='Only check links for broken URLs; do not scrape or generate output')
    parser.add_argument(
        '--url-report', action='store_true',
        help='After building, print and save a report of which URLs came from JSON, '
             'MANUAL_URLS, TOC sub-pages, or deep-scrape')
    args = parser.parse_args()

    print("=" * 80)
    print("🔧 AUTO-SYNC DOCUMENTATION BUILDER")
    print("=" * 80)
    
    # Step 1: Extract URLs from both JSON files
    all_urls = set()
    json_files = ['vsphere-no-vcf-data.json', 'vsphere-to-vcf-no-automation-data.json', 'vsphere-to-vcf-with-automation-data.json', 'vcf-5.2-to-9.1-no-automation-data.json', 'vcf-5.2-to-9.1-with-automation-data.json', 'vcf-9.0-to-9.1-with-automation-data.json', 'vcf-9.0-to-9.1-no-automation-data.json', 'vcf-9.0-to-9.1-with-automation-data.json', 'vcf-9.1-to-9.1.0100-no-automation-data.json', 'vcf-9.1-to-9.1.0100-with-automation-data.json' ]
    
    for json_file in json_files:
        if Path(json_file).exists():
            print(f"\n📖 Reading {json_file}...")
            urls = extract_urls_from_json(json_file)
            all_urls.update(urls)
            for u in urls:
                _tag_url(u, f'json:{json_file}')
            print(f"  ✓ Added {len(urls)} URLs from this file")
        else:
            print(f"\n⚠️  {json_file} not found, skipping...")
    
    # Merge manually specified URLs
    if MANUAL_URLS:
        before = len(all_urls)
        all_urls.update(MANUAL_URLS)
        added = len(all_urls) - before
        for u in MANUAL_URLS:
            _tag_url(u, 'manual')
        print(f"\n📌 Added {added} manual URL(s) from MANUAL_URLS list")

    urls = sorted(all_urls)
    print(f"\n📊 Total unique URLs from all files: {len(urls)}")
    
    if not urls:
        print("❌ No documentation URLs found in HTML!")
        return

    # --check-only: validate every link then exit without scraping
    if args.check_only:
        bad = run_link_check(urls)
        report_bad_links(bad)
        if args.url_report:
            report_url_origins(urls)
        sys.exit(1 if bad else 0)

    # --url-report standalone: tag all collected URLs as their source then report
    if args.url_report and not any(URL_ORIGINS.values()):
        # Origins already tagged during collection above; just run the report
        report_url_origins(urls)
        sys.exit(0)

    print(f"\n📥 Fetching {len(urls)} documents from Broadcom/Dell...")
    print("=" * 80)
    
    # Step 2: Scrape each URL with deep-scrape (follow checklist/index page links)
    docs = []
    scraped_urls = set(urls)
    deep_urls = set()

    for i, url in enumerate(urls, 1):
        print(f"\n[{i}/{len(urls)}]")
        doc = scrape_documentation(url)
        if doc:
            docs.append(doc)
            # Queue TOC direct-child subpages for scraping (even if not in JSON)
            sp_urls = {sp['url'] for sp in doc.get('subpages', [])}
            new_sp = sp_urls - scraped_urls - deep_urls
            if new_sp:
                print(f"    📑 Queuing {len(new_sp)} TOC subpages for scraping")
                for u in new_sp:
                    _tag_url(u, f'toc-subpage:{url}')
                deep_urls.update(new_sp)
            # Deep-scrape: find additional linked pages not already in the queue
            linked = extract_linked_urls_from_content(doc['content'], source_url=url)
            new_links = linked - scraped_urls - deep_urls
            if new_links:
                print(f"    🔗 Found {len(new_links)} linked sub-pages to deep-scrape")
                for u in new_links:
                    _tag_url(u, f'deep-L1:{url}')
                deep_urls.update(new_links)

    # Scrape deep-discovered URLs (level 1) and follow their links (level 2)
    deep_urls_list = sorted(deep_urls)[:MAX_DEEP_URLS]
    if deep_urls_list:
        print(f"\n{'='*80}")
        print(f"🔍 DEEP SCRAPING {len(deep_urls_list)} linked sub-pages (level 1)...")
        print(f"{'='*80}")
        level2_urls = set()
        for i, url in enumerate(deep_urls_list, 1):
            print(f"\n[deep-L1 {i}/{len(deep_urls_list)}]")
            doc = scrape_documentation(url)
            if doc:
                docs.append(doc)
                # Queue TOC direct-child subpages for level-2 scraping
                sp_urls = {sp['url'] for sp in doc.get('subpages', [])}
                new_sp = sp_urls - scraped_urls - deep_urls - level2_urls
                if new_sp:
                    print(f"    📑 Queuing {len(new_sp)} TOC subpages (level-2)")
                    for u in new_sp:
                        _tag_url(u, f'toc-subpage:{url}')
                    level2_urls.update(new_sp)
                # Level 2: follow links found in level-1 pages
                linked = extract_linked_urls_from_content(doc['content'], source_url=url)
                new_links = linked - scraped_urls - deep_urls - level2_urls
                if new_links:
                    print(f"    🔗 Found {len(new_links)} level-2 links")
                    for u in new_links:
                        _tag_url(u, f'deep-L2:{url}')
                    level2_urls.update(new_links)
            scraped_urls.add(url)

        # Scrape level-2 URLs (cap remaining budget)
        remaining = MAX_DEEP_URLS - len(deep_urls_list)
        level2_list = sorted(level2_urls)[:max(0, remaining)]
        if level2_list:
            print(f"\n{'='*80}")
            print(f"🔍 DEEP SCRAPING {len(level2_list)} linked sub-pages (level 2)...")
            print(f"{'='*80}")
            for i, url in enumerate(level2_list, 1):
                print(f"\n[deep-L2 {i}/{len(level2_list)}]")
                doc = scrape_documentation(url)
                if doc:
                    docs.append(doc)
                scraped_urls.add(url)
    
    # Step 3: Generate output file
    print("\n" + "=" * 80)
    print(f"📊 Results: {len(docs)}/{len(urls)} documents fetched successfully")
    print("=" * 80)
    
    if docs:
        generate_docs_file(docs, OUTPUT_FILE)
        
        print("\n✅ COMPLETE!")
        print(f"  • Read URLs from: {' + '.join(json_files)}")
        print(f"  • Scraped: {len(docs)} documents")
        print(f"  • Generated: {OUTPUT_FILE}")
        
        # Report any bad links collected during scraping
        report_bad_links(BAD_LINKS)

        # URL origins report (always after a full build; also on --url-report)
        all_scraped = list(scraped_urls)
        report_url_origins(all_scraped)

        print(f"\n💡 Next steps:")
        print(f"  1. Both HTML files share the same {OUTPUT_FILE}")
        print(f"  2. When you edit either JSON file, run: python build_docs_from_html.py")
        print(f"  3. Automatically rebuilds docs from BOTH JSON data files!")
    else:
        print("\n❌ No documents could be fetched!")
        print("Check your internet connection and try again.")

if __name__ == '__main__':
    main()