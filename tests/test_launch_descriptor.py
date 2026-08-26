"""Tests for ephemeral single-use launch descriptors."""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from claude_hub.domain import ModelMapping, ProtocolAdapter, StandaloneProfile
from claude_hub.launch_descriptor import (
    DescriptorAlreadyConsumedError,
    DescriptorExpiredError,
    consume_launch_descriptor,
    create_launch_descriptor,
)


class LaunchDescriptorTests(unittest.TestCase):
    def setUp(self) -> None:
        now = datetime.now(timezone.utc)
        self.profile = StandaloneProfile(
            profile_id=uuid4(),
            name="Desc Profile",
            base_url="https://api.descriptor.com/v1",
            adapter=ProtocolAdapter.ANTHROPIC,
            secret_ref=uuid4(),
            created_at=now,
            updated_at=now,
            models=ModelMapping(default="claude-3-5-sonnet"),
        )

    def test_create_and_consume_descriptor_success(self) -> None:
        raw_desc = create_launch_descriptor(self.profile, ttl_seconds=60)
        self.assertFalse(raw_desc.consumed)
        self.assertFalse(raw_desc.is_expired)
        self.assertEqual(raw_desc.profile_id, self.profile.profile_id)
        self.assertEqual(raw_desc.base_url, "https://api.descriptor.com/v1")

        consumed = consume_launch_descriptor(raw_desc)
        self.assertTrue(consumed.consumed)
        self.assertEqual(consumed.descriptor_id, raw_desc.descriptor_id)

    def test_descriptor_replay_prevention(self) -> None:
        raw_desc = create_launch_descriptor(self.profile, ttl_seconds=60)
        consumed = consume_launch_descriptor(raw_desc)
        # Attempt to consume again
        with self.assertRaises(DescriptorAlreadyConsumedError):
            consume_launch_descriptor(consumed)

    def test_expired_descriptor_rejected(self) -> None:
        raw_desc = create_launch_descriptor(self.profile, ttl_seconds=10)
        future_time = raw_desc.created_at + timedelta(seconds=20)
        with self.assertRaises(DescriptorExpiredError):
            consume_launch_descriptor(raw_desc, now=future_time)


if __name__ == "__main__":
    unittest.main()
