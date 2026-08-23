import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    wiki_root: Path
    repository_root: Path
    kb_root: Path
    host: str
    port: int
    mcp_path: str
    health_path: str
    embedding_model: str
    chunk_tokens: int
    top_k: int
    max_top_k: int
    embedding_batch_size: int
    min_relevance: float
    merge_adjacent_window: int
    staleness_days: int
    note_max_lines: int
    evidence_max_anchors: int
    watch_interval_seconds: int
    startup_reindex_timeout_seconds: int
    capture_dir: str
    hybrid_search: bool
    lexical_candidates: int
    rrf_k: int
    dense_weight: float
    lexical_weight: float
    lexical_min_score: float
    evidence_changed_penalty: float
    reranker_enabled: bool
    reranker_model_path: str
    reranker_top_n: int

    @staticmethod
    def load() -> "Settings":
        wiki_root = Path(os.getenv("KB_WIKI_ROOT", "./wiki")).resolve()
        repository_root = Path(os.getenv("KB_REPOSITORY_ROOT", str(wiki_root.parent))).resolve()
        kb_root = Path(os.getenv("KB_ROOT", "./wiki/.kb")).resolve()
        mcp_path = os.getenv("KB_MCP_PATH", "/mcp/")
        if not mcp_path.startswith("/"):
            mcp_path = f"/{mcp_path}"
        if not mcp_path.endswith("/"):
            mcp_path = f"{mcp_path}/"

        return Settings(
            wiki_root=wiki_root,
            repository_root=repository_root,
            kb_root=kb_root,
            host=os.getenv("KB_HOST", "0.0.0.0"),
            port=int(os.getenv("KB_PORT", "7331")),
            mcp_path=mcp_path,
            health_path=os.getenv("KB_HEALTH_PATH", "/health"),
            embedding_model=os.getenv("KB_EMBEDDING_MODEL", "all-MiniLM-L6-v2"),
            chunk_tokens=max(32, int(os.getenv("KB_CHUNK_TOKENS", "220"))),
            top_k=int(os.getenv("KB_TOP_K", "8")),
            max_top_k=max(1, int(os.getenv("KB_MAX_TOP_K", "20"))),
            embedding_batch_size=max(1, int(os.getenv("KB_EMBEDDING_BATCH_SIZE", "64"))),
            min_relevance=max(0.0, min(1.0, float(os.getenv("KB_MIN_RELEVANCE", "0.35")))),
            merge_adjacent_window=max(0, int(os.getenv("KB_MERGE_ADJACENT_WINDOW", "1"))),
            staleness_days=max(1, int(os.getenv("KB_STALENESS_DAYS", "90"))),
            note_max_lines=max(1, int(os.getenv("KB_NOTE_MAX_LINES", "200"))),
            evidence_max_anchors=max(1, int(os.getenv("KB_EVIDENCE_MAX_ANCHORS", "12"))),
            watch_interval_seconds=int(os.getenv("KB_WATCH_INTERVAL_SECONDS", "15")),
            startup_reindex_timeout_seconds=max(1, int(os.getenv("KB_STARTUP_REINDEX_TIMEOUT_SECONDS", "3"))),
            capture_dir=(os.getenv("KB_CAPTURE_DIR", "investigations").strip("/") or "investigations"),
            hybrid_search=os.getenv("KB_HYBRID_SEARCH", "1").strip().lower() not in {"0", "false", "no", "off"},
            lexical_candidates=max(1, int(os.getenv("KB_LEXICAL_CANDIDATES", "50"))),
            rrf_k=max(1, int(os.getenv("KB_RRF_K", "60"))),
            dense_weight=max(0.0, float(os.getenv("KB_DENSE_WEIGHT", "1.0"))),
            lexical_weight=max(0.0, float(os.getenv("KB_LEXICAL_WEIGHT", "1.0"))),
            lexical_min_score=max(0.0, min(1.0, float(os.getenv("KB_LEXICAL_MIN_SCORE", "0.35")))),
            evidence_changed_penalty=max(0.0, min(1.0, float(os.getenv("KB_EVIDENCE_CHANGED_PENALTY", "0.05")))),
            reranker_enabled=os.getenv("KB_RERANKER", "0").strip().lower() in {"1", "true", "yes", "on"},
            reranker_model_path=os.getenv("KB_RERANKER_MODEL_PATH", "").strip(),
            reranker_top_n=max(1, int(os.getenv("KB_RERANKER_TOP_N", "20"))),
        )
