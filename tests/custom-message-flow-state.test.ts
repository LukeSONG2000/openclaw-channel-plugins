import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCustomMessageFlowStateController,
  type CustomMessageFlowStateStoreOptions,
} from "../src/custom/message-flow-state.js";
import { loadCustomAuthorizationState, saveCustomAuthorizationState } from "../src/custom/auth-store.js";
import { loadCustomPollState, saveCustomPollState } from "../src/custom/poll-store.js";
import { loadCustomProactiveBudgetState, saveCustomProactiveBudgetState } from "../src/custom/proactive-budget-store.js";
import { loadCustomTaskSandboxState, saveCustomTaskSandboxState } from "../src/custom/task-sandbox-store.js";
import { loadCustomUnreadState, saveCustomUnreadState } from "../src/custom/unread-store.js";
import type {
  CustomAuthorizationRuntimeState,
  CustomPollRuntimeState,
  CustomProactiveBudgetRuntimeState,
  CustomTaskSandboxRuntimeState,
} from "../src/custom/types.js";
import type { CustomUnreadRuntimeState } from "../src/custom/unread-runtime.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-custom-flow-state-"));
try {
  const accountId = "default/account";
  const storeOptions: CustomMessageFlowStateStoreOptions = {
    auth: { dir: path.join(tmpRoot, "auth") },
    proactiveBudget: { dir: path.join(tmpRoot, "budget") },
    tasks: { dir: path.join(tmpRoot, "tasks") },
    polls: { dir: path.join(tmpRoot, "polls") },
    unread: { dir: path.join(tmpRoot, "unread") },
  };

  const authState: CustomAuthorizationRuntimeState = {
    grants: {
      "grant-1000-1": {
        id: "grant-1000-1",
        peerId: "GROUP_OPENID",
        actorId: "MEMBER_OPENID",
        capability: "deploy.check",
        grantedBy: "ADMIN_OPENID",
        createdAt: 1_000,
        expiresAt: Date.now() + 60_000,
      },
    },
    requests: {},
  };
  const budgetState: CustomProactiveBudgetRuntimeState = {
    entries: {
      "default:group:GROUP_OPENID": {
        period: "2026-06",
        count: 1,
        recent: [1_000],
        updatedAt: 1_000,
      },
    },
    acceptance: {},
  };
  const taskState: CustomTaskSandboxRuntimeState = {
    tasks: {
      "qqbot-default-group-GROUP_OPENID-2000-1": {
        id: "qqbot-default-group-GROUP_OPENID-2000-1",
        accountId,
        peer: { kind: "group", id: "GROUP_OPENID" },
        owner: { id: "MEMBER_OPENID", label: "Member" },
        title: "Persist task state",
        prompt: "Persist task state",
        status: "queued",
        workspace: "/tmp/tasks/qqbot-default-group-GROUP_OPENID-2000-1",
        createdAt: 2_000,
        updatedAt: 2_000,
        requirements: [],
      },
    },
  };
  const pollState: CustomPollRuntimeState = {
    polls: {
      "poll-default-group-GROUP_OPENID-3000-1": {
        id: "poll-default-group-GROUP_OPENID-3000-1",
        accountId,
        peer: { kind: "group", id: "GROUP_OPENID" },
        creator: { id: "MEMBER_OPENID", label: "Member" },
        question: "Pick one",
        options: [
          { id: "1", label: "A" },
          { id: "2", label: "B" },
        ],
        votes: {},
        status: "open",
        createdAt: 3_000,
        updatedAt: 3_000,
      },
    },
  };
  const unreadState: CustomUnreadRuntimeState = {
    peers: {
      GROUP_OPENID: {
        history: [{
          actorId: "MEMBER_OPENID",
          body: "hello",
          timestamp: 4_000,
          messageId: "msg-1",
        }],
        followupActive: true,
      },
    },
    snapshots: {},
  };

  assert.equal(saveCustomAuthorizationState(accountId, authState, storeOptions.auth), true);
  assert.equal(saveCustomProactiveBudgetState(accountId, budgetState, storeOptions.proactiveBudget), true);
  assert.equal(saveCustomTaskSandboxState(accountId, taskState, storeOptions.tasks), true);
  assert.equal(saveCustomPollState(accountId, pollState, storeOptions.polls), true);
  assert.equal(saveCustomUnreadState(accountId, unreadState, storeOptions.unread), true);

  const logLines: string[] = [];
  const controller = createCustomMessageFlowStateController({
    accountId,
    storeOptions,
    log: { info: (msg) => logLines.push(msg) },
  });

  assert.equal(controller.restoredAuthIntents.length, 0);
  assert.equal(controller.runtime.auth.getState().grants["grant-1000-1"]?.actorId, "MEMBER_OPENID");
  assert.equal(controller.runtime.proactiveBudget.getState().entries["default:group:GROUP_OPENID"]?.count, 1);
  assert.equal(controller.runtime.tasks.getTask("qqbot-default-group-GROUP_OPENID-2000-1")?.status, "queued");
  assert.equal(controller.runtime.polls.getPoll("poll-default-group-GROUP_OPENID-3000-1")?.question, "Pick one");
  assert.equal(controller.runtime.unread.getState().peers.GROUP_OPENID?.history.length, 1);
  assert.equal(logLines.some((line) => line.includes("Restored custom auth state")), true);
  assert.equal(logLines.some((line) => line.includes("Restored custom unread state")), true);

  controller.runtime.polls.vote({
    pollId: "poll-default-group-GROUP_OPENID-3000-1",
    optionId: "2",
    actor: { id: "VOTER_OPENID", label: "Voter" },
    now: 5_000,
  });
  controller.runtime.proactiveBudget.record({
    accountId,
    peer: { kind: "group", id: "GROUP_OPENID" },
    cfg: {
      enabled: true,
      monthlyLimit: 4,
      rateLimitWindowMs: 60_000,
      rateLimitMax: 4,
    },
    now: 6_000,
  });
  controller.persistAllState();

  assert.equal(loadCustomPollState(accountId, storeOptions.polls)?.polls["poll-default-group-GROUP_OPENID-3000-1"]?.votes.VOTER_OPENID?.optionId, "2");
  assert.equal(loadCustomProactiveBudgetState(accountId, storeOptions.proactiveBudget)?.entries["default/account:group:GROUP_OPENID"]?.count, 1);
  assert.equal(loadCustomAuthorizationState(accountId, storeOptions.auth)?.grants["grant-1000-1"]?.capability, "deploy.check");
  assert.equal(loadCustomTaskSandboxState(accountId, storeOptions.tasks)?.tasks["qqbot-default-group-GROUP_OPENID-2000-1"]?.title, "Persist task state");
  assert.equal(loadCustomUnreadState(accountId, storeOptions.unread)?.peers.GROUP_OPENID?.history[0]?.body, "hello");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log("custom message flow state tests passed");
