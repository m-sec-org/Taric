"""Thin Hermes general plugin bridge; Taric remains the authority service."""

PLUGIN_KIND = "general"
MEMORY_PROVIDER_REPLACEMENT = False

def describe_plugin():
    return {
        "kind": PLUGIN_KIND,
        "memory_provider_replacement": MEMORY_PROVIDER_REPLACEMENT,
        "hooks": ["pre_llm_call", "pre_tool_call", "post_tool_call", "on_session_end"],
        "authority": "taric-core",
    }

def translate_event(event_type, payload):
    if event_type not in {"pre_llm_call", "pre_tool_call", "post_tool_call", "on_session_end"}:
        raise ValueError(f"unsupported Hermes event: {event_type}")
    return {"event_type": event_type, "payload": payload, "target": "taric-adapter-contract-v1"}
