import assert from "node:assert/strict";
import test from "node:test";

import {
  connectAccountState,
  getNextAutoSyncAt,
  unlinkAccountState,
  updateAutoSyncState,
} from "../src/core/account.js";
import { AppError } from "../src/core/errors.js";
import { createInitialState } from "../src/core/state.js";

const NOW = "2026-07-31T08:00:00.000Z";

function state() {
  return createInitialState({ now: NOW, deviceId: "device-a" });
}

function account(userSlug = "tester") {
  return {
    isSignedIn: true,
    userSlug,
    username: userSlug,
    realName: "Test User",
  };
}

test("connecting records the current account without credentials", () => {
  const connected = connectAccountState(state(), account(), NOW);

  assert.equal(connected.connection.status, "connected");
  assert.equal(connected.connection.userSlug, "tester");
  assert.equal(connected.dataOwnerUserSlug, "tester");
  assert.equal("password" in connected.connection, false);
  assert.equal("cookie" in connected.connection, false);
});

test("connecting a different account is blocked while local data has an owner", () => {
  const existing = connectAccountState(state(), account("first-user"), NOW);
  existing.questions["leetcode.cn:1"] = { note: "keep" };

  assert.throws(
    () => connectAccountState(existing, account("second-user"), NOW),
    (error) => error instanceof AppError && error.code === "ACCOUNT_MISMATCH",
  );
  assert.equal(existing.questions["leetcode.cn:1"].note, "keep");
});

test("unlinking with keep preserves the data owner and questions", () => {
  const connected = connectAccountState(state(), account(), NOW);
  connected.questions["leetcode.cn:1"] = { note: "keep" };
  const unlinked = unlinkAccountState(connected, "keep", NOW);

  assert.equal(unlinked.connection.status, "disconnected");
  assert.equal(unlinked.connection.userSlug, null);
  assert.equal(unlinked.dataOwnerUserSlug, "tester");
  assert.equal(unlinked.questions["leetcode.cn:1"].note, "keep");
});

test("unlinking with delete clears account data but retains settings", () => {
  const connected = connectAccountState(state(), account(), NOW);
  connected.questions["leetcode.cn:1"] = { note: "delete" };
  connected.settings.autoSyncIntervalMinutes = 720;
  const unlinked = unlinkAccountState(connected, "delete", NOW);

  assert.equal(unlinked.connection.status, "disconnected");
  assert.equal(unlinked.dataOwnerUserSlug, null);
  assert.deepEqual(unlinked.questions, {});
  assert.equal(unlinked.settings.autoSyncIntervalMinutes, 720);
});

test("auto sync accepts supported intervals and calculates the next run", () => {
  const updated = updateAutoSyncState(state(), {
    enabled: true,
    intervalMinutes: 360,
  });

  assert.equal(updated.settings.autoSyncEnabled, true);
  assert.equal(updated.settings.autoSyncIntervalMinutes, 360);
  assert.equal(getNextAutoSyncAt(NOW, 360), "2026-07-31T14:00:00.000Z");
});

test("auto sync rejects an unsupported interval", () => {
  assert.throws(
    () =>
      updateAutoSyncState(state(), {
        enabled: true,
        intervalMinutes: 1,
      }),
    (error) => error instanceof AppError && error.code === "INVALID_SYNC_INTERVAL",
  );
});
