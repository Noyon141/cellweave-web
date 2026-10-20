import { describe, it, expect } from "vitest";
import { generateDomainId, type DomainPrefix } from "@/lib/id";

describe("Domain ID Generator (UUIDv7 Foundation)", () => {
  const prefixes: DomainPrefix[] = ["exp", "smp", "ds", "dsv", "dsf", "upl", "dfp", "dim", "dif"];

  it.each(prefixes)("generates correct prefix and UUIDv7 format for %s", (prefix) => {
    const id = generateDomainId(prefix);
    const pattern = new RegExp(
      `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
    );
    expect(id).toMatch(pattern);
  });

  it("generates unique identifiers across rapid successive invocations", () => {
    const ids = new Set<string>();
    const count = 1000;
    for (let i = 0; i < count; i++) {
      ids.add(generateDomainId("ds"));
    }
    expect(ids.size).toBe(count);
  });

  it("generates lexicographically sortable identifiers across time intervals", async () => {
    const id1 = generateDomainId("dsv");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const id2 = generateDomainId("dsv");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const id3 = generateDomainId("dsv");

    expect(id1 < id2).toBe(true);
    expect(id2 < id3).toBe(true);
  });
});
