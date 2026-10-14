import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createClientRequestId,
  withMobileRequestTelemetry,
} from "./mobile-request-telemetry.ts";

describe("mobile request telemetry", () => {
  it("generates distinct clientRequestId per call", () => {
    const a = createClientRequestId();
    const b = createClientRequestId();
    assert.notEqual(a, b);
    assert.match(a, /^([0-9a-f-]{36}|req-)/i);
  });

  it("non-native withMobileRequestTelemetry leaves payload unchanged", async () => {
    const payload = { classId: 99, visitId: 100 };
    const out = await withMobileRequestTelemetry({ ...payload });
    assert.deepEqual(out, payload);
  });
});
