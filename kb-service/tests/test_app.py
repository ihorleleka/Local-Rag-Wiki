from __future__ import annotations

import asyncio
import importlib
import sys
import threading
import types
import unittest
from threading import Lock
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


@dataclass
class DummySearchResult:
    source_file: str
    chunk_id: str
    score: float
    context: str


class DummyKnowledgeIndex:
    last_instance: "DummyKnowledgeIndex | None" = None

    def __init__(self, settings):
        self.settings = settings
        self.reindex_calls = 0
        self.search_calls: list[tuple[str, int | None, bool]] = []
        self.read_calls: list[str] = []
        self.write_calls: list[tuple[str, str]] = []
        self.delete_calls: list[tuple[str, str]] = []
        self.rename_calls: list[tuple[str, str, str]] = []
        self.search_results = [DummySearchResult("wiki/page.md", "0", 0.91, "result context")]
        DummyKnowledgeIndex.last_instance = self

    def reindex(self):
        self.reindex_calls += 1
        return {"changed": 1, "removed": 0, "total_files": 1}

    def search(self, query, top_k=None, include_inactive=False):
        self.search_calls.append((query, top_k, include_inactive))
        return self.search_results

    def read_doc(self, path):
        self.read_calls.append(path)
        return {"path": path, "content": "document body", "content_hash": "hash"}

    def list_docs(self):
        return ["wiki/page.md"]

    def schema_report(self):
        return {"schema_version": 4, "total_files": 1, "summary": {"files_with_issues": 0}, "files": []}

    def write_doc(self, path, content, expected_hash=None):
        self.write_calls.append((path, content, expected_hash))
        return {"status": "ok", "path": path, "content_hash": "new-hash"}

    def delete_doc(self, path, expected_hash):
        self.delete_calls.append((path, expected_hash))
        return {"status": "ok", "path": path, "deleted_hash": expected_hash}

    def rename_doc(self, source_path, destination_path, expected_hash):
        self.rename_calls.append((source_path, destination_path, expected_hash))
        return {
            "status": "ok",
            "source_path": source_path,
            "destination_path": destination_path,
            "content_hash": expected_hash,
        }


class DummyJSONResponse:
    def __init__(self, content=None, status_code=200):
        self.content = content
        self.status_code = status_code


class DummyFastAPI:
    def __init__(self, title, lifespan=None, redirect_slashes=True):
        self.title = title
        self.lifespan = lifespan
        self.redirect_slashes = redirect_slashes
        self.routes: dict[tuple[str, str], object] = {}
        self.mounts: list[tuple[str, object]] = []

    def get(self, path):
        def decorator(func):
            self.routes[("GET", path)] = func
            return func

        return decorator

    def post(self, path):
        def decorator(func):
            self.routes[("POST", path)] = func
            return func

        return decorator

    def mount(self, path, app):
        self.mounts.append((path, app))


class DummySessionManager:
    def run(self):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class DummyMCP:
    last_instance: "DummyMCP | None" = None

    def __init__(self, name, instructions=None):
        self.name = name
        self.instructions = instructions
        self.settings = types.SimpleNamespace(streamable_http_path=None)
        self.session_manager = DummySessionManager()
        self.tools: list[tuple[str, object]] = []
        DummyMCP.last_instance = self

    def streamable_http_app(self):
        return "dummy-mcp-app"

    def tool(self):
        def decorator(func):
            self.tools.append((func.__name__, func))
            return func

        return decorator


def install_fakes():
    fastapi_module = types.ModuleType("fastapi")
    fastapi_module.FastAPI = DummyFastAPI

    responses_module = types.ModuleType("fastapi.responses")
    responses_module.JSONResponse = DummyJSONResponse

    mcp_server_module = types.ModuleType("mcp.server")
    fastmcp_module = types.ModuleType("mcp.server.fastmcp")
    fastmcp_module.FastMCP = DummyMCP

    indexer_module = types.ModuleType("kb_service.indexer")
    indexer_module.KnowledgeIndex = DummyKnowledgeIndex
    indexer_module.INDEX_SCHEMA_VERSION = 6

    sys.modules["fastapi"] = fastapi_module
    sys.modules["fastapi.responses"] = responses_module
    sys.modules["mcp"] = types.ModuleType("mcp")
    sys.modules["mcp.server"] = mcp_server_module
    sys.modules["mcp.server.fastmcp"] = fastmcp_module
    sys.modules["kb_service.indexer"] = indexer_module


class AppBehaviorTests(unittest.TestCase):
    def setUp(self) -> None:
        install_fakes()
        sys.modules.pop("kb_service.app", None)
        self.app_module = importlib.import_module("kb_service.app")
        self.app_module = importlib.reload(self.app_module)
        self.original_settings_load = self.app_module.Settings.load

    def tearDown(self) -> None:
        self.app_module.Settings.load = self.original_settings_load

    def test_create_app_exposes_expected_tools(self) -> None:
        app = self.app_module.create_app()
        tool_names = [name for name, _ in DummyMCP.last_instance.tools]

        self.assertEqual(
            tool_names,
            [
                "wiki_search",
                "wiki_read",
                "wiki_list",
                "wiki_schema_report",
                "wiki_write",
                "wiki_delete",
                "wiki_rename",
            ],
        )
        self.assertEqual(app.mounts, [("/mcp/", "dummy-mcp-app"), ("/mcp", "dummy-mcp-app")])
        self.assertLessEqual(len(DummyMCP.last_instance.instructions), 512)
        for phrase in [
            "search is advisory",
            "Prefer packet results",
            "Use wiki_read",
            "honest knowledge gap",
            "content_hash as expected_hash",
        ]:
            self.assertIn(phrase, DummyMCP.last_instance.instructions)

    def test_health_reports_ready_when_startup_and_mcp_are_running(self) -> None:
        settings = types.SimpleNamespace(
            wiki_root=Path("wiki"),
            repository_root=Path("."),
            kb_root=Path("kb"),
            host="0.0.0.0",
            port=7331,
            mcp_path="/mcp/",
            health_path="/health",
            embedding_model="all-MiniLM-L6-v2",
            chunk_size=500,
            chunk_overlap=150,
            top_k=8,
            merge_adjacent_window=1,
            staleness_days=90,
            watch_interval_seconds=15,
            startup_reindex_timeout_seconds=3,
        )
        self.app_module.Settings.load = staticmethod(lambda: settings)

        app = self.app_module.create_app()

        async def run_health():
            async with app.lifespan(app):
                health = await app.routes[("GET", "/health")]()
                self.assertEqual(health["status"], "ok")
                self.assertEqual(health["service"], "ready")
                self.assertEqual(health["mcp"], "running")

        asyncio.run(run_health())

    def test_health_reports_starting_during_long_initial_index(self) -> None:
        release_reindex = threading.Event()

        class SlowStartingIndex(DummyKnowledgeIndex):
            def reindex(self, *, cancel_event=None, progress_callback=None):
                if progress_callback is not None:
                    progress_callback(0, 1)
                while not release_reindex.is_set():
                    if cancel_event is not None and cancel_event.is_set():
                        return {"changed": 0, "removed": 0, "total_files": 0}
                    __import__("time").sleep(0.01)
                if progress_callback is not None:
                    progress_callback(1, 1)
                return {"changed": 1, "removed": 0, "total_files": 1}

        settings = types.SimpleNamespace(
            wiki_root=Path("wiki"),
            repository_root=Path("."),
            kb_root=Path("kb"),
            host="0.0.0.0",
            port=7331,
            mcp_path="/mcp/",
            health_path="/health",
            embedding_model="all-MiniLM-L6-v2",
            chunk_size=500,
            chunk_overlap=150,
            top_k=8,
            merge_adjacent_window=1,
            staleness_days=90,
            watch_interval_seconds=15,
            startup_reindex_timeout_seconds=1,
        )
        self.app_module.Settings.load = staticmethod(lambda: settings)
        original_index_class = self.app_module.KnowledgeIndex
        self.app_module.KnowledgeIndex = SlowStartingIndex
        app = self.app_module.create_app()
        self.app_module.KnowledgeIndex = original_index_class

        async def run_health():
            async with app.lifespan(app):
                health = await app.routes[("GET", "/health")]()
                self.assertEqual(health["status"], "starting")
                self.assertEqual(health["service"], "indexing")
                self.assertEqual(health["mcp"], "running")
                release_reindex.set()

        asyncio.run(run_health())

    def test_search_tool_returns_serializable_results(self) -> None:
        app = self.app_module.create_app()
        search = DummyMCP.last_instance.tools[0][1]
        result = search("query", 2)

        self.assertEqual(
            result["results"],
            [{
                    "source_file": "wiki/page.md",
                    "chunk_id": "0",
                    "relevance_score": 0.91,
                    "context": "result context",
                    "record_type": "chunk",
                }],
        )
        self.assertEqual(
            result["diagnostics"],
            {"miss": False, "result_count": 1, "minimum_relevance": 0.35},
        )

    def test_read_tool_returns_content_with_concurrency_hash(self) -> None:
        app = self.app_module.create_app()
        read = DummyMCP.last_instance.tools[1][1]

        result = read("owner.md")

        self.assertEqual(
            result,
            {"path": "owner.md", "content": "document body", "content_hash": "hash"},
        )

    def test_search_miss_is_empty_diagnostic_not_error(self) -> None:
        app = self.app_module.create_app()
        DummyKnowledgeIndex.last_instance.search_results = []
        search = DummyMCP.last_instance.tools[0][1]

        result = search("security authentication authorization secrets")

        self.assertEqual(result["results"], [])
        self.assertTrue(result["diagnostics"]["miss"])
        self.assertIn("knowledge gap", result["diagnostics"]["message"])
        self.assertNotIn("error", result["diagnostics"])

    def test_version_endpoint_exposes_compatibility_contract(self) -> None:
        app = self.app_module.create_app()

        async def read_version():
            return await app.routes[("GET", "/version")]()

        result = asyncio.run(read_version())
        self.assertEqual(result["service"], "kb-service")
        self.assertEqual(result["index_schema_version"], 6)
        self.assertEqual(result["mcp_tool_contract_version"], 4)
        self.assertIsInstance(result["service_version"], str)

    def test_packet_search_fixtures_are_canonical_compact_and_bounded(self) -> None:
        app = self.app_module.create_app()
        search = DummyMCP.last_instance.tools[0][1]

        for source in ["index.md", "components/slice-serialization.md"]:
            with self.subTest(source=source):
                packet_fields = {
                    "kind": "reference",
                    "source": source,
                    "rule": "Use the focused repository contract.",
                    "summary": "S" * 1200,
                    "schema_health": "complete",
                    "freshness_state": "current",
                    "evidence_state": "present",
                    "verification_required": False,
                    "needs_verification": False,
                    "key_facts": [f"Fact {index}: " + "x" * 500 for index in range(20)],
                    "evidence": [f"Evidence {index}: " + "y" * 500 for index in range(20)],
                    "raw_prose": "must never be returned",
                }
                DummyKnowledgeIndex.last_instance.search_results = [
                    types.SimpleNamespace(
                        source_file=source,
                        chunk_id="packet",
                        score=0.93,
                        context="duplicated embedding text",
                        record_type="packet",
                        context_packet=packet_fields,
                        metadata={"summary": "duplicate", "raw_prose": "duplicate full note"},
                    )
                ]

                result = search(source)
                serialized = __import__("json").dumps(result, separators=(",", ":")).encode("utf-8")
                packet_result = result["results"][0]

                self.assertLess(len(serialized), 4096)
                self.assertEqual(set(packet_result), {"record_type", "relevance_score", "packet"})
                self.assertNotIn("raw_prose", packet_result["packet"])
                self.assertNotIn("semantic_metadata", packet_result)
                self.assertNotIn("context", packet_result)
                self.assertEqual(packet_result["packet"]["source"], source)
                self.assertEqual(packet_result["packet"]["schema_health"], "complete")
                self.assertEqual(packet_result["packet"]["freshness_state"], "current")
                self.assertEqual(packet_result["packet"]["evidence_state"], "present")
                self.assertNotIn("confidence", packet_result["packet"])

    def test_compact_packet_keeps_capability_decision_fields(self) -> None:
        packet = self.app_module.compact_context_packet(
            {
                "kind": "reference",
                "source": "components/component-rendering-core.md",
                "rule": "Render typed component output.",
                "capability_contract": ["Typed inputs produce typed render models."],
                "architecture_boundaries": ["Foundation owns rendering mechanics."],
                "acceptance_verification": ["Run ComponentRenderingContractTests."],
                "has_open_questions": True,
            }
        )

        self.assertIn("capability_contract", packet)
        self.assertIn("architecture_boundaries", packet)
        self.assertIn("acceptance_verification", packet)
        self.assertTrue(packet["has_open_questions"])

    def test_schema_report_tool_returns_serializable_report(self) -> None:
        app = self.app_module.create_app()
        schema_report = DummyMCP.last_instance.tools[3][1]
        result = schema_report()

        self.assertEqual(
            result,
            {"schema_version": 4, "total_files": 1, "summary": {"files_with_issues": 0}, "files": []},
        )

    def test_write_tool_passes_expected_hash_and_reindexes_only_on_success(self) -> None:
        app = self.app_module.create_app()
        write = DummyMCP.last_instance.tools[4][1]

        async def run_write_checks():
            async with app.lifespan(app):
                result = await write("owner.md", "updated", "current-hash")
                self.assertEqual(result["status"], "ok")
                self.assertEqual(result["index_status"], "ok")
                self.assertEqual(
                    DummyKnowledgeIndex.last_instance.write_calls,
                    [("owner.md", "updated", "current-hash")],
                )
                self.assertEqual(DummyKnowledgeIndex.last_instance.reindex_calls, 2)

                DummyKnowledgeIndex.last_instance.write_doc = lambda *args: {
                    "status": "conflict",
                    "reason": "hash_mismatch",
                    "current_hash": "newer-hash",
                }
                conflict = await write("owner.md", "stale", "old-hash")
                self.assertEqual(conflict["status"], "conflict")
                self.assertEqual(DummyKnowledgeIndex.last_instance.reindex_calls, 2)

        asyncio.run(run_write_checks())

    def test_delete_and_rename_reindex_immediately_only_on_success(self) -> None:
        app = self.app_module.create_app()
        delete = DummyMCP.last_instance.tools[5][1]
        rename = DummyMCP.last_instance.tools[6][1]

        async def run_mutation_checks():
            async with app.lifespan(app):
                deleted = await delete("obsolete.md", "delete-hash")
                self.assertEqual(deleted["index_status"], "ok")
                self.assertEqual(
                    DummyKnowledgeIndex.last_instance.delete_calls,
                    [("obsolete.md", "delete-hash")],
                )
                self.assertEqual(DummyKnowledgeIndex.last_instance.reindex_calls, 2)

                renamed = await rename("old.md", "new.md", "rename-hash")
                self.assertEqual(renamed["index_status"], "ok")
                self.assertEqual(
                    DummyKnowledgeIndex.last_instance.rename_calls,
                    [("old.md", "new.md", "rename-hash")],
                )
                self.assertEqual(DummyKnowledgeIndex.last_instance.reindex_calls, 3)

                DummyKnowledgeIndex.last_instance.delete_doc = lambda *args: {
                    "status": "conflict",
                    "reason": "hash_mismatch",
                    "current_hash": "newer-hash",
                }
                conflict = await delete("obsolete.md", "stale-hash")
                self.assertEqual(conflict["status"], "conflict")
                self.assertEqual(DummyKnowledgeIndex.last_instance.reindex_calls, 3)

        asyncio.run(run_mutation_checks())


class IndexMutationCoordinatorTests(unittest.TestCase):
    def setUp(self) -> None:
        install_fakes()
        sys.modules.pop("kb_service.app", None)
        self.app_module = importlib.import_module("kb_service.app")
        self.app_module = importlib.reload(self.app_module)

    def test_overlapping_requests_are_serialized_and_coalesced(self) -> None:
        class BlockingIndex:
            def __init__(self):
                self.calls = 0
                self.active = 0
                self.max_active = 0
                self.lock = Lock()

            def reindex(self):
                with self.lock:
                    self.calls += 1
                    self.active += 1
                    self.max_active = max(self.max_active, self.active)
                __import__("time").sleep(0.04)
                with self.lock:
                    self.active -= 1
                return {"changed": 0, "call": self.calls}

        async def run_test():
            index = BlockingIndex()
            coordinator = self.app_module.IndexMutationCoordinator(index)
            coordinator.start()
            results = await asyncio.gather(
                *(coordinator.request_reindex(f"request-{number}") for number in range(8))
            )
            await coordinator.stop()
            self.assertTrue(all(result["status"] == "ok" for result in results))
            self.assertEqual(index.max_active, 1)
            self.assertLessEqual(index.calls, 2)

        asyncio.run(run_test())

    def test_targeted_work_runs_off_event_loop_and_reports_progress(self) -> None:
        class SlowTargetedIndex:
            def __init__(self):
                self.paths = []

            def reindex_paths(self, paths, *, cancel_event=None, progress_callback=None):
                self.paths.append(set(paths))
                progress_callback(0, 1)
                __import__("time").sleep(0.05)
                self.assert_not_cancelled = not cancel_event.is_set()
                progress_callback(1, 1)
                return {"changed": 1, "mode": "targeted"}

        async def run_test():
            index = SlowTargetedIndex()
            coordinator = self.app_module.IndexMutationCoordinator(index)
            coordinator.start()
            request = asyncio.create_task(
                coordinator.request_reindex("write", paths={"b.md", "a.md"})
            )
            await asyncio.sleep(0.01)
            self.assertFalse(request.done())
            self.assertEqual(coordinator.snapshot()["indexing_state"], "indexing")
            result = await request
            snapshot = coordinator.snapshot()
            await coordinator.stop()

            self.assertEqual(result["status"], "ok")
            self.assertEqual(index.paths, [{"a.md", "b.md"}])
            self.assertTrue(index.assert_not_cancelled)
            self.assertEqual((snapshot["progress_processed"], snapshot["progress_total"]), (1, 1))

        asyncio.run(run_test())

    def test_failure_is_observable_and_later_success_recovers(self) -> None:
        class RecoveringIndex:
            def __init__(self):
                self.calls = 0

            def reindex(self):
                self.calls += 1
                if self.calls == 1:
                    raise RuntimeError("transient index failure")
                return {"changed": 1}

        async def run_test():
            coordinator = self.app_module.IndexMutationCoordinator(RecoveringIndex())
            coordinator.start()
            with self.assertLogs("kb_service.app", level="ERROR"):
                failed = await coordinator.request_reindex("startup")
            failed_state = coordinator.snapshot()
            recovered = await coordinator.request_reindex("watcher")
            recovered_state = coordinator.snapshot()
            await coordinator.stop()

            self.assertEqual(failed["status"], "error")
            self.assertEqual(failed_state["last_error"], "transient index failure")
            self.assertEqual(failed_state["consecutive_failures"], 1)
            self.assertEqual(recovered["status"], "ok")
            self.assertEqual(recovered_state["indexing_state"], "idle")
            self.assertEqual(recovered_state["last_error"], "")
            self.assertTrue(recovered_state["last_success_utc"])
            self.assertTrue(recovered_state["indexed_revision"])

        asyncio.run(run_test())

    def test_health_degrades_after_repeated_failures_even_with_prior_success(self) -> None:
        healthy_state = {"last_success_utc": "2026-07-18T00:00:00+00:00", "consecutive_failures": 1}
        failing_state = {**healthy_state, "consecutive_failures": 2}
        starting_state = {
            "last_success_utc": "",
            "consecutive_failures": 0,
            "indexing_state": "indexing",
            "last_error": "",
        }

        self.assertTrue(self.app_module.service_is_healthy(healthy_state, True))
        self.assertTrue(self.app_module.service_is_starting(starting_state, True))
        self.assertEqual(self.app_module.health_status(starting_state, True), ("starting", 200))
        self.assertFalse(self.app_module.service_is_healthy(failing_state, True))
        self.assertFalse(self.app_module.service_is_healthy(healthy_state, False))


if __name__ == "__main__":
    unittest.main()
