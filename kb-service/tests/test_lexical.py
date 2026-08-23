from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from kb_service.lexical import BM25Index, is_identifier_like, lexical_terms


class LexicalTermTests(unittest.TestCase):
    def test_identifiers_yield_whole_and_subtokens(self) -> None:
        terms = set(lexical_terms("call wiki_search and OrderId handling"))
        self.assertIn("wiki_search", terms)
        self.assertIn("wiki", terms)
        self.assertIn("search", terms)
        self.assertIn("orderid", terms)
        self.assertIn("order", terms)
        self.assertIn("id", terms)

    def test_stopwords_dropped_but_numeric_codes_kept(self) -> None:
        terms = lexical_terms("how to handle error 404 and E11000")
        self.assertNotIn("how", terms)
        self.assertNotIn("to", terms)
        self.assertIn("404", terms)
        self.assertIn("e11000", terms)
        self.assertIn("handle", terms)


class BM25Tests(unittest.TestCase):
    def _corpus(self) -> BM25Index:
        return BM25Index.build(
            [
                ("auth.md", "authentication login sessions and token refresh"),
                ("mongo.md", "mongo write conflict E11000 duplicate key error"),
                ("grid.md", "responsive page grid layout and column spans"),
            ]
        )

    def test_rare_identifier_ranks_its_owner_first(self) -> None:
        index = self._corpus()
        results = index.search("E11000 duplicate key", limit=5)
        self.assertTrue(results)
        self.assertEqual(results[0][0], "mongo.md")
        self.assertEqual(results[0][1], 1.0)

    def test_no_match_returns_empty(self) -> None:
        index = self._corpus()
        self.assertEqual(index.search("kubernetes ingress helm chart", limit=5), [])

    def test_majority_common_term_is_dropped(self) -> None:
        # "service" appears in every document, so it is non-discriminative and
        # must not manufacture a match for a query that shares only that word.
        index = BM25Index.build(
            [
                ("a.md", "service alpha unique_alpha"),
                ("b.md", "service beta unique_beta"),
                ("c.md", "service gamma unique_gamma"),
            ]
        )
        self.assertEqual(index.search("service", limit=5), [])
        focused = index.search("unique_beta", limit=5)
        self.assertEqual(focused[0][0], "b.md")

    def test_empty_index_is_safe(self) -> None:
        index = BM25Index.build([])
        self.assertEqual(len(index), 0)
        self.assertEqual(index.search("anything", limit=5), [])

    def test_search_reports_matched_terms(self) -> None:
        index = self._corpus()
        results = index.search("E11000 duplicate key", limit=5)
        top_id, _score, matched = results[0]
        self.assertEqual(top_id, "mongo.md")
        self.assertIn("e11000", matched)


class IdentifierHeuristicTests(unittest.TestCase):
    def test_codes_and_identifiers_are_identifier_like(self) -> None:
        for term in ("e11000", "404", "wiki_search", "app.py", "kb-top-k"):
            self.assertTrue(is_identifier_like(term), term)

    def test_plain_words_are_not_identifier_like(self) -> None:
        for term in ("production", "policy", "encryption", "authentication"):
            self.assertFalse(is_identifier_like(term), term)


if __name__ == "__main__":
    unittest.main()
