# gh-action-auto-merge-dependency-updates

A GitHub action that will automatically approve and merge a PR that only contains dependency updates, based on some rules.

If you run tests on PR's make sure you [configure those as required status checks](https://docs.github.com/en/github/administering-a-repository/enabling-required-status-checks) so that they need to go green before the merge can occur.

Note that the action does not check the lockfile is valid, so you should only set `allowed-actors` you trust, or validate that the lockfile is correct in another required action.

It currently supports npm and yarn.

## Config

- `repo-token`: a GitHub API token. E.g. `${{ secrets.GITHUB_TOKEN }}`
- `allowed-actors`: A comma separated list of usernames auto merge is allowed for.
- `allowed-update-types` (optional): A comma separated list of types of updates that are allowed. Supported: [devDependencies|dependencies]:[major|minor|patch]. _Default: `devDependencies:minor, devDependencies:patch`_
- `approve` (optional): Automatically approve the PR if it qualifies for auto merge. _Default: `true`_
- `package-block-list` (optional): A comma separated list of packages that auto merge should not be allowed for.

You should configure this action to run on the `pull_request` event.

## Example Action

```yaml
name: Auto Merge Dependency Updates

on:
  - pull_request

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: tjenkinson/gh-action-auto-merge-dependency-updates@v1
        with:
          repo-token: ${{ secrets.GITHUB_TOKEN }}
          allowed-actors: dependabot-preview[bot], dependabot[bot]
```
