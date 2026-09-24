// 测试夹具：两家医院的虚构目录/映射/快照/规则/场景。
export function catalog() {
  return {
    catalog_version: "cat-v1",
    frozen_at: "2026-09-20",
    entries: [
      { entry_code: "A001", payment_category: "CAT_I", price_cents: 100000 },
      { entry_code: "B002", payment_category: "CAT_II", price_cents: 50000 },
    ],
  };
}

export function mappingH1(version = "map-h1-v1", overrides = {}) {
  return {
    hospital_id: "H-001",
    mapping_version: version,
    base_mapping_version: version === "map-h1-v1" ? null : "map-h1-v1",
    decisions: [
      { entry_code: "A001", payment_category: "CAT_I" },
      { entry_code: "B002", payment_category: "CAT_II" },
      ...(overrides.extra ?? []),
    ],
  };
}

export function mappingH2(version = "map-h2-v1", b002Category = "CAT_III") {
  return {
    hospital_id: "H-002",
    mapping_version: version,
    base_mapping_version: version === "map-h2-v1" ? null : "map-h2-v1",
    decisions: [
      { entry_code: "A001", payment_category: "CAT_I" },
      { entry_code: "B002", payment_category: b002Category },
    ],
  };
}

export function snapshotH1() {
  return {
    hospital_id: "H-001",
    snapshot_version: "snap-h1-v1",
    claims: [
      // 跨月：服务在 9 月，结算在 10 月
      { claim_id: "CL-1", person_pseudonym: "P-A", service_date: "2026-09-28", settlement_date: "2026-10-03", entry_code: "A001", amount_cents: 100000, prior_category: "CAT_I", prior_self_pay_cents: 30000 },
      { claim_id: "CL-2", person_pseudonym: "P-B", service_date: "2026-09-30", settlement_date: "2026-10-05", entry_code: "B002", amount_cents: 50000, prior_category: "CAT_II", prior_self_pay_cents: 10000 },
    ],
  };
}

export function snapshotH2() {
  return {
    hospital_id: "H-002",
    snapshot_version: "snap-h2-v1",
    claims: [
      // CL-1 与 H-001 重复：全局只应计一次
      { claim_id: "CL-1", person_pseudonym: "P-A", service_date: "2026-09-28", settlement_date: "2026-10-03", entry_code: "A001", amount_cents: 100000, prior_category: "CAT_I", prior_self_pay_cents: 30000 },
      { claim_id: "CL-9", person_pseudonym: "P-Z", service_date: "2026-09-25", settlement_date: "2026-10-08", entry_code: "A001", amount_cents: 8000, prior_category: "CAT_I", prior_self_pay_cents: 8000 },
    ],
  };
}

export function rules(version = "rules-v1") {
  return {
    rules_version: version,
    rules: [
      { rule_id: "R-I", payment_category: "CAT_I", coinsurance_bp: 2000 },
      { rule_id: "R-II", payment_category: "CAT_II", coinsurance_bp: 5000 },
      { rule_id: "R-III", payment_category: "CAT_III", coinsurance_bp: 8000 },
    ],
  };
}

export function scenarios(version = "scen-v1") {
  return {
    scenario_version: version,
    scenarios: [
      { scenario_id: "all-service", attribution_basis: "SERVICE_DATE", claim_ids: ["CL-1", "CL-2", "CL-9"] },
      { scenario_id: "all-settle", attribution_basis: "SETTLEMENT_DATE", claim_ids: ["CL-1", "CL-2", "CL-9"] },
    ],
  };
}

export function planInput(replayId = "replay-1", basis = "SERVICE_DATE", overrides = {}) {
  return {
    replay_id: replayId,
    mapping_versions: { "H-001": "map-h1-v1", "H-002": "map-h2-v1" },
    snapshot_versions: { "H-001": "snap-h1-v1", "H-002": "snap-h2-v1" },
    rules_version: "rules-v1",
    scenario_version: "scen-v1",
    attribution_basis: basis,
    ...overrides,
  };
}
