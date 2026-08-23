FROM python:3.14-slim AS deps

WORKDIR /app

COPY pyproject.toml /app/pyproject.toml

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip \
    && python -c "import tomllib, pathlib; p=pathlib.Path('/app/pyproject.toml'); data=tomllib.loads(p.read_text()); project=data.get('project', {}); dynamic=set(project.get('dynamic', [])); assert 'dependencies' not in dynamic, 'dynamic dependencies are not supported by this Docker build'; deps=list(project.get('dependencies', [])); optional=project.get('optional-dependencies', {}); [deps.extend(group) for group in optional.values()]; unique=list(dict.fromkeys(deps)); pathlib.Path('/tmp/requirements.txt').write_text('\n'.join(unique))" \
    && pip install --prefer-binary -r /tmp/requirements.txt

FROM python:3.14-slim

WORKDIR /app
ENV PATH="/opt/venv/bin:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG VERSION=0.0.0
# Source of truth is src/kb_service/contract.py; CI extracts these and passes
# them as build args, then verifies the labels match the values inside the image.
# The defaults here are a local-build fallback only.
ARG INDEX_SCHEMA_VERSION=7
ARG MCP_TOOL_CONTRACT_VERSION=5
LABEL org.opencontainers.image.title="kb-service" \
      org.opencontainers.image.description="Repository-scoped MCP knowledge service for Markdown wiki content." \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="MIT" \
      io.github.ihorleleka.project-rag-wiki.index-schema-version="${INDEX_SCHEMA_VERSION}" \
      io.github.ihorleleka.project-rag-wiki.mcp-tool-contract-version="${MCP_TOOL_CONTRACT_VERSION}"

COPY --from=deps /opt/venv /opt/venv
COPY . /app/.knowledge-service

RUN --mount=type=cache,target=/root/.cache/pip \
    SETUPTOOLS_SCM_PRETEND_VERSION=${VERSION} pip install --no-deps /app/.knowledge-service

ENV KB_WIKI_ROOT=/workspace/wiki
ENV KB_REPOSITORY_ROOT=/repository
ENV KB_ROOT=/workspace/.kb
ENV KB_PORT=1111
ENV PYTHONPATH=/app/src

EXPOSE 1111

CMD ["python", "-m", "kb_service"]
