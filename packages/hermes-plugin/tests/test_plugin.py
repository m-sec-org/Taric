import sys
import unittest
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


if __name__ == "__main__":
    unittest.main()
