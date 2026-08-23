from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from kb_service.text_utils import markdown_chunks, merge_contexts_without_overlap


def token_count(text: str) -> int:
    return len(text.split())


def split_to_token_windows(text: str, max_tokens: int) -> list[str]:
    words = text.split()
    return [" ".join(words[start : start + max_tokens]) for start in range(0, len(words), max_tokens)]


class MarkdownChunkTests(unittest.TestCase):
    def chunk(self, markdown: str, budget: int = 40):
        return markdown_chunks(
            markdown,
            token_budget=budget,
            token_count=token_count,
            split_to_token_windows=split_to_token_windows,
        )

    def test_chunks_include_heading_path_and_section_identity(self) -> None:
        result = self.chunk("# Product\n\nIntro text.\n\n## API\n\nContract details.")

        self.assertEqual(result[0].heading_path, ("Product",))
        self.assertTrue(result[0].text.startswith("# Product"))
        self.assertEqual(result[1].heading_path, ("Product", "API"))
        self.assertTrue(result[1].text.startswith("# Product\n## API"))
        self.assertNotEqual(result[0].section_id, result[1].section_id)

    def test_lists_and_code_blocks_remain_coherent_when_within_budget(self) -> None:
        markdown = """# Runbook

Before running:

- first item
- second item

```python
print("hello")
print("world")
```
"""
        result = self.chunk(markdown, budget=10)

        self.assertTrue(any("- first item\n- second item" in item.text for item in result))
        self.assertTrue(any('```python\nprint("hello")\nprint("world")\n```' in item.text for item in result))
        self.assertFalse(any("Before running:\n```python" in item.text for item in result))

    def test_long_paragraph_is_split_to_budget_without_overlap_or_loss(self) -> None:
        words = [f"word-{index}" for index in range(60)]
        result = self.chunk("# Long\n\n" + " ".join(words), budget=16)

        self.assertGreater(len(result), 1)
        self.assertTrue(all(token_count(item.text) <= 16 for item in result))
        body_words = [word for item in result for word in item.text.split() if word.startswith("word-")]
        self.assertEqual(body_words, words)
        self.assertEqual(len(body_words), len(set(body_words)))

    def test_adjacent_merge_removes_exact_overlap(self) -> None:
        merged = merge_contexts_without_overlap(
            ["alpha beta gamma", "gamma delta", "delta epsilon"]
        )

        self.assertEqual(merged, "alpha beta gamma delta epsilon")


if __name__ == "__main__":
    unittest.main()
