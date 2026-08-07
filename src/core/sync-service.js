import { AppError, asAppError } from "./errors.js";
import { mergeRemoteSnapshot } from "./sync-engine.js";

const MAX_HISTORY = 50;

function prependHistory(history, event) {
  return [event, ...(Array.isArray(history) ? history : [])].slice(0, MAX_HISTORY);
}

function connectionFromAccount(previous, account, now) {
  return {
    ...previous,
    status: "connected",
    site: "leetcode.cn",
    userSlug: account.userSlug,
    username: account.username ?? null,
    realName: account.realName ?? null,
    avatar: account.avatar ?? null,
    connectedAt:
      previous.userSlug === account.userSlug && previous.connectedAt
        ? previous.connectedAt
        : now,
    lastCheckedAt: now,
    lastError: null,
  };
}

export async function recordSyncFailure(
  repository,
  error,
  { trigger, now, status = "failed" },
) {
  const appError = asAppError(error, "SYNC_FAILED");
  const current = await repository.load();
  const event = {
    id: `${now}:${trigger}:${appError.code}`,
    status,
    trigger,
    attemptedAt: now,
    error: {
      code: appError.code,
      message: appError.message,
      details: appError.details,
    },
  };
  const connectionStatus =
    appError.code === "AUTH_REQUIRED" || appError.code === "AUTH_EXPIRED"
      ? "needs_login"
      : appError.code === "ACCOUNT_MISMATCH"
        ? "conflict"
        : current.connection.status;

  await repository.save({
    ...current,
    connection: {
      ...current.connection,
      status: connectionStatus,
      lastCheckedAt: now,
      lastError: event.error,
    },
    sync: {
      ...current.sync,
      lastAttemptAt: now,
      lastResult: event,
      history: prependHistory(current.sync.history, event),
    },
  });
  return event;
}

export async function synchronize({ repository, fetchSnapshot, trigger, now }) {
  const before = await repository.load();
  let snapshot;
  try {
    snapshot = await fetchSnapshot();
    if (!snapshot?.account?.isSignedIn) {
      throw new AppError("AUTH_REQUIRED", "请先在力扣中国站登录");
    }

    const { state: mergedState, result } = mergeRemoteSnapshot(before, snapshot, {
      syncedAt: now,
    });
    const event = {
      id: `${now}:${trigger}:success`,
      status: "success",
      trigger,
      attemptedAt: now,
      completedAt: now,
      result,
    };
    const nextState = {
      ...mergedState,
      connection: connectionFromAccount(before.connection, snapshot.account, now),
      sync: {
        ...before.sync,
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastResult: event,
        history: prependHistory(before.sync.history, event),
      },
    };

    await repository.save(nextState);
    return { event, state: nextState };
  } catch (error) {
    await recordSyncFailure(repository, error, { trigger, now });
    throw asAppError(error, "SYNC_FAILED");
  }
}
