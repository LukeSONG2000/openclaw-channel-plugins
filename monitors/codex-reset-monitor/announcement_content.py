"""Separate visible announcement text from clickable external links."""

import re
from urllib.parse import urlsplit


URL = re.compile(r"https?://[^\s<>\"'，。；！？、【】（）]+", re.IGNORECASE)


def announcement_content(text):
    links = []

    def remove(raw):
        url = raw.rstrip(".,;!?")
        while url.endswith(")") and url.count(")") > url.count("("):
            url = url[:-1]
        try:
            parsed = urlsplit(url)
            if (parsed.scheme == "https" and parsed.hostname and not parsed.username
                    and not parsed.password and url not in links):
                links.append(url)
        except ValueError:
            pass
        return raw[len(url):]

    # Preserve Markdown labels but move their destinations outside the image.
    text = re.sub(r"\[([^\]\n]+)\]\((https?://[^\s]+)\)",
                  lambda match: match[1] + remove(match[2]), text)
    text = re.sub(r"<(https?://[^\s<>]+)>", lambda match: remove(match[1]), text)
    text = URL.sub(lambda match: remove(match.group()), text)
    text = "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()).strip()
    return text or "分享了一条链接", links
