"""Seed or verify two synthetic workspaces on a disposable, isolated Honcho server."""

import argparse
import re

from honcho import Honcho
from honcho.api_types import MessageCreateParams, SessionPeerConfig

SESSION = "group-chat"
MEMBERS = {"alice": "Prefers short replies.", "bob": "Prefers detailed replies."}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def probe(phase, run_id):
    # Run inside the sandbox API container; never accept a cloud endpoint.
    settings = dict(base_url="http://127.0.0.1:8000", api_key="fixture-only", max_retries=0)
    group = Honcho(workspace_id="luke-probe-" + run_id + "-group", **settings)
    isolated = Honcho(workspace_id="luke-probe-" + run_id + "-other", **settings)
    session = group.session(SESSION)
    observer = group.peer("luke")
    peers = {name: group.peer(name) for name in MEMBERS}
    other_session = isolated.session(SESSION)
    other_observer = isolated.peer("luke")
    other_member = isolated.peer("alice")

    if phase == "seed":
        require(not list(session.messages()) and not list(other_session.messages()), "fixture already seeded")
        session.add_peers([(p, SessionPeerConfig(observe_me=True, observe_others=False)) for p in peers.values()]
                          + [(observer, SessionPeerConfig(observe_me=False, observe_others=True))])
        session.add_messages([MessageCreateParams(peer_id=name, content=text) for name, text in MEMBERS.items()])
        for name, text in MEMBERS.items():
            observer.conclusions_of(name).create([{"content": text, "session_id": SESSION}])
        other_session.add_messages(MessageCreateParams(peer_id=other_member.id, content="Unrelated group."))
        return

    actual = sorted((m.peer_id, m.content) for m in session.messages())
    require(actual == sorted(MEMBERS.items()), "shared session lost or misattributed messages")
    for name, expected in MEMBERS.items():
        found = [c.content for c in observer.conclusions_of(name).list()]
        require(found == [expected], "explicit peer recall is missing or mixed")
    require([(m.peer_id, m.content) for m in other_session.messages()] == [("alice", "Unrelated group.")],
            "messages crossed workspace boundaries")
    require(not list(other_observer.conclusions_of(other_member.id).list()), "conclusions crossed workspace boundaries")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["seed", "verify"])
    parser.add_argument("run_id", type=str)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9-]{1,24}", args.run_id):
        parser.error("run_id must be a short lowercase identifier")
    probe(args.phase, args.run_id)
    print("Honcho persistence probe: " + args.phase + " passed")
