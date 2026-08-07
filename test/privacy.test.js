import assert from "node:assert/strict";
import test from "node:test";

import { serializeError } from "../src/core/errors.js";
import {
  assertAuthorizedDataAccess,
  createExportPayload,
  deletePersonalDataState,
  grantPrivacyConsent,
  updateOptionalStatistics,
} from "../src/core/privacy.js";
import { getReviewProgress } from "../src/core/scheduler.js";
import { createInitialState } from "../src/core/state.js";

const NOW = "2026-08-04T08:00:00.000Z";

function sampleState() {
  let state = createInitialState({ now: NOW, deviceId: "device-a" });
  state = grantPrivacyConsent(state, NOW);
  state.dataOwnerUserSlug = "tester";
  state.connection.status = "connected";
  state.connection.userSlug = "tester";
  state.questions["leetcode.cn:1"] = {
    key: "leetcode.cn:1",
    sourceQuestionId: "1",
    questionFrontendId: "1",
    title: "Two Sum",
    translatedTitle: "两数之和",
    titleSlug: "two-sum",
    difficulty: "EASY",
    tags: [{ slug: "array", translatedName: "数组" }],
    acceptedAt: NOW,
    sourceAvailability: "available",
    review: { status: "reviewing", mastery: "good", dueAt: NOW },
    reviewHistory: [{ id: "review-1", reviewedAt: NOW, rating: "good" }],
    note: "使用哈希表",
    noteUpdatedAt: NOW,
  };
  return state;
}

test("export includes the agreed personal data and omits credentials", () => {
  const payload = createExportPayload(sampleState(), NOW);

  assert.equal(payload.exportVersion, 1);
  assert.equal(payload.dataOwnerUserSlug, "tester");
  assert.equal(payload.questions[0].note, "使用哈希表");
  assert.equal(payload.questions[0].reviewHistory.length, 1);
  assert.equal("connection" in payload, false);
  assert.equal(JSON.stringify(payload).toLowerCase().includes("cookie"), false);
  assert.equal(JSON.stringify(payload).toLowerCase().includes("password"), false);
});

test("export requires explicit privacy consent", () => {
  const state = createInitialState({ now: NOW, deviceId: "device-a" });
  assert.throws(
    () => createExportPayload(state, NOW),
    (error) => error.code === "PRIVACY_CONSENT_REQUIRED",
  );
});

test("personal data deletion requires the irreversible confirmation", () => {
  const state = sampleState();
  assert.throws(
    () => deletePersonalDataState(state, NOW, "delete"),
    (error) => error.code === "DELETE_CONFIRMATION_REQUIRED",
  );

  const deleted = deletePersonalDataState(state, NOW, "DELETE");
  assert.deepEqual(deleted.questions, {});
  assert.equal(deleted.dataOwnerUserSlug, null);
  assert.equal(deleted.connection.status, "disconnected");
  assert.equal(deleted.plan.today, null);
  assert.equal(deleted.sync.history.length, 0);
  assert.equal(deleted.privacy.consentAt, null);
  assert.equal(deleted.privacy.lastDeletionAt, NOW);
});

test("optional statistics can be disabled without removing core progress", () => {
  const disabled = updateOptionalStatistics(sampleState(), false);
  const progress = getReviewProgress(disabled, NOW);

  assert.equal(progress.optionalStatisticsEnabled, false);
  assert.equal(progress.streak, null);
  assert.equal(progress.improvedCount, null);
  assert.deepEqual(progress.distributions, { difficulty: [], tags: [] });
  assert.equal(typeof progress.today.rate, "number");
  assert.equal(Array.isArray(progress.forecast), true);
});

test("serialized errors redact credentials and long token-like values", () => {
  const error = new Error("request failed token=abcdefghijklmnopqrstuvwxyz123456");
  error.details = { cookie: "secret", nested: { authorization: "Bearer secret" } };
  const serialized = serializeError(error);

  assert.equal(serialized.message.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(JSON.stringify(serialized).includes("Bearer secret"), false);
});

test("retained data is locked after unlink until the owner reconnects", () => {
  const state = sampleState();
  state.connection.status = "disconnected";
  state.connection.userSlug = null;
  assert.throws(
    () => assertAuthorizedDataAccess(state),
    (error) => error.code === "LOCAL_DATA_LOCKED",
  );
  state.connection.status = "connected";
  state.connection.userSlug = "tester";
  assert.equal(assertAuthorizedDataAccess(state), state);
});
