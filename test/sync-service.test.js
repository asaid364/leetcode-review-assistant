import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/core/errors.js";
import { createInitialState } from "../src/core/state.js";
import { synchronize } from "../src/core/sync-service.js";

const NOW = "2026-07-31T08:00:00.000Z";

function clone(value) {
  return structuredClone(value);
}

function memoryRepository(initialState) {
  let state = clone(initialState);
  return {
    async load() {
      return clone(state);
    },
    async save(nextState) {
      state = clone(nextState);
    },
    current() {
      return clone(state);
    },
  };
}

function initialState() {
  const state = createInitialState({ now: NOW, deviceId: "device-a" });
  state.dataOwnerUserSlug = "tester";
  state.connection = {
    ...state.connection,
    status: "connected",
    userSlug: "tester",
  };
  state.questions["leetcode.cn:1"] = {
    key: "leetcode.cn:1",
    sourceSite: "leetcode.cn",
    accountSlug: "tester",
    sourceQuestionId: "1",
    titleSlug: "two-sum",
    sourceAvailability: "available",
    note: "must survive",
    review: { status: "reviewing" },
    reviewHistory: [],
  };
  return state;
}

test("a fetch failure records the error without changing questions", async () => {
  const before = initialState();
  const repository = memoryRepository(before);

  await assert.rejects(
    synchronize({
      repository,
      fetchSnapshot: async () => {
        throw new AppError("NETWORK_ERROR", "network unavailable");
      },
      trigger: "manual",
      now: NOW,
    }),
    (error) => error.code === "NETWORK_ERROR",
  );

  const after = repository.current();
  assert.deepEqual(after.questions, before.questions);
  assert.equal(after.sync.lastResult.status, "failed");
  assert.equal(after.sync.lastResult.error.code, "NETWORK_ERROR");
});

test("an unsigned snapshot preserves data and moves connection to needs_login", async () => {
  const before = initialState();
  const repository = memoryRepository(before);

  await assert.rejects(
    synchronize({
      repository,
      fetchSnapshot: async () => ({ account: { isSignedIn: false } }),
      trigger: "manual",
      now: NOW,
    }),
    (error) => error.code === "AUTH_REQUIRED",
  );

  const after = repository.current();
  assert.deepEqual(after.questions, before.questions);
  assert.equal(after.connection.status, "needs_login");
});

test("a successful sync commits questions and a result in one state", async () => {
  const repository = memoryRepository(
    createInitialState({ now: NOW, deviceId: "device-a" }),
  );

  const response = await synchronize({
    repository,
    fetchSnapshot: async () => ({
      account: {
        isSignedIn: true,
        userSlug: "tester",
        username: "tester",
      },
      questions: [
        {
          id: "1",
          sourceQuestionId: "1",
          questionFrontendId: "1",
          title: "Two Sum",
          translatedTitle: "两数之和",
          titleSlug: "two-sum",
          difficulty: "EASY",
          topicTags: [],
          status: "SOLVED",
        },
      ],
      failures: [],
      warnings: [],
      complete: true,
    }),
    trigger: "manual",
    now: NOW,
  });

  assert.equal(response.event.status, "success");
  assert.equal(response.event.result.added, 1);
  assert.equal(repository.current().connection.status, "connected");
  assert.equal(Object.keys(repository.current().questions).length, 1);
});
