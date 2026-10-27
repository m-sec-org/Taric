import test from "node:test";
import assert from "node:assert/strict";
import { GatewayArgumentError, parseGatewayArguments } from "../dist/gateway-args.js";

test("gateway arguments keep listener and runtime files independent", () => {
  assert.deepEqual(parseGatewayArguments(["--config", "/etc/taric/gateway.json", "--runtime-config", "/etc/taric/runtime.json"]), {
    configPath: "/etc/taric/gateway.json",
    runtimeConfigPath: "/etc/taric/runtime.json",
  });
  assert.equal(Object.isFrozen(parseGatewayArguments(["--config", "gateway.json"])), true);
});

test("gateway argument parsing rejects missing, duplicate, unknown, and conflicting paths", () => {
  for (const args of [
    [],
    ["--config"],
    ["--runtime-config", "runtime.json"],
    ["--config", "gateway.json", "--config", "other.json"],
    ["--config", "gateway.json", "--runtime-config"],
    ["--config", "gateway.json", "--runtime-config", "gateway.json"],
    ["--config", "./gateway.json", "--runtime-config", "gateway.json"],
    ["--listener", "gateway.json"],
  ]) assert.throws(() => parseGatewayArguments(args), GatewayArgumentError);
});
