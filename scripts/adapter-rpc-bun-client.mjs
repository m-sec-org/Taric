import { createConnection } from "node:net";

const socketPath = process.env.TARIC_CORE_SOCKET;
const token = process.env.TARIC_ADAPTER_TOKEN;
const engagementId = process.env.TARIC_ENGAGEMENT_ID;
if (!socketPath || !token || !engagementId) throw new Error("TARIC_CORE_SOCKET, TARIC_ADAPTER_TOKEN, and TARIC_ENGAGEMENT_ID are required");

const rpcCall = (id, operation, request) => new Promise((resolve, reject) => {
  const socket = createConnection(socketPath);
  let buffer = "";
  const deadline = setTimeout(() => socket.destroy(new Error("adapter RPC timed out")), 5000);
  socket.setEncoding("utf8");
  socket.once("error", reject);
  socket.once("connect", () => socket.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "taric.dispatch",
    params: { token, operation, request },
  })}\n`));
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    clearTimeout(deadline);
    socket.end();
    try { resolve(JSON.parse(buffer.slice(0, newline))); }
    catch (cause) { reject(cause); }
  });
});

const requestedOperation = process.env.TARIC_RPC_OPERATION;
const requestedBody = process.env.TARIC_RPC_REQUEST ? JSON.parse(process.env.TARIC_RPC_REQUEST) : { engagement_id: engagementId };
const response = await rpcCall(1, requestedOperation ?? "engagement.status", requestedBody);

if (response?.id !== 1 || response?.result?.ok !== true) {
  if (process.env.TARIC_RPC_ALLOW_ERROR === "1") {
    process.stdout.write(`${JSON.stringify({ ok: false, error: response?.result?.error ?? { code: "transport_error" }, response })}\n`);
  } else {
  process.stderr.write(`${JSON.stringify(response)}\n`);
  process.exitCode = 1;
  }
} else {
  const data = response.result.data ?? {};
  process.stdout.write(`${JSON.stringify({ ok: true, data: (requestedOperation ?? "engagement.status") === "engagement.status" ? { engagement_id: engagementId, ...data } : data })}\n`);
}

if (process.argv.includes("--probe-privilege")) {
  for (const [id, operation] of [[2, "audit.verify"], [3, "review.submit"], [4, "admission.promote_l2"]]) {
    const denied = await rpcCall(id, operation, { engagement_id: engagementId, role: "operator" });
    if (denied?.id !== id || denied?.result?.error?.code !== "authorization_error") {
      process.stderr.write(`${JSON.stringify({ operation, response: denied })}\n`);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode !== 1) process.stdout.write(`${JSON.stringify({ ok: true, data: { operator: "denied", reviewer: "denied", writer: "denied", principal_switch: "denied" } })}\n`);
}
