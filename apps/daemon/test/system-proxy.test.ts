// The proxy an agent process is handed (CYC-296): what scutil says, and what wins over it.
import { expect, test } from "bun:test";
import { agyEnv } from "../src/agy-agent.ts";
import { claudeEnv } from "../src/claude-agent.ts";
import { codexEnv } from "../src/codex-agent.ts";
import { ConfigSchema } from "../src/config.ts";
import { parseScutilProxy, systemProxyFill } from "../src/system-proxy.ts";

const SCUTIL = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 192.168.0.0/16
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
}`;

const system = () => parseScutilProxy(SCUTIL);

test("scutil's proxy becomes variables; a disabled one does not", () => {
  expect(system()).toEqual({
    HTTPS_PROXY: "http://127.0.0.1:7890",
    HTTP_PROXY: "http://127.0.0.1:7890",
    NO_PROXY: ".local,192.168.0.0/16",
  });
  expect(parseScutilProxy("<dictionary> {\n  HTTPEnable : 0\n}")).toEqual({});
  expect(
    parseScutilProxy("<dictionary> {\n  SOCKSEnable : 1\n  SOCKSPort : 1080\n  SOCKSProxy : h\n}"),
  ).toEqual({ ALL_PROXY: "socks5://h:1080" });
});

test("the system proxy fills what is missing, in both spellings, and nothing else wins over it", () => {
  const allow = ConfigSchema.parse({}).agy.allowEnv;
  const filled = systemProxyFill(allow, {}, {}, system);
  expect(filled.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
  expect(filled.https_proxy).toBe("http://127.0.0.1:7890");
  // The daemon's own variable, either spelling, or config.json's, keeps the system's out.
  expect(
    systemProxyFill(allow, { https_proxy: "http://x:1" }, {}, system).HTTPS_PROXY,
  ).toBeUndefined();
  expect(
    systemProxyFill(allow, {}, { HTTPS_PROXY: "http://y:2" }, system).https_proxy,
  ).toBeUndefined();
  // Only the spellings the allowlist names are filled.
  expect(systemProxyFill(["HTTPS_PROXY"], {}, {}, system)).toEqual({
    HTTPS_PROXY: "http://127.0.0.1:7890",
  });
  // An allowlist that leaves the proxy out leaves it out.
  expect(systemProxyFill(["PATH"], {}, {}, system)).toEqual({});
});

test("the proxy variables pass by default to agy, Claude and Codex", () => {
  const config = ConfigSchema.parse({});
  const inherited = { HTTPS_PROXY: "http://p:1", no_proxy: "localhost", SECRET_KEY: "x" };
  for (const env of [
    agyEnv(config.agy, "/d", inherited),
    claudeEnv(config.claude, "/d", inherited),
    codexEnv(config.codex, "/d", inherited),
  ]) {
    expect(env.HTTPS_PROXY).toBe("http://p:1");
    expect(env.no_proxy).toBe("localhost");
    expect(env.SECRET_KEY).toBeUndefined();
  }
});
