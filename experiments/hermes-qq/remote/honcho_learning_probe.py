"""Verify automatic per-peer learning with synthetic messages; seed no conclusions."""

import re
import sys
import time

from honcho import Honcho
from honcho.api_types import MessageCreateParams, SessionPeerConfig

INITIAL = {
    "alice": "For our fixture project, my standing reply style preference is brief: one or two sentences.",
    "bob": "For our fixture project, my standing reply style preference is detailed, with step-by-step explanations.",
}
CHANGE = "I have changed my standing reply style preference: I no longer want brief replies. From now on, please give me detailed, step-by-step explanations."
QUERY = "How much detail should replies include? What is the user's standing preference?"


def texts(results):
    return [item.content for item in results]


def wait_for_work(client, count, seconds=75):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        state = client.queue_status()
        if state.completed_work_units > count and not (state.in_progress_work_units or state.pending_work_units):
            return
        time.sleep(1)
    raise RuntimeError("deriver did not complete and drain")


def probe(run_id):
    client = Honcho(base_url="http://127.0.0.1:8000", workspace_id="luke-learning-" + run_id,
                    api_key="fixture-only", max_retries=0)
    observer = client.peer("luke")
    alice, bob = (client.peer(name) for name in INITIAL)
    session = client.session("fixture-chat")
    session.add_peers([
        (observer, SessionPeerConfig(observe_me=False, observe_others=True)),
        (alice, SessionPeerConfig(observe_me=True, observe_others=False)),
        (bob, SessionPeerConfig(observe_me=True, observe_others=False)),
    ])
    before = client.queue_status().completed_work_units
    session.add_messages([MessageCreateParams(peer_id=name, content=text) for name, text in INITIAL.items()])
    wait_for_work(client, before)
    alice_view, bob_view = (observer.conclusions_of(name) for name in INITIAL)
    initial = {"alice": texts(alice_view.list()), "bob": texts(bob_view.list())}
    print("learned", initial, flush=True)
    if not any(re.search(r"brief|short|concise|one or two", item, re.I) for item in initial["alice"]):
        raise RuntimeError("did not learn Alice's short preference")
    if not any(re.search(r"detailed|step.by.step", item, re.I) for item in initial["bob"]):
        raise RuntimeError("did not learn Bob's detailed preference")
    if any(re.search(r"detailed|step.by.step", item, re.I) for item in initial["alice"]):
        raise RuntimeError("Bob's preference entered Alice's memory")
    if any(re.search(r"brief|short|concise|one or two", item, re.I) for item in initial["bob"]):
        raise RuntimeError("Alice's preference entered Bob's memory")
    before = client.queue_status().completed_work_units
    session.add_messages(MessageCreateParams(peer_id="alice", content=CHANGE))
    wait_for_work(client, before)
    updated = texts(alice_view.list())
    print("after correction", updated, flush=True)
    if not updated or not re.search(r"detailed|step.by.step", updated[0], re.I):
        raise RuntimeError("new Alice preference was not learned as the latest conclusion")
    if texts(bob_view.list()) != initial["bob"]:
        raise RuntimeError("Alice's correction changed Bob's conclusions")
    semantic = {name: texts(observer.conclusions_of(name).query(QUERY, top_k=4)) for name in INITIAL}
    print("vector query results (mock embedding does not validate ranking)", semantic, flush=True)
    if not all(semantic.values()):
        raise RuntimeError("semantic queries returned no conclusions")
    print("Honcho learning probe passed", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 2 or not re.fullmatch(r"[a-z0-9-]{1,24}", sys.argv[1]):
        raise SystemExit("a short synthetic run id is required")
    probe(sys.argv[1])
