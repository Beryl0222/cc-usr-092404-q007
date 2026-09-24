// 端到端演示：一条可复算的医保目录上线链。全部数据为虚构假名。
// 运行：node examples/demo_chain.js

import { ReleaseChain } from "../src/chain.js";
import {
  freezeCatalog,
  submitMapping,
  reviseMapping,
  captureSnapshot,
  lockPersonalRules,
  lockTestScenarios,
  requestReplay,
  replayHospital,
  classifyHospital,
  signBatch,
  openWindow,
  markCheckpoint,
  publishHospital,
  issueCorrection,
} from "../src/chain.js";
import { redactReport } from "../src/privacy.js";

const say = (title, value) => {
  console.log(`\n=== ${title} ===`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

const chain = new ReleaseChain();
const emit = (event) => chain.append(event);

// 1) 冻结目录 --------------------------------------------------------------
emit(freezeCatalog(chain.state, {
  catalog_version: "cat-2026-10",
  frozen_at: "2026-09-20",
  entries: [
    { entry_code: "A001", payment_category: "CAT_I", price_cents: 100000 },
    { entry_code: "B002", payment_category: "CAT_II", price_cents: 50000 },
    { entry_code: "C003", payment_category: "CAT_III", price_cents: 20000 },
  ],
}));

// 2) 医院并发提交映射：过期基线被拒 ---------------------------------------
try {
  emit(submitMapping(chain.state, {
    hospital_id: "H-002",
    mapping_version: "map-h2-vX",
    base_mapping_version: "stale-base", // 该院尚无映射，正确基线应为 null
    decisions: [{ entry_code: "A001", payment_category: "CAT_I" }],
  }));
} catch (err) {
  say("并发提交：过期基线被检测并拒绝", `${err.code}: ${err.message}`);
}

emit(submitMapping(chain.state, {
  hospital_id: "H-001",
  mapping_version: "map-h1-v1",
  base_mapping_version: null,
  decisions: [
    { entry_code: "A001", payment_category: "CAT_I" },
    { entry_code: "B002", payment_category: "CAT_II" },
    { entry_code: "C003", payment_category: "CAT_III" },
  ],
}));
emit(submitMapping(chain.state, {
  hospital_id: "H-002",
  mapping_version: "map-h2-v1",
  base_mapping_version: null,
  // 注意：B002 被该院映到 CAT_III，与 H-001 的 CAT_II 不一致（跨医院分歧）
  decisions: [
    { entry_code: "A001", payment_category: "CAT_I" },
    { entry_code: "B002", payment_category: "CAT_III" },
    { entry_code: "C003", payment_category: "CAT_III" },
  ],
}));

// 3) 历史理赔快照、自付规则、测试场景 --------------------------------------
emit(captureSnapshot(chain.state, {
  hospital_id: "H-001",
  snapshot_version: "snap-h1-v1",
  claims: [
    { claim_id: "CL-1001", person_pseudonym: "P-AAA", service_date: "2026-09-28", settlement_date: "2026-10-03", entry_code: "A001", amount_cents: 100000, prior_category: "CAT_I", prior_self_pay_cents: 10000 },
    { claim_id: "CL-1002", person_pseudonym: "P-BBB", service_date: "2026-09-30", settlement_date: "2026-10-06", entry_code: "B002", amount_cents: 50000, prior_category: "CAT_II", prior_self_pay_cents: 30000 },
    { claim_id: "CL-1003", person_pseudonym: "P-CCC", service_date: "2026-10-01", settlement_date: "2026-10-02", entry_code: "C003", amount_cents: 20000, prior_category: "CAT_III", prior_self_pay_cents: 20000 },
  ],
}));
emit(captureSnapshot(chain.state, {
  hospital_id: "H-002",
  snapshot_version: "snap-h2-v1",
  claims: [
    // CL-1001 同时出现在两家医院：去重后只在首入账医院 H-001 计一次
    { claim_id: "CL-1001", person_pseudonym: "P-AAA", service_date: "2026-09-28", settlement_date: "2026-10-03", entry_code: "A001", amount_cents: 100000, prior_category: "CAT_I", prior_self_pay_cents: 10000 },
    { claim_id: "CL-2001", person_pseudonym: "P-DDD", service_date: "2026-09-25", settlement_date: "2026-10-08", entry_code: "C003", amount_cents: 8000, prior_category: "CAT_III", prior_self_pay_cents: 8000 },
  ],
}));
emit(lockPersonalRules(chain.state, {
  rules_version: "rules-v1",
  rules: [
    { rule_id: "R-I", payment_category: "CAT_I", coinsurance_bp: 2000 },
    { rule_id: "R-II", payment_category: "CAT_II", coinsurance_bp: 5000 },
    { rule_id: "R-III", payment_category: "CAT_III", coinsurance_bp: 8000 },
  ],
}));
emit(lockTestScenarios(chain.state, {
  scenario_version: "scen-v1",
  scenarios: [
    { scenario_id: "full-service-date", attribution_basis: "SERVICE_DATE", claim_ids: ["CL-1001", "CL-1002", "CL-1003", "CL-2001"] },
    { scenario_id: "full-settlement-date", attribution_basis: "SETTLEMENT_DATE", claim_ids: ["CL-1001", "CL-1002", "CL-1003", "CL-2001"] },
  ],
}));

// 4) 五要素按同一版本钉住，发起重放（服务日归属） --------------------------
const planInput = {
  replay_id: "replay-2026-10",
  mapping_versions: { "H-001": "map-h1-v1", "H-002": "map-h2-v1" },
  snapshot_versions: { "H-001": "snap-h1-v1", "H-002": "snap-h2-v1" },
  rules_version: "rules-v1",
  scenario_version: "scen-v1",
  attribution_basis: "SERVICE_DATE",
};
emit(requestReplay(chain.state, planInput));
for (const h of ["H-001", "H-002"]) {
  emit(replayHospital(chain.state, "replay-2026-10", h));
  emit(classifyHospital(chain.state, "replay-2026-10", h));
}
{
  const r = chain.report("replay-2026-10");
  say("首次影子结果（服务日归属）", {
    H001_totals: r.hospitals[0].totals,
    H001_monthly: r.hospitals[0].monthly,
    H002_totals: r.hospitals[1].totals,
    H002_duplicates: r.hospitals[1].duplicates,
    跨医院分歧: r.hospitals[0].cross_hospital_divergence,
  });
}

// 5) 跨月归属对照：同一计划按结算日重放，CL-1001/1002 归入 2026-10 --------
emit(requestReplay(chain.state, { ...planInput, replay_id: "replay-2026-10-settle", attribution_basis: "SETTLEMENT_DATE" }));
emit(replayHospital(chain.state, "replay-2026-10-settle", "H-001"));
say("结算日归属对照（CL-1001/1002 进入 10 月）", chain.report("replay-2026-10-settle").hospitals[0].monthly);

// 6) 映射修订只重算未签署批次 ---------------------------------------------
// H-001 先完成财务+政策签署
emit(signBatch(chain.state, "replay-2026-10", "H-001", "FINANCE", "fin-001"));
emit(signBatch(chain.state, "replay-2026-10", "H-001", "POLICY", "pol-001"));
// H-002 修订 B002 映射，消除分歧（基线必须等于当前 map-h2-v1）
emit(reviseMapping(chain.state, {
  hospital_id: "H-002",
  mapping_version: "map-h2-v2",
  base_mapping_version: "map-h2-v1",
  decisions: [
    { entry_code: "A001", payment_category: "CAT_I" },
    { entry_code: "B002", payment_category: "CAT_II" },
    { entry_code: "C003", payment_category: "CAT_III" },
  ],
}));
// 注意：修订发生在计划钉住之后——在跑计划仍用 map-h2-v1；要让修订生效须新建计划
emit(requestReplay(chain.state, {
  ...planInput,
  replay_id: "replay-2026-10-r2",
  mapping_versions: { "H-001": "map-h1-v1", "H-002": "map-h2-v2" },
}));
for (const h of ["H-001", "H-002"]) {
  emit(replayHospital(chain.state, "replay-2026-10-r2", h));
  emit(classifyHospital(chain.state, "replay-2026-10-r2", h));
}
say("修订后新计划：跨医院分歧应消失", chain.report("replay-2026-10-r2").hospitals[0].cross_hospital_divergence);

// 已签署的旧批次不能重算
try {
  emit(replayHospital(chain.state, "replay-2026-10", "H-001"));
} catch (err) {
  say("已签署批次拒绝重算", `${err.code}: ${err.message}`);
}

// 7) 双角色签署齐备才打开发布窗口；旧计划 H-002 仍未签，改用新计划发布 -----
for (const h of ["H-001", "H-002"]) {
  emit(signBatch(chain.state, "replay-2026-10-r2", h, "FINANCE", "fin-001"));
  emit(signBatch(chain.state, "replay-2026-10-r2", h, "POLICY", "pol-001"));
}
emit(openWindow(chain.state, "replay-2026-10-r2", "win-2026-10-01"));

// 8) 检查点发布：H-001 完成；H-002 在 MAPPING_LIVE 后“故障” ---------------
for (const stage of ["MAPPING_LIVE", "DIFF_CONFIRMED"]) {
  chain.append(markCheckpoint(chain.state, "replay-2026-10-r2", "H-001", stage));
}
chain.append(publishHospital(chain.state, "replay-2026-10-r2", "H-001", { published_by: "release-bot" }));
chain.append(markCheckpoint(chain.state, "replay-2026-10-r2", "H-002", "MAPPING_LIVE"));
// 进程在此崩溃；重启后凭事件日志重建状态并恢复
const recovered = new ReleaseChain(chain.events);
const resumeResult = recovered.resume("replay-2026-10-r2");
say("故障恢复：未完成医院与剩余阶段", resumeResult.pending);
recovered.append(markCheckpoint(recovered.state, "replay-2026-10-r2", "H-002", "DIFF_CONFIRMED"));
recovered.append(publishHospital(recovered.state, "replay-2026-10-r2", "H-002", { published_by: "release-bot" }));
// 恢复后再次发布 H-001 是空操作，绝不重复发布
const republish = publishHospital(recovered.state, "replay-2026-10-r2", "H-001", {});
say("重复发布 H-001 被短路（null 表示无新事件）", republish);

// 9) 已发布结果只追加更正版本，不覆盖原证据 --------------------------------
recovered.append(issueCorrection(recovered.state, "replay-2026-10-r2", "H-001", {
  correction_version: "corr-2026-11-001",
  reason: "H-001 对 A001 的院方加码比例按 11 月政策解释，原影子证据保留",
}));
{
  const b = recovered.state.replays.get("replay-2026-10-r2").hospitals.get("H-001");
  say("原发布证据未被覆盖，旁挂更正版本", { original_publish_event_id: b.publish.event_id, corrections: b.corrections });
}

// 10) 对账：每项金额变化可追溯到目录条目、映射决定、签署人与发布证据 --------
const trace = recovered.report("replay-2026-10-r2").hospitals[0].trace[0];
say("逐项追溯样例（CL-1001）", {
  delta_cents: trace.delta_cents,
  catalog_entry: trace.catalog_entry,
  mapping_decision: trace.mapping_decision,
  signers: trace.signers,
  publication: trace.publication,
});

// 11) 最小可见：只授权 H-001 的查看者看不到 H-002 明细 ----------------------
const viewer = { viewer_id: "auditor-h1", authorized_hospital_ids: ["H-001"] };
const visible = redactReport(recovered.report("replay-2026-10-r2"), viewer).hospitals.map((h) => ({
  hospital_id: h.hospital_id,
  redacted: h.redacted === true,
  trace_count: h.trace ? h.trace.length : null,
}));
say("按授权医院范围裁剪后的可见性", visible);

console.log("\n演示完成。");
