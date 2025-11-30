import { threeWayMerge } from "./dmp";

describe("threeWayMerge", () => {
  it("returns local when local already matches remote", () => {
    const base = "aaa";
    const local = "aaab";
    const remote = "aaab";
    expect(threeWayMerge({ base, local, remote })).toBe(local);
  });

  it("returns remote when local matches base", () => {
    const base = "abc";
    const local = "abc";
    const remote = "zabc";
    expect(threeWayMerge({ base, local, remote })).toBe(remote);
  });

  it("merges both changes when local and remote diverge", () => {
    const base = "aaa";
    const local = "aaab";
    const remote = "zaaa";
    expect(threeWayMerge({ base, local, remote })).toBe("zaaab");
  });
});
