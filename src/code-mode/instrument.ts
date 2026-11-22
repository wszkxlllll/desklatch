import { randomUUID } from "node:crypto";
import type {
  CodeModeBranchCounter, CodeModeControlFlow, CodeModeLoopCounter,
} from "./protocol.js";

/** The static records sent to the private guest trace object. */
export interface CodeModeInstrumentation {
  readonly code: string;
  readonly traceName?: string;
  readonly controlFlow: CodeModeControlFlow;
}

type TypeScript = typeof import("typescript");

// Keep the private trace well below MAX_TRACE_BYTES even for a 32 KiB source
// full of tiny control-flow nodes.  The omission is reported, not silently
// presented as complete coverage.
const MAX_BRANCH_COUNTERS = 128;
const MAX_LOOP_COUNTERS = 128;

/**
 * Build a valid, per-run lexical identifier that is not part of the public
 * source API.  The identifier only names a counter object and has no access
 * to a DeskLatch endpoint or any approval state.
 */
function privateTraceName(): string {
  return `__desklatch_trace_${randomUUID().replace(/-/gu, "")}`;
}

function fallback(source: string, reason: string): CodeModeInstrumentation {
  return {
    code: source,
    controlFlow: {
      status: "fallback",
      transformer: "none",
      branches: [],
      loops: [],
      unsupported: [reason],
      fixedWrapper: false,
    },
  };
}

function branchLocation(sourceFile: import("typescript").SourceFile, node: import("typescript").Node) {
  const start = node.getStart(sourceFile);
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  return { line: position.line + 1, column: position.character + 1 };
}

function operatorText(ts: TypeScript, token: import("typescript").BinaryOperatorToken): "&&" | "||" | "??" | undefined {
  if (token.kind === ts.SyntaxKind.AmpersandAmpersandToken) return "&&";
  if (token.kind === ts.SyntaxKind.BarBarToken) return "||";
  if (token.kind === ts.SyntaxKind.QuestionQuestionToken) return "??";
  return undefined;
}

function branchCall(
  ts: TypeScript,
  traceName: string,
  id: number,
  value: import("typescript").Expression,
): import("typescript").Expression {
  const factory = ts.factory;
  return factory.createCallExpression(
    factory.createPropertyAccessExpression(factory.createIdentifier(traceName), "branch"),
    undefined,
    [factory.createNumericLiteral(id), value],
  );
}

function logicalCall(
  ts: TypeScript,
  traceName: string,
  id: number,
  value: import("typescript").Expression,
  operator: "&&" | "||" | "??",
): import("typescript").Expression {
  const factory = ts.factory;
  return factory.createCallExpression(
    factory.createPropertyAccessExpression(factory.createIdentifier(traceName), "logical"),
    undefined,
    [factory.createNumericLiteral(id), value, factory.createStringLiteral(operator)],
  );
}

function loopCall(ts: TypeScript, traceName: string, id: number): import("typescript").Statement {
  const factory = ts.factory;
  return factory.createExpressionStatement(factory.createCallExpression(
    factory.createPropertyAccessExpression(factory.createIdentifier(traceName), "loop"),
    undefined,
    [factory.createNumericLiteral(id)],
  ));
}

function caseCall(ts: TypeScript, traceName: string, id: number): import("typescript").Statement {
  const factory = ts.factory;
  return factory.createExpressionStatement(factory.createCallExpression(
    factory.createPropertyAccessExpression(factory.createIdentifier(traceName), "switchCase"),
    undefined,
    [factory.createNumericLiteral(id)],
  ));
}

function asLoopBody(
  ts: TypeScript,
  traceName: string,
  id: number,
  statement: import("typescript").Statement,
  unsupported: (reason: string) => void,
): import("typescript").Statement {
  const factory = ts.factory;
  // Function declarations have Annex-B block semantics that can differ after
  // wrapping.  Leave those rare bodies untouched and classify the omission.
  if (ts.isFunctionDeclaration(statement)) {
    unsupported("loop_body_function_declaration");
    return statement;
  }
  if (ts.isBlock(statement)) {
    return factory.updateBlock(statement, [loopCall(ts, traceName, id), ...statement.statements]);
  }
  return factory.createBlock([loopCall(ts, traceName, id), statement], false);
}

function makeBranch(
  sourceFile: import("typescript").SourceFile,
  id: number,
  node: import("typescript").Node,
  kind: CodeModeBranchCounter["kind"],
  operator?: "&&" | "||" | "??",
): CodeModeBranchCounter {
  const location = branchLocation(sourceFile, node);
  return {
    id,
    kind,
    ...(operator ? { operator } : {}),
    ...location,
    evaluations: 0,
    taken: 0,
    notTaken: 0,
  };
}

function makeLoop(
  sourceFile: import("typescript").SourceFile,
  id: number,
  node: import("typescript").Node,
  kind: CodeModeLoopCounter["kind"],
): CodeModeLoopCounter {
  return {
    id,
    kind,
    ...branchLocation(sourceFile, node),
    iterations: 0,
  };
}

/**
 * Instrument the erasable JavaScript body that the QuickJS guest will run.
 * The transform intentionally handles a small, semantics-preserving subset:
 * condition values, logical short-circuit decisions, switch-case entry and
 * loop-body entry.  It never rewrites DeskLatch calls or action arguments.
 */
export async function instrumentJavaScript(source: string): Promise<CodeModeInstrumentation> {
  let ts: TypeScript;
  try {
    ts = await import("typescript");
  } catch {
    return fallback(source, "typescript_unavailable");
  }

  const sourceFile = ts.createSourceFile("code-mode.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const diagnostics = (sourceFile as import("typescript").SourceFile & {
    parseDiagnostics?: readonly import("typescript").Diagnostic[];
  }).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) return fallback(source, "parse_error");

  const traceName = privateTraceName();
  const branches: CodeModeBranchCounter[] = [];
  const loops: CodeModeLoopCounter[] = [];
  const unsupported = new Set<string>();
  let nextBranchId = 1;
  let nextLoopId = 1;
  const addUnsupported = (reason: string): void => {
    if (unsupported.size < 32) unsupported.add(reason);
  };
  const reserveBranch = (): boolean => {
    if (branches.length >= MAX_BRANCH_COUNTERS) {
      addUnsupported("branch_instrumentation_limit");
      return false;
    }
    return true;
  };
  const reserveLoop = (): boolean => {
    if (loops.length >= MAX_LOOP_COUNTERS) {
      addUnsupported("loop_instrumentation_limit");
      return false;
    }
    return true;
  };
  const factory = ts.factory;

  const result = ts.transform(sourceFile, [context => {
    const visitor: import("typescript").Visitor = node => {
      const visited = ts.visitEachChild(node, visitor, context);

      if (ts.isIdentifier(visited) && visited.text === "arguments") addUnsupported("arguments_binding");

      if (ts.isIfStatement(visited)) {
        if (!reserveBranch()) return visited;
        const id = nextBranchId++;
        branches.push(makeBranch(sourceFile, id, visited, "if"));
        return factory.updateIfStatement(visited, branchCall(ts, traceName, id, visited.expression), visited.thenStatement, visited.elseStatement);
      }
      if (ts.isConditionalExpression(visited)) {
        if (!reserveBranch()) return visited;
        const id = nextBranchId++;
        branches.push(makeBranch(sourceFile, id, visited, "conditional"));
        return factory.updateConditionalExpression(
          visited,
          branchCall(ts, traceName, id, visited.condition),
          visited.questionToken,
          visited.whenTrue,
          visited.colonToken,
          visited.whenFalse,
        );
      }
      if (ts.isBinaryExpression(visited)) {
        const operator = operatorText(ts, visited.operatorToken);
        if (operator) {
          if (!reserveBranch()) return visited;
          const id = nextBranchId++;
          branches.push(makeBranch(sourceFile, id, visited, "logical", operator));
          return factory.updateBinaryExpression(visited, logicalCall(ts, traceName, id, visited.left, operator), visited.operatorToken, visited.right);
        }
        if (visited.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
          || visited.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken
          || visited.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) {
          addUnsupported("logical_assignment");
        }
      }
      if (ts.isCallExpression(visited) && ts.isIdentifier(visited.expression)
        && (visited.expression.text === "eval" || visited.expression.text === "Function")) {
        addUnsupported(visited.expression.text === "eval" ? "dynamic_eval" : "dynamic_function");
      }
      if (ts.isNewExpression(visited) && visited.expression && ts.isIdentifier(visited.expression)
        && visited.expression.text === "Function") addUnsupported("dynamic_function");
      if ((ts.isPropertyAccessExpression(visited) || ts.isElementAccessExpression(visited) || ts.isCallExpression(visited))
        && (visited as import("typescript").PropertyAccessExpression & { questionDotToken?: unknown }).questionDotToken) {
        addUnsupported("optional_chain");
      }
      if (ts.isForStatement(visited)) {
        if (!reserveLoop()) return visited;
        const loopId = nextLoopId++;
        loops.push(makeLoop(sourceFile, loopId, visited, "for"));
        const condition = visited.condition === undefined ? undefined : (() => {
          if (!reserveBranch()) return visited.condition;
          const branchId = nextBranchId++;
          branches.push(makeBranch(sourceFile, branchId, visited.condition!, "loop_condition"));
          return branchCall(ts, traceName, branchId, visited.condition!);
        })();
        return factory.updateForStatement(
          visited,
          visited.initializer,
          condition,
          visited.incrementor,
          asLoopBody(ts, traceName, loopId, visited.statement, addUnsupported),
        );
      }
      if (ts.isForOfStatement(visited)) {
        if (!reserveLoop()) return visited;
        const loopId = nextLoopId++;
        loops.push(makeLoop(sourceFile, loopId, visited, "for_of"));
        return factory.updateForOfStatement(
          visited,
          visited.awaitModifier,
          visited.initializer,
          visited.expression,
          asLoopBody(ts, traceName, loopId, visited.statement, addUnsupported),
        );
      }
      if (ts.isForInStatement(visited)) {
        if (!reserveLoop()) return visited;
        const loopId = nextLoopId++;
        loops.push(makeLoop(sourceFile, loopId, visited, "for_in"));
        return factory.updateForInStatement(
          visited,
          visited.initializer,
          visited.expression,
          asLoopBody(ts, traceName, loopId, visited.statement, addUnsupported),
        );
      }
      if (ts.isWhileStatement(visited)) {
        if (!reserveLoop()) return visited;
        const loopId = nextLoopId++;
        loops.push(makeLoop(sourceFile, loopId, visited, "while"));
        let condition = visited.expression;
        if (reserveBranch()) {
          const branchId = nextBranchId++;
          branches.push(makeBranch(sourceFile, branchId, visited, "loop_condition"));
          condition = branchCall(ts, traceName, branchId, condition);
        }
        return factory.updateWhileStatement(
          visited,
          condition,
          asLoopBody(ts, traceName, loopId, visited.statement, addUnsupported),
        );
      }
      if (ts.isDoStatement(visited)) {
        if (!reserveLoop()) return visited;
        const loopId = nextLoopId++;
        loops.push(makeLoop(sourceFile, loopId, visited, "do"));
        let condition = visited.expression;
        if (reserveBranch()) {
          const branchId = nextBranchId++;
          branches.push(makeBranch(sourceFile, branchId, visited, "loop_condition"));
          condition = branchCall(ts, traceName, branchId, condition);
        }
        return factory.updateDoStatement(
          visited,
          asLoopBody(ts, traceName, loopId, visited.statement, addUnsupported),
          condition,
        );
      }
      if (ts.isCaseClause(visited)) {
        if (!reserveBranch()) return visited;
        const branchId = nextBranchId++;
        branches.push(makeBranch(sourceFile, branchId, visited, "switch_case"));
        return factory.updateCaseClause(visited, visited.expression, [caseCall(ts, traceName, branchId), ...visited.statements]);
      }
      if (ts.isDefaultClause(visited)) {
        if (!reserveBranch()) return visited;
        const branchId = nextBranchId++;
        branches.push(makeBranch(sourceFile, branchId, visited, "switch_case"));
        return factory.updateDefaultClause(visited, [caseCall(ts, traceName, branchId), ...visited.statements]);
      }
      return visited;
    };
    return root => ts.visitNode(root, visitor) as import("typescript").SourceFile;
  }]);

  try {
    // AsyncFunction receives the private counter as a third parameter.  A
    // source that observes `arguments` could otherwise see a changed length;
    // preserve baseline semantics by leaving such programs untouched.
    if (unsupported.has("arguments_binding")) return fallback(source, "arguments_binding");
    if (unsupported.has("dynamic_eval")) return fallback(source, "dynamic_eval");
    if (unsupported.has("dynamic_function")) return fallback(source, "dynamic_function");
    const transformed = result.transformed[0];
    if (!transformed || !ts.isSourceFile(transformed)) return fallback(source, "transform_error");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const code = printer.printFile(transformed);
    const controlFlow: CodeModeControlFlow = {
      status: "instrumented",
      transformer: "typescript-ast",
      branches,
      loops,
      unsupported: [...unsupported],
      fixedWrapper: branches.length === 0 && loops.length === 0 && unsupported.size === 0,
    };
    return { code, traceName, controlFlow };
  } catch {
    return fallback(source, "print_error");
  } finally {
    result.dispose();
  }
}
