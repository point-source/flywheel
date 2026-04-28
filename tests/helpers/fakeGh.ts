import type {
  Commit,
  CreateCheckOptions,
  EnableAutoMergeResult,
  GitHubClient,
  MergeMethod,
  MergeResult,
  PRSummary,
} from "../../src/github.js";

export interface FakeCall {
  method: string;
  args: unknown;
}

export interface FakeGhInit {
  pullCommits?: Record<number, Commit[]>;
  branchCommits?: Record<string, Commit[]>;
  openPRs?: Record<string, PRSummary[]>;
  enableAutoMergeResponse?: EnableAutoMergeResult;
  mergePRResponse?: MergeResult;
  prLabels?: Record<number, string[]>;
}

export interface FakeGh extends GitHubClient {
  calls: FakeCall[];
  prLabels: Record<number, string[]>;
  prTitles: Record<number, string>;
  prBodies: Record<number, string | null>;
  createdChecks: CreateCheckOptions[];
  createdPRs: Array<{ title: string; body: string; head: string; base: string }>;
  autoMergeEnabledFor: string[];
  autoMergeDisabledFor: string[];
  directMergedPRs: number[];
}

export function createFakeGh(init: FakeGhInit = {}): FakeGh {
  const calls: FakeCall[] = [];
  const prLabels: Record<number, string[]> = { ...(init.prLabels ?? {}) };
  const prTitles: Record<number, string> = {};
  const prBodies: Record<number, string | null> = {};
  const createdChecks: CreateCheckOptions[] = [];
  const createdPRs: Array<{ title: string; body: string; head: string; base: string }> = [];
  const autoMergeEnabledFor: string[] = [];
  const autoMergeDisabledFor: string[] = [];
  const directMergedPRs: number[] = [];
  const pullCommits = init.pullCommits ?? {};
  const branchCommits = init.branchCommits ?? {};
  const openPRs = init.openPRs ?? {};
  const enableAutoMergeResponse: EnableAutoMergeResult = init.enableAutoMergeResponse ?? { ok: true };
  const mergePRResponse: MergeResult =
    init.mergePRResponse ?? { ok: true, sha: "merged0000000000000000000000000000000000" };

  const log = (method: string, args: unknown) => calls.push({ method, args });

  const fake: FakeGh = {
    calls,
    prLabels,
    prTitles,
    prBodies,
    createdChecks,
    createdPRs,
    autoMergeEnabledFor,
    autoMergeDisabledFor,
    directMergedPRs,
    owner: "testorg",
    repo: "testrepo",

    async updatePR(number, fields) {
      log("updatePR", { number, fields });
      if (fields.title !== undefined) prTitles[number] = fields.title;
      if (fields.body !== undefined) prBodies[number] = fields.body;
    },

    async addLabels(number, labels) {
      log("addLabels", { number, labels });
      const set = new Set(prLabels[number] ?? []);
      for (const l of labels) set.add(l);
      prLabels[number] = [...set];
    },

    async removeLabel(number, label) {
      log("removeLabel", { number, label });
      prLabels[number] = (prLabels[number] ?? []).filter((l) => l !== label);
    },

    async enableAutoMerge(prNodeId, method: MergeMethod) {
      log("enableAutoMerge", { prNodeId, method });
      if (enableAutoMergeResponse.ok) {
        autoMergeEnabledFor.push(prNodeId);
      }
      return enableAutoMergeResponse;
    },

    async disableAutoMerge(prNodeId) {
      log("disableAutoMerge", { prNodeId });
      autoMergeDisabledFor.push(prNodeId);
    },

    async mergePR(prNumber, method) {
      log("mergePR", { prNumber, method });
      if (mergePRResponse.ok) directMergedPRs.push(prNumber);
      return mergePRResponse;
    },

    async listPullCommits(prNumber) {
      log("listPullCommits", { prNumber });
      return pullCommits[prNumber] ?? [];
    },

    async listBranchCommits(branch, perPage) {
      log("listBranchCommits", { branch, perPage });
      return branchCommits[branch] ?? [];
    },

    async listOpenPRs(opts) {
      log("listOpenPRs", opts);
      return openPRs[`${opts.head}->${opts.base}`] ?? [];
    },

    async createPR(opts) {
      log("createPR", opts);
      createdPRs.push(opts);
      return {
        number: 999,
        nodeId: "PR_node_999",
        title: opts.title,
        body: opts.body,
      };
    },

    async createCheck(opts) {
      log("createCheck", opts);
      createdChecks.push(opts);
    },
  };

  return fake;
}

export function makeCommit(sha: string, message: string, committerDate?: string): Commit {
  const idx = message.indexOf("\n");
  const title = idx === -1 ? message : message.slice(0, idx);
  const body = idx === -1 ? "" : message.slice(idx + 1).replace(/^\n+/, "");
  return {
    sha,
    message,
    title,
    body,
    committerDate: committerDate ?? new Date(0).toISOString(),
  };
}

export function silentLogger() {
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    infos,
    warnings,
    log: {
      info: (m: string) => infos.push(m),
      warning: (m: string) => warnings.push(m),
    },
  };
}
