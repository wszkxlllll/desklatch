import type { Page } from "playwright-core";
import type {
  ActionKind,
  Control,
  Delivery,
  DesktopBackend,
  Effect,
  State,
} from "../../contracts.js";

/** Minimal structural surface for a trusted scoped CDP adapter. */
export interface BrowserPageLike {
  evaluate<R, A = unknown>(pageFunction: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  /** Optional native Playwright handle evaluation used for batched snapshots. */
  evaluateHandle?<R, A = unknown>(pageFunction: (arg: A) => R | Promise<R>, arg?: A): Promise<BrowserJavaScriptHandleLike>;
  locator(selector: string): BrowserLocatorLike;
  mouse: {
    click(x: number, y: number, options?: { button?: "left" | "right"; clickCount?: number }): Promise<void>;
  };
  screenshot?(options?: { type?: "png"; fullPage?: boolean }): Promise<Uint8Array>;
  url(): string;
  on?(event: string, listener: (...args: any[]) => void): void;
  off?(event: string, listener: (...args: any[]) => void): void;
  waitForTimeout?(milliseconds: number): Promise<void>;
  mainFrame?(): unknown;
  isClosed?(): boolean;
}

/** Minimal JSHandle surface required to unwrap a batched ElementHandle array. */
export interface BrowserJavaScriptHandleLike {
  getProperties?(): Promise<Map<string, BrowserJavaScriptHandleLike>>;
  asElement?(): BrowserElementHandleLike | null;
  dispose?(): Promise<void>;
}

export interface BrowserLocatorLike {
  count(): Promise<number>;
  /**
   * Return the current attached matches without locator auto-waiting. Native
   * Playwright locators provide this as a bounded snapshot (`$$`).
   */
  elementHandles?(): Promise<BrowserElementHandleLike[]>;
  /** Compatibility fallback for scoped adapters that predate elementHandles. */
  elementHandle?(options?: { timeout?: number }): Promise<BrowserElementHandleLike | null>;
  click?(options?: { button?: "left" | "right"; clickCount?: number; timeout?: number }): Promise<void>;
  fill?(value: string, options?: { timeout?: number }): Promise<void>;
  press?(key: string, options?: { timeout?: number }): Promise<void>;
  pressSequentially?(text: string, options?: { timeout?: number; delay?: number }): Promise<void>;
  scrollIntoViewIfNeeded?(options?: { timeout?: number }): Promise<void>;
  evaluate?<R, A = unknown>(pageFunction: (element: unknown, arg: A) => R | Promise<R>, arg?: A): Promise<R>;
}

export interface BrowserElementHandleLike {
  scrollIntoViewIfNeeded?(options?: { timeout?: number }): Promise<void>;
  dispose?(): Promise<void>;
  click?(options?: { button?: "left" | "right"; clickCount?: number; timeout?: number }): Promise<void>;
  fill?(value: string, options?: { timeout?: number }): Promise<void>;
  type?(text: string, options?: { timeout?: number; delay?: number }): Promise<void>;
  press?(key: string, options?: { timeout?: number }): Promise<void>;
  pressSequentially?(text: string, options?: { timeout?: number; delay?: number }): Promise<void>;
  evaluate?<R, A = unknown>(pageFunction: (element: unknown, arg: A) => R | Promise<R>, arg?: A): Promise<R>;
}

export interface BrowserBackendOptions {
  /** Host-owned authorization/session label; never a profile path. */
  scope?: string;
  observeLimit?: number;
  searchLimit?: number;
  searchTimeoutMs?: number;
  settleMs?: number;
  actionTimeoutMs?: number;
  /** E2B-only opt-in: avoid a broad post-navigation focus refresh after a link click. */
  skipPostNavigationFocusRefresh?: boolean;
  /** E2B-only opt-in: deliver verified cross-document link clicks by point. */
  preferMouseNavigationClick?: boolean;
  rootSelector?: string;
  authorizedOrigins?: readonly string[];
  allowBlank?: boolean;
  /** Explicit host opt-in for a viewport PNG. Controls-only observation never captures. */
  allowImages?: boolean;
  /** Explicit host opt-in for bounded rendered page text. Off by default. */
  allowDocumentText?: boolean;
  /** Total rendered text exposed by one document observation. */
  documentTextLimit?: number;
  /** Maximum number of rendered text chunks exposed by one document observation. */
  documentChunkLimit?: number;
  /** Maximum characters in each rendered text chunk. */
  documentChunkSize?: number;
  includePublicValues?: boolean;
  publicDataOnly?: boolean;
  protectedFieldNames?: readonly string[];
}

/** Bounds for model-visible document search and continuation state. */
export const MAX_DOCUMENT_QUERY_LENGTH = 256;
export const MAX_DOCUMENT_CURSOR_LENGTH = 512;
export const MAX_DOCUMENT_CURSORS = 32;

export interface BrowserBackend extends DesktopBackend {
  readonly allowDocumentText: boolean;
  readonly supportsScopedRefRefresh: true;
  /** Browser point origin checks use retained screenshot/layout evidence. */
  readonly hitTestSnapshot: true;
}

export interface BrowserRiskSignal {
  level: "low" | "medium" | "high";
  effect: Effect;
  requiresApproval: boolean;
  reason: string;
  protectedField?: boolean;
}

export type BrowserDelivery = Delivery & {
  /** Structured facts for the core policy; this leaf never approves/denies them. */
  risk?: BrowserRiskSignal;
  candidates?: readonly Control[];
};

export interface RawControl {
  path: string;
  key: string;
  role: string;
  name?: string;
  labels: string[];
  within?: string;
  withinKeys: string[];
  states: State[];
  actions: ActionKind[];
  rect?: { x: number; y: number; width: number; height: number };
  value?: string;
  sensitive: boolean;
  href?: string;
  filterAction: boolean;
  disclosure: boolean;
  /** Native form submission semantics, including a button's omitted default type. */
  formSubmitter?: boolean;
  /** A role=tab that is structurally tied to a same-document tabpanel. */
  sameDocumentTab?: boolean;
  /** Enter on this native single-line form control may invoke implicit submission. */
  enterMaySubmit?: boolean;
  approvalCandidate?: boolean;
  approvalContext?: { token: string; summary?: string };
  tagName: string;
  type?: string;
  disabled: boolean;
  stableKind: "id" | "testid" | "name" | "path";
}

export interface InternalControl extends Control {
  __path: string;
  __key: string;
  __stableKey: string;
  __tagName: string;
  __type?: string;
  __disabled: boolean;
  disclosure?: boolean;
  enterMaySubmit?: boolean;
}

export interface FrameState {
  controls: Map<string, InternalControl>;
  handles: Map<string, BrowserElementHandleLike>;
  scope: string;
}

export class BrowserBackendError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "BrowserBackendError";
    this.code = code;
  }
}

export const DEFAULT_OBSERVE_LIMIT = 100;
export const DEFAULT_SEARCH_LIMIT = 500;
export const DEFAULT_SEARCH_TIMEOUT = 750;
export const DEFAULT_SETTLE = 40;
export const DEFAULT_ACTION_TIMEOUT = 1_500;
export const MAX_STEP_TEXT_LENGTH = 32_768;
export const MAX_SCROLL_AMOUNT = 10_000;
export const DEFAULT_DOCUMENT_TEXT_LIMIT = 12_000;
export const DEFAULT_DOCUMENT_CHUNK_LIMIT = 64;
export const DEFAULT_DOCUMENT_CHUNK_SIZE = 2_000;
export const MAX_DOCUMENT_TEXT_LIMIT = 64_000;
export const MAX_DOCUMENT_CHUNK_LIMIT = 256;
export const MAX_DOCUMENT_CHUNK_SIZE = 4_096;

export type BrowserPage = Page;
