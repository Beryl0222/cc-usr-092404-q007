import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateEvent, makeEvent, EVENT_KINDS, FORBIDDEN_PII_FIELDS } from "../src/events.js";

test("样例符合领域约定", async () => {
  const record = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(record), []);
});

test("旧有五类事件仍然存在于契约中", () => {
  for (const kind of ["CATALOG_FROZEN", "CLAIM_REPLAYED", "DIFF_CLASSIFIED", "MAPPING_REVISED", "RELEASE_SIGNED"]) {
    assert.ok(EVENT_KINDS.includes(kind));
  }
});

test("缺少信封字段或未知事件类型会被报告", () => {
  assert.deepEqual(
    validateEvent({ kind: "NOPE" }).sort(),
    ["event_id", "kind", "occurred_at", "payload", "subject_id"]
  );
  const problems = validateEvent({
    event_id: "e1",
    kind: "CATALOG_FROZEN",
    occurred_at: "t",
    subject_id: "s",
    payload: {},
  });
  assert.ok(problems.includes("payload.catalog_version"));
  assert.ok(problems.includes("payload.frozen_at"));
  assert.ok(problems.includes("payload.entries"));
});

test("金额必须是非负整数，归属基准与签署角色必须在取值域内", () => {
  assert.throws(
    () =>
      makeEvent("CLAIM_SNAPSHOT_CAPTURED", {
        hospital_id: "H",
        snapshot_version: "s1",
        catalog_version: "c1",
        claims: [
          {
            claim_id: "x",
            person_pseudonym: "P",
            service_date: "2026-09-01",
            settlement_date: "2026-10-01",
            entry_code: "A",
            amount_cents: 12.5,
            prior_category: "X",
            prior_self_pay_cents: -1,
          },
        ],
      }),
    /amount_cents|prior_self_pay_cents/
  );
  assert.throws(
    () =>
      makeEvent("RELEASE_SIGNED", {
        replay_id: "r",
        hospital_id: "h",
        replay_version: "v",
        result_hash: "x",
        role: "LEGAL",
        signer_id: "u",
      }),
    /payload.role/
  );
});

test("原始个人信息字段在任何层级都被拒绝，只允许假名", () => {
  for (const field of FORBIDDEN_PII_FIELDS) {
    assert.throws(
      () =>
        makeEvent("CLAIM_SNAPSHOT_CAPTURED", {
          hospital_id: "H",
          snapshot_version: "s1",
          catalog_version: "c1",
          claims: [
            {
              claim_id: "x",
              person_pseudonym: "P",
              [field]: "leak",
              service_date: "2026-09-01",
              settlement_date: "2026-10-01",
              entry_code: "A",
              amount_cents: 1,
              prior_category: "X",
              prior_self_pay_cents: 1,
            },
          ],
        }),
      new RegExp(field),
      `字段 ${field} 应被拒绝`
    );
  }
});

test("makeEvent 生成的合规事件可通过 validateEvent", () => {
  const event = makeEvent("PERSONAL_RULES_LOCKED", {
    rules_version: "r1",
    rules: [{ rule_id: "r", payment_category: "C", coinsurance_bp: 3000 }],
  });
  assert.deepEqual(validateEvent(event), []);
});
