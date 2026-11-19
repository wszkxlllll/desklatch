import type { CuaDriverLike } from "@trycua/cua-driver";

import type { DesktopBackend } from "../../contracts.js";

/** The exact PID/HWND pair selected by the trusted host. */
export interface CuaWindowTarget {
  readonly pid: number;
  readonly windowId: bigint;
}

export type CuaWindowTargetInput = {
  readonly pid: number;
  readonly hwnd?: bigint | number | string;
  readonly windowId?: bigint | number | string;
  readonly window_id?: bigint | number | string;
};

/** Minimal CUA 0.54 surface used by this opt-in backend. */
export type CuaWindowDriver = Pick<CuaDriverLike, "metadata" | "startSession" | "endSession" | "callTool">;

/** Opaque native fingerprint for a checked WPF HWND. */
export type IdentifyWindow = (target: CuaWindowTarget) => Promise<string | undefined>;

export interface CuaBackgroundBackendOptions {
  /** A host-owned CUA 0.54 driver connection. */
  readonly driver: CuaWindowDriver;
  /** The exact native window selected by the trusted host. */
  readonly target: CuaWindowTargetInput;
  /** Optional host test seam; production defaults to a user32 WPF probe. */
  readonly identifyWindow?: IdentifyWindow;
  /** Stable host label for the CUA session; generated when omitted. */
  readonly session?: string;
  /** Maximum vertical line-scroll amount accepted by this leaf. */
  readonly maxScrollAmount?: number;
}

export interface CuaBackgroundBackend extends DesktopBackend {
  /** Opaque scope used to invalidate observations after window changes. */
  readonly authorizationScope: string;
}

export interface CuaBackgroundProfile {
  readonly profile: "windows-x64-wpf";
  /** Controls observations explicitly set `include_screenshot: false`. */
  readonly controlsObservation: "no-screenshot";
}

export class CuaBackgroundError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "CuaBackgroundError";
    this.code = code;
  }
}

export function cuaBackgroundError(code: string, message = code): CuaBackgroundError {
  return new CuaBackgroundError(code, message);
}

export function isCuaBackgroundError(error: unknown): error is CuaBackgroundError {
  return error instanceof CuaBackgroundError;
}
