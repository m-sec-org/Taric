/**
 * taric 可执行入口。
 * 必须在导入 @taric/core 之前屏蔽 node:sqlite 的实验性警告，
 * 否则警告会混入 stderr 诊断，破坏 CLI/MCP 子进程契约。
 */
const originalEmitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  if (text.includes("SQLite is an experimental feature")) return;
  return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { runCliMain } = await import("./cli.js");
const exitCode = await runCliMain(process.argv.slice(2));
// 显式退出，避免未消费的句柄让 CLI 进程继续挂起。
process.exit(exitCode);
