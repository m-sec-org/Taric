import sys
import unittest
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from taric_hermes_plugin import (CoreUnavailable, TaricIntegrationError, TaricRpcClient,
    create_hooks, describe_plugin, translate_event)


class HermesPluginTests(unittest.TestCase):
    def test_general_plugin_does_not_replace_provider(self):
        descriptor = describe_plugin()
        self.assertEqual(descriptor["kind"], "general")
        self.assertFalse(descriptor["memory_provider_replacement"])

    def test_hook_translation_is_thin(self):
        event = translate_event("pre_llm_call", {"engagement_id": "e1"})
        self.assertEqual(event["target"], "taric-adapter-contract-v1")

    def test_python_side_consumes_the_shared_phase1_fixture(self):
        """Hermes 只读同一份 Phase 1 fixture，不维护第二套字段定义（tasks 2.5）。"""
        schema_root = Path(__file__).resolve().parents[2] / "schemas" / "fixtures" / "v1"
        fixtures = json.loads((schema_root / "phase1-fixtures.json").read_text())
        self.assertEqual(fixtures["schema_version"], "1.0.0")
        self.assertEqual(fixtures["change"], "complete-taric-runtime-gaps")
        # Python 侧只消费 opaque 引用和 ID 形状，不复制 schema。
        record = fixtures["valid"]["observation"]
        self.assertEqual(record["kind"], "observation")
        self.assertEqual(record["schema_version"], fixtures["schema_version"])
        self.assertRegex(record["engagement_id"], r"^[0-9a-f-]{36}$")

    def test_hooks_use_core_rpc_and_fail_without_claiming_saved_state(self):
        class Rpc:
            def __init__(self): self.calls = []
            def call(self, operation, request):
                self.calls.append((operation, request))
                return {"context_snapshot_id": "snapshot-1"}
        rpc = Rpc()
        hooks = create_hooks(rpc)
        result = hooks["pre_llm_call"](context_budget=2048)
        self.assertIn("snapshot-1", result["context"])
        self.assertEqual(rpc.calls[0][0], "context.build")

        class Offline:
            def call(self, *_): raise CoreUnavailable("offline")
        with self.assertRaises(CoreUnavailable): create_hooks(Offline())["pre_llm_call"]()

    def test_transport_requires_authenticated_configuration(self):
        with self.assertRaises(CoreUnavailable): TaricRpcClient(socket_path=None, token="x" * 40)
        with self.assertRaises(TaricIntegrationError): TaricRpcClient(socket_path="/tmp/taric.sock", token="short")


if __name__ == "__main__":
    unittest.main()
