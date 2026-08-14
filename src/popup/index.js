const elements = {
  accountName: document.querySelector("#account-name"),
  connectionBadge: document.querySelector("#connection-badge"),
  questionCount: document.querySelector("#question-count"),
  syncMessage: document.querySelector("#sync-message"),
  retryButton: document.querySelector("#retry-button"),
  syncResult: document.querySelector("#sync-result"),
  addedCount: document.querySelector("#added-count"),
  updatedCount: document.querySelector("#updated-count"),
  unchangedCount: document.querySelector("#unchanged-count"),
  failedCount: document.querySelector("#failed-count"),
  autoJoinedReview: document.querySelector("#auto-joined-review"),
  conflictNotice: document.querySelector("#conflict-notice"),
  appButton: document.querySelector("#app-button"),
  connectButton: document.querySelector("#connect-button"),
  syncButton: document.querySelector("#sync-button"),
  openButton: document.querySelector("#open-button"),
  autoSyncToggle: document.querySelector("#auto-sync-toggle"),
  syncInterval: document.querySelector("#sync-interval"),
  nextSync: document.querySelector("#next-sync"),
  unlinkButton: document.querySelector("#unlink-button"),
  unlinkDialog: document.querySelector("#unlink-dialog"),
  unlinkKeep: document.querySelector("#unlink-keep"),
  unlinkDelete: document.querySelector("#unlink-delete"),
  privacyStatus: document.querySelector("#privacy-status"),
  privacyConsentButton: document.querySelector("#privacy-consent-button"),
  privacyDialog: document.querySelector("#privacy-dialog"),
  privacyDetailCopy: document.querySelector("#privacy-detail-copy"),
  privacyDataList: document.querySelector("#privacy-data-list"),
  privacyConsentCheck: document.querySelector("#privacy-consent-check"),
  privacyConsentConfirm: document.querySelector("#privacy-consent-confirm"),
};

let currentState = null;
let busy = false;
let lastRetry = null;

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) {
    const error = new Error(response?.error?.message ?? "扩展操作失败");
    error.code = response?.error?.code ?? "UNKNOWN_ERROR";
    error.details = response?.error?.details ?? {};
    throw error;
  }
  return response.data;
}

function formatDateTime(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function setBusy(value, message) {
  busy = value;
  elements.appButton.disabled = value;
  elements.connectButton.disabled = value || !currentState?.privacy?.consentAt;
  elements.syncButton.disabled = value;
  elements.openButton.disabled = value;
  elements.autoSyncToggle.disabled = value;
  elements.syncInterval.disabled = value;
  elements.retryButton.disabled = value;
  if (message) {
    elements.syncMessage.textContent = message;
  }
}

function setBadge(status) {
  const map = {
    connected: ["已连接", "badge-success"],
    needs_login: ["需登录", "badge-warning"],
    conflict: ["账号冲突", "badge-error"],
    disconnected: ["未连接", "badge-neutral"],
  };
  const [label, className] = map[status] ?? ["异常", "badge-error"];
  elements.connectionBadge.textContent = label;
  elements.connectionBadge.className = `badge ${className}`;
}

function renderResult(result) {
  if (!result) {
    elements.syncResult.hidden = true;
    elements.autoJoinedReview.hidden = true;
    return;
  }
  elements.syncResult.hidden = false;
  elements.addedCount.textContent = String(result.added ?? 0);
  elements.updatedCount.textContent = String(result.updated ?? 0);
  elements.unchangedCount.textContent = String(result.unchanged ?? 0);
  elements.failedCount.textContent = String(result.failed ?? 0);
  const autoJoinedReview = Number(result.autoJoinedReview) || 0;
  elements.autoJoinedReview.hidden = autoJoinedReview === 0;
  elements.autoJoinedReview.textContent = `自动加入复习 ${autoJoinedReview} 题`;
}

function render(state) {
  currentState = state;
  const consented = Boolean(state.privacy?.consentAt);
  elements.privacyStatus.textContent = consented ? "已同意，仅本机保存" : "需要确认";
  elements.privacyConsentButton.textContent = consented ? "查看数据使用说明" : "阅读并同意后连接账号";
  elements.connectButton.disabled = !consented;
  const connection = state.connection;
  const connected = connection.status === "connected";
  setBadge(connection.status);
  elements.accountName.textContent = connected
    ? connection.realName || connection.username || connection.userSlug
    : state.hasRetainedData
      ? "已保留本地数据，重新连接原账号后访问"
      : "尚未连接账号";
  elements.questionCount.textContent = `${state.questionCount} 题`;
  elements.connectButton.hidden = connected;
  elements.syncButton.hidden = !connected;
  elements.unlinkButton.hidden = !connected && !state.hasRetainedData;
  elements.autoSyncToggle.checked = Boolean(state.settings.autoSyncEnabled);
  elements.syncInterval.value = String(state.settings.autoSyncIntervalMinutes);

  const nextSyncAt = formatDateTime(state.sync.nextAutoSyncAt);
  elements.nextSync.textContent = state.settings.autoSyncEnabled
    ? nextSyncAt
      ? `下次 ${nextSyncAt}`
      : "等待账号连接"
    : "未启用";

  const lastResult = state.sync.lastResult;
  renderResult(lastResult?.status === "success" ? lastResult.result : null);
  elements.conflictNotice.hidden = state.conflictCount === 0;
  elements.conflictNotice.textContent =
    state.conflictCount > 0
      ? `${state.conflictCount} 道题的远端状态发生变化，本地记录已保留。`
      : "";

  if (lastResult?.status === "success") {
    elements.syncMessage.textContent = `同步完成于 ${formatDateTime(lastResult.completedAt) ?? "刚刚"}。`;
  } else if (lastResult?.status === "deferred") {
    elements.syncMessage.textContent = "自动同步已延后，请保持一个力扣标签页打开。";
  } else if (lastResult?.error) {
    elements.syncMessage.textContent = `${lastResult.error.message}，已有题库未受影响。`;
  } else if (connected) {
    elements.syncMessage.textContent = "账号已连接，可以读取已通过题目。";
  } else {
    elements.syncMessage.textContent = "连接当前登录的力扣账号后开始同步。";
  }
  elements.retryButton.hidden = !lastRetry;
}

function showError(error) {
  renderResult(null);
  if (error.code === "ACCOUNT_MISMATCH") {
    const expected = error.details?.expectedUserSlug ?? "原账号";
    const detected = error.details?.detectedUserSlug ?? "当前账号";
    elements.conflictNotice.hidden = false;
    elements.conflictNotice.textContent = `本地数据属于 ${expected}，当前页面登录的是 ${detected}。请切回原账号，或解绑并删除原账号数据后再连接。`;
  }
  elements.syncMessage.textContent = `${error.message}，已有题库未受影响。`;
  elements.retryButton.hidden = !lastRetry;
}

async function openPrivacyDialog() {
  const info = await send("GET_PRIVACY_INFO");
  elements.privacyDetailCopy.textContent = `${info.disclosure.purposes.join("；")}。${info.disclosure.excluded.join("；")}。`;
  elements.privacyDataList.innerHTML = info.disclosure.dataTypes
    .map((item) => `<li>${item}</li>`).join("");
  elements.privacyConsentCheck.checked = Boolean(info.consentAt);
  elements.privacyConsentConfirm.disabled = !elements.privacyConsentCheck.checked;
  elements.privacyDialog.showModal();
}

elements.privacyConsentCheck.addEventListener("change", () => {
  elements.privacyConsentConfirm.disabled = !elements.privacyConsentCheck.checked;
});
elements.privacyConsentButton.addEventListener("click", () => openPrivacyDialog().catch(showError));
elements.privacyConsentConfirm.addEventListener("click", async (event) => {
  if (!elements.privacyConsentCheck.checked) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  try {
    await send("GRANT_PRIVACY_CONSENT");
    elements.privacyDialog.close();
    await refresh();
  } catch (error) {
    showError(error);
  }
});

async function refresh() {
  const state = await send("GET_STATE");
  render(state);
}

elements.openButton.addEventListener("click", async () => {
  try {
    await send("OPEN_LEETCODE");
  } catch (error) {
    showError(error);
  }
});

elements.appButton.addEventListener("click", async () => {
  try {
    await send("OPEN_APP");
    window.close();
  } catch (error) {
    showError(error);
  }
});

elements.connectButton.addEventListener("click", async () => {
  if (busy) return;
  if (!currentState?.privacy?.consentAt) {
    await openPrivacyDialog();
    return;
  }
  setBusy(true, "正在检测当前账号...");
  try {
    const state = await send("CONNECT_ACCOUNT");
    render(state);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});

elements.syncButton.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true, "正在同步已通过题目...");
  lastRetry = () => elements.syncButton.click();
  try {
    const response = await send("SYNC_NOW");
    render(response.state);
  } catch (error) {
    showError(error);
    await refresh();
  } finally {
    setBusy(false);
  }
});

elements.retryButton.addEventListener("click", () => {
  if (lastRetry) void lastRetry();
});

async function saveAutoSync() {
  if (busy) return;
  setBusy(true, "正在保存自动同步设置...");
  try {
    const state = await send("UPDATE_AUTO_SYNC", {
      enabled: elements.autoSyncToggle.checked,
      intervalMinutes: Number(elements.syncInterval.value),
    });
    render(state);
  } catch (error) {
    showError(error);
    if (currentState) render(currentState);
  } finally {
    setBusy(false);
  }
}

elements.autoSyncToggle.addEventListener("change", saveAutoSync);
elements.syncInterval.addEventListener("change", saveAutoSync);

elements.unlinkButton.addEventListener("click", () => {
  elements.unlinkDialog.showModal();
});

async function unlink(mode) {
  if (busy) return;
  setBusy(true, mode === "delete" ? "正在删除本地数据..." : "正在解绑账号...");
  try {
    const state = await send("UNLINK_ACCOUNT", { mode });
    render(state);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

elements.unlinkKeep.addEventListener("click", () => unlink("keep"));
elements.unlinkDelete.addEventListener("click", () => unlink("delete"));

refresh().catch(showError);
