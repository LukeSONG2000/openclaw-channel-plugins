import unittest

from announcement_content import announcement_content


class AnnouncementContentTests(unittest.TestCase):
    def test_bare_url_moves_out_without_changing_surrounding_words(self):
        self.assertEqual(announcement_content("Day 15/ We're cooked https://t.co/abc"),
                         ("Day 15/ We're cooked", ["https://t.co/abc"]))

    def test_url_only_post_still_has_visible_content(self):
        self.assertEqual(announcement_content("https://t.co/abc"),
                         ("分享了一条链接", ["https://t.co/abc"]))

    def test_markdown_and_angle_links_keep_labels_and_deduplicate_destinations(self):
        self.assertEqual(announcement_content("[说明](https://example.com/a) <https://example.com/a>"),
                         ("说明", ["https://example.com/a"]))

    def test_punctuation_and_balanced_parentheses(self):
        self.assertEqual(announcement_content("看 https://example.com/a(b)，然后聊。"),
                         ("看 ，然后聊。", ["https://example.com/a(b)"]))
        self.assertEqual(announcement_content("More (https://example.com/a)."),
                         ("More ().", ["https://example.com/a"]))

    def test_no_url_is_unchanged(self):
        self.assertEqual(announcement_content("Direct usage reset\n原文"), ("Direct usage reset\n原文", []))

    def test_credentials_or_bad_authority_never_become_external_links(self):
        for url in ("https://user:pass@example.com/a", "https://[invalid/a"):
            with self.subTest(url=url):
                text, links = announcement_content("消息 " + url)
                self.assertEqual(text, "消息")
                self.assertEqual(links, [])


if __name__ == "__main__":
    unittest.main()
