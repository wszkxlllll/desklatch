export type ActionKind = "click" | "type" | "setValue" | "scroll" | "keypress" | "hotkey" | "drag";
export type TargetForm = "selector" | "ref" | "point" | "focus" | "path";
export type State = "visible" | "enabled" | "editable" | "focused" | "checked" | "selected";
export type View = "controls" | "image" | "both" | "document";
/** A read-only request for bounded, rendered page text. This is opt-in at the browser host. */
export interface DocumentReadOptions {
  kind?: "document";
  maxChars?: number;
  maxChunks?: number;
  chunkSize?: number;
  /** Include only readable blocks whose bounds intersect the current viewport. */
  viewportOnly?: boolean;
}
export type DocumentRead = "document" | DocumentReadOptions;
export interface DocumentTextChunk {
  /** Text copied from visible rendered page content; never a control value. */
  text: string;
  index: number;
}
export interface DocumentObservation {
  /** Explicit provenance label for consumers that display page text beside other evidence. */
  kind: "page_text";
  chunks: readonly DocumentTextChunk[];
  complete: boolean;
  truncated: boolean;
  /** True when the request intentionally limited collection to viewport-intersecting blocks. */
  viewportOnly: boolean;
  totalChars: number;
  totalChunks: number;
  sourceUrl?: string;
}
export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export interface Selector { role?: string; name?: string; within?: string; state?: State }
export type Target = Selector | { ref: string } | { point: Point } | { focusFromStep: number };
export type Expect = { target: Selector } & ({ state: State | "present" } | { valueEquals: string });
export type Step = { expect?: Expect } & (
  | { kind: "click"; target: Target; button?: "left" | "right"; count?: 1 | 2 }
  | { kind: "type"; target: Target; text: string }
  | { kind: "setValue"; target: Target; value: string }
  | { kind: "scroll"; target: Target; direction: "up" | "down" | "left" | "right"; amount: number; by?: "line" | "page" }
  | { kind: "keypress"; target: Target; key: string }
  | { kind: "hotkey"; target: Target; keys: string[] }
  | { kind: "drag"; from: Point; to: Point }
);
export interface ActRequest { observationId?: string; steps: Step[] }

/** Each entry is one allowed combination. Constraints from different entries cannot be combined. */
export interface Capability {
  kind: ActionKind; targets: readonly TargetForm[];
  buttons?: readonly ("left" | "right")[]; counts?: readonly (1 | 2)[];
  directions?: readonly ("up" | "down" | "left" | "right")[]; units?: readonly ("line" | "page")[];
  keys?: readonly string[]; chords?: readonly (readonly string[])[];
}
export type Effect = "read" | "navigate" | "edit" | "external" | "financial" | "destructive" | "security" | "sensitive" | "unknown";
export interface Control {
  /** Stable only within the current authorized scope. Distinguish distinct objects with equal labels. */
  id: string; role: string; name?: string; within?: string; states: readonly State[];
  actions: readonly ActionKind[]; rect?: Rect; value?: string; sensitive?: boolean;
  labels?: readonly string[]; effect?: Effect;
  /** Host-private binding to material data outside the button itself (e.g. the recipient and current form values). */
  approvalContext?: { token: string; summary?: string };
  /** Set only for a structurally identified, low-risk search/filter operation. */
  filterAction?: boolean;
  /** The backend found that Enter in this field can submit its enclosing form. */
  enterMaySubmit?: boolean;
}
export interface FrameImage { mimeType: string; dataBase64: string; width: number; height: number }
export interface Frame {
  /** Authorization scope plus document/window generation. */
  scope: string; controls: readonly Control[]; complete: boolean; focusId?: string; image?: FrameImage;
  /** Optional browser-only, host-authorized rendered page text. */
  document?: DocumentObservation;
}
export interface ObserveOptions { view: View; where?: Selector; read?: DocumentRead; signal?: AbortSignal }
export interface Dispatch {
  step: Step; frame: Frame; target: Control; destination?: Control;
  /** Original frame for a point/drag, retained privately for final identity and geometry checks. */
  origin?: Frame; signal?: AbortSignal;
}
export interface Delivery { status: "dispatched" | "refused" | "partial" | "unknown"; code?: string; focusId?: string }
/** A trusted host supplies one scoped backend. Dispatch must recheck its physical recipient at the last possible moment. */
export interface DesktopBackend {
  readonly capabilities: readonly Capability[];
  /** Host opt-in for exposing rendered browser text to the model surface. */
  readonly allowDocumentText?: boolean;
  observe(options: ObserveOptions): Promise<Frame>;
  hitTest?(frame: Frame, point: Point, signal?: AbortSignal): Promise<Control | undefined>;
  dispatch(request: Dispatch): Promise<Delivery>;
  close(): Promise<void>;
}
export interface RiskInput { step: Step; target: Control; destination?: Control; signal?: AbortSignal }
/** needs_evidence leaves the action unsent and returns control to the agent without opening an approval. */
export interface RiskDecision { decision: "allow" | "approve" | "needs_evidence" | "deny"; code: string }
export type RiskPolicy = (input: RiskInput) => Promise<RiskDecision> | RiskDecision;
