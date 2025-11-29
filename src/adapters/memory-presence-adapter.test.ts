import { MemoryPresenceAdapter } from "./memory-presence-adapter";

describe("MemoryPresenceAdapter", () => {
  it("publishes to all subscribers", () => {
    const presence = new MemoryPresenceAdapter();
    const seen: unknown[] = [];
    presence.subscribe((state) => seen.push(state));
    presence.subscribe((state) => seen.push({ wrapped: state }));
    presence.publish({ status: "online" });
    expect(seen).toEqual([{ status: "online" }, { wrapped: { status: "online" } }]);
  });

  it("stops notifying after unsubscribe", () => {
    const presence = new MemoryPresenceAdapter();
    const seen: unknown[] = [];
    const unsubscribe = presence.subscribe((state) => seen.push(state));
    presence.publish("first");
    unsubscribe();
    presence.publish("second");
    expect(seen).toEqual(["first"]);
  });
});
