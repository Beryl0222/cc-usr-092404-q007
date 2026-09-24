import assert from "node:assert/strict";
import test from "node:test";
import { computeReplay, attributedMonth, DIFF_CLASSES, digest } from "../src/model.js";
import * as fx from "./fixtures.js";

function runAll(basis = "SERVICE_DATE") {
  return computeReplay({
    replay_id: "r1",
    catalog: fx.catalog(),
    mappings: [fx.mappingH1(), fx.mappingH2()],
    snapshots: [fx.snapshotH1(), fx.snapshotH2()],
    rules: fx.rules(),
    scenario: fx.scenarios(),
    attribution_basis: basis,
  });
}

test("金额整数自付计算与差异分类：增加/减少/类别漂移无金额变化", () => {
  const h1 = runAll().hospitals.find((h) => h.hospital_id === "H-001");
  // CL-1: 100000*20% = 20000（旧 30000 → 减少 10000）；CL-2: 50000*50% = 25000（旧 10000 → 增加 15000）
  const cl1 = h1.lines.find((l) => l.claim_id === "CL-1");
  const cl2 = h1.lines.find((l) => l.claim_id === "CL-2");
  assert.equal(cl1.new_self_pay_cents, 20000);
  assert.equal(cl1.diff_class, DIFF_CLASSES.SELF_PAY_DECREASE);
  assert.equal(cl2.new_self_pay_cents, 25000);
  assert.equal(cl2.diff_class, DIFF_CLASSES.SELF_PAY_INCREASE);
  assert.equal(h1.totals.delta_cents, 5000);

  // 类别变化但金额相等 → CATEGORY_SHIFT_NO_AMOUNT
  const shifted = computeReplay({
    replay_id: "r2",
    catalog: fx.catalog(),
    mappings: [fx.mappingH1()],
    snapshots: [
      {
        hospital_id: "H-001",
        snapshot_version: "s2",
        claims: [
          { claim_id: "CL-X", person_pseudonym: "P-X", service_date: "2026-09-01", settlement_date: "2026-10-01", entry_code: "B002", amount_cents: 20000, prior_category: "CAT_I", prior_self_pay_cents: 10000 },
        ],
      },
    ],
    rules: fx.rules(),
    scenario: { scenario_version: "s", scenarios: [] },
    attribution_basis: "SERVICE_DATE",
  });
  assert.equal(shifted.hospitals[0].lines[0].diff_class, DIFF_CLASSES.CATEGORY_SHIFT_NO_AMOUNT);
});

test("跨月服务与结算日期按政策基准分别归属", () => {
  const byService = runAll("SERVICE_DATE");
  const bySettlement = runAll("SETTLEMENT_DATE");
  const cl1Service = byService.hospitals.find((h) => h.hospital_id === "H-001").lines.find((l) => l.claim_id === "CL-1");
  const cl1Settle = bySettlement.hospitals.find((h) => h.hospital_id === "H-001").lines.find((l) => l.claim_id === "CL-1");
  assert.equal(cl1Service.attributed_month, "2026-09");
  assert.equal(cl1Settle.attributed_month, "2026-10");
  // 同一 claim 两种基准下的月度聚合不同，但总额一致
  assert.deepEqual(Object.keys(byService.hospitals[0].monthly), ["2026-09"]);
  assert.deepEqual(Object.keys(bySettlement.hospitals[0].monthly), ["2026-10"]);
  assert.equal(byService.hospitals[0].totals.delta_cents, bySettlement.hospitals[0].totals.delta_cents);
});

test("重复理赔全局只计一次，重复件登记可查", () => {
  const result = runAll();
  const h1 = result.hospitals.find((h) => h.hospital_id === "H-001");
  const h2 = result.hospitals.find((h) => h.hospital_id === "H-002");
  assert.equal(h1.totals.claim_count, 2);
  assert.equal(h2.totals.claim_count, 1); // CL-1 被去重
  assert.deepEqual(result.duplicates, [
    { claim_id: "CL-1", hospital_id: "H-002", first_seen_hospital_id: "H-001" },
  ]);
});

test("同一项目跨医院映射到不同支付类别会被检出", () => {
  const divergence = runAll().cross_hospital_divergence;
  assert.equal(divergence.length, 1);
  assert.equal(divergence[0].entry_code, "B002");
  assert.deepEqual(divergence[0].by_hospital, { "H-001": "CAT_II", "H-002": "CAT_III" });
});

test("同一版本五要素重放结果确定：哈希复算一致，顺序无关", () => {
  const a = runAll();
  const b = computeReplay({
    replay_id: "r1",
    // 故意打乱输入顺序
    catalog: fx.catalog(),
    mappings: [fx.mappingH2(), fx.mappingH1()],
    snapshots: [fx.snapshotH2(), fx.snapshotH1()],
    rules: fx.rules(),
    scenario: fx.scenarios(),
    attribution_basis: "SERVICE_DATE",
  });
  for (const hospital of a.hospitals) {
    const other = b.hospitals.find((x) => x.hospital_id === hospital.hospital_id);
    assert.equal(other.replay_version, hospital.replay_version);
    assert.equal(other.result_hash, hospital.result_hash);
  }
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.notEqual(runAll("SERVICE_DATE").hospitals[0].replay_version, runAll("SETTLEMENT_DATE").hospitals[0].replay_version);
});

test("场景限定：只重放场景覆盖的理赔，基准冲突被拒", () => {
  const result = computeReplay({
    replay_id: "r3",
    catalog: fx.catalog(),
    mappings: [fx.mappingH1()],
    snapshots: [fx.snapshotH1()],
    rules: fx.rules(),
    scenario: fx.scenarios(),
    attribution_basis: "SERVICE_DATE",
    scenario_id: "all-service",
  });
  assert.deepEqual(
    result.hospitals[0].lines.map((l) => l.claim_id),
    ["CL-1", "CL-2"]
  );
  // 场景未列入的理赔（如快照中额外的件）不参与重放
  const limited = computeReplay({
    replay_id: "r3b",
    catalog: fx.catalog(),
    mappings: [fx.mappingH1()],
    snapshots: [fx.snapshotH1()],
    rules: fx.rules(),
    scenario: { scenario_version: "s", scenarios: [{ scenario_id: "only-1", attribution_basis: "SERVICE_DATE", claim_ids: ["CL-1"] }] },
    attribution_basis: "SERVICE_DATE",
    scenario_id: "only-1",
  });
  assert.deepEqual(limited.hospitals[0].lines.map((l) => l.claim_id), ["CL-1"]);
  assert.throws(
    () =>
      computeReplay({
        replay_id: "r4",
        catalog: fx.catalog(),
        mappings: [fx.mappingH1()],
        snapshots: [fx.snapshotH1()],
        rules: fx.rules(),
        scenario: fx.scenarios(),
        attribution_basis: "SETTLEMENT_DATE",
        scenario_id: "all-service",
      }),
    { code: "BASIS_MISMATCH" }
  );
});

test("attributedMonth 对两种基准取对应日期", () => {
  const claim = { service_date: "2026-01-31", settlement_date: "2026-02-01" };
  assert.equal(attributedMonth(claim, "SERVICE_DATE"), "2026-01");
  assert.equal(attributedMonth(claim, "SETTLEMENT_DATE"), "2026-02");
});
