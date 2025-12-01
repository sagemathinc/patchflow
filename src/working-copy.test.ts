import { StringDocument } from "./string-document";
import { rebaseDraft } from "./working-copy";

describe("rebaseDraft", () => {
  it("preserves staged changes when the base advances", () => {
    const base = new StringDocument("hello");
    const draft = new StringDocument("hello2");
    const updatedBase = new StringDocument("1hello");

    const rebased = rebaseDraft({ base, draft, updatedBase });
    expect(rebased.toString()).toBe("1hello2");
  });

  it("returns the updated base when there are no staged changes", () => {
    const base = new StringDocument("same");
    const draft = new StringDocument("same");
    const updatedBase = new StringDocument("same!");

    const rebased = rebaseDraft({ base, draft, updatedBase });
    expect(rebased.toString()).toBe("same!");
  });

  it("rebases staged edits onto an advanced base without duplication", () => {
    const base = new StringDocument("abc");
    const draft = new StringDocument("abcXXX");
    const updatedBase = new StringDocument("Zabc");

    const rebased = rebaseDraft({ base, draft, updatedBase });
    expect(rebased.toString()).toBe("ZabcXXX");
  });
});
