import asyncio
import threading
import time
import unittest

from kb_service.deferred_index import DeferredKnowledgeIndex, IndexUnavailableError


class Backend:
    def __init__(self) -> None:
        self.calls = 0

    def search(self, query):
        self.calls += 1
        return [query]


class DeferredKnowledgeIndexTests(unittest.TestCase):
    def test_factory_does_not_run_until_started_or_used(self) -> None:
        built = []
        deferred = DeferredKnowledgeIndex(lambda: built.append(1) or Backend())
        self.assertEqual(built, [])
        self.assertFalse(deferred.is_ready)
        self.assertEqual(deferred.search("a"), ["a"])
        self.assertEqual(built, [1])
        self.assertTrue(deferred.is_ready)

    def test_start_returns_immediately_while_build_is_slow(self) -> None:
        release = threading.Event()

        def slow_factory():
            release.wait(5)
            return Backend()

        deferred = DeferredKnowledgeIndex(slow_factory)
        started = time.monotonic()
        deferred.start()
        deferred.start()  # idempotent
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertFalse(deferred.is_ready)
        release.set()
        self.assertEqual(deferred.search("x"), ["x"])

    def test_factory_runs_once_for_concurrent_callers(self) -> None:
        builds = []

        def factory():
            builds.append(1)
            time.sleep(0.05)
            return Backend()

        deferred = DeferredKnowledgeIndex(factory)
        results = []
        threads = [threading.Thread(target=lambda: results.append(deferred.search("q"))) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(builds), 1)
        self.assertEqual(len(results), 8)

    def test_failed_build_raises_for_every_caller_with_cause(self) -> None:
        def broken():
            raise RuntimeError("model download failed")

        deferred = DeferredKnowledgeIndex(broken)
        deferred.start()
        for _ in range(2):
            with self.assertRaises(IndexUnavailableError) as raised:
                deferred.search("q")
            self.assertIn("model download failed", str(raised.exception))
        self.assertFalse(deferred.is_ready)

    def test_wait_times_out_with_retryable_error(self) -> None:
        release = threading.Event()
        deferred = DeferredKnowledgeIndex(lambda: release.wait(5) and Backend(), wait_seconds=0.05)
        with self.assertRaises(IndexUnavailableError) as raised:
            deferred.search("q")
        self.assertIn("still starting", str(raised.exception))
        release.set()

    def test_private_and_dunder_lookups_do_not_trigger_a_build(self) -> None:
        built = []
        deferred = DeferredKnowledgeIndex(lambda: built.append(1) or Backend())
        with self.assertRaises(AttributeError):
            deferred.__wrapped__  # noqa: B018
        with self.assertRaises(AttributeError):
            deferred._private  # noqa: B018
        self.assertEqual(built, [])

    def test_wait_ready_does_not_block_the_event_loop(self) -> None:
        release = threading.Event()
        deferred = DeferredKnowledgeIndex(lambda: release.wait(5) and Backend())

        async def scenario():
            ticks = 0
            waiter = asyncio.create_task(deferred.wait_ready())
            for _ in range(5):
                await asyncio.sleep(0.01)
                ticks += 1
            self.assertFalse(waiter.done())
            release.set()
            await asyncio.wait_for(waiter, timeout=2)
            return ticks

        self.assertEqual(asyncio.run(scenario()), 5)

    def test_wait_ready_raises_when_build_failed(self) -> None:
        def broken():
            raise ValueError("bad store")

        deferred = DeferredKnowledgeIndex(broken)
        with self.assertRaises(IndexUnavailableError):
            asyncio.run(deferred.wait_ready())


if __name__ == "__main__":
    unittest.main()
