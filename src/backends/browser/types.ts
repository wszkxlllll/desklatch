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

export interface BrowserLocatorLike {
  count(): Promise<number>;
  elementHandle?(): Promise<BrowserElementHandleLike | null>;
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
  rootSelector?: string;
  authorizedOrigins?: readonly string[];
  allowBlank?: boolean;
  /** Explicit host opt-in for a viewport PNG. Controls-only observation never captures. */
  allowImages?: boolean;
  includePublicValues?: boolean;
  publicDataOnly?: boolean;
  protectedFieldNames?: readonly string[];
}

export interface BrowserBackend extends DesktopBackend {
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

export type BrowserPage = Page;
