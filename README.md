# gh-action-auto-merge-dependency-updates

A GitHub action that will automatically approve and merge a PR that only contains dependency updates, based on some rules.

If you run tests on PR's make sure you [configure those as required status checks](https://docs.github.com/en/github/administering-a-repository/enabling-required-status-checks) so that they need to go green before the merge can occur.

Note that the action does not check the lockfile is valid, so you should only set `allowed-actors` you trust, or validate that the lockfile is correct in another required action.

It currently supports npm and yarn.

## Config

- `allowed-actors`: A comma separated list of usernames auto merge is allowed for.
- `repo-token` (optional): a GitHub API token. _Default: The token provided to the workflow (`${{ github.token }}`)_
- `allowed-update-types` (optional): A comma separated list of types of updates that are allowed. Supported: [devDependencies|dependencies]:[major|minor|patch]. _Default: `devDependencies:minor, devDependencies:patch`_
- `approve` (optional): Automatically approve the PR if it qualifies for auto merge. _Default: `true`_
- `package-block-list` (optional): A comma separated list of packages that auto merge should not be allowed for.
- `package-allow-list` (optional): A comma separated list of packages that auto merge should only be allowed for. Omit to allow all packages.
- `merge` (optional): Merge the PR if it qualifies. _Default: `true`_
- `merge-method` (optional): Merge method. Supported: `merge`, `squash`, `rebase` _Default: `merge`_

You should configure this action to run on the `pull_request_target` event. If you use `pull_request` you might need to provide a custom `repo-token` which has permission to merge. [The default token for dependabot PRs only has read-only access](https://github.blog/changelog/2021-02-19-github-actions-workflows-triggered-by-dependabot-prs-will-run-with-read-only-permissions/).

## Outputs

A `success` output is set to `true` if a commit is eligible for auto merge.

## Example Action

```yaml
name: Auto Merge Dependency Updates

on:
  - pull_request_target

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: tjenkinson/gh-action-auto-merge-dependency-updates@v1
        with:
          allowed-actors: dependabot-preview[bot], dependabot[bot]
```
