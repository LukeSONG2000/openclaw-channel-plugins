import json
import logging
from urllib.parse import urlsplit

from plugins.web._common import search_fail, search_ok, title_hit
from plugins.web.tavily.provider import TavilyWebSearchProvider

logger = logging.getLogger(__name__)


def prime_hits(result, limit):
    if not result.get("ok") or result.get("truncated"):
        return []
    rows = result.get("result")
    # Search Prime returns a JSON-encoded string in a text block.
    try:
        for _ in range(2):
            if isinstance(rows, str):
                rows = json.loads(rows)
    except ValueError:
        return []
    if not isinstance(rows, list):
        return []
    hits = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        url = row.get("link")
        if not isinstance(url, str):
            continue
        try:
            parsed = urlsplit(url)
            if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username:
                continue
        except ValueError:
            continue
        hits.append(title_hit(str(row.get("title") or "")[:240], url,
                              str(row.get("content") or "")[:1000], len(hits) + 1))
        if len(hits) >= limit:
            break
    return hits


class TavilyWithPrime(TavilyWebSearchProvider):
    NAME = "qq-tavily"
    DISPLAY_NAME = "Tavily with GLM Search Prime fallback"
    EXTRACT = False

    def __init__(self, call_mcp):
        self.call_mcp = call_mcp

    def search(self, query, limit=5):
        primary = super().search(query, limit)
        if primary.get("success") and primary.get("data", {}).get("web"):
            return primary
        from tools.interrupt import is_interrupted
        if is_interrupted():
            return search_fail("Interrupted")
        try:
            result = self.call_mcp("web-search-prime", "web_search_prime",
                                   {"search_query": query}, timeout=15)
            hits = prime_hits(result, limit)
            if hits:
                logger.info("QQ search served by GLM Search Prime after Tavily returned no usable hits")
                return search_ok(hits)
        except Exception:
            logger.warning("QQ search MCP fallback unavailable")
        if primary.get("success"):
            return primary
        return search_fail("Tavily and GLM Search Prime did not return results")


def register(ctx):
    ctx.register_web_search_provider(TavilyWithPrime(ctx.call_mcp))
