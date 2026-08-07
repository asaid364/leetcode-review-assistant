import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/core/errors.js";
import { createInitialState } from "../src/core/state.js";
import { mergeRemoteSnapshot } from "../src/core/sync-engine.js";

const FIRST_SYNC = "2026-07-31T08:00:00.000Z";
const SECOND_SYNC = "2026-08-01T08:00:00.000Z";

function createState() {
  return createInitialState({ now: FIRST_SYNC, deviceId: "device-a" });
}

function question(overrides = {}) {
  return {
    id: "1",
    sourceQuestionId: "1",
    questionFrontendId: "1",
    title: "Two Sum",
    translatedTitle: "两数之和",
    titleSlug: "two-sum",
    difficulty: "EASY",
    topicTags: [{ name: "Array", nameTranslated: "数组", slug: "array" }],
    paidOnly: false,
    status: "SOLVED",
    acceptedAt: "2026-07-30T08:00:00.000Z",
    ...overrides,
  };
}

function snapshot(questions, overrides = {}) {
  return {
    account: {
      isSignedIn: true,
      userSlug: "tester",
      username: "tester",
    },
    questions,
    failures: [],
    warnings: [],
    complete: true,
    ...overrides,
  };
}

test("first sync adds solved questions with a pending review state", () => {
  const outcome = mergeRemoteSnapshot(createState(), snapshot([question()]), {
    syncedAt: FIRST_SYNC,
  });

  assert.deepEqual(outcome.result, {
    added: 1,
    updated: 0,
    unchanged: 0,
    failed: 0,
    conflicts: 0,
    warnings: [],
  });
  assert.equal(Object.keys(outcome.state.questions).length, 1);
  assert.equal(outcome.state.questions["leetcode.cn:1"].review.status, "pending");
  assert.equal(outcome.state.questions["leetcode.cn:1"].acceptedAtSource, "recent_accepted_submission");
});

test("first sync honors the automatic review setting", () => {
  const state = createState();
  state.settings.newQuestionMode = "reviewing";
  const outcome = mergeRemoteSnapshot(state, snapshot([question()]), {
    syncedAt: FIRST_SYNC,
  });

  assert.equal(outcome.state.questions["leetcode.cn:1"].review.status, "reviewing");
  assert.equal(outcome.state.questions["leetcode.cn:1"].review.dueAt, null);
});

test("repeating the same sync does not create duplicates", () => {
  const first = mergeRemoteSnapshot(createState(), snapshot([question()]), {
    syncedAt: FIRST_SYNC,
  }).state;
  const second = mergeRemoteSnapshot(first, snapshot([question()]), {
    syncedAt: SECOND_SYNC,
  });

  assert.equal(Object.keys(second.state.questions).length, 1);
  assert.equal(second.result.added, 0);
  assert.equal(second.result.updated, 0);
  assert.equal(second.result.unchanged, 1);
  assert.equal(
    second.state.questions["leetcode.cn:1"].lastSourceSeenAt,
    SECOND_SYNC,
  );
});

test("source metadata updates preserve local review data and notes", () => {
  const first = mergeRemoteSnapshot(createState(), snapshot([question()]), {
    syncedAt: FIRST_SYNC,
  }).state;
  first.questions["leetcode.cn:1"].review = {
    status: "reviewing",
    isFocus: true,
    mastery: "hard",
    updatedAt: FIRST_SYNC,
    updatedByDeviceId: "device-a",
  };
  first.questions["leetcode.cn:1"].note = "注意哈希表边界";
  first.questions["leetcode.cn:1"].reviewHistory = [{ grade: "hard" }];

  const outcome = mergeRemoteSnapshot(
    first,
    snapshot([
      question({
        translatedTitle: "两数之和（更新）",
        difficulty: "MEDIUM",
      }),
    ]),
    { syncedAt: SECOND_SYNC },
  );
  const merged = outcome.state.questions["leetcode.cn:1"];

  assert.equal(outcome.result.updated, 1);
  assert.equal(merged.translatedTitle, "两数之和（更新）");
  assert.equal(merged.review.status, "reviewing");
  assert.equal(merged.review.isFocus, true);
  assert.equal(merged.note, "注意哈希表边界");
  assert.deepEqual(merged.reviewHistory, [{ grade: "hard" }]);
});

test("a question missing from a complete remote snapshot is preserved and flagged", () => {
  const first = mergeRemoteSnapshot(createState(), snapshot([question()]), {
    syncedAt: FIRST_SYNC,
  }).state;
  first.questions["leetcode.cn:1"].note = "保留的本地笔记";

  const outcome = mergeRemoteSnapshot(first, snapshot([]), {
    syncedAt: SECOND_SYNC,
  });
  const preserved = outcome.state.questions["leetcode.cn:1"];

  assert.equal(Object.keys(outcome.state.questions).length, 1);
  assert.equal(preserved.sourceAvailability, "missing");
  assert.equal(preserved.remoteConflict.type, "NO_LONGER_IN_SOLVED_SNAPSHOT");
  assert.equal(preserved.note, "保留的本地笔记");
  assert.equal(outcome.result.conflicts, 1);
});

test("an account mismatch stops the merge before question mutation", () => {
  const state = createState();
  state.dataOwnerUserSlug = "original-user";
  state.questions["leetcode.cn:1"] = { key: "leetcode.cn:1", note: "keep" };

  assert.throws(
    () =>
      mergeRemoteSnapshot(state, snapshot([question()]), {
        syncedAt: SECOND_SYNC,
      }),
    (error) =>
      error instanceof AppError &&
      error.code === "ACCOUNT_MISMATCH" &&
      error.details.expectedUserSlug === "original-user",
  );
  assert.equal(state.questions["leetcode.cn:1"].note, "keep");
});

test("malformed and unsolved remote records are counted as failures", () => {
  const outcome = mergeRemoteSnapshot(
    createState(),
    snapshot([
      { status: "SOLVED", title: "Missing identity" },
      question({ id: "2", sourceQuestionId: "2", titleSlug: "attempted", status: "ATTEMPTED" }),
    ]),
    { syncedAt: FIRST_SYNC },
  );

  assert.equal(outcome.result.failed, 2);
  assert.equal(Object.keys(outcome.state.questions).length, 0);
});

test("an incomplete snapshot is rejected", () => {
  assert.throws(
    () =>
      mergeRemoteSnapshot(
        createState(),
        snapshot([question()], { complete: false }),
        { syncedAt: FIRST_SYNC },
      ),
    (error) => error instanceof AppError && error.code === "INCOMPLETE_SNAPSHOT",
  );
});
