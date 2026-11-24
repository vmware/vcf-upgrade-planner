"""Read and write the pooled JavaScript documentation bundle."""

import json
import re
from pathlib import Path


DOCS_PREFIX = 'window.INLINE_DOCS = '
POOL_MARKER = 'window.INLINE_DOC_CONTENT = '


def _pool_docs(data):
    content_pool = []
    content_indexes = {}
    pooled = {}

    for url, entry in data.items():
        content = entry.get('content', '')
        if content not in content_indexes:
            content_indexes[content] = len(content_pool)
            content_pool.append(content)

        pooled_entry = dict(entry)
        pooled_entry['content'] = {'$contentIndex': content_indexes[content]}
        pooled[url] = pooled_entry

    return pooled, content_pool


def write_inline_docs(data, output_path):
    """Write the runtime-compatible pooled bundle."""
    pooled, content_pool = _pool_docs(data)
    js_content = (
        DOCS_PREFIX + json.dumps(pooled, ensure_ascii=False, indent=2) + ';\n' +
        POOL_MARKER + json.dumps(content_pool, ensure_ascii=False, indent=2) + ';\n' +
        '(function (docs, contentPool) {\n'
        '  Object.keys(docs).forEach(function (url) {\n'
        '    var entry = docs[url];\n'
        '    if (entry.content && typeof entry.content === "object" &&\n'
        '        Object.prototype.hasOwnProperty.call(entry.content, "$contentIndex")) {\n'
        '      entry.content = contentPool[entry.content.$contentIndex];\n'
        '    }\n'
        '  });\n'
        '})(window.INLINE_DOCS, window.INLINE_DOC_CONTENT);\n'
        'delete window.INLINE_DOC_CONTENT;'
    )
    Path(output_path).write_text(js_content, encoding='utf-8')


def read_inline_docs(input_path):
    """Read both pooled bundles and legacy unpooled JSON bundles."""
    text = Path(input_path).read_text(encoding='utf-8').strip()
    if not text.startswith(DOCS_PREFIX):
        raise ValueError(f'Unexpected inline docs format in {input_path}')

    if POOL_MARKER not in text:
        payload = text[len(DOCS_PREFIX):]
        if payload.endswith(';'):
            payload = payload[:-1]
        return json.loads(payload)

    docs_text, pool_text = text[len(DOCS_PREFIX):].split(
        ';\n' + POOL_MARKER, 1
    )
    if pool_text.endswith(';'):
        pool_text = pool_text[:-1]
    # The pool is followed by the runtime hydration IIFE.
    pool_text = re.split(r';\n\(function \(docs, contentPool\)', pool_text, maxsplit=1)[0]
    data = json.loads(docs_text)
    content_pool = json.loads(pool_text)

    for entry in data.values():
        marker = entry.get('content')
        if isinstance(marker, dict) and '$contentIndex' in marker:
            entry['content'] = content_pool[marker['$contentIndex']]
    return data
