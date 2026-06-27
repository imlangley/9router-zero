import { describe, expect, it } from "vitest";
import { createBulkConnectionNameAllocator } from "@/app/(dashboard)/dashboard/providers/[id]/bulkConnectionNames.js";

describe("bulk connection name allocation", () => {
  it("allocates unnamed keys by successful key order", () => {
    const allocateName = createBulkConnectionNameAllocator();

    expect(allocateName("")).toBe("Key 1");
    expect(allocateName("")).toBe("Key 2");
    expect(allocateName("")).toBe("Key 3");
  });

  it("allocates duplicate explicit names by base-name occurrence", () => {
    const allocateName = createBulkConnectionNameAllocator();

    expect(allocateName("Shared")).toBe("Shared");
    expect(allocateName("Other")).toBe("Other");
    expect(allocateName("Shared")).toBe("Shared 2");
    expect(allocateName("Shared")).toBe("Shared 3");
  });
});
