from kb_service.runtime_safety import disable_crash_dumps


def main() -> None:
    # Establish protection before Chroma/ONNX/tokenizers or other native imports.
    disable_crash_dumps()

    from kb_service.settings import Settings
    from kb_service.app import create_app
    import uvicorn

    settings = Settings.load()
    uvicorn.run(create_app(), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
