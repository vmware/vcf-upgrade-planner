"""Safe truncation of HTML fragments.

Cutting an HTML string at a fixed length can stop inside a tag or attribute and leaves elements open. When such a
fragment is embedded in a larger page (the print/PDF export), the browser nests everything that follows inside the
open table cell or div. safe_truncate() cuts at a tag boundary and closes every element still open.
"""
import re
from html.parser import HTMLParser

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}


class _Stack(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.stack = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        pass

    def handle_endtag(self, tag):
        if tag in self.stack:
            while self.stack and self.stack.pop() != tag:
                pass


def open_tags(fragment):
    p = _Stack()
    p.feed(fragment)
    return p.stack


def close_open_tags(fragment):
    """Return fragment with a dangling partial tag removed and all still-open elements closed."""
    cut = fragment.rfind('<')
    if cut > fragment.rfind('>'):
        fragment = fragment[:cut]
    # also drop a dangling partial entity such as '&am'
    fragment = re.sub(r'&[#A-Za-z0-9]{0,10}$', '', fragment)
    return fragment + ''.join('</%s>' % t for t in reversed(open_tags(fragment)))


def safe_truncate(html, limit, note=''):
    if len(html) <= limit:
        return html
    return close_open_tags(html[:limit]) + note
