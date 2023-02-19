import * as core from '@actions/core';
import * as github from '@actions/github';
import { EmitterWebhookEvent } from '@octokit/webhooks';
import { GitHub, getOctokitOptions } from '@actions/github/lib/utils';
import { throttling } from '@octokit/plugin-throttling';
import { detailedDiff } from 'deep-object-diff';
import semver from 'semver';
import { Result } from './result';

type MergeMethod = 'merge' | 'squash' | 'rebase';
const mergeMethods: ReadonlyArray<MergeMethod> = ['merge', 'squash', 'rebase'];
const isMergeMethod = (method: string): method is MergeMethod => {
  return mergeMethods.includes(method as MergeMethod);
};
const toMergeMethod = (method: string): MergeMethod => {
  if (isMergeMethod(method)) {
    return method;
  }
  throw new Error(`merge-method invalid: ${method}`);
};

const semverRegex = /^([~^]?)[0-9]+\.[0-9]+\.[0-9]+(-.+)?$/;
const retryDelays = [1, 1, 1, 2, 3, 4, 5, 10, 20, 40, 60].map((a) => a * 1000);
const timeout = 6 * 60 * 60 * 1000;

export async function run(): Promise<Result> {
  const startTime = Date.now();
  core.info('Starting');

  const context = github.context;
  core.debug(JSON.stringify(context, null, 2));

  if (
    !['pull_request', 'pull_request_target', 'pull_request_review'].includes(
      github.context.eventName
    )
  ) {
    core.error(`Unsupported event name: ${github.context.eventName}`);
    return Result.UnknownEvent;
  }
  const payload: EmitterWebhookEvent<
    'pull_request' | 'pull_request_review'
  >['payload'] = github.context.payload as any;

  const token = core.getInput('repo-token', { required: true });

  const allowedActors = core
    .getInput('allowed-actors', { required: true })
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);

  const allowedUpdateTypes: Record<string, string[]> = {};
  core
    .getInput('allowed-update-types', { required: true })
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
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

  const approve = core.getInput('approve') === 'true';

  const packageBlockList = (core.getInput('package-block-list') || '')
    .split(',')
    .map((a) => a.trim());

  const packageAllowListRaw = core.getInput('package-allow-list');
  const packageAllowList = packageAllowListRaw
    ? packageAllowListRaw.split(',').map((a) => a.trim())
    : null;

  if (!allowedActors.includes(context.actor)) {
    core.error(`Actor not allowed: ${context.actor}`);
    return Result.ActorNotAllowed;
  }

  const merge = core.getInput('merge') === 'true';
  const mergeMethod = toMergeMethod(
    core.getInput('merge-method', { required: true })
  );

  const pr = payload.pull_request;

  const Octokit = GitHub.plugin(throttling);
  const octokit = new Octokit(
    getOctokitOptions(token, {
      throttle: {
        onRateLimit: /* istanbul ignore next */ (retryAfter: number) => {
          core.warning(`Hit rate limit. Retrying in ${retryAfter} seconds`);
          return true;
        },
        onAbuseLimit: /* istanbul ignore next */ (retryAfter: number) => {
          core.warning(`Hit abuse limit. Retrying in ${retryAfter} seconds`);
          return true;
        },
      },
    })
  );

  const readPackageJson = async (ref: string): Promise<Record<string, any>> => {
    const content = await octokit.rest.repos.getContent({
      owner: context.repo.owner,
      repo: context.repo.repo,
      path: 'package.json',
      ref,
    });

    if (
      !('type' in content.data) ||
      content.data.type !== 'file' ||
      !('encoding' in content.data) ||
      content.data.encoding !== 'base64'
    ) {
      throw new Error('Unexpected repo content response');
    }
    return JSON.parse(
      Buffer.from(content.data.content, 'base64').toString('utf-8')
    );
  };

  const mergeWhenPossible = async (): Promise<
    Result.PRNotOpen | Result.PRHeadChanged | Result.PRMerged
  > => {
    for (let i = 0; ; i++) {
      core.info(`Attempt: ${i}`);
      const livePR = await getPR();
      core.debug(JSON.stringify(livePR, null, 2));
      if (livePR.data.state !== 'open') {
        core.error('PR is not open');
        return Result.PRNotOpen;
      }
      const mergeable = livePR.data.mergeable;
      if (mergeable) {
        try {
          core.info('Attempting merge');
          await octokit.rest.pulls.merge({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pr.number,
            merge_method: mergeMethod,
            sha: pr.head.sha,
          });
          core.info('Merged');
          return Result.PRMerged;
        } catch (e) {
          if (e && typeof e === 'object' && 'status' in e && e.status === 409) {
            core.error('Failed to merge. PR head changed');
            return Result.PRHeadChanged;
          }
          core.error(`Merge failed: ${e}`);
        }
      } else {
        core.error('Not mergeable yet');
      }

      if (Date.now() - startTime >= timeout) {
        break;
      }

      const delay = retryDelays[Math.min(retryDelays.length - 1, i)];
      core.info(`Retry in ${delay} ms`);
      await new Promise<void>((resolve) => setTimeout(() => resolve(), delay));
    }
    core.error('Timed out');
    throw new Error('Timed out');
  };

  const getPR = () =>
    octokit.rest.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number,
    });

  const compareCommits = () =>
    octokit.rest.repos.compareCommits({
      owner: context.repo.owner,
      repo: context.repo.repo,
      base: pr.base.sha,
      head: pr.head.sha,
    });

  const approvePR = async () => {
    const review = await octokit.rest.pulls.createReview({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number,
      commit_id: pr.head.sha,
    });
    await octokit.rest.pulls.submitReview({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number,
      review_id: review.data.id,
      event: 'APPROVE',
    });
  };

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

  core.info('Getting PR files');
  const comparison = await compareCommits();
  core.debug(JSON.stringify(comparison, null, 2));
  if (!comparison.data.files) {
    throw new Error('Unexpected error. `files` missing in commit comparison');
  }
  const onlyPackageJsonChanged = comparison.data.files.every(
    ({ filename, status }) =>
      ['package.json', 'package-lock.json', 'yarn.lock'].includes(filename) &&
      status === 'modified'
  );
  if (!onlyPackageJsonChanged) {
    core.error('More changed than the package.json and lockfile');
    return Result.FileNotAllowed;
  }

  core.info('Retrieving package.json');
  const packageJsonBase = await readPackageJson(pr.base.sha);
  const packageJsonPr = await readPackageJson(pr.head.sha);

  core.info('Calculating diff');
  const diff: any = detailedDiff(packageJsonBase, packageJsonPr);
  core.debug(JSON.stringify(diff, null, 2));
  if (Object.keys(diff.added).length || Object.keys(diff.deleted).length) {
    core.error('Unexpected changes');
    return Result.UnexpectedChanges;
  }

  core.info('Checking diff');

  const allowedPropsChanges = Object.keys(diff.updated).every((prop) => {
    return (
      ['dependencies', 'devDependencies'].includes(prop) &&
      typeof diff.updated[prop] === 'object'
    );
  });
  if (!allowedPropsChanges) {
    core.error('Unexpected property change');
    return Result.UnexpectedPropertyChange;
  }

  const allowedChange = Object.keys(diff.updated).every((prop) => {
    const allowedBumpTypes = allowedUpdateTypes[prop] || [];
    const changedDependencies = diff.updated[prop];
    return Object.keys(changedDependencies).every((dependency) => {
      if (typeof changedDependencies[dependency] !== 'string') {
        return false;
      }
      if (packageAllowList && !packageAllowList.includes(dependency)) {
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
    return Result.VersionChangeNotAllowed;
  }

  core.setOutput('success', 'true');

  if (approve) {
    core.info('Approving PR');
    await approvePR();
  }

  let result = Result.PRMergeSkipped;
  if (merge) {
    core.info('Merging when possible');
    result = await mergeWhenPossible();
  }
  core.info('Finished!');
  return result;
}
