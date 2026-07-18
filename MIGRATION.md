# Service Migration And Rollback

## 0.0.9 To 0.0.10

Project-Rag-Wiki `0.0.10` advances the index schema from `4` to `6` and the MCP
tool contract from `1` to `4`. It adds trust-aware packets, hash-protected
write/delete/rename operations, incremental indexing, bounded queries, and
observable progress.

Markdown under the mounted `wiki/` directory is authoritative user data. The
KB volume contains only rebuildable Chroma/index state. Back up or commit the
Markdown before migration; do not treat the KB volume as a wiki backup.

1. Stop clients and the repository container.
2. Record the current image and exact KB volume with `harness status .` and
   `docker inspect <container>`.
3. Keep the old KB volume until the new pair has been verified.
4. Update to a harness version whose compatibility matrix includes service
   `0.0.10`, schema `6`, and tool contract `4`.
5. Pull its pinned image, then restart. A schema change causes notes to be
   reparsed and re-embedded; the Hugging Face cache can be reused safely.
6. Run `harness doctor . --live`, then confirm a representative positive search
   and an expected knowledge-gap search.

If an existing Chroma volume cannot be upgraded, stop the container and select
a new empty `KB_VOLUME`. The service reconstructs it from Markdown. Do not
delete the old volume until the replacement passes live doctor and retrieval.

## Rollback

Roll back the harness and image as a compatible pair. Service `0.0.9` expects
schema `4` and tool contract `1`; `0.0.10` expects schema `6` and contract `4`.
Do not reuse a schema-6 KB volume with the older image. Point `KB_VOLUME` at the
preserved pre-upgrade volume, or use a new empty volume and let `0.0.9` rebuild
from the unchanged Markdown.

After rollback, run status and live doctor. A `KB_IMAGE` override is useful for
a temporary rollback, but keep the digest explicit and remove the override when
returning to the harness-pinned pair.

## First Start

First start may download the embedding model and rebuild every note. The local
rehearsal measured about 39 seconds with a fresh model cache and 18 seconds for
a cold client initialization with cached dependencies. Repository size,
network, disk, and CPU will change these numbers; generated clients allow 75
seconds for startup. Progress is exposed by `/health`.
