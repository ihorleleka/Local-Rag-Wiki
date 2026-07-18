from __future__ import annotations

import fnmatch
import hashlib
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any


BACKTICK_PATTERN = re.compile(r"`([^`]+)`")
EXPLICIT_PATTERN = re.compile(r"^(path|dir|glob|symbol|test|generated):\s*(.+)$", re.IGNORECASE)
COMMAND_PREFIXES = ("dotnet ", "npm ", "node ", "python ", "docker ", "aspire ", "git ")
KNOWN_FILE_SUFFIXES = {
    ".cs", ".csproj", ".config", ".css", ".html", ".js", ".json", ".jsonc",
    ".md", ".mjs", ".props", ".ps1", ".py", ".razor", ".sh", ".sln", ".slnx",
    ".targets", ".toml", ".ts", ".tsx", ".vue", ".xml", ".yaml", ".yml",
}


@dataclass(frozen=True)
class EvidenceAnchor:
    raw: str
    kind: str
    target: str
    locator: str
    exists: bool
    identity: str
    working_tree_state: str

    def snapshot(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "target": self.target,
            "locator": self.locator,
            "exists": self.exists,
            "identity": self.identity,
            "working_tree_state": self.working_tree_state,
        }


@dataclass(frozen=True)
class EvidenceReport:
    declared_count: int
    anchors: tuple[EvidenceAnchor, ...]
    changed_targets: tuple[str, ...] = ()
    max_anchors: int = 12

    @property
    def missing_targets(self) -> tuple[str, ...]:
        return tuple(anchor.target for anchor in self.anchors if not anchor.exists)

    @property
    def verifiable_count(self) -> int:
        return len(self.anchors)

    @property
    def excessive_inventory(self) -> bool:
        return self.verifiable_count > self.max_anchors

    @property
    def state(self) -> str:
        if self.missing_targets:
            return "missing"
        if self.changed_targets:
            return "changed_since_verification"
        return "present" if self.declared_count else "missing"

    @property
    def snapshot(self) -> dict[str, dict[str, Any]]:
        return {
            f"{anchor.kind}:{anchor.target}#{anchor.locator}": anchor.snapshot()
            for anchor in self.anchors
        }

    def summary(self) -> dict[str, Any]:
        return {
            "declared_count": self.declared_count,
            "verifiable_count": self.verifiable_count,
            "missing_count": len(self.missing_targets),
            "changed_count": len(self.changed_targets),
            "excessive_inventory": self.excessive_inventory,
        }


def declared_evidence_report(items: list[str], max_anchors: int = 12) -> EvidenceReport:
    """Fallback for packet-only compilation where repository inspection was not requested."""
    return EvidenceReport(declared_count=len(items), anchors=(), max_anchors=max_anchors)


class EvidenceInspector:
    def __init__(
        self,
        repository_root: Path,
        max_anchors: int = 12,
        wiki_root: Path | None = None,
    ) -> None:
        self.repository_root = repository_root.resolve()
        self.wiki_root = wiki_root.resolve() if wiki_root else None
        self.max_anchors = max_anchors
        self._tracked = self._tracked_blobs()
        self._dirty = self._dirty_paths()

    def _git(self, *args: str) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                ["git", "-C", str(self.repository_root), *args],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
        except FileNotFoundError:
            return subprocess.CompletedProcess(["git", *args], 127, "", "git is unavailable")

    def _tracked_blobs(self) -> dict[str, str]:
        result = self._git("ls-files", "-s")
        if result.returncode != 0:
            return {}
        tracked: dict[str, str] = {}
        for line in result.stdout.splitlines():
            match = re.match(r"\d+\s+([0-9a-f]+)\s+\d+\t(.+)$", line)
            if match:
                tracked[match.group(2).replace("\\", "/")] = match.group(1)
        return tracked

    def _dirty_paths(self) -> set[str]:
        result = self._git("status", "--porcelain=v1", "--untracked-files=all")
        if result.returncode != 0:
            return set()
        dirty: set[str] = set()
        for line in result.stdout.splitlines():
            if len(line) >= 4:
                value = line[3:].split(" -> ")[-1].strip('"').replace("\\", "/")
                dirty.add(value)
        return dirty

    @staticmethod
    def _safe_target(value: str) -> tuple[str, str]:
        cleaned = value.strip().strip("`'\"").rstrip(".,;:")
        locator = ""
        if "#" in cleaned:
            cleaned, locator = cleaned.split("#", 1)
        elif "::" in cleaned:
            cleaned, locator = cleaned.split("::", 1)
        portable = cleaned.replace("\\", "/")
        if portable.startswith("./"):
            portable = portable[2:]
        path = PurePosixPath(portable)
        if not portable or path.is_absolute() or any(part in {".", ".."} for part in path.parts):
            return "", locator
        return portable, locator

    def _candidate_specs(self, item: str) -> list[tuple[str, str, str]]:
        raw = item.strip()
        explicit = EXPLICIT_PATTERN.match(raw)
        if explicit:
            kind = explicit.group(1).lower()
            target, locator = self._safe_target(explicit.group(2))
            return [(kind, target, locator)] if target else []
        if raw.lower().startswith(("http://", "https://", *COMMAND_PREFIXES)):
            return []

        tokens = BACKTICK_PATTERN.findall(raw)
        if not tokens:
            tokens = [raw]
        specs: list[tuple[str, str, str]] = []
        for token in tokens:
            target, locator = self._safe_target(token)
            if not target:
                continue
            direct = self.repository_root / Path(*PurePosixPath(target).parts)
            wiki_candidate = (
                self.wiki_root / Path(*PurePosixPath(target).parts)
                if self.wiki_root
                else None
            )
            if not direct.exists() and wiki_candidate and wiki_candidate.exists():
                target = wiki_candidate.relative_to(self.repository_root).as_posix()
                direct = wiki_candidate
            suffix = PurePosixPath(target).suffix.lower()
            if "/" not in target and not direct.exists() and suffix not in KNOWN_FILE_SUFFIXES:
                continue
            kind = "glob" if any(char in target for char in "*?[") else "path"
            specs.append((kind, target, locator))
        return specs

    def _identity_for_files(self, files: list[str]) -> str:
        identities: list[str] = []
        for rel in sorted(files):
            identity = self._tracked.get(rel)
            full = self.repository_root / Path(*PurePosixPath(rel).parts)
            if full.is_file() and (identity is None or rel in self._dirty):
                identity = hashlib.sha256(full.read_bytes()).hexdigest()
            identities.append(f"{rel}:{identity or 'missing'}")
        return hashlib.sha256("\n".join(identities).encode("utf-8")).hexdigest() if identities else ""

    def _matching_files(self, kind: str, target: str) -> tuple[list[str], bool]:
        full = self.repository_root / Path(*PurePosixPath(target).parts)
        if kind == "glob":
            matches = sorted(
                rel
                for rel in set(self._tracked) | self._dirty
                if fnmatch.fnmatch(rel, target)
                and (self.repository_root / Path(*PurePosixPath(rel).parts)).is_file()
            )
            return matches, bool(matches)
        if full.is_dir() or kind == "dir":
            prefix = target.rstrip("/") + "/"
            matches = sorted(
                rel
                for rel in set(self._tracked) | self._dirty
                if rel.startswith(prefix)
                and (self.repository_root / Path(*PurePosixPath(rel).parts)).is_file()
            )
            return matches, full.is_dir()
        return [target], full.is_file()

    def _working_tree_state(self, target: str, files: list[str]) -> str:
        prefix = target.rstrip("/") + "/"
        if any(path == target or path.startswith(prefix) or path in files for path in self._dirty):
            return "modified_or_untracked"
        return "clean"

    def inspect(
        self,
        items: list[str],
        previous_snapshot: dict[str, dict[str, Any]] | None = None,
        verification_updated: bool = False,
    ) -> EvidenceReport:
        anchors: list[EvidenceAnchor] = []
        seen: set[tuple[str, str, str]] = set()
        for item in items:
            for kind, target, locator in self._candidate_specs(item):
                key = (kind, target, locator)
                if key in seen:
                    continue
                seen.add(key)
                files, exists = self._matching_files(kind, target)
                full = self.repository_root / Path(*PurePosixPath(target).parts)
                if locator and full.is_file():
                    try:
                        exists = exists and locator in full.read_text(encoding="utf-8", errors="ignore")
                    except OSError:
                        exists = False
                anchors.append(
                    EvidenceAnchor(
                        raw=item,
                        kind=kind,
                        target=target,
                        locator=locator,
                        exists=exists,
                        identity=self._identity_for_files(files),
                        working_tree_state=self._working_tree_state(target, files),
                    )
                )

        preliminary = EvidenceReport(
            declared_count=len(items),
            anchors=tuple(anchors),
            max_anchors=self.max_anchors,
        )
        changed: list[str] = []
        if previous_snapshot and not verification_updated:
            for key, value in preliminary.snapshot.items():
                if previous_snapshot.get(key) != value:
                    changed.append(str(value["target"]))
            for key, value in previous_snapshot.items():
                if key not in preliminary.snapshot:
                    changed.append(str(value.get("target", key)))
        elif not previous_snapshot and not verification_updated:
            changed.extend(
                anchor.target
                for anchor in anchors
                if anchor.working_tree_state != "clean"
            )
        return EvidenceReport(
            declared_count=len(items),
            anchors=tuple(anchors),
            changed_targets=tuple(sorted(set(changed))),
            max_anchors=self.max_anchors,
        )
