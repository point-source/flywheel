import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";

export interface InstallationAuth {
  token: string;
  permissions: Record<string, string>;
  installationId: number;
  appSlug: string | null;
}

/**
 * Mints a fresh installation token for `owner/repo`, signing a JWT with the
 * App's private key, looking up the App's installation on the repo, and
 * exchanging the JWT for an installation token. Returns the token alongside
 * the permissions GitHub actually granted (which `preflight.ts` validates
 * before any work proceeds).
 */
export async function mintInstallationToken(
  appId: string,
  privateKey: string,
  owner: string,
  repo: string,
): Promise<InstallationAuth> {
  const auth = createAppAuth({ appId, privateKey });

  const appJwt = await auth({ type: "app" });
  const installation = await request("GET /repos/{owner}/{repo}/installation", {
    owner,
    repo,
    headers: { authorization: `bearer ${appJwt.token}` },
  });

  const installationToken = await auth({
    type: "installation",
    installationId: installation.data.id,
  });

  return {
    token: installationToken.token,
    permissions: installationToken.permissions ?? {},
    installationId: installation.data.id,
    appSlug: installation.data.app_slug ?? null,
  };
}
