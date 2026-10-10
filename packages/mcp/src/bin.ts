/**
 * taric-mcp 可执行入口。
 * 必须在导入 @taric/core 之前屏蔽 node:sqlite 的实验性警告，
 * 否则 stdout/stderr 契约无法被稳定断言。
 */
const originalEmitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (text.includes("SQLite is an experimental feature")) return;
  return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { runMcpStdio } = await import("./server.js");
await runMcpStdio();
