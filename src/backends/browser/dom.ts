import type { Control, Effect, State } from "../../contracts.js";
import type { BrowserPageLike, InternalControl, RawControl } from "./types.js";

export const SEARCH_NAMES = new Set(["search", "find", "filter", "query", "\u641c\u7d22", "\u67e5\u8be2", "\u7b5b\u9009"]);

export const MODIFIER_KEYS = new Map([
  ["ctrl", "Control"], ["control", "Control"], ["cmd", "Meta"], ["command", "Meta"],
  ["meta", "Meta"], ["alt", "Alt"], ["option", "Alt"], ["shift", "Shift"],
]);

export const SAFE_KEYS = new Set([
  "Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Space",
]);

const EFFECT_WORDS: Array<[Effect, RegExp]> = [
  ["financial", /\b(pay|payment|checkout|purchase|buy|refund|donat|billing|card)\b|\u652f\u4ed8|\u4ed8\u6b3e|\u8d2d\u4e70|\u9000\u6b3e|\u94f6\u884c|\u4fe1\u7528\u5361/i],
  ["destructive", /\b(delete|remove|destroy|discard|reset|cancel|erase)\b|\u5220\u9664|\u79fb\u9664|\u4e22\u5f03|\u91cd\u7f6e|\u53d6\u6d88/i],
  ["security", /\b(permission|authorize|authorise|grant|revoke|password|sign[ -]?in|log[ -]?in|logout|sign[ -]?out)\b|\u6743\u9650|\u6388\u6743|\u5bc6\u7801|\u767b\u5f55|\u9000\u51fa/i],
  ["external", /\b(send|submit|publish|post|share|invite|export|confirm|place order)\b|\u53d1\u9001|\u63d0\u4ea4|\u53d1\u5e03|\u5206\u4eab|\u9080\u8bf7|\u5bfc\u51fa|\u786e\u8ba4/i],
];

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function clippedText(value: unknown): string | undefined {
  const normalized = normalizeText(value);
  return normalized ? normalized.slice(0, 256) : undefined;
}

export function normalizedName(value: unknown): string {
  return normalizeText(value).normalize("NFKC").toLocaleLowerCase();
}

export function isSearchName(value: string | undefined): boolean {
  return value !== undefined && SEARCH_NAMES.has(normalizedName(value));
}

export function isPoint(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false;
  const point = value as { x: number; y: number };
  return Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0;
}

export function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value as number)));
}

export function stableHash(input: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function selectorFor(raw: Pick<RawControl, "path" | "key" | "tagName" | "stableKind">): string {
  if (raw.stableKind === "id" && raw.key.startsWith("id:")) return `#${cssEscape(raw.key.slice(3))}`;
  if (raw.stableKind === "testid" && raw.key.startsWith("testid:")) {
    const value = cssAttributeEscape(raw.key.slice(7));
    return `[data-testid="${value}"],[data-test="${value}"]`;
  }
  if (raw.stableKind === "name" && raw.key.startsWith("name:")) {
    const value = raw.key.slice(5, raw.key.lastIndexOf(":"));
    return `${raw.tagName}[name="${cssAttributeEscape(value)}"]`;
  }
  return raw.path || raw.tagName;
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character.codePointAt(0)?.toString(16)} `);
}

function cssAttributeEscape(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\A ");
}

export function classifyEffect(raw: Pick<RawControl, "role" | "name" | "tagName" | "href" | "sensitive" | "disclosure"> & {
  filterAction: boolean;
  formSubmitter?: boolean;
  sameDocumentTab?: boolean;
}): Effect {
  if (raw.sensitive) return "sensitive";
  const name = raw.name ?? "";
  for (const [effect, expression] of EFFECT_WORDS) if (expression.test(name)) return effect;
  // Consequential evidence must win over attributes that can look like a
  // disclosure or a tab. A native submitter is consequential even when its
  // accessible name is opaque or absent.
  // A scoped search/filter is the one benign exception for a native submitter:
  // the structural input association is stronger evidence than a generic
  // label, while a generic submitter still remains consequential.
  if (raw.formSubmitter && !raw.filterAction) return "external";
  if (raw.filterAction) return "read";
  if (raw.sameDocumentTab) return "read";
  if (raw.role === "img") return "read";
  if (raw.disclosure) return "read";
  if (raw.href || raw.role === "link") return "navigate";
  if (["textbox", "searchbox", "combobox"].includes(raw.role)) return "edit";
  if (raw.tagName === "button" || raw.role === "button") return "unknown";
  return "read";
}

export function toControl(raw: RawControl, id: string, stableKey: string): InternalControl {
  return {
    id,
    role: raw.role,
    ...(raw.name ? { name: raw.name } : {}),
    ...(raw.within ? { within: raw.within } : {}),
    states: raw.states,
    actions: raw.actions,
    ...(raw.rect ? { rect: raw.rect } : {}),
    ...(raw.value !== undefined ? { value: raw.value } : {}),
    sensitive: raw.sensitive,
    ...(raw.labels.length ? { labels: raw.labels } : {}),
    effect: classifyEffect({ ...raw, filterAction: raw.filterAction }),
    filterAction: raw.filterAction,
    ...(raw.disclosure ? { disclosure: true } : {}),
    ...(raw.sameDocumentTab ? { sameDocumentTab: true } : {}),
    ...(raw.enterMaySubmit ? { enterMaySubmit: true } : {}),
    ...(raw.approvalContext ? { approvalContext: raw.approvalContext } : {}),
    __path: raw.path,
    __key: raw.key,
    __stableKey: stableKey,
    __tagName: raw.tagName,
    ...(raw.type ? { __type: raw.type } : {}),
    __disabled: raw.disabled,
  };
}

export function publicControl(control: InternalControl): Control {
  const { __path: _path, __key: _key, __stableKey: _stableKey, __tagName: _tagName, __type: _type, __disabled: _disabled, ...publicValue } = control;
  return publicValue;
}

/** Self-contained page function used at the final dispatch boundary. */
export async function readApprovalContext(element: unknown, _ignored?: unknown): Promise<{ token: string; summary: string } | undefined> {
  const target = element as HTMLElement & { form?: HTMLFormElement | null };
  const attr = (name: string) => target.getAttribute(name) || "";
  const nativeForm = target instanceof HTMLButtonElement || target instanceof HTMLInputElement ? target.form : undefined;
  const form = nativeForm || target.closest("form");
  if (!form) return undefined;
  const nativeType = target instanceof HTMLButtonElement || target instanceof HTMLInputElement ? target.type.toLocaleLowerCase() : attr("type").toLocaleLowerCase();
  const formSubmitter = Boolean(
    nativeForm && (
      (target instanceof HTMLButtonElement && nativeType === "submit") ||
      (target instanceof HTMLInputElement && (nativeType === "submit" || nativeType === "image"))
    ),
  );
  const materialName = `${attr("aria-label")} ${target.textContent || ""} ${attr("type")}`;
  const material = Boolean(formSubmitter || /\b(send|submit|publish|post|share|invite|confirm|overwrite|replace|delete|remove|pay|checkout)\b|\u53d1\u9001|\u63d0\u4ea4|\u53d1\u5e03|\u5206\u4eab|\u9080\u8bf7|\u786e\u8ba4|\u8986\u76d6|\u66ff\u6362|\u5220\u9664|\u652f\u4ed8/iu.test(materialName));
  if (!material) return undefined;
  const destination = attr("formaction") || form.getAttribute("action") || document.URL;
  let endpoint: URL | undefined;
  try { endpoint = new URL(destination, document.baseURI); } catch { /* opaque base without a resolved action */ }
  const recipients = new Set<string>();
  const materialArray: unknown[] = [
    ["form", endpoint?.href ?? [document.baseURI, destination], form.method, form.target, form.enctype],
    ["submitter", attr("formaction"), attr("formmethod"), attr("formenctype"), attr("formtarget"), attr("name"), attr("type"), nativeType, attr("value")],
  ];
  for (const field of Array.from(form.elements)) {
    const input = field as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const selected = input instanceof HTMLSelectElement && input.multiple
      ? Array.from(input.selectedOptions).map((option) => [option.value, option.selected])
      : [];
    const attachments = input instanceof HTMLInputElement && input.type === "file"
      ? Array.from(input.files ?? [], file => [file.name, file.size, file.lastModified]) : [];
    materialArray.push(["field", field.tagName, field.getAttribute("name") || "", field.getAttribute("type") || "", field.getAttribute("id") || "", "value" in input ? String(input.value) : "", "checked" in input ? Boolean(input.checked) : false, field.matches(":disabled"), selected, attachments]);
    if (input instanceof HTMLInputElement && !input.matches(":disabled") && (input.type === "email" ||
      /^(?:to|recipient|recipient_email|收件人)$/iu.test(input.name))) {
      const address = /^([^\s@,;]{1,64})@([a-z\d.-]{1,190})$/iu.exec(input.value.trim());
      if (address && recipients.size < 3) recipients.add(`${address[1][0]}…@${address[2]}`);
    }
  }
  // This description is for the host's approval UI. Only the origin and masked, typed recipients leave the page.
  const summary = [endpoint && (endpoint.protocol === "http:" || endpoint.protocol === "https:") ? endpoint.origin : undefined,
    recipients.size ? `Recipient ${[...recipients].join(", ")}` : undefined, `Form fields ${form.elements.length}`].filter(Boolean).join(" · ");
  const source = JSON.stringify(materialArray);
  try {
    if (globalThis.crypto?.subtle && typeof TextEncoder !== "undefined") {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
      const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
      return { token: `sha256-${hex}`, summary };
    }
  } catch {
    // A missing/failing digest is deliberately an unbound material action;
    // never return the canonical material or a weak value-derived token.
  }
  try {
    // Chromium's opaque about:blank/data contexts may not expose subtle.
    // Keep the fallback inside the page and return only a SHA-256 digest.
    if (typeof TextEncoder !== "undefined") {
      const bytes = Array.from(new Uint8Array(new TextEncoder().encode(source)));
      const bitLength = bytes.length * 8;
      bytes.push(128);
      while ((bytes.length + 8) % 64 !== 0) bytes.push(0);
      for (let shift = 56; shift >= 0; shift -= 8) bytes.push((bitLength / 2 ** shift) & 255);
      const words = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
      const constants = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
      ];
      const rotr = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));
      for (let offset = 0; offset < bytes.length; offset += 64) {
        const schedule = new Array<number>(64).fill(0);
        for (let index = 0; index < 16; index += 1) {
          const position = offset + index * 4;
          schedule[index] = ((bytes[position] << 24) | (bytes[position + 1] << 16) | (bytes[position + 2] << 8) | bytes[position + 3]) >>> 0;
        }
        for (let index = 16; index < 64; index += 1) {
          const s0 = rotr(schedule[index - 15], 7) ^ rotr(schedule[index - 15], 18) ^ (schedule[index - 15] >>> 3);
          const s1 = rotr(schedule[index - 2], 17) ^ rotr(schedule[index - 2], 19) ^ (schedule[index - 2] >>> 10);
          schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = words;
        for (let index = 0; index < 64; index += 1) {
          const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
          const ch = (e & f) ^ (~e & g);
          const temp1 = (h + S1 + ch + constants[index] + schedule[index]) >>> 0;
          const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
          const maj = (a & b) ^ (a & c) ^ (b & c);
          const temp2 = (S0 + maj) >>> 0;
          [h, g, f, e, d, c, b, a] = [g, f, e, (d + temp1) >>> 0, c, b, a, (temp1 + temp2) >>> 0];
        }
        words[0] = (words[0] + a) >>> 0; words[1] = (words[1] + b) >>> 0; words[2] = (words[2] + c) >>> 0; words[3] = (words[3] + d) >>> 0;
        words[4] = (words[4] + e) >>> 0; words[5] = (words[5] + f) >>> 0; words[6] = (words[6] + g) >>> 0; words[7] = (words[7] + h) >>> 0;
      }
      return { token: `sha256-${words.map((word) => word.toString(16).padStart(8, "0")).join("")}`, summary };
    }
  } catch {
    // No digest means no approval binding; the host can require fresh review.
  }
  return undefined;
}

/** This function is serialized by Playwright and runs only in the authorized page. */
export function createRawCollectionScript() {
  return ({ rootSelector, includePublicValues, protectedFieldNames, target }: {
    rootSelector?: string;
    includePublicValues: boolean;
    protectedFieldNames: string[];
    target?: { role?: string; name?: string; within?: string; state?: string; filterActionOnly?: boolean; maxResults: number; scanLimit: number };
  }) => {
    const root = rootSelector ? document.querySelector(rootSelector) : document.body ?? document.documentElement;
    if (!root) return { controls: [], total: 0 };
    let scanComplete = true;
    let nodes: Iterable<HTMLElement>;
    if (target) {
      const scanLimit = Math.max(1, Math.floor(target.scanLimit));
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      const examined: HTMLElement[] = [];
      for (let element = walker.nextNode(); element; element = walker.nextNode()) {
        if (examined.length === scanLimit) { scanComplete = false; break; }
        examined.push(element as HTMLElement);
      }
      nodes = examined;
    } else {
      nodes = root.querySelectorAll<HTMLElement>("*");
    }
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/gu, " ").trim().normalize("NFKC").toLocaleLowerCase();
    const canonicalRole = (value: unknown): string => {
      const role = normalize(value);
      return role === "edit" || role === "input" || role === "textfield" ? "textbox" : role;
    };
    const wantedRole = target?.role === undefined ? undefined : canonicalRole(target.role);
    const wantedName = target?.name === undefined ? undefined : normalize(target.name);
    const interactiveRoles = new Set(["button", "checkbox", "combobox", "link", "listbox", "menuitem", "option", "radio", "searchbox", "slider", "switch", "tab", "textbox"]);
    const interactiveTags = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
    const protectedPattern = /(?:password|passcode|passwd|secret|token|api[ _-]?key|authorization|credential|cvv|cvc|otp|pin|ssn|credit[ _-]?card|private[ _-]?key|\u5bc6\u7801|\u4ee4\u724c|\u79d8\u94a5|\u51ed\u8bc1|\u9a8c\u8bc1\u7801|\u8eab\u4efd\u8bc1|\u5361\u53f7)/iu;
    const searchNames = new Set(["search", "find", "filter", "query", "\u641c\u7d22", "\u67e5\u8be2", "\u7b5b\u9009"]);
    const protectedExtras = protectedFieldNames.map((value) => String(value).toLocaleLowerCase());
    const text = (value: unknown) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, 256);
    const attr = (element: HTMLElement, name: string) => element.getAttribute(name) || undefined;
    const pathFor = (element: Element): string => {
      const parts: string[] = [];
      let current: Element | null = element;
      // Include the document ancestry in fallback selectors. A path relative
      // only to the observation root makes body-level and nested siblings
      // collide (for example, both can be `button:nth-child(1)`).
      while (current && current.parentElement) {
        const ancestor: Element = current.parentElement;
        const siblings = Array.from(ancestor.children);
        parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${Math.max(1, siblings.indexOf(current) + 1)})`);
        current = ancestor;
      }
      return parts.join(">");
    };
    const roleFor = (element: HTMLElement): string | undefined => {
      const explicit = attr(element, "role")?.toLocaleLowerCase();
      if (explicit) return explicit;
      const tag = element.tagName.toLocaleLowerCase();
      if (tag === "canvas" || tag === "img" || tag === "svg") return "img";
      if (tag === "button" || tag === "summary") return "button";
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return (element as HTMLSelectElement).multiple ? "listbox" : "combobox";
      if (tag === "input") {
        const type = (attr(element, "type") || "text").toLocaleLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "search") return "searchbox";
        return "textbox";
      }
      return undefined;
    };
    const visible = (element: HTMLElement, style: CSSStyleDeclaration): boolean => {
      const rect = element.getBoundingClientRect();
      return Boolean(rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && Number(style.opacity) !== 0 && !element.hidden);
    };
    const enabled = (element: HTMLElement): boolean => !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true";
    const editable = (element: HTMLElement, role: string): boolean => {
      if (element.isContentEditable) return true;
      if (!(role === "textbox" || role === "searchbox" || role === "combobox" || role === "listbox")) return false;
      if (element instanceof HTMLInputElement) return !["button", "submit", "reset", "checkbox", "radio", "range", "file", "hidden"].includes(element.type) && !element.readOnly;
      return !element.hasAttribute("readonly") && !element.hasAttribute("aria-readonly");
    };
    const labelsFor = (element: HTMLElement): string[] => {
      const values: string[] = [];
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
        for (const label of Array.from(element.labels ?? [])) { const value = text(label.textContent); if (value) values.push(value); }
      }
      const parentLabel = element.closest("label");
      if (parentLabel) { const value = text(parentLabel.textContent); if (value) values.push(value); }
      return Array.from(new Set(values));
    };
    const nameFor = (element: HTMLElement, labels: string[]): string | undefined => {
      const aria = attr(element, "aria-label");
      if (aria) return text(aria);
      const labelledBy = attr(element, "aria-labelledby");
      if (labelledBy) { const value = labelledBy.split(/\s+/u).map((id) => document.getElementById(id)?.textContent || "").join(" "); if (text(value)) return text(value); }
      if (labels.length) return labels.join(" ");
      if (element instanceof HTMLImageElement && element.alt) return text(element.alt);
      const title = attr(element, "title");
      if (title) return text(title);
      if (element instanceof HTMLInputElement) {
        const inputType = element.type.toLocaleLowerCase();
        if (["button", "submit", "reset"].includes(inputType)) return text(element.value) || undefined;
        if (inputType === "image") return text(element.alt) || undefined;
      }
      const placeholder = attr(element, "placeholder");
      if (placeholder) return text(placeholder);
      const tag = element.tagName.toLocaleLowerCase();
      if (["button", "a", "summary"].includes(tag) || element.getAttribute("role") === "button") return text(element.textContent) || undefined;
      return undefined;
    };
    const isProtected = (element: HTMLElement, name: string | undefined, labels: string[]): boolean => {
      if (attr(element, "type")?.toLocaleLowerCase() === "password") return true;
      const fields = [attr(element, "name"), attr(element, "id"), attr(element, "autocomplete"), attr(element, "aria-label"), name, ...labels].filter(Boolean).join(" ").toLocaleLowerCase();
      return protectedPattern.test(fields) || protectedExtras.some((value) => value && fields.includes(value));
    };
    const plainGetSearchStructure = (form: HTMLFormElement, submitter: HTMLElement): boolean => {
      const method = (form.getAttribute("method") || "get").toLocaleLowerCase();
      if (method !== "get" || submitter.hasAttribute("formmethod") || submitter.hasAttribute("formtarget")) return false;
      const submitterType = attr(submitter, "type")?.toLocaleLowerCase() || "";
      if (submitterType === "image" || submitter.hasAttribute("dirname")) return false;
      if (submitter.hasAttribute("name")) return false;
      const target = (form.getAttribute("target") || document.querySelector("base")?.getAttribute("target") || "").toLocaleLowerCase();
      if (target && target !== "_self") return false;
      try {
        const destination = new URL(attr(submitter, "formaction") || attr(form, "action") || document.URL, document.baseURI);
        const current = new URL(document.URL);
        if (destination.origin !== current.origin || destination.protocol !== current.protocol || destination.host !== current.host || destination.pathname !== current.pathname) return false;
      } catch {
        return false;
      }
      const fields = Array.from(form.elements).filter((field): field is HTMLElement => field instanceof HTMLElement);
      if (fields.some((field) => field.hasAttribute("dirname"))) return false;
      const successful = fields.filter((field) => {
        if (field === submitter || !attr(field, "name") || field.hasAttribute("disabled")) return false;
        const type = attr(field, "type")?.toLocaleLowerCase() || "";
        if (["submit", "image", "button", "reset"].includes(type)) return false;
        if (["checkbox", "radio"].includes(type) && !(field as HTMLInputElement).checked) return false;
        return true;
      });
      const queryNames = new Set(["q", "query", "search", "term", "keyword", "keywords", "search_query", "searchterm"]);
      const queryFields = successful.filter((field) => {
        const type = attr(field, "type")?.toLocaleLowerCase() || "text";
        if (!(field instanceof HTMLInputElement) || !["text", "search"].includes(type)) return false;
        const labels = labelsFor(field);
        const accessible = nameFor(field, labels);
        const explicitAccessible = attr(field, "aria-label") || (attr(field, "aria-labelledby")?.split(/\s+/u).map((id) => document.getElementById(id)?.textContent || "").join(" ")) || labels.join(" ");
        const named = text(attr(field, "name")).normalize("NFKC").toLocaleLowerCase();
        const accessibleName = text(explicitAccessible).normalize("NFKC").toLocaleLowerCase();
        return !isProtected(field, accessible, labels) && queryNames.has(named) && /\b(search|query|keyword|term)\b|\u641c\u7d22|\u67e5\u8be2/iu.test(accessibleName);
      });
      return successful.length === 1 && queryFields.length === 1;
    };
    const nearestWithin = (element: HTMLElement): { name?: string; keys: string[] } => {
      let current: HTMLElement | null = element.parentElement;
      while (current && current !== root) {
        const role = attr(current, "role")?.toLocaleLowerCase();
        const tag = current.tagName.toLocaleLowerCase();
        const id = attr(current, "id");
        const testid = attr(current, "data-testid") || attr(current, "data-test");
        if (id || testid || role === "dialog" || role === "region" || role === "main" || role === "form" || tag === "form" || tag === "fieldset") {
          const name = attr(current, "aria-label") || attr(current, "title") || text(current.querySelector("legend")?.textContent) || undefined;
          return { name: text(name || id || testid || role || tag) || undefined, keys: [id, testid, role, tag].filter(Boolean) as string[] };
        }
        current = current.parentElement;
      }
      return { keys: [] };
    };
    const controls: any[] = [];
    const graphics: any[] = [];
    for (const element of nodes) {
      const role = roleFor(element);
      const graphic = role === "img";
      if (!role || (!graphic && !interactiveTags.has(element.tagName) && !interactiveRoles.has(role))) continue;
      if (wantedRole !== undefined && canonicalRole(role) !== wantedRole) continue;
      const labels = labelsFor(element);
      const name = nameFor(element, labels);
      if (wantedName !== undefined && ![name, ...labels].some(value => normalize(value) === wantedName)) continue;
      const style = getComputedStyle(element);
      if (graphic && (!name || !visible(element, style) || element.closest('[aria-hidden="true"],button,a,[role="button"],[role="link"]'))) continue;
      const sensitive = isProtected(element, name, labels);
      const canonicalName = name?.normalize("NFKC").toLocaleLowerCase();
      const nativeForm = element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element.form : null;
      const form = nativeForm || element.closest("form");
      const formSubmitter = Boolean(
        nativeForm && (
          (element instanceof HTMLButtonElement && element.type.toLocaleLowerCase() === "submit") ||
          (element instanceof HTMLInputElement && ["submit", "image"].includes(element.type.toLocaleLowerCase()))
        ),
      );
      const searchScope = form || element.parentElement;
      const genericSearchStructure = searchScope?.querySelector("input:not([type='hidden']),textarea,select,[contenteditable='true'],[role='textbox'],[role='searchbox'],[role='combobox']");
      const nativeSearchStructure = searchScope?.querySelector("input[type='search'],[role='searchbox']") ||
        (form?.getAttribute("role")?.toLocaleLowerCase() === "search" ? genericSearchStructure : null);
      let boundedNativeSearch = false;
      if (formSubmitter && nativeForm && (attr(element, "formmethod") || attr(nativeForm, "method") || "get").toLocaleLowerCase() === "get") {
        const targetName = (attr(element, "formtarget") || attr(nativeForm, "target") || document.querySelector("base")?.getAttribute("target") || "").toLocaleLowerCase();
        if (!targetName || targetName === "_self") {
          try {
            const destination = new URL(attr(element, "formaction") || attr(nativeForm, "action") || document.URL, document.baseURI);
            const current = new URL(document.URL);
            boundedNativeSearch = destination.origin === current.origin && destination.protocol === current.protocol && destination.host === current.host;
          } catch {
            boundedNativeSearch = false;
          }
        }
      }
      const plainSelfSearch = Boolean(formSubmitter && nativeForm && boundedNativeSearch && plainGetSearchStructure(nativeForm, element));
      const filterAction = Boolean(
        searchScope && ["button", "link"].includes(role) && canonicalName && searchNames.has(canonicalName) &&
        (formSubmitter ? Boolean((boundedNativeSearch && nativeSearchStructure) || plainSelfSearch) : Boolean(genericSearchStructure)),
      );
      const singleLineInput = element instanceof HTMLInputElement && ["text", "search", "email", "url", "tel", "password", "number"].includes(element.type.toLocaleLowerCase()) && !element.disabled && !element.readOnly;
      const enterMaySubmit = Boolean(singleLineInput && nativeForm);
      const expanded = attr(element, "aria-expanded");
      const controlledIds = attr(element, "aria-controls")?.split(/\s+/u).filter(Boolean) ?? [];
      const controlledRegions = controlledIds.map((id) => document.getElementById(id));
      const tabList = element.closest('[role="tablist"]');
      const controlledRegion = controlledIds.length === 1 && controlledRegions.length === 1 ? controlledRegions[0] : undefined;
      const sameDocumentLink = (element: HTMLElement): boolean => {
        const href = attr(element, "href");
        if (!href) return true;
        if (element.hasAttribute("download")) return false;
        const targetName = attr(element, "target")?.toLocaleLowerCase();
        if (targetName && !["_self", "_top", "_parent"].includes(targetName)) return false;
        try {
          const destination = new URL(href, document.baseURI);
          const current = new URL(document.URL);
          return destination.protocol === current.protocol && destination.host === current.host && destination.pathname === current.pathname && destination.search === current.search && Boolean(destination.hash);
        } catch {
          return false;
        }
      };
      const sameDocumentTab = Boolean(
        role === "tab" &&
        tabList &&
        root.contains(tabList) &&
        controlledRegion &&
        root.contains(controlledRegion) &&
        controlledRegion.getAttribute("role")?.toLocaleLowerCase() === "tabpanel" &&
        !formSubmitter &&
        sameDocumentLink(element),
      );
      const disclosure = Boolean(
        (element.tagName.toLocaleLowerCase() === "summary" && element.closest("details")) ||
        (expanded && (expanded === "true" || expanded === "false") && controlledIds.length > 0 && controlledRegions.length === controlledIds.length && controlledRegions.every(Boolean)),
      );
      const materialName = `${name || ""} ${attr(element, "type") || ""} ${text(element.textContent)}`;
      const approvalCandidate = Boolean(form && (formSubmitter || /\b(send|submit|publish|post|share|invite|confirm|overwrite|replace|delete|remove|pay|checkout)\b|\u53d1\u9001|\u63d0\u4ea4|\u53d1\u5e03|\u5206\u4eab|\u9080\u8bf7|\u786e\u8ba4|\u8986\u76d6|\u66ff\u6362|\u5220\u9664|\u652f\u4ed8/iu.test(materialName)));
      const within = nearestWithin(element);
      const states: string[] = [];
      if (visible(element, style)) states.push("visible");
      if (enabled(element)) states.push("enabled");
      if (editable(element, role)) states.push("editable");
      if (document.activeElement === element) states.push("focused");
      if ((element as HTMLInputElement).checked || element.getAttribute("aria-checked") === "true") states.push("checked");
      if (element.getAttribute("aria-selected") === "true" || element.hasAttribute("selected")) states.push("selected");
      if (expanded === "true") states.push("expanded");
      const actions: string[] = [];
      if (!graphic && (["button", "checkbox", "link", "menuitem", "option", "radio", "switch", "tab"].includes(role) || ["A", "BUTTON", "SUMMARY"].includes(element.tagName))) actions.push("click");
      if (!graphic && editable(element, role)) actions.push("type", "setValue");
      if (!graphic && states.includes("enabled")) actions.push("keypress", "hotkey");
      if (!graphic && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)) actions.push("scroll");
      const rect = element.getBoundingClientRect();
      const id = attr(element, "id");
      const testid = attr(element, "data-testid") || attr(element, "data-test");
      const elementName = attr(element, "name");
      const stableKind = id ? "id" : testid ? "testid" : elementName ? "name" : "path";
      const path = pathFor(element);
      const baseKey = id ? `id:${id}` : testid ? `testid:${testid}` : elementName ? `name:${elementName}:${role}` : `path:${path}`;
      (graphic ? graphics : controls).push({
        path, key: baseKey, role, name, labels, within: within.name, withinKeys: within.keys,
        states, actions, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        value: graphic || sensitive || !includePublicValues ? undefined : (element as HTMLInputElement).value,
        sensitive, href: attr(element, "href"), filterAction, disclosure, formSubmitter, sameDocumentTab, enterMaySubmit, approvalCandidate, tagName: element.tagName.toLocaleLowerCase(), type: attr(element, "type"),
        disabled: !enabled(element), stableKind,
      });
    }
    // Read-only visual landmarks follow actionable controls in the bounded public list.
    const allControls = controls.concat(graphics);
    if (!target) return { controls: allControls, total: allControls.length, scanComplete: true };
    const wantedWithin = target.within === undefined ? undefined : normalize(target.within);
    const matched = allControls.filter((control) => {
      if (!control.states.includes("visible")) return false;
      if (target.filterActionOnly && !control.filterAction) return false;
      if (target.state !== undefined && !control.states.includes(target.state)) return false;
      if (wantedWithin !== undefined && ![control.within, ...control.withinKeys].some(value => normalize(value) === wantedWithin)
        && !normalize(control.key).includes(wantedWithin)) return false;
      return true;
    });
    const maxResults = Math.max(1, Math.floor(target.maxResults));
    return {
      controls: matched.slice(0, maxResults),
      total: matched.length,
      scanComplete,
    };
  };
}

/**
 * This function is serialized by Playwright and runs only in the authorized
 * page. It deliberately reads rendered DOM text rather than source HTML,
 * accessibility labels, control values, or embedded-frame documents.
 */
export function createDocumentTextScript() {
  return ({ rootSelector, expectedHref, maxChars, maxChunks, chunkSize, viewportOnly, query, startChunk, startOffset, startMatch, startMatchOffset }: {
    rootSelector?: string;
    expectedHref?: string;
    maxChars: number;
    maxChunks: number;
    chunkSize: number;
    viewportOnly: boolean;
    query?: string;
    startChunk?: number;
    startOffset?: number;
    startMatch?: number;
    startMatchOffset?: number;
  }) => {
    const documentElement = document.documentElement;
    // The read path is non-mutating. Identity is attested by retaining the
    // original DocumentElement object for the duration of this evaluation;
    // the host's scope generation covers reloads between evaluations.
    const route = () => ({ href: window.location.href, baseURI: document.baseURI, documentToken: documentElement ? "document-element" : "missing" });
    const before = route();
    const empty = { chunks: [], totalChars: 0, totalChunks: 0, truncated: false, fingerprint: "0", attestation: { before, after: before, sameDocument: true }, routeChanged: false };
    if (expectedHref !== undefined && before.href !== expectedHref) return { ...empty, routeChanged: true };
    const root = rootSelector ? document.querySelector<HTMLElement>(rootSelector) : document.body ?? document.documentElement;
    if (!root) return empty;

    const blockTags = new Set([
      "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
      "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
      "TABLE", "TD", "TH", "TR", "UL",
    ]);
    const excludedTags = new Set([
      "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "SUMMARY", "SCRIPT", "STYLE", "NOSCRIPT",
      "TEMPLATE", "IFRAME", "FRAME", "OBJECT", "EMBED", "HEAD", "TITLE", "META", "LINK", "BASE",
    ]);
    const interactiveRoles = new Set([
      "button", "checkbox", "combobox", "link", "listbox", "menuitem", "option", "radio", "searchbox", "slider",
      "spinbutton", "switch", "tab", "textbox",
    ]);
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/gu, " ").trim();
    const isBlock = (element: Element): boolean => blockTags.has(element.tagName) || ["article", "main", "region"].includes((element.getAttribute("role") || "").toLocaleLowerCase());
    const inViewport = (element: Element): boolean => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    };
    const renderedGeometry = (element: Element, candidateRect?: DOMRect): boolean => {
      let current: Element | null = element;
      while (current) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0 || style.contentVisibility === "hidden") return false;
        if (style.clipPath !== "none" || style.clip !== "auto" && style.clip !== "none") return false;
        if ((style.overflowX === "hidden" || style.overflowX === "clip" || style.overflowY === "hidden" || style.overflowY === "clip")) {
          const clipRect = (current as HTMLElement).getBoundingClientRect();
          if (candidateRect) {
            const intersects = candidateRect.right > clipRect.left && candidateRect.left < clipRect.right && candidateRect.bottom > clipRect.top && candidateRect.top < clipRect.bottom;
            if (!intersects) return false;
          }
        }
        current = current.parentElement;
      }
      return true;
    };
    const excluded = (element: Element): boolean => {
      let current: Element | null = element;
      while (current) {
        if (excludedTags.has(current.tagName)) return true;
        if (current.getAttribute("aria-hidden")?.toLocaleLowerCase() === "true" || current.hasAttribute("inert")) return true;
        if (current.getAttribute("contenteditable")?.toLocaleLowerCase() === "true" || (current as HTMLElement).isContentEditable) return true;
        if (current instanceof HTMLDetailsElement && !current.open && current !== element) return true;
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0 || style.contentVisibility === "hidden") return true;
        if (style.clipPath !== "none" || style.clip !== "auto" && style.clip !== "none") return true;
        const role = current.getAttribute("role")?.toLocaleLowerCase();
        if (role && interactiveRoles.has(role)) return true;
        current = current.parentElement;
      }
      return false;
    };
    const readable = (element: Element): boolean => {
      if (excluded(element)) return false;
      return renderedGeometry(element);
    };
    const textRendered = (textNode: Text): boolean => {
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
      const owner = textNode.parentElement ?? root;
      return rects.some((rect) => renderedGeometry(owner, rect));
    };
    // Walk text nodes once in DOM order. Each contiguous run is assigned to
    // its nearest block owner, preserving parent text around nested blocks
    // (for example `intro <h2>heading</h2> tail`).
    const ownerFor = (textNode: Text): Element | undefined => {
      let current: Element | null = textNode.parentElement;
      while (current && current !== root.parentElement) {
        if (excluded(current)) return undefined;
        if (isBlock(current)) return readable(current) ? current : undefined;
        current = current.parentElement;
      }
      return readable(root) ? root : undefined;
    };
    const runs: Array<{ owner: Element; parts: string[] }> = [];
    let currentRun: (typeof runs)[number] | undefined;
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = String(node.textContent ?? "").replace(/\s+/gu, " ");
        const value = raw.trim();
        const owner = ownerFor(node as Text);
        if (!owner || !textRendered(node as Text) || (viewportOnly && !inViewport(owner))) {
          currentRun = undefined;
          return;
        }
        // Keep whitespace-only inline text as a separator when it belongs to
        // the current block (for example between two adjacent spans).
        if (!value) {
          if (currentRun?.owner === owner) currentRun.parts.push(raw);
          return;
        }
        if (!currentRun || currentRun.owner !== owner) {
          currentRun = { owner, parts: [] };
          runs.push(currentRun);
        }
        currentRun.parts.push(raw);
        return;
      }
      if (!(node instanceof Element) || excluded(node)) return;
      if (node.tagName === "BR") {
        if (currentRun?.owner.contains(node)) currentRun.parts.push(" ");
        return;
      }
      for (const child of Array.from(node.childNodes)) walk(child);
    };
    walk(root);
    const rendered = runs.map((run) => normalize(run.parts.join(""))).filter((value) => value.length > 0);

    const fingerprintSource = rendered.join("\u0000");
    let fingerprint = 2_166_136_261;
    for (let index = 0; index < fingerprintSource.length; index += 1) {
      fingerprint ^= fingerprintSource.charCodeAt(index);
      fingerprint = Math.imul(fingerprint, 16_777_619);
    }
    const fingerprintText = (fingerprint >>> 0).toString(36);
    const chunks: string[] = [];
    let usedChars = 0;
    let nextChunk: number | undefined;
    let nextOffset: number | undefined;
    if (query !== undefined) {
      const fullText = rendered.join("\n");
      const caseInsensitive = /^[\x00-\x7f]+$/u.test(query);
      const asciiLower = (value: string): string => value.replace(/[A-Z]/g, (character) => character.toLowerCase());
      const haystack = caseInsensitive ? asciiLower(fullText) : fullText;
      const needle = caseInsensitive ? asciiLower(query) : query;
      const context = Math.max(0, Math.floor((chunkSize - query.length) / 2));
      const positions: number[] = [];
      const startMatchIndex = Math.max(0, Math.floor(startMatch ?? 0));
      const snippetSize = query.length + context * 2;
      let matchCount = 0;
      let totalChars = 0;
      for (let position = haystack.indexOf(needle); position >= 0; position = haystack.indexOf(needle, position + needle.length)) {
        if (matchCount >= startMatchIndex && positions.length < maxChunks) positions.push(position);
        matchCount += 1;
        const start = Math.max(0, position - context);
        totalChars += Math.min(snippetSize, fullText.length - start);
      }
      let matchIndex = startMatchIndex;
      let offset = Math.max(0, Math.floor(startMatchOffset ?? 0));
      for (const position of positions) {
        if (usedChars >= maxChars) break;
        const start = Math.max(0, position - context);
        const piece = fullText.slice(start, start + snippetSize);
        const text = piece.slice(offset, offset + maxChars - usedChars);
        if (text) {
          chunks.push(text);
          usedChars += text.length;
          offset += text.length;
        }
        if (offset < piece.length) break;
        matchIndex += 1;
        offset = 0;
      }
      const truncated = matchIndex < matchCount;
      const after = route();
      const sameDocument = documentElement === document.documentElement && before.href === after.href && before.baseURI === after.baseURI && before.documentToken === after.documentToken;
      return {
        chunks, totalChars, totalChunks: matchCount, matchCount, fingerprint: fingerprintText, truncated,
        ...(truncated ? { nextMatch: matchIndex, nextMatchOffset: offset } : {}),
        attestation: { before, after, sameDocument }, routeChanged: !sameDocument,
      };
    }
    const pieces: string[] = [];
    for (const value of rendered) {
      let offset = 0;
      while (offset < value.length) {
        let end = Math.min(value.length, offset + Math.max(1, chunkSize));
        if (end < value.length) {
          const boundary = value.lastIndexOf(" ", end);
          if (boundary > offset + Math.floor(chunkSize / 2)) end = boundary;
        }
        const piece = value.slice(offset, end).trim();
        if (piece) pieces.push(piece);
        offset = Math.max(end, offset + 1);
      }
    }
    const totalChars = pieces.reduce((sum, piece) => sum + piece.length, 0);
    const totalChunks = pieces.length;
    let pieceIndex = Math.max(0, Math.floor(startChunk ?? 0));
    let offset = Math.max(0, Math.floor(startOffset ?? 0));
    while (pieceIndex < pieces.length && chunks.length < Math.max(1, maxChunks) && usedChars < Math.max(1, maxChars)) {
      const piece = pieces[pieceIndex];
      const remaining = Math.max(1, maxChars) - usedChars;
      const text = piece.slice(offset, offset + remaining);
      if (text) {
        chunks.push(text);
        usedChars += text.length;
      }
      if (offset + text.length < piece.length) {
        nextChunk = pieceIndex;
        nextOffset = offset + text.length;
        break;
      }
      pieceIndex += 1;
      offset = 0;
      if (pieceIndex < pieces.length && chunks.length >= Math.max(1, maxChunks)) {
        nextChunk = pieceIndex;
        nextOffset = 0;
      }
    }
    if (nextChunk === undefined && pieceIndex < pieces.length) {
      nextChunk = pieceIndex;
      nextOffset = offset;
    }
    const after = route();
    const sameDocument = documentElement === document.documentElement && before.href === after.href && before.baseURI === after.baseURI && before.documentToken === after.documentToken;
    return {
      chunks,
      totalChars,
      totalChunks,
      fingerprint: fingerprintText,
      ...(nextChunk === undefined ? {} : { nextChunk, nextOffset }),
      truncated: nextChunk !== undefined,
      attestation: { before, after, sameDocument },
      routeChanged: !sameDocument,
    };
  };
}

export async function pagePointHit(page: BrowserPageLike, point: { x: number; y: number }): Promise<string | undefined> {
  return page.evaluate(({ x, y }) => {
    const top = document.elementFromPoint(x, y);
    if (!top) return undefined;
    const isInteractive = (element: Element): boolean => Boolean(element.getAttribute("role") || ["a", "button", "input", "select", "textarea", "summary"].includes(element.tagName.toLocaleLowerCase()));
    let current: Element | null = top;
    while (current && !isInteractive(current)) current = current.parentElement;
    if (!current) return undefined;
    const parts: string[] = [];
    while (current && current.parentElement) {
      const ancestor: Element = current.parentElement;
      parts.unshift(`${current.tagName.toLocaleLowerCase()}:nth-child(${Math.max(1, Array.from(ancestor.children).indexOf(current) + 1)})`);
      current = ancestor;
    }
    return parts.join(">");
  }, point);
}

export function hasState(control: Control, state: State): boolean { return control.states.includes(state); }
export function visible(control: Control): boolean { return control.states.includes("visible"); }
export function area(rect: { width: number; height: number } | undefined): number { return rect ? Math.max(1, rect.width * rect.height) : Number.POSITIVE_INFINITY; }
export function containsPoint(rect: { x: number; y: number; width: number; height: number }, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}
