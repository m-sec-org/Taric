import sys
import unittest
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from taric_hermes_plugin import describe_plugin, translate_event


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


if __name__ == "__main__":
    unittest.main()
