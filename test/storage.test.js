import assert from "node:assert/strict";
import test from "node:test";

import { createInitialState } from "../src/core/state.js";
import { chromeStateRepository } from "../src/storage/chrome-storage.js";

const STORAGE_KEY = "leetcodeReviewState";
const BACKUP_KEY = "leetcodeReviewStateBackup";
const NOW = "2026-08-04T08:00:00.000Z";

function installChromeStorage(initial = {}) {
  const values = structuredClone(initial);
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") return { [keys]: structuredClone(values[keys]) };
          return Object.fromEntries(
            keys.filter((key) => key in values).map((key) => [key, structuredClone(values[key])]),
          );
        },
        async set(entries) {
          Object.assign(values, structuredClone(entries));
        },
      },
    },
  };
  return values;
}

test("repository keeps the previous valid state as a backup", async () => {
  const values = installChromeStorage();
  const first = createInitialState({ now: NOW, deviceId: "device-a" });
  first.questions["leetcode.cn:1"] = { key: "leetcode.cn:1", review: { status: "pending" } };
  await chromeStateRepository.save(first);

  const second = structuredClone(first);
  second.questions["leetcode.cn:2"] = { key: "leetcode.cn:2", review: { status: "pending" } };
  await chromeStateRepository.save(second);

  assert.deepEqual(values[BACKUP_KEY], first);
  assert.deepEqual(values[STORAGE_KEY], second);
});

test("repository restores the backup when the primary state is malformed", async () => {
  const backup = createInitialState({ now: NOW, deviceId: "device-a" });
  backup.questions["leetcode.cn:1"] = { key: "leetcode.cn:1", review: { status: "pending" } };
  const values = installChromeStorage({
    [STORAGE_KEY]: { corrupted: true },
    [BACKUP_KEY]: backup,
  });

  const restored = await chromeStateRepository.load();

  assert.equal(restored.questions["leetcode.cn:1"].key, "leetcode.cn:1");
  assert.equal(values[STORAGE_KEY].schemaVersion, restored.schemaVersion);
});
