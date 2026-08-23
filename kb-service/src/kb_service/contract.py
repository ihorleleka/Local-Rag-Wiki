"""Single source of truth for the service's index and MCP tool contract versions.

Both the runtime ``/version`` endpoint and the built image's OCI labels derive
from these constants (the Docker build extracts them, and CI verifies the labels
match the values baked into the image). Bump them here only; the schema version
governs on-disk index compatibility and the tool contract version governs the
exposed MCP tool surface.
"""

INDEX_SCHEMA_VERSION = 7
MCP_TOOL_CONTRACT_VERSION = 5
