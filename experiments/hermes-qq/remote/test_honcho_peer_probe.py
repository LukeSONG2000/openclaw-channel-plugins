"""Run against the pinned Honcho plugin's offline pytest harness, not a live profile."""

from types import SimpleNamespace
from unittest.mock import MagicMock

from hermes_plugin_honcho.client import HonchoClientConfig
from hermes_plugin_honcho.session import HonchoSessionManager


def test_later_author_is_written_separately_but_default_recall_stays_on_session_peer():
    config = HonchoClientConfig(api_key="fixture-only", peer_name="fixture", ai_peer="luke")
    manager = HonchoSessionManager(honcho=MagicMock(), config=config, runtime_user_peer_name="alice")
    key = "qq-fixture-group"
    backend = MagicMock()
    preferences = {"alice": "Prefers short replies.", "bob": "Prefers detailed replies."}

    def peer(peer_id):
        result = MagicMock()
        result.representation.side_effect = lambda **fields: preferences.get(fields.get("target") or peer_id, "")
        result.get_card.return_value = []
        result.context.side_effect = lambda **fields: SimpleNamespace(
            representation=preferences.get(fields.get("target") or peer_id, ""), peer_card=[]
        )
        return result

    manager._get_or_create_peer = MagicMock(side_effect=peer)
    manager._get_or_create_honcho_session = MagicMock(return_value=(backend, [], None))
    session = manager.get_or_create(key)
    manager._sessions_cache[session.honcho_session_id] = backend
    backend.context.side_effect = lambda **fields: SimpleNamespace(
        summary=None,
        peer_representation=preferences.get(fields.get("peer_target"), ""),
        peer_card=[],
        messages=[],
    )

    assert manager.resolve_author_peer_id(key, "bob", "Same display name") == "bob"
    assert manager.resolve_author_peer_id(key, "bob", "Renamed") == "bob"
    assert manager.get_prefetch_context(key, "Reply preferences", current_query_only=True)[
        "representation"
    ] == preferences["alice"]
    assert manager.get_session_context(key, peer="bob")["representation"] == preferences["bob"]

    other = manager.get_or_create("qq-fixture-other-group", user_peer_id="different-scope-alice")
    assert other.user_peer_id != session.user_peer_id
    assert manager.get_session_context(other.key)["representation"] == ""
