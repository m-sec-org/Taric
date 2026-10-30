import { test } from "bun:test";
import assert from "node:assert/strict";
import { connect as connectNet, createServer } from "node:net";
import type { Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthorityStore, createCoreService, createPrincipal, listenAdapterHttpsRpc, listenAdapterRpc, uuidv7 } from "@taric/core";
import { operationContracts } from "@taric/schemas";
import { BunSqliteAuthorityDriver } from "../src/index.js";

const hostToken = "profile-host-token-0123456789abcdef0123456789";
const modelToken = "profile-model-token-0123456789abcdef0123456789";
const reviewerToken = "profile-reviewer-token-0123456789abcdef0123456789";
const roles = ["host", "model", "reviewer"] as const;

type ProfileCall = (token: string, operation: string, request: Record<string, unknown>) => Promise<any>;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0 }, resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function socketRpcCall(connect: () => Socket, principals: Map<string, ReturnType<typeof createPrincipal>>): ProfileCall {
  return async (token, operation, request) => {
    const socket = connect();
    socket.setEncoding("utf8");
    let buffer = "";
    const pending = new Map<number, (message: any) => void>();
    let id = 0;
    const response = (requestId: number) => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC response ${requestId} timed out`)), 5_000);
      pending.set(requestId, (message) => { clearTimeout(timer); resolve(message); });
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
        newline = buffer.indexOf("\n");
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", resolve);
        if (socket.connecting === false) resolve();
      });
      const principal = principals.get(token);
      assert.ok(principal, "test token must map to a fixed principal");
      const identifyId = ++id;
      const identified = response(identifyId);
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: identifyId, method: "taric.identify", params: { token, declare: { role: principal.role, principal_id: principal.id, engagement_id: principal.engagement_id } } })}\n`);
      const identifyResult = await identified;
      assert.equal(identifyResult.result?.ok, true, JSON.stringify(identifyResult));
      const callId = ++id;
      const result = response(callId);
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: callId, method: "taric.dispatch", params: { token, operation, request } })}\n`);
      const envelope = await result;
      return envelope.result ?? envelope;
    } finally {
      socket.destroy();
    }
  };
}

function httpsRpcCall(port: number, cert: Buffer): ProfileCall {
  return (token, operation, request) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "taric.dispatch", params: { operation, request } });
    const httpRequest = httpsRequest({ hostname: "127.0.0.1", port, ca: cert, method: "POST", path: "/rpc", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode !== 200) return resolve({ ok: false, error: { code: payload.error?.data?.code ?? "transport_error", message: payload.error?.message } });
          resolve(payload.result);
        } catch (error) { reject(error); }
      });
    });
    httpRequest.once("error", reject);
    httpRequest.end(body);
  });
}

test("Bun in-process, Unix socket, loopback TLS TCP, and HTTPS preserve registry authorization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taric-profile-auth-"));
  const engagementId = uuidv7();
  const store = new AuthorityStore(new BunSqliteAuthorityDriver(join(directory, "authority.sqlite")));
  const service = await createCoreService(store, join(directory, "content"));
  const principals = new Map([
    [hostToken, createPrincipal("host", "profile-host", engagementId)],
    [modelToken, createPrincipal("model", "profile-model", engagementId)],
    [reviewerToken, createPrincipal("reviewer", "profile-reviewer", engagementId)],
  ]);
  const resolvePrincipal = (declared: { role: string; principal_id: string; engagement_id?: string }, token: string) => {
    const principal = principals.get(token);
    if (!principal || declared.role !== principal.role || declared.principal_id !== principal.id || declared.engagement_id !== principal.engagement_id) throw new Error("token identity mismatch");
    return principal;
  };
  const certDirectory = fileURLToPath(new URL("../../core/test/fixtures/", import.meta.url));
  const key = await readFile(join(certDirectory, "gateway-test-key.pem"));
  const cert = await readFile(join(certDirectory, "gateway-test-cert.pem"));
  const socketPath = join(directory, "profile.sock");
  const tcpPort = await freePort();
  const httpsPort = await freePort();
  let unixListener: Awaited<ReturnType<typeof listenAdapterRpc>> | undefined;
  let tlsListener: Awaited<ReturnType<typeof listenAdapterRpc>> | undefined;
  let httpsListener: Awaited<ReturnType<typeof listenAdapterHttpsRpc>> | undefined;
  try {
    await store.commit({ id: uuidv7(), engagement_id: engagementId, kind: "engagement", name: "profile-auth" }, "L2");
    unixListener = await listenAdapterRpc(service, { socket_path: socketPath, token: hostToken, resolvePrincipal: resolvePrincipal as any });
    tlsListener = await listenAdapterRpc(service, { tls_tcp: { host: "127.0.0.1", port: tcpPort, key, cert }, token: hostToken, resolvePrincipal: resolvePrincipal as any });
    httpsListener = await listenAdapterHttpsRpc(service, { host: "127.0.0.1", port: httpsPort, key, cert, resolvePrincipal: (token) => principals.get(token) });

    const profiles: Array<[string, ProfileCall, string]> = [
      ["Bun in-process", (token, operation, request) => service.dispatch(operation, principals.get(token)!, request), "validation_error"],
      ["Unix socket", socketRpcCall(() => connectNet(socketPath), principals), "validation_error"],
      ["TLS TCP", socketRpcCall(() => connectTls({ host: "127.0.0.1", port: tcpPort, ca: cert, servername: "localhost" }), principals), "unsupported_capability"],
      ["HTTPS", httpsRpcCall(httpsPort, cert), "unsupported_capability"],
    ];
    const hostOnlyProbes = [
      "work.claim", "coverage.record", "artifact.metadata", "checkpoint.commit", "action.host-decision",
    ] as const;
    const hostOnlyContracts = hostOnlyProbes.map((operation) => {
      const contract = operationContracts.find((item) => item.operation === operation);
      assert.ok(contract, `${operation} must have an operation registry contract`);
      assert.equal(contract.roles.includes("host"), true, `${operation} must permit a host principal`);
      for (const role of ["model", "reviewer"] as const) assert.equal(contract.roles.includes(role), false, `${operation} must deny ${role}`);
      return contract;
    });

    const results: Record<string, Record<string, string>> = {};
    for (const [profile, call, localArtifactIngestError] of profiles) {
      const workItemId = uuidv7();
      await store.commit({ id: workItemId, engagement_id: engagementId, kind: "work_item", title: `${profile} authorization`, status: "queued", acceptance_criteria: ["profile authorization"] }, "L2");
      const hostClaim = await call(hostToken, "work.claim", { engagement_id: engagementId, work_item_id: workItemId, agent_id: "profile-agent", host_id: "forged-host", role: "operator", principal_id: "forged-principal" });
      assert.equal(hostClaim.ok, true, `${profile}: ${JSON.stringify(hostClaim)}`);
      assert.equal(hostClaim.data.owner.host_id, "profile-host", `${profile}: request body cannot override authenticated host identity`);

      const denied: string[] = [];
      for (const token of [modelToken, reviewerToken]) {
        const result = await call(token, "work.claim", { engagement_id: engagementId, work_item_id: workItemId, agent_id: "profile-agent", role: "host", principal_id: "profile-host" });
        assert.equal(result.ok, false, `${profile}: ${JSON.stringify(result)}`);
        assert.equal(result.error.code, "authorization_error", `${profile}: ${JSON.stringify(result)}`);
        denied.push(result.error.code);
      }
      const matrix: Record<string, string> = { work: hostClaim.ok ? "allowed" : "denied" };
      for (const contract of hostOnlyContracts.slice(1)) {
        const probe = await call(hostToken, contract.operation, { engagement_id: engagementId });
        assert.notEqual(probe.error?.code, "authorization_error", `${profile} must evaluate ${contract.operation} under the registry-authorized host principal: ${JSON.stringify(probe)}`);
        for (const token of [modelToken, reviewerToken]) {
          const rejected = await call(token, contract.operation, { engagement_id: engagementId });
          assert.equal(rejected.ok, false, `${profile} ${contract.operation}: ${JSON.stringify(rejected)}`);
          assert.equal(rejected.error.code, "authorization_error", `${profile} ${contract.operation}: ${JSON.stringify(rejected)}`);
        }
        matrix[contract.operation] = "allowed";
      }
      const crossEngagement = await call(hostToken, "work.claim", { engagement_id: uuidv7(), work_item_id: workItemId, agent_id: "profile-agent" });
      assert.equal(crossEngagement.ok, false, `${profile}: cross-Engagement request should be rejected`);
      assert.equal(crossEngagement.error.code, "authorization_error", `${profile}: ${JSON.stringify(crossEngagement)}`);

      const pageResourceId = uuidv7();
      await store.commit({ id: pageResourceId, engagement_id: engagementId, kind: "resource", asset_type: "service", identity: { origin: `https://${profile.replaceAll(" ", "-")}.invalid` }, revision: 1 }, "L2");
      const pageItems = [uuidv7(), uuidv7()];
      for (const id of pageItems) await store.commit({ id, engagement_id: engagementId, kind: "work_item", title: "profile page", status: "queued", acceptance_criteria: ["preserve cursor"], resource_refs: [pageResourceId] }, "L2");
      const firstPage = await call(hostToken, "work.query", { engagement_id: engagementId, resource_refs: [pageResourceId], page_size: 1 });
      assert.equal(firstPage.ok, true, `${profile}: ${JSON.stringify(firstPage)}`);
      assert.equal(firstPage.data.items.length, 1);
      assert.equal(firstPage.data.has_more, true);
      assert.ok(firstPage.data.next_cursor);
      const nextPage = await call(hostToken, "work.query", { engagement_id: engagementId, resource_refs: [pageResourceId], page_size: 1, cursor: firstPage.data.next_cursor });
      assert.equal(nextPage.ok, true, `${profile}: ${JSON.stringify(nextPage)}`);
      assert.equal(nextPage.data.read_seq, firstPage.data.read_seq, `${profile}: pagination must preserve its read watermark`);
      assert.equal(nextPage.data.items.length, 1);
      assert.equal(nextPage.data.has_more, false);
      assert.deepEqual(new Set([firstPage.data.items[0].id, nextPage.data.items[0].id]), new Set(pageItems), `${profile}: cursor must return each match once`);

      const unsupported = await call(hostToken, "host.profile.unsupported", { engagement_id: engagementId });
      assert.equal(unsupported.ok, false, `${profile}: unsupported operation must fail explicitly`);
      assert.equal(unsupported.error.code, "unsupported_capability", `${profile}: ${JSON.stringify(unsupported)}`);
      const localPathIngest = await call(hostToken, "artifact.ingest_file", { engagement_id: engagementId });
      assert.equal(localPathIngest.ok, false, `${profile}: path-based ingestion does not become a successful fallback`);
      assert.equal(localPathIngest.error.code, localArtifactIngestError, `${profile}: ${JSON.stringify(localPathIngest)}`);
      results[profile] = { ...matrix, model: denied[0]!, reviewer: denied[1]!, cross_engagement: crossEngagement.error.code, unsupported: unsupported.error.code };
    }
    for (const profile of Object.keys(results)) assert.deepEqual(results[profile], results["Bun in-process"], `${profile} authorization differs from Core dispatch`);
  } finally {
    await httpsListener?.close();
    await tlsListener?.close();
    await unixListener?.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
