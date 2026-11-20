// In-MicroVM worker for the Claude self-hosted sandbox.
//
// Lifecycle hooks are served as HTTP endpoints on port 9000:
//   POST /aws/lambda-microvms/runtime/v1/ready     (image build: snapshot gate)
//   POST /aws/lambda-microvms/runtime/v1/validate  (post-build smoke test)
//   POST /aws/lambda-microvms/runtime/v1/run       (once, after run from snapshot)
//   POST /aws/lambda-microvms/runtime/v1/resume    (after SUSPENDED -> RUNNING)
//   POST /aws/lambda-microvms/runtime/v1/suspend   (before RUNNING -> SUSPENDED)
//   POST /aws/lambda-microvms/runtime/v1/terminate (before termination)
//
// One MicroVM serves one session. The /run hook receives the dispatch payload
// (session id, environment id, parameter reference, region). It acknowledges
// immediately (200) then:
//   1. Fetches the environment key from SSM Parameter Store (VM execution role).
//   2. Polls the work queue for the matching session and handles its tool calls.
//   3. Waits for the background stack install (boot.sh) to finish.
//   4. Suspends the MicroVM (SuspendMicrovm) so the same session can continue later.
// The /resume hook runs the same steps again for that session: the poller and the
// environment key are fetched anew, then the VM is suspended again.
// The worker never exits on its own: it is the main process and must outlive suspends.
//
// Logs are verbose on purpose (debugging the work-queue handoff). Lines start with
// "worker:" and an ISO timestamp. Secret values are never logged, only their lengths.

import http from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { LambdaMicrovmsClient, SuspendMicrovmCommand } from "@aws-sdk/client-lambda-microvms";
import Anthropic from "@anthropic-ai/sdk";
import { EnvironmentWorker } from "@anthropic-ai/sdk/helpers/beta/environments";

// Hook server config.
const HOOK_PORT = Number(process.env.HOOK_PORT || 9000);
const HOOK_HOST = "0.0.0.0";
const HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1";
// How long to wait for the session's work item before giving up on this run.
const WORK_WAIT_MS = Number(process.env.WORK_WAIT_MS || 15 * 60 * 1000);
const ALIVE_LOG_MS = 60_000;
const WAIT_REPORT_MS = 30_000;
// boot.sh starts the stack install once this file exists (the poller is up).
const WORKER_READY_FILE = "/var/run/worker.polling";
// The session this VM actually serves, read by upload_outputs when no session id is given.
const SERVED_SESSION_FILE = "/var/run/served_session";
// Raw work-poll settings. A foreign item stays claimed by the VM that polled it until it is
// older than RECLAIM_OLDER_THAN_MS. That VM sleeps for at least that long, so the owner can
// reclaim it; the random jitter keeps two VMs from sleeping in lockstep and passing items back and forth.
const RECLAIM_OLDER_THAN_MS = Number(process.env.RECLAIM_OLDER_THAN_MS || 1000);
const POLL_BLOCK_MS = 999;
const SKIP_JITTER_MS = Number(process.env.SKIP_JITTER_MS || 2000);
const WORKER_ID = `${hostname()}-${randomUUID()}`;

function isFatalStatus(err) {
  const status = err?.status ?? err?.$metadata?.httpStatusCode;
  return status >= 400 && status < 500 && status !== 429;
}

function backoffMs(failures) {
  return Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// The one session this VM serves. Kept in memory: a suspend preserves memory, so it
// survives until the VM is terminated.
let current = null; // { dispatch, microvmId, region }
let busy = false; // a run or resume is in progress; ignore overlapping hook calls
const STARTED_AT = Date.now();

const ts = () => new Date().toISOString();
const log = (msg) => console.log(`${ts()} worker: ${msg}`);
const warn = (msg) => console.warn(`${ts()} worker: ${msg}`);
const errorLog = (msg, err) => console.error(`${ts()} worker: ${msg}`, describeError(err));

// Keep the fields that explain an AWS or HTTP failure, drop the rest.
function describeError(err) {
  if (!err) return undefined;
  return {
    name: err.name,
    message: err.message,
    code: err.code,
    httpStatus: err.$metadata?.httpStatusCode ?? err.status,
    requestId: err.$metadata?.requestId,
    stack: err.stack,
  };
}

process.on("unhandledRejection", (err) => {
  errorLog("unhandled rejection", err);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  errorLog("uncaught exception", err);
  process.exit(1);
});

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function fetchEnvironmentKey(parameterName, region) {
  log(`fetching environment key param=${parameterName} region=${region}`);
  const started = Date.now();
  const client = new SSMClient({ region });
  try {
    const result = await client.send(
      new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
    );
    const value = result.Parameter?.Value;
    if (!value) {
      throw new Error(`SSM parameter ${parameterName} has no value`);
    }
    log(`environment key fetched keyLength=${value.length} durationMs=${Date.now() - started}`);
    return value;
  } catch (err) {
    errorLog(`environment key fetch failed after durationMs=${Date.now() - started}`, err);
    throw err;
  }
}

// Handle one work item. anyItem: the first run takes the next session item, since every VM
// in the environment is interchangeable; a resume takes only the session this VM already serves.
// Builds a new client and poller each time, so a resumed VM reconnects with a fresh key and
// connection. Returns the id of the session that was served, or null if no work arrived.
async function handleSession(dispatch, { anyItem }) {
  const sessionId = dispatch.ANTHROPIC_SESSION_ID;
  const environmentId = dispatch.ANTHROPIC_ENVIRONMENT_ID;
  const parameterName = dispatch.ENVIRONMENT_KEY_PARAM_NAME;
  const region = dispatch.AWS_REGION;
  const baseURL = dispatch.ANTHROPIC_BASE_URL || undefined;

  log(`session start session=${sessionId} environment=${environmentId} region=${region} baseURL=${baseURL ?? "default"}`);

  const environmentKey = await fetchEnvironmentKey(parameterName, region);
  const client = new Anthropic({ authToken: environmentKey, baseURL });
  const worker = new EnvironmentWorker({ client, environmentId, environmentKey, workdir: "/workspace" });

  // Raw poll loop instead of WorkPoller: the SDK acks every claimed item before yielding it,
  // so a VM would ack and drop another session's item. A foreign item stays unacked here and
  // becomes claimable again after RECLAIM_OLDER_THAN_MS, so its own VM can take it.
  log(`waiting for work item for session ${sessionId} reclaimOlderThanMs=${RECLAIM_OLDER_THAN_MS}`);
  const waitStarted = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORK_WAIT_MS);
  const reporter = setInterval(() => {
    log(`still waiting for session ${sessionId} elapsedMs=${Date.now() - waitStarted}`);
  }, WAIT_REPORT_MS);

  // The key is fetched and the poll loop is ready: signal boot.sh to start the install now.
  try {
    writeFileSync(WORKER_READY_FILE, ts());
    log(`worker polling; wrote ${WORKER_READY_FILE}`);
  } catch (err) {
    errorLog("could not write worker ready file; install waits for the timeout", err);
  }

  let itemsSeen = 0;
  let skipped = 0;
  let failures = 0;
  try {
    while (!controller.signal.aborted) {
      let work;
      try {
        work = await client.beta.environments.work.poll(
          environmentId,
          {
            "Anthropic-Worker-ID": WORKER_ID,
            block_ms: POLL_BLOCK_MS,
            reclaim_older_than_ms: RECLAIM_OLDER_THAN_MS,
          },
          { signal: controller.signal },
        );
        failures = 0;
      } catch (err) {
        if (controller.signal.aborted) break;
        if (isFatalStatus(err)) throw err;
        const waitMs = backoffMs(failures);
        failures += 1;
        warn(`poll failed, backing off waitMs=${waitMs} error=${err?.message}`);
        await sleep(waitMs, controller.signal);
        continue;
      }
      if (work == null) continue;

      itemsSeen += 1;
      const isSession = work.data?.type === "session";
      const matches = anyItem ? isSession : isSession && work.data?.id === sessionId;
      if (!matches) {
        // Left unacked on purpose: once it is older than RECLAIM_OLDER_THAN_MS its own VM can claim it.
        // Sleep past that window (plus jitter) so this VM does not hold the item while the owner polls.
        skipped += 1;
        const skipDelayMs = RECLAIM_OLDER_THAN_MS + Math.random() * SKIP_JITTER_MS;
        log(`skip work ${work.id} for session ${work.data?.id} (not ours) skipped=${skipped} sleepMs=${Math.round(skipDelayMs)}`);
        await sleep(skipDelayMs, controller.signal);
        continue;
      }

      // The item's own session is the one served, which can differ from the dispatch's on a first run.
      // Logged before the ack, so the served session is on record even if the ack fails.
      const servedId = work.data.id;
      log(`served session=${servedId} work=${work.id} dispatchSession=${sessionId} anyItem=${anyItem} elapsedMs=${Date.now() - waitStarted}`);
      try {
        await client.beta.environments.work.ack(work.id, { environment_id: work.environment_id });
      } catch (err) {
        errorLog(`ack failed for work ${work.id}; polling again`, err);
        continue;
      }
      try {
        writeFileSync(SERVED_SESSION_FILE, servedId);
      } catch (err) {
        errorLog("could not write served session file; upload_outputs needs an explicit session id", err);
      }
      const handleStarted = Date.now();
      try {
        await worker.handleItem({ workId: work.id, environmentId, sessionId: servedId, environmentKey });
      } catch (err) {
        errorLog(`handleItem failed for work ${work.id} after durationMs=${Date.now() - handleStarted}`, err);
        throw err;
      }
      log(`session ${servedId} complete durationMs=${Date.now() - handleStarted}`);
      return servedId;
    }
  } catch (err) {
    errorLog(`poll loop stopped with error after elapsedMs=${Date.now() - waitStarted}`, err);
    throw err;
  } finally {
    clearTimeout(timer);
    clearInterval(reporter);
  }
  warn(`no work item for session ${sessionId} within ${WORK_WAIT_MS} ms itemsSeen=${itemsSeen} skipped=${skipped}`);
  return null;
}

// boot.sh writes this file when the stack install ends (see boot.sh INSTALL_STATUS).
const INSTALL_STATUS_FILE = "/var/run/install.status";
const INSTALL_TIMEOUT_MS = Number(process.env.INSTALL_TIMEOUT_MS || 60 * 60 * 1000);

// Wait for the background install: suspending mid-install would freeze it half-done.
async function waitForInstall() {
  const started = Date.now();
  const deadline = started + INSTALL_TIMEOUT_MS;
  let lastReport = started;
  log(`waiting for stack install statusFile=${INSTALL_STATUS_FILE} timeoutMs=${INSTALL_TIMEOUT_MS}`);
  while (Date.now() < deadline) {
    if (existsSync(INSTALL_STATUS_FILE)) {
      const status = readFileSync(INSTALL_STATUS_FILE, "utf-8").trim();
      log(`stack install finished (${status}) waitedMs=${Date.now() - started}`);
      return;
    }
    if (Date.now() - lastReport >= 60_000) {
      log(`stack install still running elapsedMs=${Date.now() - started}`);
      lastReport = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  warn("stack install still running after timeout; suspending anyway");
}

// Suspend this MicroVM so the session can resume later. The call may not return
// before the VM freezes, so nothing after it is relied on. Best effort: if the
// call fails, the VM keeps running until the idle policy reclaims it.
async function suspendSelf(microvmId, region) {
  await waitForInstall();
  if (!microvmId) {
    warn("no microvmId for this VM; cannot suspend, staying RUNNING");
    return;
  }
  log(`requesting suspend of microvm ${microvmId} region=${region}`);
  try {
    const client = new LambdaMicrovmsClient({ region });
    await client.send(new SuspendMicrovmCommand({ microvmIdentifier: microvmId }));
    log(`requested suspend of microvm ${microvmId}`);
  } catch (err) {
    errorLog("suspend-microvm failed; VM stays RUNNING until the idle policy reclaims it", err);
  }
}

// Run the session (first run or after a resume), then suspend. A failed session is
// logged and the VM is still suspended, so the state stays available for debugging.
async function runSession(anyItem) {
  busy = true;
  // The dispatch session is the one the webhook launched this VM for; the served session is
  // the one whose work item it actually ran. They differ when a first run takes another item.
  const dispatchId = current.dispatch.ANTHROPIC_SESSION_ID;
  let servedId = null;
  log(`runSession start busy=true anyItem=${anyItem} dispatchSession=${dispatchId}`);
  try {
    servedId = await handleSession(current.dispatch, { anyItem });
    // Later resumes must match the session this VM actually ran, not the one in its dispatch.
    if (servedId) current.dispatch.ANTHROPIC_SESSION_ID = servedId;
  } catch (err) {
    errorLog("session failed", err);
  } finally {
    busy = false;
    log(`runSession end dispatchSession=${dispatchId} servedSession=${servedId ?? "none"} suspending`);
    await suspendSelf(current.microvmId, current.region);
  }
}

// Heartbeat: one line a minute, so a silent worker is still visible in the logs.
setInterval(() => {
  log(
    `alive uptimeS=${Math.round((Date.now() - STARTED_AT) / 1000)} busy=${busy} ` +
      `session=${current?.dispatch?.ANTHROPIC_SESSION_ID ?? "none"}`,
  );
}, ALIVE_LOG_MS).unref();

// Restore probe (log only): a frozen VM resumes with wall-clock time jumped forward. The jump
// marks the snapshot restore or suspend resume, so compare it with the run hook time.
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const gapMs = now - lastTick;
  lastTick = now;
  if (gapMs > 3000) {
    log(`clock jump ${gapMs}ms: VM was frozen and restored (or resumed) at ${new Date(now).toISOString()}`);
  }
}, 500).unref();

const server = http.createServer(async (req, res) => {
  const ok = (body = { status: "ok" }) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  log(`hook request method=${req.method} url=${req.url}`);

  if (req.method !== "POST" || !req.url.startsWith(HOOK_PREFIX)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const hook = req.url.slice(HOOK_PREFIX.length + 1); // path part after the prefix

  switch (hook) {
    case "ready": // image build: app initialized, safe to snapshot
    case "validate": // post-build smoke test of the snapshot
    case "suspend": // nothing to flush: the install and the session state live in memory and on disk
    case "terminate":
      log(`hook ${hook} acknowledged`);
      ok();
      return;
    case "resume": {
      // Same session, new run: handle any further work for it, then suspend again.
      if (!current || busy) {
        log(`resume ignored hasCurrent=${!!current} busy=${busy}`);
        ok({ status: "ignored" });
        return;
      }
      log(`resume accepted session=${current.dispatch.ANTHROPIC_SESSION_ID}`);
      ok({ status: "accepted" });
      runSession(false);
      return;
    }
    case "run": {
      try {
        const raw = await readBody(req);
        const envelope = raw ? JSON.parse(raw) : {};
        log(`run hook received bytes=${raw.length} envelopeKeys=${Object.keys(envelope).join(",")} microvmId=${envelope.microvmId ?? "none"}`);
        // The service wraps the payload: { microvmId, runHookPayload: "<JSON>" }.
        const inner = envelope.runHookPayload
          ? JSON.parse(envelope.runHookPayload)
          : envelope;
        const dispatch = inner.session || inner;
        log(
          `run dispatch session=${dispatch.ANTHROPIC_SESSION_ID ?? "none"} ` +
            `environment=${dispatch.ANTHROPIC_ENVIRONMENT_ID ?? "none"} region=${dispatch.AWS_REGION ?? "none"} ` +
            `paramName=${dispatch.ENVIRONMENT_KEY_PARAM_NAME ?? "none"}`,
        );
        if (!dispatch.ANTHROPIC_SESSION_ID) {
          errorLog(`run hook missing ANTHROPIC_SESSION_ID raw=${raw}`, undefined);
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "missing ANTHROPIC_SESSION_ID" }));
          return;
        }
        if (current) {
          // A VM serves one session; a second /run is a service error, not new work.
          warn(`run ignored: VM already serves session=${current.dispatch.ANTHROPIC_SESSION_ID}`);
          ok({ status: "ignored" });
          return;
        }
        // microvmId lives on the envelope, not the inner dispatch; the worker
        // needs it to suspend itself once the session is done.
        current = { dispatch, microvmId: envelope.microvmId, region: dispatch.AWS_REGION };
        ok({ status: "accepted" });
        runSession(true);
      } catch (err) {
        errorLog("/run hook error", err);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid run payload" }));
      }
      return;
    }
    default:
      res.writeHead(404);
      res.end();
  }
});

server.listen(HOOK_PORT, HOOK_HOST, () => {
  log(
    `hook server listening on ${HOOK_HOST}:${HOOK_PORT} node=${process.version} pid=${process.pid} ` +
      `workWaitMs=${WORK_WAIT_MS} installTimeoutMs=${INSTALL_TIMEOUT_MS} ` +
      `awsRegion=${process.env.AWS_REGION ?? "none"} anthropicLog=${process.env.ANTHROPIC_LOG ?? "unset"}`,
  );
});
