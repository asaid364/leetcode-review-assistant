import { createInitialState, normalizeState } from "../core/state.js";

const STORAGE_KEY = "leetcodeReviewState";
const BACKUP_KEY = "leetcodeReviewStateBackup";

function createDeviceId() {
  return globalThis.crypto?.randomUUID?.() ?? `device-${Date.now()}-${Math.random()}`;
}

export const chromeStateRepository = {
  async load() {
    const result = await chrome.storage.local.get([STORAGE_KEY, BACKUP_KEY]);
    const now = new Date().toISOString();
    const stored = isUsableStoredState(result[STORAGE_KEY])
      ? result[STORAGE_KEY]
      : isUsableStoredState(result[BACKUP_KEY])
        ? result[BACKUP_KEY]
        : undefined;
    const deviceId = stored?.device?.id ?? createDeviceId();
    const normalized = normalizeState(stored, { now, deviceId });

    if (!result[STORAGE_KEY] || stored !== result[STORAGE_KEY] || result[STORAGE_KEY].schemaVersion !== normalized.schemaVersion) {
      await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
    }
    return normalized;
  },

  async save(state) {
    const current = await chrome.storage.local.get(STORAGE_KEY);
    if (isUsableStoredState(current[STORAGE_KEY])) {
      await chrome.storage.local.set({ [BACKUP_KEY]: current[STORAGE_KEY] });
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  },

  async resetAccountData({ keepSettings = true } = {}) {
    const current = await this.load();
    const initial = createInitialState({
      now: new Date().toISOString(),
      deviceId: current.device.id,
    });
    if (keepSettings) {
      initial.settings = current.settings;
    }
    await this.save(initial);
    return initial;
  },
};

function isUsableStoredState(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Number.isInteger(value.schemaVersion) &&
      value.questions &&
      typeof value.questions === "object" &&
      value.settings &&
      typeof value.settings === "object",
  );
}
