// A packaged app that starts signed in, to a stand-in provider of the test's own (.agents/notes/2026-11-23-sso-login-desktop-must-sign-in.md).
// `CYCLE_SSO_ISSUER` points the app at it, which also keeps the login in a file of the test's (never the keychain), and
// the file is written here as a sign-in would have left it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type MockIdp, startMockIdp } from "@cycle/oidc/mock-idp";

export const signedIn = async (
  userDataDir: string,
): Promise<{ idp: MockIdp; env: { CYCLE_SSO_ISSUER: string } }> => {
  const idp = await startMockIdp();
  mkdirSync(userDataDir, { recursive: true });
  const user = idp.controls.user;
  writeFileSync(
    join(userDataDir, "account-test.json"),
    JSON.stringify({
      issuer: idp.issuer,
      clientId: idp.clientId,
      sub: user.sub,
      name: user.name ?? "",
      email: user.email ?? "",
      renewedAt: Date.now(),
      refreshToken: idp.issueRefreshToken(),
    }),
    { mode: 0o600 },
  );
  return { idp, env: { CYCLE_SSO_ISSUER: idp.issuer } };
};
