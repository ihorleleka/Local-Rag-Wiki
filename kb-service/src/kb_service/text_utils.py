from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

WIKILINK_PATTERN = re.compile(r"\[\[([^\]|#]+)")
HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
LIST_ITEM_PATTERN = re.compile(r"^\s*(?:[-*+] |\d+[.)] )")


@dataclass(frozen=True)
class MarkdownChunk:
    text: str
    heading_path: tuple[str, ...]
    section_id: str


def sha256_text(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def chunks(text: str, size: int, overlap: int) -> list[str]:
    if size <= 0:
        raise ValueError("chunk size must be greater than zero")
    if overlap >= size:
        raise ValueError("chunk overlap must be smaller than chunk size")

    out: list[str] = []
    start = 0
    length = len(text)
    while start < length:
        end = min(start + size, length)
        out.append(text[start:end])
        if end == length:
            break
        start = end - overlap
    return out


def _markdown_sections(markdown: str) -> list[tuple[tuple[str, ...], list[str]]]:
    sections: list[tuple[tuple[str, ...], list[str]]] = []
    heading_stack: list[tuple[int, str]] = []
    current_lines: list[str] = []
    in_fence = False

    def flush() -> None:
        nonlocal current_lines
        if any(line.strip() for line in current_lines):
            sections.append((tuple(title for _, title in heading_stack), current_lines))
        current_lines = []

    for line in markdown.splitlines():
        if line.lstrip().startswith("```") or line.lstrip().startswith("~~~"):
            in_fence = not in_fence
            current_lines.append(line)
            continue
        match = None if in_fence else HEADING_PATTERN.match(line)
        if not match:
            current_lines.append(line)
            continue
        flush()
        level = len(match.group(1))
        heading_stack = [(existing_level, title) for existing_level, title in heading_stack if existing_level < level]
        heading_stack.append((level, match.group(2).strip()))
    flush()
    return sections


def _markdown_blocks(lines: list[str]) -> list[str]:
    blocks: list[str] = []
    current: list[str] = []
    in_fence = False

    def flush() -> None:
        nonlocal current
        text = "\n".join(current).strip()
        if text:
            blocks.append(text)
        current = []

    for line in lines:
        stripped = line.strip()
        if line.lstrip().startswith("```") or line.lstrip().startswith("~~~"):
            if not in_fence and current:
                flush()
            current.append(line)
            in_fence = not in_fence
            if not in_fence:
                flush()
            continue
        if in_fence:
            current.append(line)
            continue
        if not stripped:
            flush()
            continue
        if LIST_ITEM_PATTERN.match(line):
            if current and not LIST_ITEM_PATTERN.match(current[0]):
                flush()
            current.append(line)
            continue
        if current and LIST_ITEM_PATTERN.match(current[0]) and not line.startswith((" ", "\t")):
            flush()
        current.append(line)
    flush()
    return blocks


def markdown_chunks(
    markdown: str,
    *,
    token_budget: int,
    token_count,
    split_to_token_windows,
) -> list[MarkdownChunk]:
    if token_budget <= 0:
        raise ValueError("token budget must be greater than zero")
    output: list[MarkdownChunk] = []

    for section_index, (heading_path, lines) in enumerate(_markdown_sections(markdown)):
        prefix = "\n".join(
            f"{'#' * min(level, 6)} {title}"
            for level, title in enumerate(heading_path, start=1)
        )
        section_id = f"section-{section_index}"
        current_blocks: list[str] = []

        def render(blocks: list[str]) -> str:
            return "\n\n".join(part for part in [prefix, *blocks] if part).strip()

        def emit(blocks: list[str]) -> None:
            text = render(blocks)
            if not text:
                return
            count = token_count(text)
            if count > token_budget:
                raise ValueError(f"Markdown chunk exceeds token budget: {count} > {token_budget}")
            output.append(MarkdownChunk(text, heading_path, section_id))

        for block in _markdown_blocks(lines):
            candidate = render([*current_blocks, block])
            if token_count(candidate) <= token_budget:
                current_blocks.append(block)
                continue
            if current_blocks:
                emit(current_blocks)
                current_blocks = []
            standalone = render([block])
            if token_count(standalone) <= token_budget:
                current_blocks = [block]
                continue

            prefix_cost = token_count(prefix) if prefix else 0
            available = max(1, token_budget - prefix_cost - 4)
            for window in split_to_token_windows(block, available):
                emit([window])
        if current_blocks:
            emit(current_blocks)
    return output


def merge_contexts_without_overlap(parts: list[str]) -> str:
    merged = ""
    for part in (item for item in parts if item):
        if not merged:
            merged = part
            continue
        max_overlap = min(len(merged), len(part))
        overlap = 0
        for size in range(max_overlap, 0, -1):
            if merged.endswith(part[:size]):
                overlap = size
                break
        separator = "\n\n" if overlap == 0 else ""
        merged = f"{merged}{separator}{part[overlap:]}"
    return merged


def extract_links(markdown: str) -> list[str]:
    seen = set()
    links: list[str] = []
    for m in WIKILINK_PATTERN.finditer(markdown):
        link = m.group(1).strip()
        if link and link not in seen:
            seen.add(link)
            links.append(link)
    return links


def relative_md_paths(root: Path) -> Iterable[Path]:
    for file in sorted(root.rglob("*.md")):
        if file.is_file():
            yield file.relative_to(root)
