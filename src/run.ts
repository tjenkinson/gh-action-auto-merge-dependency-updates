import * as core from '@actions/core';
import * as github from '@actions/github';
import * as Webhooks from '@octokit/webhooks';
import { detailedDiff } from 'deep-object-diff';
import semver from 'semver';

const semverRegex = /^([~^]?)[0-9]+\.[0-9]+\.[0-9]+(-.+)?$/;
const retryDelays = [1, 1, 1, 2, 3, 4, 5, 10, 20, 40, 60, 60, 60, 120].map(
  (a) => a * 1000
);

function isWantedPayload(
  payload: any
): payload is
  | Webhooks.EventPayloads.WebhookPayloadPullRequest
  | Webhooks.EventPayloads.WebhookPayloadPullRequestReview {
  return ['pull_request', 'pull_request_review'].includes(payload.eventName);
}

export async function run(): Promise<void> {
  core.info('Starting');

  const context = github.context;
  core.debug(JSON.stringify(context, null, 2));

  const payload = github.context.payload;
  if (!isWantedPayload(payload)) {
    core.error(`Unsupported event name: ${payload.eventName}`);
    return;
  }

  const token = core.getInput('repo-token', { required: true });

  const allowedActors = core
    .getInput('allowed-actors', { required: true })
    .split(',')
    .map((a) => a.trim());

  const allowedUpdateTypes: Record<string, string[]> = {};
  core
    .getInput('allowed-update-types', { required: true })
    .split(',')
    .forEach((group) => {
      const parts = group
        .trim()
        .split(':', 2)
        .map((a) => a.trim());
      if (parts.length !== 2 || !parts.every((a) => typeof a === 'string')) {
        throw new Error('allowed-update-types invalid');
      }
      const [dependencyType, bumpType] = parts;
      if (!allowedUpdateTypes[dependencyType]) {
        allowedUpdateTypes[dependencyType] = [];
      }
      allowedUpdateTypes[dependencyType].push(bumpType);
    });

  const packageBlockList = (core.getInput('package-block-list') || '')
    .split(',')
    .map((a) => a.trim());

  const pr = payload.pull_request;

  if (!allowedActors.includes(context.actor)) {
    core.error(`Actor not allowed: ${context.actor}`);
    return;
  }

  const octokit = github.getOctokit(token);

  const readPackageJson = async (ref: string): Promise<Record<string, any>> => {
    const content = await octokit.repos.getContent({
      owner: context.repo.owner,
      repo: context.repo.repo,
      path: 'package.json',
      ref,
    });
    if (content.data.type !== 'file' || content.data.encoding !== 'base64') {
      throw new Error('Unexpected repo content response');
    }
    return JSON.parse(
      Buffer.from(content.data.content, 'base64').toString('utf-8')
    );
  };

  const mergeWhenPossible = async (expectedSha: string): Promise<void> => {
    for (let i = 0; i < retryDelays.length; i++) {
      core.info(`Attempt: ${i}`);
      const prData = await getPR();
      if (prData.data.merge_commit_sha !== expectedSha) {
        core.error(
          `PR changed. ${prData.data.merge_commit_sha} !== ${expectedSha}`
        );
        return;
      }
      if (prData.data.state !== 'open') {
        core.error('PR is not open');
        return;
      }
      const mergeable = prData.data.mergeable;
      if (mergeable) {
        try {
          core.info('Attempting merge');
          await octokit.pulls.merge({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pr.number,
            sha: prData.data.head.sha,
            commit_message:
              'Merged by [tjenkinson/gh-action-auto-merge-dependency-updates](https://github.com/tjenkinson/gh-action-auto-merge-dependency-updates)',
          });
          core.info('Merged');
          return;
        } catch (e) {
          if (e.status && e.status === 409) {
            core.error('Failed to merge. PR head changed');
            return;
          }
          core.error(`Merge failed: ${e}`);
        }
      } else {
        core.error('Not mergeable yet');
      }

      core.info(`Retry in ${retryDelays[i]} ms`);
      await new Promise((resolve) =>
        setTimeout(() => resolve(), retryDelays[i])
      );
    }
    core.error('Ran out of retries');
  };

  const getCommit = () =>
    octokit.repos.getCommit({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: context.ref,
    });

  const getPR = () =>
    octokit.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number,
    });

  const validVersionChange = (
    oldVersion: string,
    newVersion: string,
    allowedBumpTypes: string[]
  ): boolean => {
    const oldVersionMatches = semverRegex.exec(oldVersion);
    if (!oldVersionMatches) {
      return false;
    }
    const newVersionMatches = semverRegex.exec(newVersion);
    if (!newVersionMatches) {
      return false;
    }
    const oldVersionPrefix = oldVersionMatches[1];
    const newVersionPrefix = newVersionMatches[1];
    if (oldVersionPrefix !== newVersionPrefix) {
      return false;
    }

    const oldVersionExact = oldVersion.slice(oldVersionPrefix.length);
    const newVersionExact = newVersion.slice(newVersionPrefix.length);

    if (semver.gte(oldVersionExact, newVersionExact)) {
      return false;
    }

    const allowed: Array<string | null> = [];
    if (allowedBumpTypes.includes('major')) {
      allowed.push('major');
    }
    if (allowedBumpTypes.includes('minor')) {
      allowed.push('minor');
    }
    if (allowedBumpTypes.includes('patch')) {
      allowed.push('patch');
    }
    return allowed.includes(semver.diff(oldVersionExact, newVersionExact));
  };

  core.info('Getting commit info');
  const commit = await getCommit();
  const onlyPackageJsonChanged = commit.data.files.every(
    ({ filename, status }) =>
      ['package.json', 'package-lock.json'].includes(filename) &&
      status === 'modified'
  );
  if (!onlyPackageJsonChanged) {
    core.error('More changed than the package.json and package-lock.json');
    return;
  }

  core.info('Getting base');
  const base = pr.base;

  core.info('Retrieving package.json');
  const packageJsonBase = await readPackageJson(base.ref);
  const packageJsonPr = await readPackageJson(context.ref);

  core.info('Calculating diff');
  const diff: any = detailedDiff(packageJsonBase, packageJsonPr);
  if (Object.keys(diff.added).length || Object.keys(diff.deleted).length) {
    core.error('Unexpected changes');
    return;
  }
  core.debug(JSON.stringify(diff, null, 2));

  core.info('Checking diff');

  const allowedChange = Object.keys(diff.updated).every((prop) => {
    if (
      !['dependencies', 'devDependencies'].includes(prop) ||
      typeof diff.updated[prop] !== 'object'
    ) {
      return false;
    }

    const allowedBumpTypes = allowedUpdateTypes[prop] || [];
    if (!allowedBumpTypes.length) {
      return false;
    }

    const changedDependencies = diff.updated[prop];
    return Object.keys(changedDependencies).every((dependency) => {
      if (typeof changedDependencies[dependency] !== 'string') {
        return false;
      }
      if (packageBlockList.includes(dependency)) {
        return false;
      }
      const oldVersion = packageJsonBase[prop][dependency];
      const newVersion = packageJsonPr[prop][dependency];
      if (typeof oldVersion !== 'string' || typeof newVersion !== 'string') {
        return false;
      }
      return validVersionChange(oldVersion, newVersion, allowedBumpTypes);
    });
  });

  if (!allowedChange) {
    core.error('One or more version changes are not allowed');
    return;
  }

  core.info('Merging when possible');
  await mergeWhenPossible(context.sha);
  core.info('Finished!');
}
