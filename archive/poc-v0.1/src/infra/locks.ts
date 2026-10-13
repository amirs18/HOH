import { Store } from './database.js';
import { processIdentity, killRecordedChild } from './process.js';

export async function claimRun(store: Store, runId: string): Promise<string> {
  const old = store.lease(runId);
  if (old) {
    const current = await processIdentity(old.pid);
    if (current && current === old.identity)
      throw new Error(`RUN_LOCKED: controller PID ${old.pid}; heartbeat ${new Date(old.heartbeat).toISOString()}`);
    // Compare token under a transaction; two recovery processes cannot both take ownership.
    store.transaction(() => store.release(runId, old.token));
  }
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error('CONTROLLER_IDENTITY_UNAVAILABLE');
  const token = store.transaction(() => store.claim(runId, identity));
  for (const child of store.children(runId)) {
    await killRecordedChild(child.pid, child.identity); store.removeChild(child.pid);
  }
  return token;
}
