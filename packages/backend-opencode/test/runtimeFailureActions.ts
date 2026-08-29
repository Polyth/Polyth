/**
 * Test-only transport / process failure actions over `createFakeOpenCode`.
 * Identity/storage breaks live in `localRuntimeFailure.ts` and
 * `fakeRemoteRuntime.ts`. Do not import from production packages.
 */
import {
  createFakeBarrier,
  httpFaults,
  type FakeBarrier,
  type FakeOpenCode,
} from "./fakeOpenCode.ts";

export const runtimeFailureActions = {
  killTransport(fake: FakeOpenCode): Promise<void> {
    return fake.crash();
  },
  dropConnection(fake: FakeOpenCode): void {
    fake.disconnectSse();
  },
  holdBackend(
    fake: FakeOpenCode,
    method: string,
    path: string,
  ): FakeBarrier {
    const barrier = createFakeBarrier();
    fake.scriptHttp({
      method,
      path,
      steps: [httpFaults.barrier(barrier, httpFaults.delayForever())],
    });
    return barrier;
  },
  crashAfterAdmission(fake: FakeOpenCode, method: string, path: string): void {
    fake.scriptHttp({
      method,
      path,
      steps: [httpFaults.acceptThenClose({ accepted: true })],
    });
  },
  restartBackend(fake: FakeOpenCode): Promise<FakeOpenCode> {
    return fake.restart();
  },
};
