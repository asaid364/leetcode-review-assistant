import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9338;
const ENDPOINT = "http://127.0.0.1:" + PORT;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function poll(operation, message, attempts = 80) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw lastError ?? new Error(message);
}

class CdpSession {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.exceptions.push(message.params.exceptionDetails.text);
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    this.socket.close();
  }
}

async function createTarget(url) {
  const response = await fetch(ENDPOINT + "/json/new?" + encodeURIComponent(url), { method: "PUT" });
  if (!response.ok) throw new Error("无法创建浏览器目标：" + response.status);
  return response.json();
}

async function evaluate(session, expression) {
  const response = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

async function capture(url, width, height, outputPath) {
  const target = await createTarget(url);
  const session = new CdpSession(target.webSocketDebuggerUrl);
  try {
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    await session.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 700,
    });
    await poll(
      async () => (await evaluate(session, "document.readyState")) === "complete",
      "页面加载超时",
    );
    await delay(500);
    const layout = await evaluate(session, "({ title: document.title, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, bodyWidth: document.body.getBoundingClientRect().width, viewportWidth: document.documentElement.clientWidth, text: document.body.innerText.slice(0, 500) })");
    if (layout.horizontalOverflow) throw new Error(layout.title + " 在 " + width + "px 视口存在横向溢出");
    if (session.exceptions.length) throw new Error("页面运行异常：" + session.exceptions.join("；"));
    const screenshot = await session.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
    return layout;
  } finally {
    session.close();
    await fetch(ENDPOINT + "/json/close/" + target.id).catch(() => undefined);
  }
}

const profile = await mkdtemp(path.join(os.tmpdir(), "leetcode-review-edge-"));
const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + profile,
  "--disable-extensions-except=" + ROOT,
  "--load-extension=" + ROOT,
  "about:blank",
], { stdio: "ignore", windowsHide: true });

try {
  const extensionId = await poll(async () => {
    const targets = await fetch(ENDPOINT + "/json/list").then((response) => response.json());
    const extensionTarget = targets.find((target) => target.url.endsWith("/src/background.js"));
    return extensionTarget?.url.split("/")[2];
  }, "扩展后台未启动");
  const base = "chrome-extension://" + extensionId;
  const results = [];
  results.push(await capture(
    base + "/src/app/index.html#settings",
    1440,
    900,
    path.join(ROOT, "img", "m4-settings-desktop.png"),
  ));
  results.push(await capture(
    base + "/src/app/index.html#settings",
    390,
    844,
    path.join(ROOT, "img", "m4-settings-mobile.png"),
  ));
  results.push(await capture(
    base + "/src/popup/index.html",
    368,
    620,
    path.join(ROOT, "img", "m4-popup-privacy.png"),
  ));
  if (results.some((page) => !page.text.includes("复习"))) {
    throw new Error("扩展页面内容未正确加载");
  }
  process.stdout.write(JSON.stringify({ extensionId, pages: results }, null, 2));
} finally {
  edge.kill();
  await Promise.race([
    new Promise((resolve) => edge.once("exit", resolve)),
    delay(2000),
  ]);
  await delay(400);
  try {
    await rm(profile, { recursive: true, force: true });
  } catch {
    // Edge may keep a dictionary file locked briefly after exit.
  }
}
