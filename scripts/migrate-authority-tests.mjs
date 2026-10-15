import ts from "typescript";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Mechanical API migration. Assertions and fixtures remain intact; only the
// persistence boundary and the callers that consume it become asynchronous.
const root = resolve("packages/core/test");
const files = readdirSync(root).filter((file) => file.endsWith(".test.mjs") && !["artifact-async.test.mjs", "async-unit-of-work.test.mjs"].includes(file)).map((file) => resolve(root, file));
const ioFunctions = new Set(["createCoreService", "createCoreServiceForPath", "buildContextPack", "resumeContextDelta", "createControlObservation", "createAccessDecisionObservation", "createCoverageCell", "createNegativeObservation", "coverageCloseGate", "coverageVisibility"]);
const classFiles = new Set(["store.d.ts", "service.d.ts", "artifact-content-store.d.ts", "postgres.d.ts"]);
const contractFiles = new Set([...classFiles, "storage-contract.d.ts"]);
const pureMethods = new Set(["manifest", "deploymentProfile", "referenceInstrumentation"]);
const ioMethods = new Set([...classFiles].flatMap((file) => {
  const source = ts.createSourceFile(file, readFileSync(resolve("packages/core/dist", file), "utf8"), ts.ScriptTarget.ESNext, true);
  const names = [];
  const collect = (node) => {
    if ((ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) && node.name && !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)) names.push(node.name.getText(source));
    ts.forEachChild(node, collect);
  };
  collect(source);
  return names.filter((name) => !pureMethods.has(name));
}));
const nearestFunction = (node) => {
  for (let parent = node.parent; parent; parent = parent.parent) if (ts.isFunctionLike(parent)) return parent;
};
const isAsync = (node) => Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
const isPromise = (type) => type?.getSymbol()?.getName() === "Promise";
const inPromiseBatch = (node) => ts.isArrayLiteralExpression(node.parent) && ts.isCallExpression(node.parent.parent)
  && ts.isPropertyAccessExpression(node.parent.parent.expression) && node.parent.parent.expression.expression.getText() === "Promise"
  && ["all", "allSettled", "race", "any"].includes(node.parent.parent.expression.name.text);

for (const file of files) {
  const contents = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const edits = [];
  const collect = (node) => {
    if (ts.isAwaitExpression(node)) {
      let argument = node;
      while (ts.isParenthesizedExpression(argument.parent)) argument = argument.parent;
      const parent = argument.parent;
      if (ts.isPropertyAccessExpression(parent) && ["then", "catch", "finally"].includes(parent.name.text)) {
        edits.push({ start: argument.getStart(source), end: argument.end, text: node.expression.getText(source) });
      }
      if (ts.isCallExpression(parent) && parent.arguments[0] === argument && parent.expression.getText(source) === "assert.rejects") {
        edits.push({ start: argument.getStart(source), end: argument.end, text: node.expression.getText(source) });
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  let output = contents;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  output = output.replaceAll("(await Promise.resolve())", "Promise.resolve()");
  if (output !== contents) writeFileSync(file, output);
}

for (let pass = 0; pass < 20; pass++) {
  const program = ts.createProgram(files, { allowJs: true, checkJs: false, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const checker = program.getTypeChecker();
  let changed = 0;
  for (const file of files) {
    const source = program.getSourceFile(file);
    const contents = readFileSync(file, "utf8");
    const insertions = new Map();
    const replacements = [];
    const functions = new Set();
    const awaited = new Set();
    const append = (position, text) => insertions.set(position, (insertions.get(position) ?? "") + text);
    const awaitNode = (node) => {
      if (awaited.has(node) || ts.isAwaitExpression(node.parent) || inPromiseBatch(node)) return;
      if (ts.isPropertyAccessExpression(node.parent) && ["then", "catch", "finally"].includes(node.parent.name.text)) return;
      if (ts.isCallExpression(node.parent) && node.parent.arguments[0] === node && node.parent.expression.getText(source) === "assert.rejects") return;
      awaited.add(node);
      append(node.getStart(source), "(await ");
      append(node.end, ")");
      const fn = nearestFunction(node);
      if (fn) functions.add(fn);
    };
    const isIoCall = (node) => {
      if (ts.isIdentifier(node.expression) && ioFunctions.has(node.expression.text)) return true;
      if (!ts.isPropertyAccessExpression(node.expression) || pureMethods.has(node.expression.name.text)) return false;
      const symbol = checker.getSymbolAtLocation(node.expression.name);
      return symbol?.declarations?.some((declaration) => contractFiles.has(declaration.getSourceFile().fileName.split("/").at(-1)))
        || !symbol && ioMethods.has(node.expression.name.text);
    };
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const type = checker.getTypeAtLocation(node);
        const nativePromise = ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === "Promise";
        if (isIoCall(node) || isPromise(type) && node.expression.getText(source) !== "test" && !nativePromise) awaitNode(node);
        if (ts.isPropertyAccessExpression(node.expression) && (["map", "forEach"].includes(node.expression.name.text) || node.expression.getText(source) === "Array.from")) {
          const callback = node.arguments[node.expression.name.text === "from" ? 1 : 0];
          const returnsPromise = callback && checker.getTypeAtLocation(callback).getCallSignatures().some((signature) => isPromise(signature.getReturnType()));
          if (returnsPromise && !(ts.isCallExpression(node.parent) && /^Promise\.(all|allSettled)$/.test(node.parent.expression.getText(source)))) {
            if (node.expression.name.text === "forEach") replacements.push({ start: node.expression.name.getStart(source), end: node.expression.name.end, text: "map" });
            append(node.getStart(source), "(await Promise.all("); append(node.end, "))");
            const fn = nearestFunction(node); if (fn) functions.add(fn);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    // An awaited rejection must be observed by node:test. Keep synchronous
    // validator assertions as assert.throws.
    const assertions = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === "assert" && node.expression.name.text === "throws") {
        const callback = node.arguments[0];
        if (callback && functions.has(callback)) {
          replacements.push({ start: node.expression.name.getStart(source), end: node.expression.name.end, text: "rejects" });
          awaitNode(node);
        }
      }
      ts.forEachChild(node, assertions);
    };
    assertions(source);
    for (const fn of functions) if (!isAsync(fn)) append(fn.getStart(source), "async ");

    // Artifact construction stays synchronous; initialization owns catalog I/O.
    const initialize = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isNewExpression(node.initializer) && node.initializer.expression.getText(source) === "ArtifactContentStore") {
        const statement = node.parent.parent;
        if (!contents.slice(statement.end, statement.end + 150).trimStart().startsWith(`await ${node.name.text}.initialize()`)) {
          append(statement.end, ` await ${node.name.text}.initialize();`);
          const fn = nearestFunction(node); if (fn && !isAsync(fn) && !functions.has(fn)) append(fn.getStart(source), "async ");
        }
      }
      if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && ts.isNewExpression(node.expression.right) && node.expression.right.expression.getText(source) === "ArtifactContentStore") {
        const name = node.expression.left.getText(source);
        if (!contents.slice(node.end, node.end + 150).trimStart().startsWith(`await ${name}.initialize()`)) append(node.end, ` await ${name}.initialize();`);
      }
      ts.forEachChild(node, initialize);
    };
    initialize(source);
    if (!insertions.size && !replacements.length) continue;
    const edits = [...insertions].map(([start, text]) => ({ start, end: start, text })).concat(replacements).sort((left, right) => right.start - left.start || right.end - left.end);
    let output = contents;
    for (const edit of edits) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    output = output.replaceAll("(await Promise.resolve())", "Promise.resolve()");
    writeFileSync(file, output);
    changed++;
  }
  if (!changed) { console.log(`Asynchronous persistence migration complete after ${pass} passes.`); break; }
  console.log(`Migration pass ${pass + 1}: ${changed} files.`);
}
