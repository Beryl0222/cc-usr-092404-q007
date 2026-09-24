import assert from "node:assert/strict";
import test from "node:test";
import { makeEvent } from "../src/events.js";
import { redactSnapshotEvent, redactReport, isAuthorizedFor, MINIMAL_CLAIM_FIELDS } from "../src/privacy.js";

function snapshotEvent() {
  return makeEvent("CLAIM_SNAPSHOT_CAPTURED", {
    hospital_id: "H-001",
    snapshot_version: "s1",
    catalog_version: "c1",
    claims: [
      {
        claim_id: "CL-1",
        person_pseudonym: "P-A",
        service_date: "2026-09-28",
        settlement_date: "2026-10-03",
        entry_code: "A001",
        amount_cents: 100000,
        prior_category: "CAT_I",
        prior_self_pay_cents: 20000,
        internal_note: "不应外发",
      },
    ],
  });
}

test("授权医院查看者只看到最小字段白名单，其他字段被剥离", () => {
  const viewer = { viewer_id: "v1", authorized_hospital_ids: ["H-001"] };
  const redacted = redactSnapshotEvent(snapshotEvent(), viewer);
  assert.deepEqual(Object.keys(redacted.payload.claims[0]).sort(), [...MINIMAL_CLAIM_FIELDS].sort());
  assert.ok(!("internal_note" in redacted.payload.claims[0]));
  assert.equal(isAuthorizedFor(viewer, "H-001"), true);
  assert.equal(isAuthorizedFor(viewer, "H-002"), false);
});

test("未授权医院只看到脱敏占位，看不到任何理赔", () => {
  const viewer = { viewer_id: "v2", authorized_hospital_ids: ["H-009"] };
  const redacted = redactSnapshotEvent(snapshotEvent(), viewer);
  assert.equal(redacted.payload.claims_redacted, true);
  assert.equal(redacted.payload.claim_count, 1);
  assert.ok(!("claims" in redacted.payload));
});

test("无授权信息的查看者同样不可见", () => {
  assert.equal(isAuthorizedFor({}, "H-001"), false);
  const redacted = redactSnapshotEvent(snapshotEvent(), null);
  assert.equal(redacted.payload.claims_redacted, true);
});

test("对账报告按授权医院裁剪：未授权医院无金额、无明细", () => {
  const report = {
    replay_id: "r1",
    window_id: "w1",
    hospitals: [
      {
        hospital_id: "H-001",
        status: "PUBLISHED",
        replay_version: "rv1",
        result_hash: "h1",
        pinned_versions: { catalog_version: "c1" },
        totals: { delta_cents: 100 },
        trace: [{ claim_id: "CL-1", delta_cents: 100 }],
      },
      {
        hospital_id: "H-002",
        status: "SIGNED",
        replay_version: "rv2",
        result_hash: "h2",
        pinned_versions: { catalog_version: "c1" },
        totals: { delta_cents: -999 },
        trace: [{ claim_id: "CL-9", delta_cents: -999 }],
      },
    ],
  };
  const visible = redactReport(report, { authorized_hospital_ids: ["H-001"] });
  const h1 = visible.hospitals.find((h) => h.hospital_id === "H-001");
  const h2 = visible.hospitals.find((h) => h.hospital_id === "H-002");
  assert.ok(h1.trace);
  assert.equal(h2.redacted, true);
  assert.ok(!("trace" in h2));
  assert.ok(!("totals" in h2));
  assert.equal(h2.status, "SIGNED"); // 状态仍可见，便于流程协作
});
