import {
  MemoryPatchStore,
  MemoryPresenceAdapter,
  Session,
  StringCodec,
  StringDocument,
} from "../src/index";

/**
 * Minimal wiring of two Sessions against a shared in-memory PatchStore.
 * Run with: pnpm example:basic (builds then runs dist/esm/examples/basic-session.js)
 */
async function main() {
  const patchStore = new MemoryPatchStore();
  const presence = new MemoryPresenceAdapter();

  const sessionA = new Session({
    codec: StringCodec,
    patchStore,
    userId: 1,
    presenceAdapter: presence,
  });
  const sessionB = new Session({
    codec: StringCodec,
    patchStore,
    userId: 2,
    presenceAdapter: presence,
  });

  sessionA.on("change", (doc) => {
    console.log("A sees:", doc.toString());
  });
  sessionB.on("change", (doc) => {
    console.log("B sees:", doc.toString());
  });
  presence.subscribe((state, clientId) => {
    console.log("presence from", clientId, state);
  });

  await sessionA.init();
  await sessionB.init();

  // A commits "Hello"
  await sessionA.commit(new StringDocument("Hello"));

  // B commits "Hello world" on top of the merged view
  await sessionB.commit(new StringDocument("Hello world"));
}

void main();
