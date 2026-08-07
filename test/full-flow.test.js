import assert from "node:assert/strict";
import test from "node:test";

import { connectAccountState } from "../src/core/account.js";
import { updateQuestions } from "../src/core/library.js";
import {
  createExportPayload,
  deletePersonalDataState,
  grantPrivacyConsent,
} from "../src/core/privacy.js";
import { ensureTodayPlan, submitReviewFeedback } from "../src/core/scheduler.js";
import { createInitialState } from "../src/core/state.js";
import { mergeRemoteSnapshot } from "../src/core/sync-engine.js";

const NOW = "2026-08-04T08:00:00.000Z";

test("account consent through review, export and deletion forms one complete data flow", () => {
  let state = createInitialState({ now: NOW, deviceId: "device-a" });
  state = grantPrivacyConsent(state, NOW);
  state = connectAccountState(state, {
    isSignedIn: true,
    userSlug: "tester",
    username: "tester",
  }, NOW);
  state = mergeRemoteSnapshot(state, {
    account: { isSignedIn: true, userSlug: "tester", username: "tester" },
    complete: true,
    failures: [],
    warnings: [],
    questions: [{
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
      acceptedAt: NOW,
    }],
  }, { syncedAt: NOW }).state;

  state = updateQuestions(state, ["leetcode.cn:1"], { type: "join" }, { now: NOW });
  state = ensureTodayPlan(state, { now: NOW });
  const task = state.plan.today.assignments[0];
  const outcome = submitReviewFeedback(state, {
    taskId: task.id,
    questionKey: task.questionKey,
    rating: "good",
    durationMinutes: 12,
    now: NOW,
  });
  state = outcome.state;

  assert.equal(state.plan.today.assignments[0].status, "completed");
  assert.equal(state.questions["leetcode.cn:1"].reviewHistory.length, 1);
  const exported = createExportPayload(state, NOW);
  assert.equal(exported.questions[0].reviewHistory[0].rating, "good");

  const deleted = deletePersonalDataState(state, NOW, "DELETE");
  assert.deepEqual(deleted.questions, {});
  assert.equal(deleted.dataOwnerUserSlug, null);
});
