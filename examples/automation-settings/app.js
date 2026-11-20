const get = (id) => document.getElementById(id);
const keyFromUrl = new URLSearchParams(location.hash.slice(1)).get("key");
const keyStore = "desklatch.automation-settings";
const requestKey = keyFromUrl || sessionStorage.getItem(keyStore);
if (keyFromUrl) {
  sessionStorage.setItem(keyStore, keyFromUrl);
  history.replaceState(null, "", location.pathname + location.search);
}

const controls = new Map();
let groups = [];
let saved;
let draft;
let saving = false;
let probingSite = false;

function element(tag, className, content) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (content !== undefined) item.textContent = content;
  return item;
}

function keyFor(prefs) {
  return JSON.stringify({
    blockedApps: [...prefs.blockedApps].sort(),
    blockedWindows: [...prefs.blockedWindows].sort(),
    mode: prefs.browser.mode,
    origins: [...prefs.browser.origins].sort(),
  });
}

function hasChanges() {
  return keyFor(draft) !== keyFor(saved);
}

async function request(path, method = "GET", value) {
  if (!requestKey) throw new Error("请打开启动时提供的完整预览链接。");
  const response = await fetch(path, {
    method,
    headers: {
      "X-DeskLatch-Key": requestKey,
      ...(value === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  if (response.status === 401 || response.status === 403) throw new Error("预览链接已失效，请打开当前服务提供的完整链接。");
  if (!response.ok) throw new Error(response.status === 409 ? "设置已在另一个页面更改，请重新加载后再试。" : "这次请求没有完成，请重试。");
  return response.json();
}

function makeSwitch(labelText, handler) {
  const label = element("label", "switch");
  const input = element("input");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.setAttribute("aria-label", labelText);
  const labelState = element("span");
  labelState.setAttribute("aria-hidden", "true");
  input.addEventListener("change", () => handler(input.checked));
  label.append(input, labelState);
  return { label, input, labelState };
}

function markBlocked(list, id, blocked) {
  const keys = new Set(draft[list]);
  if (blocked) keys.add(id);
  else keys.delete(id);
  draft[list] = [...keys];
  renderPreferences();
}

function renderGroups() {
  const list = get("app-list");
  const options = get("check-target");
  list.replaceChildren();
  options.replaceChildren();
  controls.clear();

  for (const group of groups) {
    const row = element("div", "app-group");
    const heading = element("div", "app-heading");
    const expand = element("button", "expand-group");
    expand.type = "button";
    const icon = element("span", "app-icon", group.name[0]);
    icon.setAttribute("aria-hidden", "true");
    const caption = element("span");
    caption.append(element("span", "app-name", group.name), element("span", "app-meta", String(group.windows.length) + " 个窗口"));
    const chevron = element("span", "chevron");
    chevron.setAttribute("aria-hidden", "true");
    expand.append(chevron, icon, caption);
    const app = makeSwitch("允许自动操作 " + group.name, (checked) => markBlocked("blockedApps", group.id, !checked));
    controls.set(group.id, app);
    heading.append(expand, app.label);
    row.append(heading);

    const windows = element("ul", "window-list");
    windows.id = "windows-" + group.id;
    expand.setAttribute("aria-controls", windows.id);
    windows.hidden = group.windows.length < 2;
    expand.setAttribute("aria-expanded", String(!windows.hidden));
    expand.addEventListener("click", () => {
      windows.hidden = !windows.hidden;
      expand.setAttribute("aria-expanded", String(!windows.hidden));
    });
    for (const window of group.windows) {
      const item = element("li", "window-row");
      const name = element("span", "window-name", window.title);
      const inherited = element("small", "window-inherited", "应用已禁止");
      inherited.hidden = true;
      name.append(inherited);
      const control = makeSwitch("允许自动操作 " + window.title, (checked) => markBlocked("blockedWindows", window.id, !checked));
      controls.set(window.id, { ...control, inherited });
      item.append(name, control.label);
      windows.append(item);
      const option = element("option", "", group.name + " · " + window.title);
      option.value = window.id;
      options.append(option);
    }
    row.append(windows);
    list.append(row);
  }
  if (!groups.length) list.append(element("p", "empty-list", "当前工作区还没有登记可设置的应用。"));
}

function renderSites() {
  const siteList = get("site-list");
  siteList.replaceChildren();
  for (const origin of draft.browser.origins) {
    const entry = element("li");
    const remove = element("button", "button secondary", "移除");
    remove.type = "button";
    remove.disabled = saving;
    remove.setAttribute("aria-label", "移除 " + origin);
    remove.addEventListener("click", () => {
      draft.browser.origins = draft.browser.origins.filter((current) => current !== origin);
      renderPreferences();
      get("site-address").focus();
    });
    entry.append(element("span", "", origin), remove);
    siteList.append(entry);
  }
}

function renderBrowserChecks(checks) {
  const target = get("site-check-target");
  target.replaceChildren();
  for (const check of checks ?? []) {
    const option = element("option", "", check.name);
    option.value = check.id;
    target.append(option);
  }
  get("browser-test").hidden = !target.options.length;
}

function renderPreferences(message, failed = false) {
  const blockedApps = new Set(draft.blockedApps);
  const blockedWindows = new Set(draft.blockedWindows);
  let allowedCount = 0;
  let windowCount = 0;
  for (const group of groups) {
    const appAllowed = !blockedApps.has(group.id);
    const app = controls.get(group.id);
    app.input.checked = appAllowed;
    app.input.disabled = saving;
    app.labelState.textContent = appAllowed ? "允许" : "禁止";
    for (const window of group.windows) {
      const enabled = appAllowed && !blockedWindows.has(window.id);
      const control = controls.get(window.id);
      control.input.checked = enabled;
      control.input.disabled = !appAllowed || saving;
      control.labelState.textContent = enabled ? "允许" : "禁止";
      control.inherited.hidden = appAllowed;
      windowCount += 1;
      allowedCount += Number(enabled);
    }
  }
  get("window-count").textContent = "允许 " + allowedCount + " / " + windowCount + " 个窗口";
  document.querySelectorAll('input[name="browser-mode"]').forEach((radio) => {
    radio.checked = radio.value === draft.browser.mode;
    radio.disabled = saving;
  });
  const siteMode = draft.browser.mode === "sites";
  get("site-settings").hidden = !siteMode;
  get("site-address").disabled = saving;
  get("site-form").querySelector("button").disabled = saving;
  if (siteMode) renderSites();
  const dirty = hasChanges();
  const missingSite = siteMode && draft.browser.origins.length === 0;
  get("save-bar").classList.toggle("has-changes", dirty);
  get("site-status").textContent = missingSite ? "请至少添加一个站点。" : "列表内站点的各个页面可访问。";
  get("site-status").classList.toggle("error-state", missingSite);
  get("save").disabled = saving || !dirty || missingSite;
  get("reset").disabled = saving || !dirty;
  get("check-button").disabled = saving || !windowCount || dirty;
  get("check-target").disabled = saving || !windowCount;
  get("site-check-button").disabled = saving || probingSite || dirty;
  get("site-check-target").disabled = saving || probingSite;
  if (dirty) {
    get("check-result").hidden = true;
    get("site-check-result").hidden = true;
  }
  const status = get("save-status");
  status.textContent = message ?? (dirty ? "有未保存的更改" : "设置已保存");
  status.classList.toggle("error-state", failed);
}

async function loadSettings() {
  const status = get("load-status");
  status.textContent = "正在读取本机设置…";
  status.classList.remove("error-state");
  get("retry").hidden = true;
  try {
    const payload = await request("/api/settings");
    groups = payload.groups;
    saved = payload.preferences;
    draft = structuredClone(saved);
    renderGroups();
    renderBrowserChecks(payload.browserChecks);
    renderPreferences();
    status.hidden = true;
    get("settings").hidden = false;
  } catch (error) {
    status.textContent = error.message || "无法读取本机设置。";
    status.classList.add("error-state");
    get("retry").hidden = false;
  }
}

document.querySelectorAll('input[name="browser-mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    draft.browser.mode = radio.value;
    renderPreferences();
  });
});
get("site-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = get("site-address");
  const feedback = get("site-status");
  try {
    const parsed = new URL(input.value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("请输入 HTTP 或 HTTPS 站点地址。");
    if (draft.browser.origins.includes(parsed.origin)) throw new Error("该站点已在列表中。");
    draft.browser.origins.push(parsed.origin);
    input.value = "";
    renderPreferences();
  } catch (error) {
    feedback.textContent = error.message || "请输入有效的站点地址。";
    feedback.classList.add("error-state");
  }
});

get("save").addEventListener("click", async () => {
  saving = true;
  renderPreferences("正在保存…");
  let message = "设置已保存";
  let failed = false;
  try {
    const result = await request("/api/settings", "PUT", draft);
    saved = result.preferences;
    draft = structuredClone(saved);
    get("check-result").hidden = true;
    get("site-check-result").hidden = true;
  } catch (error) {
    message = error.message || "保存失败，请重试。";
    failed = true;
  } finally {
    saving = false;
    renderPreferences(message, failed);
  }
});

get("site-check-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving || probingSite || hasChanges()) return;
  const target = get("site-check-target");
  const checkedPreferences = keyFor(saved);
  const label = target.selectedOptions[0]?.textContent ?? "";
  const result = get("site-check-result");
  probingSite = true;
  get("site-check-button").disabled = true;
  get("site-check-target").disabled = true;
  result.hidden = false;
  result.dataset.state = "";
  result.textContent = "正在试访问…";
  try {
    const response = await request("/api/check-site", "POST", { id: target.value });
    const reasons = {
      browser_site_not_granted: "当前设置未允许这个站点",
      application_automation_blocked: "网页调研窗口已禁止自动操作",
      browser_probe_failed: "浏览器未能完成访问验证",
      browser_probe_unavailable: "当前预览没有启用浏览器验证",
    };
    if (hasChanges() || keyFor(saved) !== checkedPreferences) return;
    result.dataset.state = response.allowed ? "allowed" : "blocked";
    result.textContent = label + " · " + (response.allowed ? "通过访问验证" : reasons[response.code] ?? "访问验证未通过");
  } catch (error) {
    if (hasChanges() || keyFor(saved) !== checkedPreferences) return;
    result.dataset.state = "blocked";
    result.textContent = error.message || "验证失败，请重试。";
  } finally {
    probingSite = false;
    get("site-check-button").disabled = saving || hasChanges();
    get("site-check-target").disabled = saving;
  }
});
get("reset").addEventListener("click", () => {
  draft = structuredClone(saved);
  renderPreferences("已恢复已保存的设置");
  get("applications").focus({ preventScroll: true });
});

get("check-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving || hasChanges()) return;
  const target = get("check-target");
  const button = get("check-button");
  const result = get("check-result");
  const label = target.selectedOptions[0]?.textContent ?? "";
  const checkedPreferences = keyFor(saved);
  button.disabled = true;
  result.hidden = false;
  result.dataset.state = "";
  result.textContent = "正在检查…";
  try {
    const response = await request("/api/check", "POST", { id: target.value });
    if (hasChanges() || keyFor(saved) !== checkedPreferences) return;
    result.dataset.state = response.allowed ? "allowed" : "blocked";
    result.textContent = label + (response.allowed ? " · 允许自动接入" : " · 已阻止自动接入");
  } catch (error) {
    if (hasChanges() || keyFor(saved) !== checkedPreferences) return;
    result.dataset.state = "blocked";
    result.textContent = error.message || "验证失败，请重试。";
  } finally {
    button.disabled = saving || hasChanges();
  }
});

document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".nav-link").forEach((item) => {
      item.classList.toggle("current", item === link);
      if (item === link) item.setAttribute("aria-current", "location");
      else item.removeAttribute("aria-current");
    });
  });
});
get("retry").addEventListener("click", loadSettings);
void loadSettings();
