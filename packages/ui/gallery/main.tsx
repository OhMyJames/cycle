// The gallery page: `index.html?s=<scenario>` draws that scenario with the real components over a scripted
// bridge, `?s=tokens` draws the tokens, and no `s` lists the scenarios. `&theme=light|dark` forces a scheme.
import { App, StoreProvider } from "@cycle/ui/react";
import { AppStore, BLANK_KEY, viewKey } from "@cycle/ui/store";
import { createRoot } from "react-dom/client";
import { fakeBridge } from "../test/fake-bridge.ts";
import { LOCAL, type Scenario, scenarios, sessionSnapshotOf, UP } from "./scenarios.ts";

const params = new URLSearchParams(location.search);
const name = params.get("s");
const theme = params.get("theme");
if (theme === "light" || theme === "dark") document.documentElement.style.colorScheme = theme;
// `&platform=darwin` draws it as it is on a Mac (the title bar); otherwise as the user agent says.
document.documentElement.dataset.platform =
  params.get("platform") ?? (/Mac/.test(navigator.userAgent) ? "darwin" : "other");

const root = document.getElementById("root");
if (root === null) throw new Error("no #root");

const bridgeFor = (scenario: Scenario) => {
  const script = fakeBridge({
    connected: true,
    ...(scenario.update ? { update: scenario.update } : {}),
    ...(scenario.analytics ? { analytics: { available: true, enabled: true, noticed: true } } : {}),
    ...(scenario.language ? { preferences: { language: scenario.language } } : {}),
    ...(scenario.connectors ? { connectors: scenario.connectors } : {}),
    ...(scenario.plugins ? { plugins: scenario.plugins } : {}),
    ...(scenario.account ? { account: scenario.account } : {}),
  });
  const environments = scenario.environments ?? [LOCAL];
  const status =
    scenario.status ??
    environments.map((h) =>
      scenario.trust !== undefined
        ? {
            ...UP(h.id),
            capabilities: { queue: true, files: true, folders: true, trust: true },
          }
        : UP(h.id),
    );
  if (scenario.trust !== undefined) {
    const trusted = scenario.trust;
    script.bridge.readTrust = async (_environment, path) => ({
      path,
      trusted,
      from: trusted === null ? null : path,
    });
  }
  const sessions = Object.fromEntries(
    environments.map((environment) => [
      environment.id,
      (scenario.sessions ?? []).filter((session) => session.environmentId === environment.id),
    ]),
  );
  const planUsage = scenario.planUsage ?? {};
  script.bridge.planUsage = async () => planUsage;
  script.bridge.environments = async () => ({ environments, status, sessions });
  script.bridge.sessions = async (environmentId) => sessions[environmentId] ?? [];
  script.bridge.openSession = async (_environmentId, sessionId) =>
    sessionSnapshotOf(scenario, sessionId);
  script.bridge.agents = async () =>
    scenario.noAgents
      ? []
      : [
          {
            id: "claude",
            name: "Claude",
            available: true,
            ...(scenario.attach ? { promptCapabilities: { image: {} } } : {}),
            configSchema: {
              type: "object",
              properties: {
                model: {
                  type: "string",
                  title: "Model",
                  oneOf: [
                    {
                      const: "default",
                      title: "Default model",
                      description: "Uses your Claude Code default.",
                    },
                    {
                      const: "sonnet",
                      title: "Sonnet",
                      description: "Balanced speed for everyday coding.",
                    },
                    {
                      const: "opus",
                      title: "Opus",
                      description: "Most capable for complex work.",
                    },
                    {
                      const: "haiku",
                      title: "Haiku",
                      description: "Fastest for quick edits and lookups.",
                    },
                  ],
                  default: "default",
                },
                effort: {
                  type: "string",
                  title: "Effort",
                  oneOf: [
                    {
                      const: "default",
                      title: "Default",
                      description: "Model default reasoning depth.",
                    },
                    {
                      const: "low",
                      title: "Low",
                      description: "Minimal reasoning for quick tasks.",
                    },
                    {
                      const: "medium",
                      title: "Medium",
                      description: "Balanced depth and speed.",
                    },
                    {
                      const: "high",
                      title: "High",
                      description: "Deeper reasoning for complex changes.",
                    },
                    {
                      const: "xhigh",
                      title: "XHigh",
                      description: "Extended reasoning for hard problems.",
                    },
                    {
                      const: "max",
                      title: "Max",
                      description: "Maximum depth for this session.",
                    },
                  ],
                  default: "default",
                },
                mode: {
                  type: "string",
                  title: "Permission mode",
                  oneOf: [
                    {
                      const: "auto",
                      title: "Auto",
                      description: "Reviews actions automatically; asks when unsure.",
                      _meta: { "cycle/recommended": true },
                    },
                    {
                      const: "default",
                      title: "Ask before acting",
                      description: "Asks before editing files or running commands.",
                    },
                    {
                      const: "plan",
                      title: "Plan mode",
                      description: "Plans changes first; waits for approval.",
                    },
                    {
                      const: "bypassPermissions",
                      title: "Bypass permissions",
                      description: "Runs all edits and commands without asking.",
                      _meta: { "cycle/danger": true },
                    },
                  ],
                  default: "auto",
                },
              },
            },
          },
        ];
  if (scenario.secondAgent) {
    const first = script.bridge.agents;
    script.bridge.agents = async (environmentId) => [
      ...(await first(environmentId)),
      { id: "codex", name: "Codex", available: true, configSchema: {} },
    ];
  }
  return script;
};

const list = () => {
  root.innerHTML = "";
  const ul = document.createElement("ul");
  ul.style.cssText = "font: 14px system-ui; padding: 1rem 2rem; line-height: 1.8";
  const all: [string, { title: string }][] = [
    ["tokens", { title: "Tokens, type, spacing, controls" }],
    ...Object.entries(scenarios),
  ];
  for (const [key, s] of all) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `?s=${key}`;
    a.textContent = key;
    li.append(a, ` - ${s.title}`);
    ul.append(li);
  }
  root.append(ul);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const scenario = async (key: string) => {
  const s = scenarios[key];
  if (s === undefined) return list();
  const script = bridgeFor(s);
  const store = new AppStore(script.bridge);
  createRoot(root).render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await store.start();
  // The first session is chosen, as a click would.
  if (s.history !== undefined && (s.sessions ?? []).length > 0) {
    for (let i = 0; i < 100 && root.querySelector('[role="option"]') === null; i++) await sleep(30);
    (root.querySelector('[role="option"]') as HTMLElement | null)?.click();
    const first = s.sessions?.[0];
    if (s.sidePanel && first !== undefined)
      store.sidePanels.show(viewKey(first.environmentId, first.sessionId), "overview");
  }
  if (s.blank !== undefined) {
    if (s.blank.starting !== undefined) script.bridge.createSession = () => new Promise(() => {});
    store.openBlank({ environmentId: "local", cwd: s.blank.cwd });
    if (s.blank.starting !== undefined) {
      await sleep(100);
      store.drafts.setText(BLANK_KEY, s.blank.starting);
      void store.send();
    }
  }
  await sleep(300);
  await s.after?.(root, script.emit);
  await sleep(400);
  document.title = "ready";
};

if (name === null) list();
else if (name === "tokens")
  void import("./tokens.tsx").then(({ drawTokens }) => {
    drawTokens(root);
    document.title = "ready";
  });
else void scenario(name);
