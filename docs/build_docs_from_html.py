#!/usr/bin/env python3
"""
Auto-sync documentation builder
Reads vsphere-no-vcf.html, extracts URLs, scrapes content, generates docs_inline.js
Run this whenever you change the HTML file!
"""

import re
import json
import requests
from bs4 import BeautifulSoup
from pathlib import Path

# Configuration
JSON_FILE = ['vsphere-no-vcf-data.json', 'vsphere-to-vcf-no-automation-data.json', 'vsphere-to-vcf-with-automation-data.json', 'vcf-5.2-to-9.1-no-automation-data.json', 'vcf-5.2-to-9.1-with-automation-data.json', 'vcf-9.0-to-9.1-with-automation-data.json', 'vcf-9.0-to-9.1-no-automation-data.json', 'VCF-9.0-to-VCF-9.1-(VCF-Automation-included).html']
OUTPUT_FILE = 'docs_inline.js'
MAX_CONTENT_SIZE = 100000  # 100KB per doc
MAX_DEEP_URLS = 1000 # Max sub-pages to deep-scrape per run

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
        if any(domain in url for domain in ['techdocs.broadcom.com', 'knowledge.broadcom.com', 'dell.com/support']):
            # Clean URL (remove fragments for cleaner scraping)
            clean_url = url.split('#')[0] if '#' in url else url
            doc_urls.add(clean_url)
    
    print(f"🔗 Found {len(doc_urls)} unique documentation URLs in JSON data")
    return sorted(doc_urls)

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
            print(f"    ❌ Failed: HTTP {response.status_code}")
            return None
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Extract title
        title_tag = soup.find('title')
        title = title_tag.text.strip() if title_tag else 'Documentation'
        title = re.sub(r'\s*\|\s*VMware.*$', '', title).strip()
        
        # Extract main content — KB articles use a different structure to TechDocs
        if 'knowledge.broadcom.com' in url:
            main_content = (
                soup.find('div', class_=re.compile(r'wolken-content-container')) or
                soup.find('div', class_=re.compile(r'article-container')) or
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
        return None
    except Exception as e:
        print(f"    ❌ Error: {str(e)}")
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
    print("=" * 80)
    print("🔧 AUTO-SYNC DOCUMENTATION BUILDER")
    print("=" * 80)
    
    # Step 1: Extract URLs from both JSON files
    all_urls = set()
    json_files = ['vsphere-no-vcf-data.json', 'vsphere-to-vcf-no-automation-data.json', 'vsphere-to-vcf-with-automation-data.json', 'vcf-5.2-to-9.1-no-automation-data.json', 'vcf-5.2-to-9.1-with-automation-data.json', 'vcf-9.0-to-9.1-with-automation-data.json', 'vcf-9.0-to-9.1-no-automation-data.json', 'VCF-9.0-to-VCF-9.1-(VCF-Automation-included).html' ]
    
    for json_file in json_files:
        if Path(json_file).exists():
            print(f"\n📖 Reading {json_file}...")
            urls = extract_urls_from_json(json_file)
            all_urls.update(urls)
            print(f"  ✓ Added {len(urls)} URLs from this file")
        else:
            print(f"\n⚠️  {json_file} not found, skipping...")
    
    urls = sorted(all_urls)
    print(f"\n📊 Total unique URLs from all files: {len(urls)}")
    
    if not urls:
        print("❌ No documentation URLs found in HTML!")
        return
    
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
                deep_urls.update(new_sp)
            # Deep-scrape: find additional linked pages not already in the queue
            linked = extract_linked_urls_from_content(doc['content'], source_url=url)
            new_links = linked - scraped_urls - deep_urls
            if new_links:
                print(f"    🔗 Found {len(new_links)} linked sub-pages to deep-scrape")
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
                    level2_urls.update(new_sp)
                # Level 2: follow links found in level-1 pages
                linked = extract_linked_urls_from_content(doc['content'], source_url=url)
                new_links = linked - scraped_urls - deep_urls - level2_urls
                if new_links:
                    print(f"    🔗 Found {len(new_links)} level-2 links")
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
        
        # Show broken URLs if any
        failed_count = len(urls) - len(docs)
        if failed_count > 0:
            print(f"\n⚠️  {failed_count} URLs failed to scrape")
            print(f"  (Scroll up to see which URLs returned errors)")
        
        print(f"\n💡 Next steps:")
        print(f"  1. Both HTML files share the same {OUTPUT_FILE}")
        print(f"  2. When you edit either JSON file, run: python build_docs_from_html.py")
        print(f"  3. Automatically rebuilds docs from BOTH JSON data files!")
    else:
        print("\n❌ No documents could be fetched!")
        print("Check your internet connection and try again.")

if __name__ == '__main__':
    main()