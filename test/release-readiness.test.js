import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, ROOT), "utf8");
}

test("manifest requests only the documented minimum permissions", async () => {
  const manifest = JSON.parse(await text("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["alarms", "notifications", "scripting", "storage", "tabs"],
  );
  assert.deepEqual(manifest.host_permissions, ["https://leetcode.cn/*"]);
  assert.equal(manifest.permissions.includes("cookies"), false);
});

test("privacy controls exist and no password field is exposed", async () => {
  const [popup, app] = await Promise.all([
    text("src/popup/index.html"),
    text("src/app/index.html"),
  ]);
  assert.match(popup, /id="privacy-consent-check"/);
  assert.match(app, /id="export-data-button"/);
  assert.match(app, /id="delete-data-confirmation"/);
  assert.doesNotMatch(popup + app, /type="password"/i);
});

test("critical interactive controls expose keyboard focus and accessible names", async () => {
  const [popup, app, popupCss, appCss] = await Promise.all([
    text("src/popup/index.html"),
    text("src/app/index.html"),
    text("src/popup/styles.css"),
    text("src/app/styles.css"),
  ]);
  assert.match(popup, /<html lang="zh-CN">/);
  assert.match(app, /<html lang="zh-CN">/);
  assert.match(popupCss, /:focus-visible/);
  assert.match(appCss, /:focus-visible/);

  for (const html of [popup, app]) {
    const iconButtons = html.match(/<button[^>]*class="[^"]*icon-button[^"]*"[^>]*>/g) ?? [];
    for (const button of iconButtons) assert.match(button, /aria-label="[^"]+"/);
  }
  assert.match(app, /aria-live="polite"/);
  assert.match(popup, /aria-live="polite"/);
});
