"""Hermes general plugin for the authenticated Taric Core JSON-RPC contract.

Configuration is provided through TARIC_CORE_SOCKET (Unix domain socket) or
TARIC_CORE_URL (loopback HTTP). This plugin intentionally does not interact
with Hermes' exclusive MemoryProvider selection.
"""
from __future__ import annotations

import json
import os
import socket
from typing import Any

PLUGIN_KIND = "general"
MEMORY_PROVIDER_REPLACEMENT = False
PLUGIN_VERSION = "0.19.0"
HOOKS = ("pre_llm_call", "pre_tool_call", "post_tool_call", "on_session_start", "on_session_end", "on_session_finalize", "on_session_reset")


class TaricIntegrationError(RuntimeError):
    code = "integration_error"


class CoreUnavailable(TaricIntegrationError):
    code = "unavailable_host"


class TaricRpcClient:
    """Small JSON-RPC transport. Host callbacks never silently swallow failures."""
    def __init__(self, socket_path: str | None = None, engagement_id: str | None = None, token: str | None = None):
        self.socket_path = socket_path or os.getenv("TARIC_CORE_SOCKET")
        self.engagement_id = engagement_id or os.getenv("TARIC_ENGAGEMENT_ID")
        self.token = token or os.getenv("TARIC_ADAPTER_TOKEN")
        if not self.socket_path:
            raise CoreUnavailable("configure TARIC_CORE_SOCKET")
        if not self.token or len(self.token) < 32:
            raise TaricIntegrationError("TARIC_ADAPTER_TOKEN must contain at least 32 characters")

    def call(self, operation: str, request: dict[str, Any]) -> dict[str, Any]:
        if not self.engagement_id:
            raise TaricIntegrationError("TARIC_ENGAGEMENT_ID is required")
        request = {**request, "engagement_id": self.engagement_id}
        payload = json.dumps({"jsonrpc": "2.0", "id": "taric-hermes-v1", "method": "taric.dispatch", "params": {"operation": operation, "token": self.token, "request": request}}).encode()
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
                channel.settimeout(3.0)
                channel.connect(self.socket_path)
                channel.sendall(payload + b"\n")
                chunks = []
                while True:
                    part = channel.recv(65536)
                    if not part or b"\n" in part:
                        chunks.append(part.split(b"\n", 1)[0]); break
                    chunks.append(part)
                response = json.loads(b"".join(chunks))
        except (OSError, TimeoutError, json.JSONDecodeError) as exc:
            raise CoreUnavailable(f"Taric Core RPC unavailable: {type(exc).__name__}") from exc
        if response.get("error"):
            error = response["error"]
            raise TaricIntegrationError(f"{error.get('code', 'internal_error')}: {error.get('message', 'Core RPC failed')}")
        result = response.get("result")
        if not isinstance(result, dict) or result.get("ok") is not True:
            error = result.get("error", {}) if isinstance(result, dict) else {}
            raise TaricIntegrationError(f"{error.get('code', 'internal_error')}: {error.get('message', 'Core rejected request')}")
        return result.get("data", {})


def describe_plugin():
    return {"kind": PLUGIN_KIND, "version": PLUGIN_VERSION, "memory_provider_replacement": MEMORY_PROVIDER_REPLACEMENT, "hooks": list(HOOKS), "authority": "taric-core", "fallback": ["MCP", "CLI"]}


def _event_key(kwargs: dict[str, Any], suffix: str) -> str:
    event = kwargs.get("event")
    session = kwargs.get("session_id") or kwargs.get("session_key") or getattr(event, "session_id", None) or getattr(event, "session_key", None) or "session"
    turn = kwargs.get("turn_id") or kwargs.get("turn", "")
    return f"hermes:{session}:{turn}:{suffix}"


def create_hooks(client: TaricRpcClient):
    def pre_llm_call(**kwargs):
        data = client.call("context.build", {"budget": kwargs.get("context_budget")})
        return {"context": json.dumps(data, separators=(",", ":"))}

    def pre_tool_call(**kwargs):
        # Observer-only integration: no tool execution or host authorization.
        return None

    def post_tool_call(**kwargs):
        result = kwargs.get("result")
        if kwargs.get("error"):
            client.call("error.report", {"error_ref": _event_key(kwargs, "tool-error"), "message": str(kwargs.get("error"))[:500]})
        return result

    def on_session_start(**kwargs):
        return client.call("engagement.status", {})

    def on_session_end(**kwargs):
        # A lifecycle notification only; no transcript or reasoning is persisted.
        return {"ended": True, "session": _event_key(kwargs, "end")}

    return {"pre_llm_call": pre_llm_call, "pre_tool_call": pre_tool_call, "post_tool_call": post_tool_call,
            "on_session_start": on_session_start, "on_session_end": on_session_end,
            "on_session_finalize": on_session_end, "on_session_reset": on_session_start}


def register(ctx):
    """Hermes' documented ``register(ctx)`` plugin entry point."""
    client = TaricRpcClient()
    hooks = create_hooks(client)
    for name, callback in hooks.items():
        ctx.register_hook(name, callback)
    return {"client": client, "hooks": list(hooks), "memory_provider_replacement": False}


def translate_event(event_type, payload):
    if event_type not in HOOKS:
        raise ValueError(f"unsupported Hermes event: {event_type}")
    return {"event_type": event_type, "payload": payload, "target": "taric-adapter-contract-v1"}
