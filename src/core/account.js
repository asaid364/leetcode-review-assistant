import { AppError } from "./errors.js";
import { createInitialState } from "./state.js";

export const ALLOWED_AUTO_SYNC_INTERVALS = new Set([360, 720, 1440]);

export function connectAccountState(state, account, now) {
  if (!account?.isSignedIn || !account.userSlug) {
    throw new AppError("AUTH_REQUIRED", "请先在力扣中国站登录");
  }
  if (state.dataOwnerUserSlug && state.dataOwnerUserSlug !== account.userSlug) {
    throw new AppError("ACCOUNT_MISMATCH", "检测到不同的力扣账号", {
      expectedUserSlug: state.dataOwnerUserSlug,
      detectedUserSlug: account.userSlug,
    });
  }

  return {
    ...state,
    dataOwnerUserSlug: state.dataOwnerUserSlug ?? account.userSlug,
    connection: {
      ...state.connection,
      status: "connected",
      userSlug: account.userSlug,
      username: account.username ?? null,
      realName: account.realName ?? null,
      avatar: account.avatar ?? null,
      connectedAt:
        state.connection.userSlug === account.userSlug && state.connection.connectedAt
          ? state.connection.connectedAt
          : now,
      lastCheckedAt: now,
      lastError: null,
    },
  };
}

export function unlinkAccountState(state, mode, now) {
  if (mode === "delete") {
    const reset = createInitialState({ now, deviceId: state.device.id });
    reset.settings = { ...state.settings };
    return reset;
  }
  if (mode !== "keep") {
    throw new AppError("INVALID_UNLINK_MODE", "请选择保留或删除本地数据");
  }

  return {
    ...state,
    connection: {
      ...state.connection,
      status: "disconnected",
      userSlug: null,
      username: null,
      realName: null,
      avatar: null,
      connectedAt: null,
      lastCheckedAt: now,
      lastError: null,
    },
  };
}

export function updateAutoSyncState(state, { enabled, intervalMinutes }) {
  if (!ALLOWED_AUTO_SYNC_INTERVALS.has(intervalMinutes)) {
    throw new AppError("INVALID_SYNC_INTERVAL", "自动同步间隔不受支持");
  }

  return {
    ...state,
    settings: {
      ...state.settings,
      autoSyncEnabled: Boolean(enabled),
      autoSyncIntervalMinutes: intervalMinutes,
    },
  };
}

export function getNextAutoSyncAt(now, intervalMinutes) {
  return new Date(new Date(now).valueOf() + intervalMinutes * 60_000).toISOString();
}
