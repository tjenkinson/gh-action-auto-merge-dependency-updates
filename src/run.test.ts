import * as github from '@actions/github';
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
  return new Promise((resolve) => {
    return realSetTimeout(() => resolve(), 0);
  });
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

  ['pull_request', 'pull_request_review'].forEach((name) => {
    describe(`when the event name is ${name}`, () => {
      let mockAllowedActors: string;
      let mockAllowedUpdateTypes: string;
      let mockApprove: string;
      let mockPackageBlockList: string;

      beforeEach(() => {
        github.context.eventName = name;
        mockAllowedActors = '';
        mockAllowedUpdateTypes = '';
        mockApprove = '';
        mockPackageBlockList = '';

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
          .calledWith('approve', undefined)
          .mockImplementation(() => mockApprove);
        getInputMock
          .calledWith('package-block-list', undefined)
          .mockImplementation(() => mockPackageBlockList);
      });

      it('stops if the actor is not in the allow list', async () => {
        github.context.actor = 'unknown';
        expect(await run()).toBe(Result.ActorNotAllowed);
      });

      ['actor1', 'actor2'].forEach((actor) => {
        describe(`for actor "${actor}"`, () => {
          let mockPackageJsonPr: any;
          let mockPackageJsonBase: any;
          let mockCommit: any;
          let mockPr: any;
          let reviewSubmitted: boolean;
          let reposGetContentMock: jest.Mock;
          let validMergeCallMock: jest.Mock;
          const mockSha = 'mockSha';

          beforeEach(() => {
            mockAllowedActors = 'actor1, actor2';
            mockPackageJsonPr = {};
            mockPackageJsonBase = {};
            reviewSubmitted = false;

            github.context.actor = actor;
            (github.context as any).repo = {
              owner: 'repoOwner',
              repo: 'repo ',
            };
            (github.context as any).ref = 'ref';
            (github.context as any).payload = {
              pull_request: {
                number: 1,
                base: {
                  ref: 'baseRef',
                },
              },
            };
            mockCommit = {
              data: {
                files: [{ filename: 'package.json', status: 'modified' }],
              },
            };
            mockPr = {};

            reposGetContentMock = jest.fn();
            when(reposGetContentMock)
              .mockImplementation(() => {
                throw new Error('Unexpected call');
              })
              .calledWith({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                path: 'package.json',
                ref: github.context.ref,
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
                ref: (github.context.payload.pull_request as any).base.ref,
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

            const reposGetCommitMock = jest.fn();
            when(reposGetCommitMock)
              .expectCalledWith({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                ref: github.context.ref,
              })
              .mockImplementation(() => mockCommit);

            const pullsGetMock = jest.fn();
            when(pullsGetMock)
              .expectCalledWith({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                pull_number: github.context.payload.pull_request!.number,
              })
              .mockImplementation(() => mockPr);

            const mockReviewId = 'mockReviewId';
            const createReviewMock = jest.fn();
            when(createReviewMock)
              .expectCalledWith({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                pull_number: github.context.payload.pull_request!.number,
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
                sha: mockSha,
              })
              .mockImplementation(validMergeCallMock);

            const octokitMock = {
              repos: {
                getContent: reposGetContentMock,
                getCommit: reposGetCommitMock,
              },
              pulls: {
                get: pullsGetMock,
                createReview: createReviewMock,
                submitReview: submitReviewMock,
                merge: mergeMock,
              },
            };

            when(github.getOctokit as any)
              .mockImplementation(() => {
                throw new Error('Unexpected call');
              })
              .calledWith('token')
              .mockReturnValue(octokitMock);
          });

          it('errors if allowed-update-types invalid', async () => {
            mockAllowedUpdateTypes = 'invalid';
            await expect(run()).rejects.toHaveProperty(
              'message',
              'allowed-update-types invalid'
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
            mockCommit.data.files = [
              { filename: 'something', status: 'modified' },
            ];
            expect(await run()).toBe(Result.InvalidFiles);

            mockCommit.data.files = [
              { filename: 'package.json', status: 'modified' },
              { filename: 'something', status: 'modified' },
            ];
            expect(await run()).toBe(Result.InvalidFiles);
          });

          it('stops if an allowed file is changed but not modified', async () => {
            mockCommit.data.files = [
              { filename: 'package.json', status: 'something' },
            ];
            expect(await run()).toBe(Result.InvalidFiles);
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
                    } else {
                      [true, false].forEach((approve) => {
                        describe(`when approve option is ${
                          approve ? 'enabled' : 'disabled'
                        }`, () => {
                          beforeEach(() => {
                            mockPr.data = {
                              state: 'open',
                              mergeable: true,
                              head: { sha: mockSha },
                            };
                          });

                          if (approve) {
                            it('approves the PR', async () => {
                              mockApprove = 'true';
                              expect(await run()).toBe(Result.Success);
                            });
                          } else {
                            it('does not approve the PR', async () => {
                              expect(await run()).toBe(Result.Success);
                              expect(reviewSubmitted).toBe(false);
                            });
                          }

                          it('merges the PR', async () => {
                            expect(await run()).toBe(Result.Success);
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

                            expect(await result).toBe(Result.Success);
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

                            expect(await result).toBe(Result.Success);
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
                    }
                  });
                }
              );
            });
          });
        });
      });
    });
  });
});
