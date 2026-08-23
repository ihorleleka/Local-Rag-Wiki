from __future__ import annotations

import importlib
import os
import sys
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


class DummyCollection:
    def __init__(self):
        self.add_calls = []
        self.delete_calls = []
        self.query_calls = []

    def add(self, **kwargs):
        self.add_calls.append(kwargs)
        return None

    def delete(self, **kwargs):
        self.delete_calls.append(kwargs)
        return None

    def query(self, **kwargs):
        self.query_calls.append(kwargs)
        return {}

    def get(self, **kwargs):
        return {}


class DummyClient:
    def __init__(self, path):
        self.path = path

    def get_or_create_collection(self, *args, **kwargs):
        return DummyCollection()


class DummyProvider:
    def __init__(self, model):
        self.model = model
        self.embed_calls = []

    def embed(self, texts):
        self.embed_calls.append(list(texts))
        return [[0.0] for _ in texts]

    @property
    def max_input_tokens(self):
        return 256

    def token_count(self, text):
        return len(text.split()) + 2

    def truncate_to_tokens(self, text, max_tokens):
        return " ".join(text.split()[:max_tokens])

    def split_to_token_windows(self, text, max_tokens):
        words = text.split()
        return [" ".join(words[start : start + max_tokens]) for start in range(0, len(words), max_tokens)]


def install_fakes():
    chromadb_module = types.ModuleType("chromadb")
    chromadb_module.PersistentClient = DummyClient
    sys.modules["chromadb"] = chromadb_module

    frontmatter_module = types.ModuleType("frontmatter")
    frontmatter_module.loads = lambda raw: types.SimpleNamespace(content=raw, metadata={})
    sys.modules["frontmatter"] = frontmatter_module

    embeddings_module = types.ModuleType("kb_service.embeddings")
    embeddings_module.OnnxMiniLmProvider = DummyProvider
    sys.modules["kb_service.embeddings"] = embeddings_module


class ContextPacketTests(unittest.TestCase):
    def setUp(self) -> None:
        install_fakes()
        sys.modules.pop("kb_service.indexer", None)
        self.indexer_module = importlib.import_module("kb_service.indexer")

    def test_reindex_stores_markdown_section_metadata(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            wiki_root = root / "wiki"
            wiki_root.mkdir()
            (wiki_root / "api.md").write_text(
                "# Product\n\n## API\n\nContract details for clients.\n",
                encoding="utf-8",
            )
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                kb_root=root / "kb",
                embedding_model="dummy",
                staleness_days=90,
                chunk_tokens=32,
            )
            index = self.indexer_module.KnowledgeIndex(settings)

            result = index.reindex()

            self.assertEqual(result["changed"], 1)
            added = index.collection.add_calls[0]
            chunk_metadata = [
                metadata
                for metadata in added["metadatas"]
                if metadata["record_type"] == "chunk"
            ]
            self.assertEqual(chunk_metadata[0]["heading_path"], "Product > API")
            self.assertEqual(chunk_metadata[0]["section_id"], "section-0")
            self.assertTrue(added["documents"][0].startswith("# Product\n## API"))

    def test_unchanged_reindex_uses_hash_and_cached_evidence_without_reparsing(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            wiki_root = root / "wiki"
            wiki_root.mkdir()
            (wiki_root / "owner.md").write_text("# Owner\n\nStable contract.\n", encoding="utf-8")
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                repository_root=root,
                kb_root=root / "kb",
                embedding_model="dummy",
                staleness_days=90,
                chunk_tokens=32,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            index.reindex()
            embed_call_count = len(index.provider.embed_calls)

            with patch.object(indexer_frontmatter := self.indexer_module.frontmatter, "loads", side_effect=AssertionError("unchanged note was reparsed")):
                result = index.reindex()

            self.assertIsNotNone(indexer_frontmatter)
            self.assertEqual(result["changed"], 0)
            self.assertEqual(result["scanned"], 1)
            self.assertEqual(len(index.provider.embed_calls), embed_call_count)

    def test_targeted_reindex_updates_only_changed_note_and_batches_embeddings(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            wiki_root = root / "wiki"
            wiki_root.mkdir()
            for number in range(4):
                (wiki_root / f"note-{number}.md").write_text(
                    f"# Note {number}\n\n" + "content " * 50,
                    encoding="utf-8",
                )
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                repository_root=root,
                kb_root=root / "kb",
                embedding_model="dummy",
                staleness_days=90,
                chunk_tokens=32,
                embedding_batch_size=3,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            index.reindex()
            self.assertTrue(index.provider.embed_calls)
            self.assertTrue(all(len(call) <= 3 for call in index.provider.embed_calls))

            index.provider.embed_calls.clear()
            (wiki_root / "note-2.md").write_text("# Note 2\n\nchanged content\n", encoding="utf-8")
            result = index.reindex_paths({"note-2.md"})

            self.assertEqual(result["mode"], "targeted")
            self.assertEqual(result["scanned"], 1)
            self.assertEqual(result["changed"], 1)
            embedded = [text for call in index.provider.embed_calls for text in call]
            self.assertTrue(embedded)
            self.assertTrue(all("Note 2" in text or "changed content" in text for text in embedded))

    def test_targeted_reindex_falls_back_when_an_evidence_anchor_depends_on_path(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            wiki_root = root / "wiki"
            wiki_root.mkdir()
            (wiki_root / "owner.md").write_text("# Owner\n", encoding="utf-8")
            (wiki_root / "consumer.md").write_text(
                "# Consumer\n\n## Evidence\n- path: wiki/owner.md\n",
                encoding="utf-8",
            )
            (wiki_root / "data.md").write_text("# Data\n", encoding="utf-8")
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                repository_root=root,
                kb_root=root / "kb",
                embedding_model="dummy",
                staleness_days=90,
                chunk_tokens=32,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            index.reindex()

            (wiki_root / "owner.md").write_text("# Owner\n\nchanged\n", encoding="utf-8")
            dependent = index.reindex_paths({"owner.md"})
            unrelated = index.reindex_paths({"data.md"})

            self.assertEqual(dependent["mode"], "full")
            self.assertEqual(unrelated["mode"], "targeted")

    def test_reindex_cancellation_and_progress_are_observable(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            wiki_root = root / "wiki"
            wiki_root.mkdir()
            (wiki_root / "owner.md").write_text("# Owner\n", encoding="utf-8")
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                kb_root=root / "kb",
                embedding_model="dummy",
                staleness_days=90,
                chunk_tokens=32,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            cancel = __import__("threading").Event()
            cancel.set()
            progress = []

            with self.assertRaisesRegex(RuntimeError, "indexing cancelled"):
                index.reindex(cancel_event=cancel, progress_callback=lambda done, total: progress.append((done, total)))

            self.assertEqual(progress, [(0, 1)])

    def test_search_caps_caller_top_k_and_vector_candidate_count(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            wiki_root = root / "wiki"
            wiki_root.mkdir()
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                kb_root=root / "kb",
                embedding_model="dummy",
                staleness_days=90,
                top_k=8,
                max_top_k=20,
                min_relevance=0.35,
                merge_adjacent_window=0,
            )
            index = self.indexer_module.KnowledgeIndex(settings)

            self.assertEqual(index.search("owner contract", top_k=10_000), [])
            self.assertEqual(index.collection.query_calls[-1]["n_results"], 60)

    def test_compile_context_packet_extracts_decision_ready_fields(self) -> None:
        with TemporaryDirectory() as tmpdir:
            settings = types.SimpleNamespace(
                wiki_root=Path(tmpdir) / "wiki",
                kb_root=Path(tmpdir) / "kb",
                embedding_model="dummy",
                staleness_days=90,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            body = """# Image Guidance

## Use this when
Image retrieval needs implementation rules.

## Decision
Return compiled context packets before raw chunks.

## Rationale
Packet results give agents decision-ready context without loading full notes.

## Consequences
Raw chunks remain available as fallback when no packet matches.

## Do
- Parse semantic sections.
- Preserve Markdown as the editable format.

## Do not
- Require agents to maintain generated packet files.

## Evidence
- src/kb_service/indexer.py

## Retrieval hints
- MCP image support contract
"""
            packet = index.compile_context_packet(
                "Image.md",
                {
                    "id": "image-guidance",
                    "kind": "decision",
                    "scope": "project-specific",
                    "last_verified": date.today().isoformat(),
                    "status": "active",
                    "applies_to": ["wiki_search", "indexer"],
                },
                body,
            )

        self.assertIsNotNone(packet)
        assert packet is not None
        self.assertEqual(packet.kind, "decision")
        self.assertEqual(packet.rule, "Return compiled context packets before raw chunks.")
        self.assertEqual(packet.schema_health, "complete")
        self.assertEqual(packet.freshness_state, "current")
        self.assertEqual(packet.evidence_state, "present")
        self.assertFalse(packet.verification_required)
        self.assertFalse(packet.needs_verification)
        self.assertEqual(packet.applies_to, ["wiki_search", "indexer"])
        self.assertEqual(packet.metadata["context_packet"]["decision"], "Return compiled context packets before raw chunks.")
        self.assertEqual(packet.metadata["context_packet"]["rationale"], "Packet results give agents decision-ready context without loading full notes.")
        self.assertIn("Parse semantic sections.", packet.do)
        self.assertIn("Require agents to maintain generated packet files.", packet.do_not)
        self.assertEqual(packet.metadata["decision"], "Return compiled context packets before raw chunks.")
        self.assertIn("MCP image support contract", packet.metadata["retrieval_hints"])
        self.assertNotIn("raw_prose", packet.metadata)
        self.assertNotIn("Raw prose:", packet.index_text)

    def test_compile_context_packet_supports_investigation_notes(self) -> None:
        with TemporaryDirectory() as tmpdir:
            settings = types.SimpleNamespace(
                wiki_root=Path(tmpdir) / "wiki",
                kb_root=Path(tmpdir) / "kb",
                embedding_model="dummy",
                staleness_days=90,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            body = """# Flaky Retry Investigation

## Use this when
Retry storms reappear in the scheduler.

## Context
Intermittent duplicate retries under load.

## Findings
- Backoff timer was never reset after a success.
- The jitter window collapsed to zero at high concurrency.

## Eliminated approaches
- Increasing the global retry cap did not help.

## Scope and completeness
Covers the scheduler retry path only; queue consumers not audited.

## Evidence
- src/kb_service/indexer.py

## Retrieval hints
- scheduler retry backoff
"""
            packet = index.compile_context_packet(
                "investigations/flaky-retry.md",
                {
                    "id": "flaky-retry",
                    "kind": "investigation",
                    "scope": "project-specific",
                    "last_verified": date.today().isoformat(),
                    "status": "active",
                },
                body,
            )

        self.assertIsNotNone(packet)
        assert packet is not None
        self.assertEqual(packet.kind, "investigation")
        structured = packet.metadata["context_packet"]
        self.assertEqual(structured["kind"], "investigation")
        self.assertIn("Backoff timer was never reset after a success.", structured["findings"])
        self.assertEqual(structured["context"], "Intermittent duplicate retries under load.")
        self.assertIn("Increasing the global retry cap did not help.", structured["eliminated_approaches"])
        self.assertTrue(structured["scope_and_completeness"])
        self.assertEqual(packet.schema_health, "complete")
        self.assertIn("Findings:", packet.index_text)

    def test_investigation_kind_inferred_from_findings_sections(self) -> None:
        module = self.indexer_module
        kind, explicit = module._normalise_kind("", {"findings": "x"})
        self.assertEqual(kind, "investigation")
        self.assertFalse(explicit)

    def test_path_scope_helpers_restrict_to_subtree(self) -> None:
        module = self.indexer_module
        self.assertEqual(module._normalise_path_prefix("/components/"), "components")
        self.assertTrue(module._path_within_scope("components/page.md", "components"))
        self.assertFalse(module._path_within_scope("integrations/app.md", "components"))
        self.assertTrue(module._path_within_scope("components/page.md", "components/page.md"))
        self.assertFalse(module._path_within_scope("components/page.md", "components/other.md"))

    def test_capture_writes_pending_investigation_and_conflicts_on_repeat(self) -> None:
        with TemporaryDirectory() as tmpdir:
            wiki_root = Path(tmpdir) / "wiki"
            wiki_root.mkdir()
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                kb_root=Path(tmpdir) / "kb",
                embedding_model="dummy",
                staleness_days=90,
                capture_dir="investigations",
            )
            index = self.indexer_module.KnowledgeIndex(settings)

            result = index.capture(
                title="Flaky Retry Root Cause",
                context="Intermittent duplicate retries under load.",
                findings=["Backoff timer was never reset."],
                evidence=["src/kb_service/indexer.py"],
            )

            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["path"], "investigations/flaky-retry-root-cause.md")
            self.assertEqual(result["note_status"], "pending")
            written = (wiki_root / "investigations" / "flaky-retry-root-cause.md").read_text(encoding="utf-8")
            self.assertIn("kind: investigation", written)
            self.assertIn("status: pending", written)
            self.assertNotIn("last_verified", written)
            self.assertIn("Backoff timer was never reset.", written)

            packet = index.compile_context_packet(
                "investigations/flaky-retry-root-cause.md",
                {"id": "flaky-retry-root-cause", "kind": "investigation", "status": "pending"},
                written.split("---", 2)[-1],
            )
            self.assertIsNotNone(packet)

            conflict = index.capture(
                title="Flaky Retry Root Cause",
                context="Second attempt.",
                findings=["Different finding."],
            )
            self.assertEqual(conflict["status"], "conflict")

    def test_tree_reports_navigable_structure_from_manifest(self) -> None:
        with TemporaryDirectory() as tmpdir:
            wiki_root = Path(tmpdir) / "wiki"
            (wiki_root / "components").mkdir(parents=True)
            (wiki_root / "index.md").write_text("# Index\n\n## Summary\n\nMap.\n", encoding="utf-8")
            (wiki_root / "components" / "page.md").write_text(
                "# Page\n\n## Summary\n\nPage contract.\n", encoding="utf-8"
            )
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                kb_root=Path(tmpdir) / "kb",
                embedding_model="dummy",
                staleness_days=90,
                chunk_tokens=32,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            index.reindex()

            full = index.tree()
            self.assertEqual(full["total_notes"], 2)
            top_level = {child["name"]: child for child in full["tree"]["children"]}
            self.assertIn("components", top_level)
            self.assertEqual(top_level["components"]["type"], "dir")

            scoped = index.tree(path_prefix="components")
            self.assertEqual(scoped["total_notes"], 1)
            scoped_notes = [c for c in scoped["tree"]["children"] if c["type"] == "note"]
            self.assertEqual(scoped_notes[0]["path"], "components/page.md")

    def test_compile_context_packet_supports_reference_notes(self) -> None:
        with TemporaryDirectory() as tmpdir:
            settings = types.SimpleNamespace(
                wiki_root=Path(tmpdir) / "wiki",
                kb_root=Path(tmpdir) / "kb",
                embedding_model="dummy",
                staleness_days=90,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            body = """# Wiki Vocabulary

## Use this when
Agents need to understand wiki note taxonomy.

## Summary
Reference notes store durable facts that are useful for retrieval but are not rules.

## Key facts
- A reference note can describe concepts, fields, or API shapes.
- It should not force Do or Do not sections.

## Evidence
- README.md

## Retrieval hints
- wiki note kind reference packet
"""
            packet = index.compile_context_packet(
                "Vocabulary.md",
                {
                    "id": "wiki-vocabulary",
                    "kind": "reference",
                    "scope": "general",
                    "last_verified": date.today().isoformat(),
                    "status": "active",
                    "applies_to": ["wiki"],
                },
                body,
            )

        self.assertIsNotNone(packet)
        assert packet is not None
        self.assertEqual(packet.kind, "reference")
        self.assertEqual(packet.schema_health, "complete")
        self.assertEqual(packet.freshness_state, "current")
        self.assertEqual(packet.evidence_state, "present")
        self.assertFalse(packet.verification_required)
        self.assertEqual(packet.rule, "Reference notes store durable facts that are useful for retrieval but are not rules.")
        self.assertIn("A reference note can describe concepts, fields, or API shapes.", packet.metadata["key_facts"])
        self.assertEqual(packet.gaps, [])

    def test_compile_context_packet_flags_missing_or_stale_verification(self) -> None:
        with TemporaryDirectory() as tmpdir:
            settings = types.SimpleNamespace(
                wiki_root=Path(tmpdir) / "wiki",
                kb_root=Path(tmpdir) / "kb",
                embedding_model="dummy",
                staleness_days=90,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            body = """## Decision
Verify stale notes before applying them.

## Do
- Check current code.

## Evidence
- README.md
"""
            packet = index.compile_context_packet(
                "Stale.md",
                {"last_verified": (date.today() - timedelta(days=91)).isoformat()},
                body,
            )

        self.assertIsNotNone(packet)
        assert packet is not None
        self.assertEqual(packet.schema_health, "incomplete")
        self.assertEqual(packet.freshness_state, "stale")
        self.assertEqual(packet.evidence_state, "present")
        self.assertTrue(packet.verification_required)
        self.assertTrue(packet.needs_verification)
        self.assertIn("last_verified exceeds staleness threshold", packet.gaps)

    def test_trust_fields_report_schema_freshness_and_evidence_independently(self) -> None:
        with TemporaryDirectory() as tmpdir:
            settings = types.SimpleNamespace(
                wiki_root=Path(tmpdir) / "wiki",
                kb_root=Path(tmpdir) / "kb",
                embedding_model="dummy",
                staleness_days=90,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            body = """# Ownership Vocabulary

## Terms
- Owner note: the canonical note for a capability.

## Aliases
- canonical home

## Retrieval hints
- converter ownership
"""
            packet = index.compile_context_packet(
                "Ownership.md",
                {
                    "id": "ownership",
                    "kind": "glossary",
                    "status": "active",
                    "last_verified": "not-a-date",
                },
                body,
            )

        self.assertIsNotNone(packet)
        assert packet is not None
        self.assertEqual(packet.schema_health, "complete")
        self.assertEqual(packet.freshness_state, "unknown")
        self.assertEqual(packet.evidence_state, "missing")
        self.assertTrue(packet.verification_required)
        self.assertIn("evidence not provided", packet.gaps)

    def test_packet_embedding_keeps_routing_fields_inside_token_budget(self) -> None:
        with TemporaryDirectory() as tmpdir:
            settings = types.SimpleNamespace(
                wiki_root=Path(tmpdir) / "wiki",
                kb_root=Path(tmpdir) / "kb",
                embedding_model="dummy",
                staleness_days=90,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            body = f"""# Hero Converter Ownership

## Use this when
{"hero conversion routing " * 80}

## Summary
The Hero owner converts Hero content into rendering models.

## Key facts
{chr(10).join(f"- Long fact {item} " + "detail " * 40 for item in range(20))}

## Evidence
{chr(10).join(f"- src/evidence/{item}.cs" for item in range(50))}

## Retrieval hints
- HERO_CONVERTER_QUERY_MARKER
- hero converter owner
"""
            packet = index.compile_context_packet(
                "components/hero.md",
                {"id": "hero-owner", "applies_to": ["HeroConverter", "component rendering"]},
                body,
            )

        self.assertIsNotNone(packet)
        assert packet is not None
        self.assertLessEqual(index.provider.token_count(packet.index_text), 240)
        self.assertIn("HERO_CONVERTER_QUERY_MARKER", packet.index_text)
        self.assertIn("Applies to: HeroConverter", packet.index_text)
        self.assertLess(packet.index_text.index("Retrieval hints:"), packet.index_text.index("Primary contract:"))
        self.assertNotIn("Evidence:", packet.index_text)

    def test_capability_fixtures_expose_extended_contract_fields(self) -> None:
        for source, title in [
            ("components/component-rendering-core.md", "Component Rendering Core"),
            ("components/page-grid-areas.md", "Page Grid Areas"),
        ]:
            with self.subTest(source=source), TemporaryDirectory() as tmpdir:
                settings = types.SimpleNamespace(
                    wiki_root=Path(tmpdir) / "wiki",
                    kb_root=Path(tmpdir) / "kb",
                    embedding_model="dummy",
                    staleness_days=90,
                )
                index = self.indexer_module.KnowledgeIndex(settings)
                body = f"""# {title}

## Use this when
Changing capability behavior or ownership.

## Summary
This capability has a typed delivery contract.

## Key facts
- The capability has one owner.

## Capability contract
- Inputs produce deterministic typed outputs.

## Behavior model
- Invalid input returns a deterministic failure.

## Interaction model
- Callers invoke the owner through its public contract.

## Architecture boundaries
- Foundation owns reusable mechanics; features own concrete behavior.

## Data and integration contracts
- External messages remain backward compatible.

## Quality attributes
- Rendering remains observable and reliable.

## Acceptance and verification
- Run focused capability contract tests.

## Reconstruction guidance
- Rebuild the contract before adapters.

## Open questions
- Production hardening needs confirmation.

## Evidence
- src/Capability.cs

## Retrieval hints
- capability owner contract
"""
                packet = index.compile_context_packet(
                    source,
                    {"kind": "reference", "last_verified": date.today().isoformat()},
                    body,
                )

                self.assertIsNotNone(packet)
                assert packet is not None
                structured = packet.metadata["context_packet"]
                self.assertEqual(structured["capability_contract"], ["Inputs produce deterministic typed outputs."])
                self.assertEqual(
                    structured["architecture_boundaries"],
                    ["Foundation owns reusable mechanics; features own concrete behavior."],
                )
                self.assertEqual(
                    structured["acceptance_verification"],
                    ["Run focused capability contract tests."],
                )
                self.assertTrue(structured["has_open_questions"])
                self.assertIn("Capability contract:", packet.index_text)

    def test_schema_report_requires_core_sections_only_for_capability_shape(self) -> None:
        with TemporaryDirectory() as tmpdir:
            wiki_root = Path(tmpdir) / "wiki"
            wiki_root.mkdir()
            (wiki_root / "Partial.md").write_text(
                """# Partial capability

## Summary
Partial behavior.

## Key facts
- One fact.

## Behavior model
- One behavior.

## Evidence
- src/Partial.cs

## Retrieval hints
- partial capability
""",
                encoding="utf-8",
            )
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                kb_root=Path(tmpdir) / "kb",
                embedding_model="dummy",
                staleness_days=90,
            )
            report = self.indexer_module.KnowledgeIndex(settings).schema_report()

        entry = report["files"][0]
        self.assertTrue(entry["capability_specification"])
        self.assertEqual(
            entry["missing_capability_sections"],
            ["Capability contract", "Architecture boundaries", "Acceptance and verification"],
        )
        self.assertEqual(
            sum(issue["code"] == "missing_capability_section" for issue in entry["issues"]),
            3,
        )

    def test_schema_report_compares_evidence_with_the_accepted_manifest_snapshot(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            wiki_root = root / "wiki"
            wiki_root.mkdir()
            (wiki_root / "Current.md").write_text(
                """# Current

## Summary
Current behavior.

## Key facts
- One fact.

## Evidence
- README.md

## Retrieval hints
- current behavior
""",
                encoding="utf-8",
            )
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                kb_root=root / "kb",
                repository_root=root,
                embedding_model="dummy",
                staleness_days=90,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            accepted_snapshot = {
                "path:README.md#": {
                    "kind": "path",
                    "target": "README.md",
                    "locator": "",
                    "exists": True,
                    "identity": "accepted",
                    "working_tree_state": "modified_or_untracked",
                }
            }
            index._write_manifest(
                {"files": {"Current.md": {"evidence_snapshot": accepted_snapshot}}}
            )

            with patch.object(self.indexer_module, "EvidenceInspector") as inspector_type:
                inspector_type.return_value.inspect.return_value = (
                    self.indexer_module.declared_evidence_report(["README.md"])
                )
                index.schema_report()

            inspector_type.return_value.inspect.assert_called_once_with(
                ["README.md"],
                accepted_snapshot,
            )

    def test_schema_report_flags_legacy_schema_and_link_gaps(self) -> None:
        with TemporaryDirectory() as tmpdir:
            wiki_root = Path(tmpdir) / "wiki"
            wiki_root.mkdir()
            (wiki_root / "Legacy.md").write_text(
                """# Legacy

## Decision
Use typed packets.

## Evidence
- [[Missing]]
""",
                encoding="utf-8",
            )
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                kb_root=Path(tmpdir) / "kb",
                embedding_model="dummy",
                staleness_days=90,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            report = index.schema_report()

        self.assertEqual(report["schema_version"], self.indexer_module.INDEX_SCHEMA_VERSION)
        self.assertEqual(report["total_files"], 1)
        self.assertEqual(report["summary"]["packet_files"], 1)
        self.assertEqual(report["summary"]["files_with_issues"], 1)
        entry = report["files"][0]
        self.assertEqual(entry["source_file"], "Legacy.md")
        self.assertEqual(entry["kind"], "decision")
        self.assertFalse(entry["explicit_kind"])
        self.assertTrue(entry["packet_compiled"])
        self.assertIn("Missing", entry["broken_links"])
        issue_codes = {issue["code"] for issue in entry["issues"]}
        self.assertIn("missing_or_invalid_kind", issue_codes)
        self.assertIn("missing_last_verified", issue_codes)
        self.assertIn("broken_wiki_link", issue_codes)

    def test_schema_report_warns_for_notes_over_line_limit(self) -> None:
        with TemporaryDirectory() as tmpdir:
            wiki_root = Path(tmpdir) / "wiki"
            wiki_root.mkdir()
            oversized_body = "\n".join(
                [
                    "# Oversized",
                    "",
                    "## Summary",
                    "This note is intentionally too long.",
                    "",
                    "## Key facts",
                    "- One fact.",
                    "",
                    "## Evidence",
                    "- README.md",
                    "",
                    "## Retrieval hints",
                    "- oversized note",
                    *["extra detail" for _ in range(8)],
                ]
            )
            (wiki_root / "Oversized.md").write_text(oversized_body, encoding="utf-8")
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                kb_root=Path(tmpdir) / "kb",
                embedding_model="dummy",
                staleness_days=90,
                note_max_lines=20,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            report = index.schema_report()

        self.assertEqual(report["summary"]["max_note_lines"], 20)
        self.assertEqual(report["summary"]["oversized_files"], 1)
        entry = report["files"][0]
        self.assertGreater(entry["line_count"], 20)
        issue_codes = {issue["code"] for issue in entry["issues"]}
        self.assertIn("note_too_large", issue_codes)

    def test_schema_report_bounds_large_missing_evidence_inventory_warnings(self) -> None:
        with TemporaryDirectory() as tmpdir:
            wiki_root = Path(tmpdir) / "wiki"
            wiki_root.mkdir()
            anchors = "\n".join(f"- path: missing/file-{index}.cs" for index in range(6))
            (wiki_root / "Evidence.md").write_text(
                f"""# Evidence

## Summary
Evidence warning fixture.

## Key facts
- One fact.

## Evidence
{anchors}

## Retrieval hints
- bounded evidence warnings
""",
                encoding="utf-8",
            )
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                kb_root=Path(tmpdir) / "kb",
                embedding_model="dummy",
                staleness_days=90,
                evidence_max_anchors=2,
            )
            report = self.indexer_module.KnowledgeIndex(settings).schema_report()

        evidence_issues = [
            issue for issue in report["files"][0]["issues"] if "evidence" in issue["code"]
        ]
        self.assertEqual(
            [issue["code"] for issue in evidence_issues],
            ["missing_evidence_anchors", "evidence_inventory_too_large"],
        )
        self.assertIn("(+2 more)", evidence_issues[0]["message"])


class RankingTests(unittest.TestCase):
    def setUp(self) -> None:
        install_fakes()
        sys.modules.pop("kb_service.indexer", None)
        self.indexer_module = importlib.import_module("kb_service.indexer")

    def candidate(
        self,
        source: str,
        score: float,
        record_type: str,
        *,
        verification_required: bool = False,
        status: str = "active",
        chunk_idx: int = 0,
        evidence_state: str = "present",
    ):
        packet = None
        if record_type == "packet":
            packet = {
                "source": source,
                "rule": f"Owner contract for {source}",
                "verification_required": verification_required,
                "status": status,
                "evidence_state": evidence_state,
            }
        return self.indexer_module.SearchCandidate(
            source_file=source,
            chunk_idx=chunk_idx,
            semantic_score=score,
            context=f"Context for {source}",
            record_type=record_type,
            packet=packet,
            metadata={"note_status": status},
        )

    def test_strong_chunk_outranks_weak_packet(self) -> None:
        weak_packet = self.candidate("weak.md", 0.30, "packet")
        strong_chunk = self.candidate("strong.md", 0.70, "chunk")

        ranked = self.indexer_module.KnowledgeIndex._select_ranked_candidates(
            [weak_packet, strong_chunk], 2
        )

        self.assertIs(ranked[0], strong_chunk)

    def test_small_boost_prefers_relevant_verified_owner_packet(self) -> None:
        owner_packet = self.candidate("owner.md", 0.70, "packet")
        owner_chunk = self.candidate("owner.md", 0.72, "chunk", chunk_idx=1)
        other_chunk = self.candidate("other.md", 0.50, "chunk")

        ranked = self.indexer_module.KnowledgeIndex._select_ranked_candidates(
            [owner_chunk, owner_packet, other_chunk], 3
        )

        self.assertIs(ranked[0], owner_packet)
        self.assertGreater(owner_packet.ranking_score, owner_chunk.ranking_score)

    def test_unverified_packet_is_penalized(self) -> None:
        packet = self.candidate("owner.md", 0.70, "packet", verification_required=True)
        chunk = self.candidate("owner.md", 0.72, "chunk", chunk_idx=1)

        ranked = self.indexer_module.KnowledgeIndex._select_ranked_candidates(
            [packet, chunk], 2
        )

        self.assertIs(ranked[0], chunk)

    def test_changed_evidence_packet_is_auto_demoted(self) -> None:
        # Same relevance for two owner packets; the one whose evidence changed
        # since verification must be demoted so drift self-corrects.
        fresh = self.candidate("fresh.md", 0.70, "packet")
        drifted = self.candidate(
            "drifted.md",
            0.70,
            "packet",
            verification_required=True,
            evidence_state="changed_since_verification",
        )

        self.assertGreater(fresh.ranking_score, drifted.ranking_score)
        ranked = self.indexer_module.KnowledgeIndex._select_ranked_candidates(
            [drifted, fresh], 2
        )
        self.assertIs(ranked[0], fresh)

    def test_missing_evidence_incurs_extra_penalty_over_unverified(self) -> None:
        unverified = self.candidate("a.md", 0.70, "packet", verification_required=True)
        missing = self.candidate(
            "b.md",
            0.70,
            "packet",
            verification_required=True,
            evidence_state="missing",
        )
        self.assertGreater(unverified.ranking_score, missing.ranking_score)

    def test_source_diversity_prevents_one_note_filling_results(self) -> None:
        candidates = [
            self.candidate("owner.md", 0.90, "packet"),
            self.candidate("owner.md", 0.85, "chunk", chunk_idx=1),
            self.candidate("owner.md", 0.80, "chunk", chunk_idx=2),
            self.candidate("support.md", 0.60, "packet"),
        ]

        ranked = self.indexer_module.KnowledgeIndex._select_ranked_candidates(candidates, 4)

        self.assertEqual([item.source_file for item in ranked[:2]], ["owner.md", "support.md"])
        self.assertLessEqual(sum(item.source_file == "owner.md" for item in ranked), 2)

    def test_inactive_notes_require_explicit_history_option(self) -> None:
        active = self.candidate("active.md", 0.50, "packet")
        deprecated = self.candidate("old.md", 0.95, "packet", status="deprecated")

        default = self.indexer_module.KnowledgeIndex._select_ranked_candidates(
            [deprecated, active], 2
        )
        history = self.indexer_module.KnowledgeIndex._select_ranked_candidates(
            [deprecated, active], 2, include_inactive=True
        )

        self.assertEqual([item.source_file for item in default], ["active.md"])
        self.assertEqual(history[0].source_file, "old.md")

    def test_minimum_relevance_filters_unrelated_candidates(self) -> None:
        unrelated = self.candidate("unrelated.md", 0.30, "chunk")
        relevant = self.candidate("owner.md", 0.50, "packet")

        miss = self.indexer_module.KnowledgeIndex._select_ranked_candidates(
            [unrelated], 3, min_relevance=0.35
        )
        hit = self.indexer_module.KnowledgeIndex._select_ranked_candidates(
            [unrelated, relevant], 3, min_relevance=0.35
        )

        self.assertEqual(miss, [])
        self.assertEqual([item.source_file for item in hit], ["owner.md"])


class WikiPathSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        install_fakes()
        sys.modules.pop("kb_service.indexer", None)
        self.indexer_module = importlib.import_module("kb_service.indexer")

    def make_index(self, root: Path):
        wiki_root = root / "wiki"
        wiki_root.mkdir()
        settings = types.SimpleNamespace(
            wiki_root=wiki_root,
            kb_root=root / "kb",
            embedding_model="dummy",
            staleness_days=90,
        )
        return self.indexer_module.KnowledgeIndex(settings), wiki_root

    def assert_rejected_for_read_and_write(self, index, path: str) -> None:
        with self.assertRaises(ValueError, msg=f"read accepted unsafe path: {path}"):
            index.read_doc(path)
        with self.assertRaises(ValueError, msg=f"write accepted unsafe path: {path}"):
            index.write_doc(path, "unsafe")

    def test_valid_nested_markdown_read_and_write(self) -> None:
        with TemporaryDirectory() as tmpdir:
            index, wiki_root = self.make_index(Path(tmpdir))
            created = index.write_doc("guides/nested.md", "# Safe\n")

            self.assertEqual(created["status"], "ok")
            read = index.read_doc("guides\\nested.md")
            self.assertEqual(read["content"], "# Safe\n")
            self.assertEqual(read["content_hash"], created["content_hash"])
            self.assertEqual((wiki_root / "guides" / "nested.md").read_text(encoding="utf-8"), "# Safe\n")

    def test_stale_concurrent_writer_cannot_overwrite_newer_content(self) -> None:
        with TemporaryDirectory() as tmpdir:
            index, _ = self.make_index(Path(tmpdir))
            created = index.write_doc("owner.md", "version one")
            expected_hash = created["content_hash"]
            barrier = Barrier(2)

            def write(content: str):
                barrier.wait()
                return index.write_doc("owner.md", content, expected_hash)

            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(write, ["version two-a", "version two-b"]))

            self.assertEqual(sorted(result["status"] for result in results), ["conflict", "ok"])
            final = index.read_doc("owner.md")
            self.assertIn(final["content"], {"version two-a", "version two-b"})
            conflict = next(result for result in results if result["status"] == "conflict")
            self.assertEqual(conflict["reason"], "hash_mismatch")
            self.assertEqual(conflict["current_hash"], final["content_hash"])

    def test_replacing_existing_note_requires_expected_hash(self) -> None:
        with TemporaryDirectory() as tmpdir:
            index, _ = self.make_index(Path(tmpdir))
            created = index.write_doc("owner.md", "original")

            conflict = index.write_doc("owner.md", "unsafe replacement")

            self.assertEqual(conflict["reason"], "expected_hash_required")
            self.assertEqual(conflict["current_hash"], created["content_hash"])
            self.assertEqual(index.read_doc("owner.md")["content"], "original")

    def test_interrupted_note_replace_leaves_original_and_no_temporary_file(self) -> None:
        with TemporaryDirectory() as tmpdir:
            index, wiki_root = self.make_index(Path(tmpdir))
            created = index.write_doc("owner.md", "original")

            with patch("kb_service.atomic_io.os.replace", side_effect=OSError("simulated interruption")):
                with self.assertRaises(OSError):
                    index.write_doc("owner.md", "partial replacement", created["content_hash"])

            self.assertEqual(index.read_doc("owner.md")["content"], "original")
            self.assertEqual(list(wiki_root.glob(".owner.md.*.tmp")), [])

    def test_interrupted_manifest_replace_leaves_valid_original(self) -> None:
        with TemporaryDirectory() as tmpdir:
            index, _ = self.make_index(Path(tmpdir))
            index._write_manifest({"files": {"first.md": {"hash": "one"}}})
            original = index._read_manifest()

            with patch("kb_service.atomic_io.os.replace", side_effect=OSError("simulated interruption")):
                with self.assertRaises(OSError):
                    index._write_manifest({"files": {"second.md": {"hash": "two"}}})

            self.assertEqual(index._read_manifest(), original)
            self.assertEqual(list(index.manifest_path.parent.glob(".manifest.json.*.tmp")), [])

    def test_index_revision_ignores_manifest_timestamp_churn(self) -> None:
        with TemporaryDirectory() as tmpdir:
            index, _ = self.make_index(Path(tmpdir))
            files = {"owner.md": {"hash": "stable"}}
            index._write_manifest({"files": files})
            first = index.index_revision()
            index._write_manifest({"files": files})

            self.assertEqual(index.index_revision(), first)

    def test_rejects_traversal_prefix_sibling_and_absolute_paths(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            index, _ = self.make_index(root)
            paths = [
                "../outside.md",
                "..\\outside.md",
                "../wiki-other/file.md",
                str((root / "absolute.md").resolve()),
                "C:\\outside\\file.md",
                "\\\\server\\share\\file.md",
            ]
            for path in paths:
                with self.subTest(path=path):
                    self.assert_rejected_for_read_and_write(index, path)

    def test_rejects_hidden_and_non_markdown_paths(self) -> None:
        with TemporaryDirectory() as tmpdir:
            index, _ = self.make_index(Path(tmpdir))
            for path in [".obsidian/config.md", "nested/.private.md", "notes.txt", "notes.MD"]:
                with self.subTest(path=path):
                    self.assert_rejected_for_read_and_write(index, path)

    def test_rejects_symlink_escape(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            index, wiki_root = self.make_index(root)
            outside = root / "outside"
            outside.mkdir()
            (outside / "secret.md").write_text("secret", encoding="utf-8")
            link = wiki_root / "linked"
            try:
                os.symlink(outside, link, target_is_directory=True)
            except OSError as error:
                self.fail(f"test environment could not create the required symlink: {error}")

            self.assert_rejected_for_read_and_write(index, "linked/secret.md")

    def test_rename_rejects_inbound_links_then_succeeds_after_link_update(self) -> None:
        with TemporaryDirectory() as tmpdir:
            index, _ = self.make_index(Path(tmpdir))
            source = index.write_doc("owner.md", "# Owner\n")
            referring = index.write_doc("map.md", "See [[owner#Contract|the owner contract]].\n")

            conflict = index.rename_doc("owner.md", "archive/owner.md", source["content_hash"])
            self.assertEqual(conflict["reason"], "inbound_links_exist")
            self.assertEqual(conflict["inbound_links"], ["map.md"])

            updated_map = index.write_doc("map.md", "No inbound link.\n", referring["content_hash"])
            self.assertEqual(updated_map["status"], "ok")
            renamed = index.rename_doc("owner.md", "archive/owner.md", source["content_hash"])
            self.assertEqual(renamed["status"], "ok")
            self.assertEqual(index.read_doc("archive/owner.md")["content"], "# Owner\n")
            with self.assertRaises(FileNotFoundError):
                index.read_doc("owner.md")

    def test_delete_requires_current_hash_and_removes_index_records_on_reindex(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            wiki_root = root / "wiki"
            wiki_root.mkdir()
            settings = types.SimpleNamespace(
                wiki_root=wiki_root,
                kb_root=root / "kb",
                embedding_model="dummy",
                staleness_days=90,
                chunk_tokens=32,
            )
            index = self.indexer_module.KnowledgeIndex(settings)
            created = index.write_doc("owner.md", "# Owner\n\nOwner details.\n")
            index.reindex()

            stale = index.delete_doc("owner.md", "stale-hash")
            self.assertEqual(stale["reason"], "hash_mismatch")
            deleted = index.delete_doc("owner.md", created["content_hash"])
            result = index.reindex()

            self.assertEqual(deleted["status"], "ok")
            self.assertEqual(result["removed"], 1)
            self.assertEqual(index.list_docs(), [])
            self.assertTrue(index.collection.delete_calls)


if __name__ == "__main__":
    unittest.main()
