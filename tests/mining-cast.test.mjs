import assert from "node:assert/strict";
import { beforeEach, after, test } from "node:test";
import { build } from "esbuild";

// Exercise the actual Edge handler and SDK adapter without publishing casts,
// requiring credentials, or writing to the production database.
async function loadModule(entry, mocks = {}) {
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm",
    plugins: [{ name: "test-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => path in mocks ? { path, namespace: "test" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "test" }, ({ path }) => ({ contents: mocks[path], loader: "js" }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const backendMock = `
export const json = (value, status = 200) => Response.json(value, { status });
export const error = (cause) => json({ error: cause.message }, 400);
${["requireFarcasterUser", "requireWallet", "supabase", "readCurrentEra", "settleEndedMineSessions", "reconcileClaimedAllocations"].map((name) => `export const ${name} = (...args) => globalThis.castTestBackend.${name}(...args);`).join("\n")}
`;
const { default: start } = await loadModule("api/mine/start.ts", { "../_lib/backend": backendMock });
const { composeOnFarcaster } = await loadModule("src/lib/farcaster.ts", {
  "@farcaster/miniapp-sdk": "export const sdk = { isInMiniApp: async () => true, actions: { composeCast: (args) => globalThis.castTestCompose(args) } };",
});
const { readPendingCast, savePendingCast } = await loadModule("src/lib/pending-cast.ts");
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalKey = process.env.NEYNAR_API_KEY;
const hash = `0x${"ab".repeat(20)}`;
const wallet = `0x${"12".repeat(20)}`;
let cast, sessions, allocations, requests, inserts, simulateInsertRace, missingReads, lookupStatus;

beforeEach(() => {
  process.env.NEYNAR_API_KEY = "test-only";
  sessions = []; allocations = []; requests = []; inserts = 0;
  simulateInsertRace = false; missingReads = 0; lookupStatus = 200;
  cast = { hash, text: "Edited in Farcaster, with a photo", timestamp: new Date().toISOString(),
    embeds: [{ url: "https://example.com/photo.jpg" }],
    author: { fid: 42, username: "creator", follower_count: 1000, verified_addresses: { eth_addresses: [wallet] } } };
  globalThis.castTestBackend = {
    requireFarcasterUser: async (request) => {
      if (request.headers.get("authorization") !== "Bearer test") throw new Error("Farcaster authentication is required.");
      return 42;
    },
    requireWallet: (value) => { assert.match(value, /^0x[a-fA-F0-9]{40}$/); return value; },
    readCurrentEra: async () => 0,
    settleEndedMineSessions: async () => [],
    reconcileClaimedAllocations: async () => {},
    supabase: async (path, init = {}) => {
      const url = new URL(`https://db.test/${path}`);
      const table = url.pathname.slice(1);
      if (table === "mining_sessions") {
        if (init.method === "POST") {
          const input = JSON.parse(init.body);
          if (sessions.some((session) => session.cast_hash === input.cast_hash)) throw new Error("duplicate cast");
          const row = { id: "session-1", settled_at: null, ...input };
          sessions.push(row); inserts++;
          if (simulateInsertRace) throw new Error("duplicate cast committed by concurrent request");
          // PostgREST numeric columns are JSON numbers unless selected as text.
          return Response.json([{ ...row, reward_wei: Number(row.reward_wei) }]);
        }
        const filter = url.searchParams.get("cast_hash");
        const rows = filter ? sessions.filter((row) => row.cast_hash === filter.slice(3)) : sessions.filter((row) => !row.settled_at);
        return Response.json(rows.map((row) => ({ ...row, reward_wei: url.searchParams.get("select")?.includes("reward_wei::text") ? row.reward_wei : Number(row.reward_wei) })));
      }
      if (table === "miners") return Response.json([]);
      if (table === "claim_allocations") return Response.json(allocations);
      throw new Error(`Unexpected database operation: ${path}`);
    },
  };
  globalThis.fetch = async (url) => {
    requests.push(new URL(url));
    assert.equal(new URL(url).hostname, "api.neynar.com");
    if (missingReads-- > 0) return Response.json({}, { status: 404 });
    return Response.json({ cast }, { status: lookupStatus });
  };
  const storage = new Map();
  globalThis.window = { localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  } };
  globalThis.castTestCompose = async () => ({ cast: { hash } });
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  if (originalKey === undefined) delete process.env.NEYNAR_API_KEY; else process.env.NEYNAR_API_KEY = originalKey;
  delete globalThis.castTestBackend; delete globalThis.castTestCompose;
});

function request(body = {}) {
  return new Request("https://app.test/api/mine/start", { method: "POST", headers: { authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ castHash: hash, walletAddress: wallet, ...body }) });
}

test("changed text and image embeds start a verified session using the published text", async () => {
  const result = await start(request());
  assert.equal(result.status, 201);
  const data = await result.json();
  assert.equal(data.castText, cast.text);
  assert.equal(data.rewardWei, "3860294117647058823520");
  assert.equal(Date.parse(data.endsAt) - Date.parse(data.startedAt), 86400000);
  assert.equal(inserts, 1);
});

test("an image-only cast is accepted", async () => {
  cast.text = "";
  const result = await start(request());
  assert.equal(result.status, 201);
  assert.equal((await result.json()).castText, "");
});

test("new cast is retried when Neynar indexing lags", async () => {
  missingReads = 1;
  assert.equal((await start(request())).status, 201);
  assert.equal(requests.length, 2);
  assert.equal(inserts, 1);
});

test("missing cast stays unstarted after bounded retries", async () => {
  lookupStatus = 404;
  const result = await start(request());
  assert.equal(result.status, 503);
  assert.match((await result.json()).error, /do not post again/i);
  assert.equal(requests.length, 3);
  assert.equal(inserts, 0);
});

test("rate limits do not cause a request storm or start mining", async () => {
  lookupStatus = 429;
  assert.equal((await start(request())).status, 503);
  assert.equal(requests.length, 1);
  assert.equal(inserts, 0);
});

test("recovering by a Farcaster link resolves a canonical cast hash", async () => {
  const result = await start(request({ castHash: undefined, castUrl: "https://farcaster.xyz/creator/0xabababab?share=1" }));
  assert.equal(result.status, 201);
  assert.equal(requests[0].searchParams.get("type"), "url");
  assert.equal(sessions[0].cast_hash, hash);
});

test("arbitrary URLs are rejected before any external request", async () => {
  const result = await start(request({ castHash: undefined, castUrl: "https://evil.example/creator/0xabababab" }));
  assert.equal(result.status, 400);
  assert.equal(requests.length, 0);
});

test("another FID's cast and an unverified payout wallet cannot mine", async () => {
  cast.author.fid = 99;
  assert.notEqual((await start(request())).status, 201);
  cast.author.fid = 42;
  cast.author.verified_addresses.eth_addresses = [];
  assert.notEqual((await start(request())).status, 201);
  assert.equal(inserts, 0);
});

test("old, missing and future timestamps cannot start a new session", async () => {
  for (const timestamp of [undefined, "bad-date", new Date(Date.now() - 86400001).toISOString(), new Date(Date.now() + 600000).toISOString()]) {
    cast.timestamp = timestamp;
    assert.equal((await start(request())).status, 400);
  }
  assert.equal(inserts, 0);
});

test("a lost success response can be retried without minting a second session or resetting time", async () => {
  const first = await (await start(request())).json();
  const retry = await start(request({ castHash: undefined, castUrl: "https://warpcast.com/creator/0xabababab" }));
  assert.equal(retry.status, 200);
  const recovered = await retry.json();
  for (const key of ["sessionId", "startedAt", "endsAt", "rewardWei"]) assert.equal(recovered[key], first[key]);
  assert.equal(recovered.resumed, true);
  assert.equal(inserts, 1);
});

test("a concurrent insert is recovered using the database's original session", async () => {
  simulateInsertRace = true;
  const result = await start(request());
  assert.equal(result.status, 200);
  assert.equal((await result.json()).resumed, true);
  assert.equal(inserts, 1);
});

test("completed casts cannot be replayed and unclaimed rewards still block new sessions", async () => {
  await start(request());
  sessions[0].settled_at = new Date().toISOString();
  assert.equal((await start(request())).status, 409);
  sessions = [];
  allocations = [{ id: "unclaimed" }];
  const result = await start(request());
  assert.match((await result.json()).error, /Claim your previous/);
  assert.equal(inserts, 1);
});

test("another active session still blocks a new cast", async () => {
  await start(request());
  cast.hash = `0x${"cd".repeat(20)}`;
  const result = await start(request({ castHash: cast.hash }));
  assert.match((await result.json()).error, /active mining session/);
  assert.equal(inserts, 1);
});

test("SDK keeps the miniapp open and accepts the cast returned after editing", async () => {
  globalThis.castTestCompose = async (options) => {
    assert.equal(options.close, false);
    return { cast: { hash, text: "Completely changed", embeds: ["https://example.com/photo.jpg"] } };
  };
  assert.deepEqual(await composeOnFarcaster("Original draft"), { status: "posted", hash });
});

test("missing callbacks and SDK exceptions are not reported as cancellations", async () => {
  globalThis.castTestCompose = async () => undefined;
  assert.equal((await composeOnFarcaster("draft")).status, "unknown");
  globalThis.castTestCompose = async () => { throw new Error("transport interrupted"); };
  assert.equal((await composeOnFarcaster("draft")).status, "unknown");
  globalThis.castTestCompose = async () => ({ cast: null });
  assert.equal((await composeOnFarcaster("draft")).status, "cancelled");
});

test("pending cast recovery survives reloads but is isolated per Farcaster account", () => {
  savePendingCast(42, hash);
  assert.equal(readPendingCast(42), hash);
  assert.equal(readPendingCast(99), "");
  savePendingCast(42, "");
  assert.equal(readPendingCast(42), "");
});
