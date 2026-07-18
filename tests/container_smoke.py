"""Read-only HTTP/MCP smoke probe for a running release-candidate container."""

from __future__ import annotations

import http.client
import json
import sys


def decode_response(response: http.client.HTTPResponse) -> dict:
    body = response.read().decode("utf-8")
    if response.status >= 400:
        raise RuntimeError(f"HTTP {response.status}: {body}")
    if not body.strip():
        return {}
    if "text/event-stream" in (response.getheader("content-type") or ""):
        payloads = [line[5:].strip() for line in body.splitlines() if line.startswith("data:")]
        if not payloads:
            raise RuntimeError(f"SSE response contained no data: {body}")
        return json.loads(payloads[-1])
    return json.loads(body)


def post(port: int, message: dict, session_id: str | None = None) -> tuple[dict, str | None]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    headers = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
    }
    if session_id:
        headers["mcp-session-id"] = session_id
    connection.request("POST", "/mcp/", json.dumps(message), headers)
    response = connection.getresponse()
    next_session = response.getheader("mcp-session-id") or session_id
    decoded = decode_response(response)
    connection.close()
    return decoded, next_session


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18111
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    connection.request("GET", "/version")
    version = decode_response(connection.getresponse())
    connection.close()
    assert version["index_schema_version"] == 6, version
    assert version["mcp_tool_contract_version"] == 4, version

    initialized, session = post(
        port,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "release-smoke", "version": "1.0.0"},
            },
        },
    )
    assert initialized.get("result", {}).get("serverInfo"), initialized
    instructions = initialized["result"].get("instructions", "")
    assert "search is advisory" in instructions and len(instructions) <= 512, initialized
    post(port, {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}, session)

    tools, session = post(port, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, session)
    names = {tool["name"] for tool in tools["result"]["tools"]}
    expected = {
        "wiki_search",
        "wiki_read",
        "wiki_list",
        "wiki_schema_report",
        "wiki_write",
        "wiki_delete",
        "wiki_rename",
    }
    assert expected <= names, names

    searched, _ = post(
        port,
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "wiki_search",
                "arguments": {"query": "repository map owner major implementation areas", "top_k": 1},
            },
        },
        session,
    )
    assert not searched.get("error") and not searched.get("result", {}).get("isError"), searched
    print("container-smoke: health, version, initialize, instructions, seven tools, search ok")


if __name__ == "__main__":
    main()
