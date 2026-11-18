import sys

from kb_service.runtime_safety import disable_crash_dumps


def main() -> None:
    # Establish protection before Chroma/ONNX/tokenizers or other native imports.
    disable_crash_dumps()

    from kb_service.settings import Settings
    from kb_service.vector_store_safety import probe_vector_store

    settings = Settings.load()
    if "--probe-vector-store" in sys.argv:
        probe_vector_store(settings)
        return

    from kb_service.app import create_app
    import uvicorn

    # The vector-store probe and index build run after the port is bound (see
    # create_app), so MCP clients can connect and list tools immediately.
    uvicorn.run(create_app(defer_index_build=True), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
