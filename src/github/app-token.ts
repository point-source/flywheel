import { createAppAuth } from '@octokit/auth-app';

export interface AppTokenOptions {
  appId: string | number;
  privateKey: string;
  /** Owner of the repo to scope the token to. Required. */
  owner: string;
  /** Repo name to scope the token to. If omitted, token covers all repos. */
  repo?: string;
}

/**
 * Mint a short-lived GitHub App installation token from APP_ID + private key.
 *
 * Why an App token instead of GITHUB_TOKEN: per spec.md §47, GITHUB_TOKEN
 * cannot trigger downstream `on: push` workflows. The whole pipeline
 * relies on bot pushes to develop/staging triggering the next stage, so we
 * need an App-issued token (which IS treated as a real actor by the
 * trigger system).
 */
export async function mintAppToken(opts: AppTokenOptions): Promise<string> {
  const auth = createAppAuth({
    appId: opts.appId,
    privateKey: opts.privateKey,
  });

  // First, get a JWT to look up the installation.
  const installationsResponse = await fetch('https://api.github.com/app/installations', {
    headers: {
      Authorization: `Bearer ${(await auth({ type: 'app' })).token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!installationsResponse.ok) {
    throw new Error(
      `failed to list app installations: HTTP ${installationsResponse.status}`,
    );
  }
  const installations = (await installationsResponse.json()) as Array<{
    id: number;
    account: { login: string };
  }>;
  const installation = installations.find(
    (i) => i.account.login.toLowerCase() === opts.owner.toLowerCase(),
  );
  if (!installation) {
    throw new Error(
      `App is not installed on owner "${opts.owner}". Available: ${installations.map((i) => i.account.login).join(', ') || '<none>'}`,
    );
  }

  // Mint installation token, optionally scoped to a single repo.
  const auth2 = await auth({
    type: 'installation',
    installationId: installation.id,
    repositoryNames: opts.repo ? [opts.repo] : undefined,
  });
  return auth2.token;
}
