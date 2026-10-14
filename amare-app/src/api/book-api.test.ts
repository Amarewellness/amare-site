import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withMobileRequestTelemetry } from "./mobile-request-telemetry.ts";

describe("book API telemetry envelope", () => {
  it("book payload shape unchanged on web/dev (no native telemetry)", async () => {
    const base = { classId: 12885, classStartIso: "2099-01-01T10:00:00" };
    const body = await withMobileRequestTelemetry(base);
    assert.equal(body.classId, 12885);
    assert.equal((body as { clientSource?: string }).clientSource, undefined);
  });
});
