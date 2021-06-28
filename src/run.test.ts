import * as github from '@actions/github';
import * as githubUtils from '@actions/github/lib/utils';
import { throttling } from '@octokit/plugin-throttling';
import * as core from '@actions/core';
import { when } from 'jest-when';
import { Result } from './result';
import { run } from './run';

type BumpType = 'none' | 'patch' | 'minor' | 'major' | 'impossible';
const bumpTypes: BumpType[] = ['none', 'patch', 'minor', 'major', 'impossible'];
const possibleBumpTypes = bumpTypes.filter((type) => type !== 'impossible');

type VersionChange = {
  before: {
    dev?: Record<string, string>;
    prod?: Record<string, string>;
  };
  after: {
    dev?: Record<string, string>;
    prod?: Record<string, string>;
  };
  minRequired: { dev: BumpType; prod: BumpType };
};

const versionChanges: VersionChange[] = [
  {
    before: { dev: { mod1: '0.0.1' } },
    after: { dev: { mod1: '0.0.2' } },
    minRequired: { dev: 'patch', prod: 'none' },
  },
  {
    before: { prod: { mod1: '0.0.1' } },
    after: { prod: { mod1: '0.0.2' } },
    minRequired: { dev: 'none', prod: 'patch' },
  },
  {
    before: { dev: { mod1: '0.0.1' }, prod: { mod2: '0.0.1' } },
    after: { dev: { mod1: '0.0.1' }, prod: { mod2: '0.1.0' } },
    minRequired: { dev: 'none', prod: 'minor' },
  },
  {
    before: { dev: { mod1: '0.0.2' } },
    after: { dev: { mod1: '0.0.1' } },
    minRequired: { dev: 'impossible', prod: 'none' },
  },
  {
    before: { dev: { mod1: '^0.0.1' } },
    after: { dev: { mod1: '^0.0.2' } },
    minRequired: { dev: 'patch', prod: 'none' },
  },
  {
    before: { dev: { mod1: '~0.0.1' } },
    after: { dev: { mod1: '~0.0.2' } },
    minRequired: { dev: 'patch', prod: 'none' },
  },
  {
    before: { dev: { mod1: '~0.0.1' } },
    after: { dev: { mod1: '0.0.2' } },
    minRequired: { dev: 'impossible', prod: 'none' },
  },
  {
    before: { dev: { mod1: '0.0.1' } },
    after: { dev: { mod1: '~0.0.2' } },
    minRequired: { dev: 'impossible', prod: 'none' },
  },
  {
    before: { dev: { mod1: '0.0.1' } },
    after: { dev: { mod1: '0.1.0' } },
    minRequired: { dev: 'minor', prod: 'none' },
  },
  {
    before: { dev: { mod1: '0.0.1' } },
    after: { dev: { mod1: '1.0.0' } },
    minRequired: { dev: 'major', prod: 'none' },
  },
  {
    before: { dev: { mod1: '0.0.1-alpha' } },
    after: { dev: { mod1: '0.0.1' } },
    minRequired: { dev: 'impossible', prod: 'none' },
  },
  {
    before: { dev: { mod1: '0.0.1-alpha' } },
    after: { dev: { mod1: '0.0.2' } },
    minRequired: { dev: 'impossible', prod: 'none' },
  },
  {
    before: { dev: { mod1: '!0.0.1' } },
    after: { dev: { mod1: '0.0.2' } },
    minRequired: { dev: 'impossible', prod: 'none' },
  },
  {
    before: { dev: { mod1: '0.0.1' } },
    after: { dev: { mod1: '!0.0.2' } },
    minRequired: { dev: 'impossible', prod: 'none' },
  },
  {
    before: { dev: { mod1: 1 as any } },
    after: { dev: { mod1: '0.0.1' } },
    minRequired: { dev: 'impossible', prod: 'none' },
  },
  {
    before: { dev: { mod1: '0.0.1' } },
    after: { dev: { mod1: 1 as any } },
    minRequired: { dev: 'impossible', prod: 'none' },
  },
];

const realSetTimeout = setTimeout;
function whenAllPromisesFinished(): Promise<void> {
  return new Promise((resolve) => realSetTimeout(() => resolve(), 0));
}

const allowedUpdateTypeCombinations: {
  allowedUpdateTypes: string;
  maxBump: { dev: BumpType; prod: BumpType };
}[] = [];
possibleBumpTypes.forEach((prodBumpType) => {
  possibleBumpTypes.forEach((devBumpType) => {
    const allowedUpdateTypes: string[] = [];
    (['dev', 'prod'] as const).forEach((type) => {
      for (
        let i = bumpTypes.indexOf(type === 'dev' ? devBumpType : prodBumpType);
        i >= 0;
        i--
      ) {
        if (bumpTypes[i] !== 'none') {
          allowedUpdateTypes.push(
            `${type === 'dev' ? 'devDependencies' : 'dependencies'}:${
              bumpTypes[i]
            }`
          );
        }
      }
    });

    allowedUpdateTypeCombinations.push({
      allowedUpdateTypes: allowedUpdateTypes.join(', '),
      maxBump: { dev: devBumpType, prod: prodBumpType },
    });
  });
});

describe('run', () => {
  beforeEach(() => {
    jest.useFakeTimers('modern').setSystemTime(0);
    (github as any).context = {};
  });

  afterEach(() => jest.useRealTimers());

  it('stops if the event name is unknown', async () => {
    github.context.eventName = 'unknown';
    expect(await run()).toBe(Result.UnknownEvent);
  });

  ['pull_request', 'pull_request_target', 'pull_request_review'].forEach(
    (name) => {
      describe(`when the event name is ${name}`, () => {
        let mockAllowedActors: string;
        let mockAllowedUpdateTypes: string;
        let mockApprove: string;
        let mockMerge: string;
        let mockMergeMethod: string;
        let mockPackageBlockList: string;
        let mockPackageAllowList: string | undefined;

        beforeEach(() => {
          github.context.eventName = name;
          mockAllowedActors = '';
          mockAllowedUpdateTypes = '';
          mockApprove = '';
          mockMerge = '';
          mockMergeMethod = 'merge';
          mockPackageBlockList = '';
          mockPackageAllowList = undefined;

          (core.setOutput as any).mockReset();
          const getInputMock = when(core.getInput as any).mockImplementation(
            () => {
              throw new Error('Unexpected call');
            }
          );
          getInputMock
            .calledWith('repo-token', { required: true })
            .mockReturnValue('token');
          getInputMock
            .calledWith('allowed-actors', { required: true })
            .mockImplementation(() => mockAllowedActors);
          getInputMock
            .calledWith('allowed-update-types', { required: true })
            .mockImplementation(() => mockAllowedUpdateTypes);
          getInputMock
            .calledWith('approve')
            .mockImplementation(() => mockApprove);
          getInputMock
            .calledWith('package-block-list')
            .mockImplementation(() => mockPackageBlockList);
          getInputMock
            .calledWith('package-allow-list')
            .mockImplementation(() => mockPackageAllowList);
          getInputMock.calledWith('merge').mockImplementation(() => mockMerge);
          getInputMock
            .calledWith('merge-method', { required: true })
            .mockImplementation(() => mockMergeMethod);
        });

        it('stops if the actor is not in the allow list', async () => {
          github.context.actor = 'unknown';
          expect(await run()).toBe(Result.ActorNotAllowed);
        });

        describe('with an allowed actor', () => {
          let mockPackageJsonPr: any;
          let mockPackageJsonBase: any;
          let mockCompareCommits: any;
          let mockPr: any;
          let reviewSubmitted: boolean;
          let reposGetContentMock: jest.Mock;
          let validMergeCallMock: jest.Mock;
          const mockSha = 'headSha';

          beforeEach(() => {
            mockAllowedActors = 'actor1, actor2';
            mockPackageJsonPr = {};
            mockPackageJsonBase = {};
            reviewSubmitted = false;

            github.context.actor = 'actor2';
            (github.context as any).repo = {
              owner: 'repoOwner',
              repo: 'repo ',
            };
            (github.context as any).payload = {
              pull_request: {
                number: 1,
                base: {
                  sha: 'baseSha',
                },
                head: {
                  sha: mockSha,
                },
              },
            };
            mockCompareCommits = {
              data: {
                files: [
                  { filename: 'package.json', status: 'modified' },
                  { filename: 'package-lock.json', status: 'modified' },
                  { filename: 'yarn.lock', status: 'modified' },
                ],
              },
            };
            mockPr = {
              data: {
                state: 'open',
                mergeable: true,
                head: { sha: mockSha },
              },
            };

            reposGetContentMock = jest.fn();
            when(reposGetContentMock)
              .mockImplementation(() => {
                throw new Error('Unexpected call');
              })
              .calledWith({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                path: 'package.json',
                ref: (github.context.payload.pull_request as any).head.sha,
              })
              .mockImplementation(() =>
                Promise.resolve({
                  data: {
                    type: 'file',
                    encoding: 'base64',
                    content: Buffer.from(
                      JSON.stringify(mockPackageJsonPr, null, 2)
                    ).toString('base64'),
                  },
                })
              )
              .calledWith({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                path: 'package.json',
                ref: (github.context.payload.pull_request as any).base.sha,
              })
              .mockImplementation(() =>
                Promise.resolve({
                  data: {
                    type: 'file',
                    encoding: 'base64',
                    content: Buffer.from(
                      JSON.stringify(mockPackageJsonBase, null, 2)
                    ).toString('base64'),
                  },
                })
              );

            const pullsGetMock = jest.fn();
            when(pullsGetMock)
              .expectCalledWith({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                pull_number: github.context.payload.pull_request!.number,
              })
              .mockImplementation(() => mockPr);

            const reposCompareCommitsMock = jest.fn();
            when(reposCompareCommitsMock)
              .expectCalledWith({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                base: (github.context.payload.pull_request as any).base.sha,
                head: (github.context.payload.pull_request as any).head.sha,
              })
              .mockImplementation(() => mockCompareCommits);

            const mockReviewId = 'mockReviewId';
            const createReviewMock = jest.fn();
            when(createReviewMock)
              .expectCalledWith({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                pull_number: github.context.payload.pull_request!.number,
                commit_id: mockSha,
              })
              .mockReturnValue(Promise.resolve({ data: { id: mockReviewId } }));

            const submitReviewMock = jest.fn();
            when(submitReviewMock)
              .expectCalledWith({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                pull_number: github.context.payload.pull_request!.number,
                review_id: mockReviewId,
                event: 'APPROVE',
              })
              .mockImplementation(() => {
                reviewSubmitted = true;
                return Promise.resolve();
              });

            const mergeMock = jest.fn();
            validMergeCallMock = jest.fn();
            when(mergeMock)
              .expectCalledWith({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                pull_number: github.context.payload.pull_request!.number,
                merge_method: mockMergeMethod,
                sha: mockSha,
              })
              .mockImplementation(validMergeCallMock);

            const octokitMock = {
              repos: {
                getContent: reposGetContentMock,
                compareCommits: reposCompareCommitsMock,
              },
              pulls: {
                get: pullsGetMock,
                createReview: createReviewMock,
                submitReview: submitReviewMock,
                merge: mergeMock,
              },
            };

            const getOctokitOptionsReturn = Symbol('getOctokitOptionsReturn');
            when((githubUtils as any).getOctokitOptions)
              .expectCalledWith('token', {
                throttle: expect.objectContaining({
                  onRateLimit: expect.any(Function),
                  onAbuseLimit: expect.any(Function),
                }),
              })
              .mockReturnValue(getOctokitOptionsReturn);

            const octokitMockBuilder = jest.fn();
            when(octokitMockBuilder)
              .expectCalledWith(getOctokitOptionsReturn)
              .mockReturnValue(octokitMock);

            when((githubUtils.GitHub as any).plugin)
              .expectCalledWith(throttling)
              .mockReturnValue(octokitMockBuilder);
          });

          it('errors if allowed-update-types invalid', async () => {
            mockAllowedUpdateTypes = 'invalid';
            await expect(run()).rejects.toHaveProperty(
              'message',
              'allowed-update-types invalid'
            );
          });

          it('errors if merge-method invalid', async () => {
            mockMergeMethod = 'invalid';
            await expect(run()).rejects.toHaveProperty(
              'message',
              'merge-method invalid: invalid'
            );
          });

          it('errors if the content type is incorrect', async () => {
            reposGetContentMock.mockReturnValue(
              Promise.resolve({ data: { type: 'unknown' } })
            );
            await expect(run()).rejects.toHaveProperty(
              'message',
              'Unexpected repo content response'
            );
          });

          it('errors if the content encoding is incorrect', async () => {
            reposGetContentMock.mockReturnValue(
              Promise.resolve({ data: { type: 'file', encoding: 'unknown' } })
            );
            await expect(run()).rejects.toHaveProperty(
              'message',
              'Unexpected repo content response'
            );
          });

          it('stops if more than the allowed files change', async () => {
            mockCompareCommits.data.files = [
              { filename: 'something', status: 'modified' },
            ];
            expect(await run()).toBe(Result.FileNotAllowed);

            mockCompareCommits.data.files = [
              { filename: 'package.json', status: 'modified' },
              { filename: 'something', status: 'modified' },
            ];
            expect(await run()).toBe(Result.FileNotAllowed);
          });

          it('stops if an allowed file is changed but not modified', async () => {
            mockCompareCommits.data.files = [
              { filename: 'package.json', status: 'something' },
            ];
            expect(await run()).toBe(Result.FileNotAllowed);
          });

          it('stops if the diff of the package.json contains additions', async () => {
            mockPackageJsonPr = { addition: true };
            expect(await run()).toBe(Result.UnexpectedChanges);
          });

          it('stops if the diff of the package.json contains removals', async () => {
            mockPackageJsonBase = { addition: true };
            expect(await run()).toBe(Result.UnexpectedChanges);
          });

          it('stops if the diff of the package.json contains changes to something other than dependencies or devDependencies', async () => {
            mockPackageJsonBase.name = 'something';
            mockPackageJsonPr.name = 'somethingElse';
            expect(await run()).toBe(Result.UnexpectedPropertyChange);
          });

          it('stops if one of the updates is in the package block list', async () => {
            mockAllowedUpdateTypes = 'dependencies: patch';
            mockPackageBlockList = 'dep1, dep2';

            mockPackageJsonBase.dependencies = {
              dep1: '1.2.3',
            };
            mockPackageJsonPr.dependencies = {
              dep1: '1.2.4',
            };
            expect(await run()).toBe(Result.VersionChangeNotAllowed);

            mockPackageJsonBase.dependencies = {
              dep1: '1.2.3',
              dep2: '1.2.3',
            };
            mockPackageJsonPr.dependencies = {
              dep1: '1.2.4',
              dep2: '1.2.4',
            };
            expect(await run()).toBe(Result.VersionChangeNotAllowed);

            mockPackageJsonBase.dependencies = {
              dep1: '1.2.3',
              something: '1.2.3',
            };
            mockPackageJsonPr.dependencies = {
              dep1: '1.2.4',
              something: '1.2.4',
            };
            expect(await run()).toBe(Result.VersionChangeNotAllowed);
          });

          it('stops if one of the updates is not in the package allow list', async () => {
            mockAllowedUpdateTypes = 'dependencies: patch';
            mockPackageAllowList = 'dep1, dep2';

            mockPackageJsonBase.dependencies = {
              something: '1.2.3',
            };
            mockPackageJsonPr.dependencies = {
              something: '1.2.4',
            };
            expect(await run()).toBe(Result.VersionChangeNotAllowed);

            mockPackageJsonBase.dependencies = {
              dep1: '1.2.3',
              something: '1.2.3',
            };
            mockPackageJsonPr.dependencies = {
              dep1: '1.2.4',
              something: '1.2.4',
            };
            expect(await run()).toBe(Result.VersionChangeNotAllowed);
          });

          versionChanges.forEach(({ before, after, minRequired }) => {
            describe(`with an update from ${JSON.stringify(
              before
            )} to "${JSON.stringify(after)}"`, () => {
              beforeEach(() => {
                if (before.dev) {
                  mockPackageJsonBase.devDependencies = before.dev;
                }
                if (before.prod) {
                  mockPackageJsonBase.dependencies = before.prod;
                }
                if (after.dev) {
                  mockPackageJsonPr.devDependencies = after.dev;
                }
                if (after.prod) {
                  mockPackageJsonPr.dependencies = after.prod;
                }
              });

              allowedUpdateTypeCombinations.forEach(
                ({ allowedUpdateTypes, maxBump }) => {
                  describe(`with allowedUpdateTypes of "${allowedUpdateTypes}"`, () => {
                    beforeEach(() => {
                      mockAllowedUpdateTypes = allowedUpdateTypes;
                    });

                    if (
                      bumpTypes.indexOf(maxBump.dev) <
                        bumpTypes.indexOf(minRequired.dev) ||
                      bumpTypes.indexOf(maxBump.prod) <
                        bumpTypes.indexOf(minRequired.prod)
                    ) {
                      it('stops', async () => {
                        expect(await run()).toBe(
                          Result.VersionChangeNotAllowed
                        );
                      });

                      it('does not set the "success" output', async () => {
                        await run();
                        expect(core.setOutput).not.toHaveBeenCalledWith(
                          'success',
                          'true'
                        );
                      });
                    } else {
                      it('sets the "success" output', async () => {
                        await run();
                        expect(core.setOutput).toHaveBeenCalledWith(
                          'success',
                          'true'
                        );
                      });

                      [true, false].forEach((approve) => {
                        describe(`when approve option is ${
                          approve ? 'enabled' : 'disabled'
                        }`, () => {
                          if (approve) {
                            it('approves the PR', async () => {
                              mockApprove = 'true';
                              expect(await run()).toBe(Result.PRMergeSkipped);
                            });
                          } else {
                            it('does not approve the PR', async () => {
                              expect(await run()).toBe(Result.PRMergeSkipped);
                              expect(reviewSubmitted).toBe(false);
                            });
                          }

                          describe('when merge option is disabled', () => {
                            it('completes and does not merge the PR', async () => {
                              expect(await run()).toBe(Result.PRMergeSkipped);
                            });
                          });

                          describe('when merge option is enabled', () => {
                            beforeEach(() => {
                              mockMerge = 'true';
                            });

                            it('merges the PR', async () => {
                              expect(await run()).toBe(Result.PRMerged);
                            });

                            it('aborts if the PR is not open', async () => {
                              mockPr.data.state = 'unknown';
                              expect(await run()).toBe(Result.PRNotOpen);
                            });

                            it('waits 1 second if the PR is not mergeable then retries', async () => {
                              let resolved = false;
                              let error: any;

                              mockPr.data.mergeable = false;
                              const result = run();
                              result
                                .then(() => (resolved = true))
                                .catch((e) => (error = e));
                              await whenAllPromisesFinished();
                              expect(error).toBeUndefined();
                              expect(resolved).toBe(false);

                              mockPr.data.mergeable = true;
                              jest.advanceTimersByTime(999);
                              await whenAllPromisesFinished();
                              expect(resolved).toBe(false);

                              jest.advanceTimersByTime(1);
                              await whenAllPromisesFinished();
                              expect(resolved).toBe(true);

                              expect(await result).toBe(Result.PRMerged);
                            });

                            it('waits 1 second if the PR fails to merge and then retries', async () => {
                              let resolved = false;
                              let error: any;

                              validMergeCallMock.mockImplementationOnce(() => {
                                throw new Error('Oops');
                              });

                              const result = run();
                              result
                                .then(() => (resolved = true))
                                .catch((e) => (error = e));
                              await whenAllPromisesFinished();
                              expect(error).toBeUndefined();
                              expect(resolved).toBe(false);

                              jest.advanceTimersByTime(999);
                              await whenAllPromisesFinished();
                              expect(resolved).toBe(false);

                              jest.advanceTimersByTime(1);
                              await whenAllPromisesFinished();
                              expect(resolved).toBe(true);

                              expect(await result).toBe(Result.PRMerged);
                            });

                            it('stops if the merge fails because the head changed', async () => {
                              validMergeCallMock.mockImplementation(() => {
                                throw { status: 409 };
                              });

                              expect(await run()).toBe(Result.PRHeadChanged);
                            });

                            it('throws when it has retried for 6 hours', async () => {
                              let rejected = false;
                              let error: any;

                              mockPr.data.mergeable = false;
                              const result = run();
                              result.catch((e) => {
                                rejected = true;
                                error = e;
                              });
                              await whenAllPromisesFinished();
                              expect(error).toBeUndefined();
                              expect(rejected).toBe(false);

                              jest.runOnlyPendingTimers();
                              await whenAllPromisesFinished();
                              expect(rejected).toBe(false);

                              jest.setSystemTime(6 * 60 * 60 * 1000);
                              jest.runOnlyPendingTimers();
                              await whenAllPromisesFinished();

                              expect(rejected).toBe(true);
                              expect(error?.message).toBe('Timed out');
                            });
                          });
                        });
                      });
                    }
                  });
                }
              );
            });
          });
        });
      });
    }
  );
});
