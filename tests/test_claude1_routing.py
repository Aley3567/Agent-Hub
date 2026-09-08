"""Routing consumes the supplied snapshot; matching never guesses a provider."""

import copy
import unittest

from claude1_routing import match_channel_provider, route


class ChannelMatchingTests(unittest.TestCase):
    def test_explicit_selector_wins_over_a_different_url_match(self):
        selected = {"base_url": "https://selected.example"}
        by_url = {"base_url": "https://legacy.example"}
        result = match_channel_provider(
            {"provider": "id:selected", "provider_base_url": by_url["base_url"]},
            {"id:selected": selected, "id:legacy": by_url},
        )
        self.assertIs(result, selected)

    def test_missing_explicit_selector_does_not_fall_back_by_url(self):
        provider = {"base_url": "https://legacy.example"}
        self.assertIsNone(match_channel_provider(
            {"provider": "id:missing", "provider_base_url": provider["base_url"]},
            {"id:legacy": provider},
        ))

    def test_id_and_name_for_one_provider_are_not_ambiguous(self):
        provider = {"base_url": "https://upstream.example"}
        result = match_channel_provider(
            {"provider_base_url": provider["base_url"]},
            {"id:fixture": provider, "Fixture": provider},
        )
        self.assertIs(result, provider)

    def test_distinct_providers_with_the_same_url_are_ambiguous(self):
        provider = {"base_url": "https://upstream.example"}
        self.assertIsNone(match_channel_provider(
            {"provider_base_url": provider["base_url"]},
            {"id:first": provider, "id:second": dict(provider)},
        ))

    def test_legacy_url_uses_shared_endpoint_normalization(self):
        provider = {"base_url": "https://upstream.example/v1/"}
        self.assertIs(match_channel_provider(
            {"provider_base_url": "https://upstream.example"},
            {"id:fixture": provider},
        ), provider)


class RouteSnapshotTests(unittest.TestCase):
    def test_each_call_uses_its_snapshot_without_changing_inputs(self):
        cfg = {
            "default_channel": "primary",
            "channels": {"primary": {"provider": "id:fixture", "models": []}},
        }
        old = {"id:fixture": {"model_map": {"haiku": "model-before"}}}
        new = {"id:fixture": {"model_map": {"haiku": "model-after"}}}
        before = copy.deepcopy((cfg, old, new))

        self.assertEqual(route("haiku", cfg, old), ("primary", "model-before"))
        self.assertEqual(route("haiku", cfg, new), ("primary", "model-after"))
        self.assertEqual((cfg, old, new), before)
