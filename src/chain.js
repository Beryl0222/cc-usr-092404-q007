// 上线链状态机：所有状态只能由合规事件 fold 得到（事件溯源）。
//
// 关键规则：
// 1. 五要素（目录/映射/快照/规则/场景）在 REPLAY_REQUESTED 时按版本钉住，之后修订不影响在跑批次；
// 2. 医院并发提交映射做乐观并发：base_mapping_version 必须等于当前基线，否则 BASE_VERSION_CONFLICT；
// 3. CLAIM_REPLAYED / DIFF_CLASSIFIED 入账时按钉住版本重算并核对 result_hash，哈希不符拒绝入账；
// 4. 映射修订只能重算“未签署”批次；已有任一签署的批次冻结，已发布批次只能追加 CORRECTION_ISSUED；
// 5. 发布按医院经过 MAPPING_LIVE → DIFF_CONFIRMED 两个检查点；恢复时跳过已完成阶段，
//    既不重复发布，也不重复/丢失差异确认；
// 6. RESULT_PUBLISHED 固化证据（事件行不可变），CORRECTION_ISSUED 只追加解释，不覆盖原证据。

import { makeEvent, SIGN_ROLES, CHECKPOINT_STAGES } from "./events.js";
import { computeReplay, classifyView, canonicalJSON } from "./model.js";

export const BATCH_STATUS = Object.freeze({
  REPLAYED: "REPLAYED",
  CLASSIFIED: "CLASSIFIED",
  SIGNED: "SIGNED",
  PUBLISHED: "PUBLISHED",
  CORRECTED: "CORRECTED",
});

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

function emptyState() {
  return {
    catalogs: new Map(), // catalog_version -> 冻结目录
    catalogVersion: null,
    mappingVersions: new Map(), // `${hospital}|${version}` -> 映射载荷
    mappingCurrent: new Map(), // hospital -> mapping_version
    snapshotVersions: new Map(), // `${hospital}|${version}` -> 快照载荷
    snapshotCurrent: new Map(), // hospital -> snapshot_version
    rulesVersions: new Map(), // rules_version -> 规则载荷
    rulesVersion: null,
    scenarioVersions: new Map(), // scenario_version -> 场景载荷
    scenarioVersion: null,
    replays: new Map(), // replay_id -> { request, hospitals: Map<hospital, batch> }
    windows: new Map(), // window_id -> replay_id
  };
}

const mvKey = (hospital, version) => `${hospital}|${version}`;

// ---- 写命令：均返回“待追加事件”（单条或数组），不直接改状态 -----------------

export function freezeCatalog(state, { catalog_version, frozen_at, entries }) {
  if (state.catalogVersion) throw fail("CATALOG_ALREADY_FROZEN", "目录已冻结，不能再次冻结");
  if (state.catalogs.has(catalog_version)) throw fail("VERSION_DUPLICATED", `目录版本已存在: ${catalog_version}`);
  return makeEvent("CATALOG_FROZEN", { catalog_version, frozen_at, entries: structuredClone(entries) });
}

function submitMappingEvent(kind, state, { hospital_id, mapping_version, base_mapping_version, decisions }) {
  if (!state.catalogVersion) throw fail("CATALOG_NOT_FROZEN", "目录尚未冻结，不能提交映射");
  if (state.mappingVersions.has(mvKey(hospital_id, mapping_version))) {
    throw fail("VERSION_DUPLICATED", `医院 ${hospital_id} 映射版本已存在: ${mapping_version}`);
  }
  const current = state.mappingCurrent.get(hospital_id) ?? null;
  // 乐观并发：基线必须与当前版本一致；首次提交基线为 null。
  if (base_mapping_version !== current) {
    throw fail("BASE_VERSION_CONFLICT", `医院 ${hospital_id} 基线版本过期：期望 ${current}，收到 ${base_mapping_version}`, {
      expected_base: current,
      submitted_base: base_mapping_version,
    });
  }
  const known = new Set(state.catalogs.get(state.catalogVersion).entries.map((e) => e.entry_code));
  for (const d of decisions) {
    if (!known.has(d.entry_code)) throw fail("UNKNOWN_CATALOG_ENTRY", `映射条目不在冻结目录中: ${d.entry_code}`);
  }
  return makeEvent(kind, {
    hospital_id,
    mapping_version,
    base_mapping_version,
    catalog_version: state.catalogVersion,
    decisions: structuredClone(decisions),
  });
}

export const submitMapping = (state, input) => submitMappingEvent("HOSPITAL_MAPPING_SUBMITTED", state, input);
export const reviseMapping = (state, input) => {
  if (!state.mappingCurrent.has(input.hospital_id)) {
    throw fail("MAPPING_NOT_FOUND", `医院 ${input.hospital_id} 尚无基线映射，请使用首次提交`);
  }
  return submitMappingEvent("MAPPING_REVISED", state, input);
};

export function captureSnapshot(state, { hospital_id, snapshot_version, claims }) {
  if (!state.catalogVersion) throw fail("CATALOG_NOT_FROZEN", "目录尚未冻结，不能截取理赔快照");
  if (state.snapshotVersions.has(mvKey(hospital_id, snapshot_version))) {
    throw fail("VERSION_DUPLICATED", `医院 ${hospital_id} 快照版本已存在: ${snapshot_version}`);
  }
  return makeEvent("CLAIM_SNAPSHOT_CAPTURED", {
    hospital_id,
    snapshot_version,
    catalog_version: state.catalogVersion,
    claims: structuredClone(claims),
  });
}

export function lockPersonalRules(state, { rules_version, rules }) {
  if (state.rulesVersions.has(rules_version)) throw fail("VERSION_DUPLICATED", `规则版本已存在: ${rules_version}`);
  return makeEvent("PERSONAL_RULES_LOCKED", { rules_version, rules: structuredClone(rules) });
}

export function lockTestScenarios(state, { scenario_version, scenarios }) {
  if (state.scenarioVersions.has(scenario_version)) throw fail("VERSION_DUPLICATED", `场景版本已存在: ${scenario_version}`);
  return makeEvent("TEST_SCENARIO_LOCKED", { scenario_version, scenarios: structuredClone(scenarios) });
}

export function requestReplay(
  state,
  { replay_id, mapping_versions, snapshot_versions, rules_version, scenario_version, attribution_basis }
) {
  if (state.replays.has(replay_id)) throw fail("VERSION_DUPLICATED", `重放计划已存在: ${replay_id}`);
  for (const [hospital, version] of Object.entries(mapping_versions)) {
    if (!state.mappingVersions.has(mvKey(hospital, version))) {
      throw fail("VERSION_NOT_FOUND", `医院 ${hospital} 的映射版本不存在: ${version}`);
    }
  }
  for (const [hospital, version] of Object.entries(snapshot_versions)) {
    if (!state.snapshotVersions.has(mvKey(hospital, version))) {
      throw fail("VERSION_NOT_FOUND", `医院 ${hospital} 的快照版本不存在: ${version}`);
    }
  }
  const hospitals = new Set([...Object.keys(mapping_versions), ...Object.keys(snapshot_versions)]);
  if (!hospitals.size) throw fail("PLAN_INCOMPLETE", "重放计划至少要包含一家医院的映射与快照版本");
  for (const hospital of hospitals) {
    if (!mapping_versions[hospital] || !snapshot_versions[hospital]) {
      throw fail("PLAN_INCOMPLETE", `医院 ${hospital} 缺少映射或快照版本，五要素不完整`);
    }
  }
  if (!state.rulesVersions.has(rules_version)) throw fail("VERSION_NOT_FOUND", `规则版本不存在: ${rules_version}`);
  if (!state.scenarioVersions.has(scenario_version)) throw fail("VERSION_NOT_FOUND", `场景版本不存在: ${scenario_version}`);
  return makeEvent("REPLAY_REQUESTED", {
    replay_id,
    catalog_version: state.catalogVersion,
    mapping_versions: { ...mapping_versions },
    snapshot_versions: { ...snapshot_versions },
    rules_version,
    scenario_version,
    attribution_basis,
  });
}

// 按钉住版本为整份计划做一次确定性重算（校验与命令共用）。
function recomputePlan(state, request) {
  const hospitals = [...new Set([...Object.keys(request.mapping_versions), ...Object.keys(request.snapshot_versions)])].sort();
  return computeReplay({
    replay_id: request.replay_id,
    catalog: state.catalogs.get(request.catalog_version),
    mappings: hospitals.map((h) => state.mappingVersions.get(mvKey(h, request.mapping_versions[h]))),
    snapshots: hospitals.map((h) => state.snapshotVersions.get(mvKey(h, request.snapshot_versions[h]))),
    rules: state.rulesVersions.get(request.rules_version),
    scenario: state.scenarioVersions.get(request.scenario_version),
    attribution_basis: request.attribution_basis,
  });
}

const requireBatch = (state, replayId, hospitalId) => {
  const plan = state.replays.get(replayId);
  if (!plan) throw fail("REPLAY_NOT_FOUND", `重放计划不存在: ${replayId}`);
  const batch = plan.hospitals.get(hospitalId);
  if (!batch) throw fail("BATCH_NOT_IN_PLAN", `医院 ${hospitalId} 不在重放计划 ${replayId} 中`);
  return { plan, batch };
};

// 重放某医院批次。若该批次已有任一角色签署，则拒绝——映射修订只重算未签署批次。
export function replayHospital(state, replayId, hospitalId) {
  const { plan, batch } = requireBatch(state, replayId, hospitalId);
  const signed = SIGN_ROLES.filter((role) => batch.signatures[role]);
  if (signed.length) {
    throw fail("BATCH_ALREADY_SIGNED", `医院 ${hospitalId} 批次已被 ${signed.join("、")} 签署，不能重算；已发布须走更正版本`, {
      signed_roles: signed,
    });
  }
  const full = recomputePlan(state, plan.request);
  const result = full.hospitals.find((h) => h.hospital_id === hospitalId);
  return makeEvent("CLAIM_REPLAYED", {
    replay_id: replayId,
    hospital_id: hospitalId,
    replay_version: result.replay_version,
    result_hash: result.result_hash,
    bindings: result.bindings,
    lines: result.lines,
    totals: result.totals,
    monthly: result.monthly,
    classes: result.classes,
    duplicates: full.duplicates.filter((d) => d.hospital_id === hospitalId),
  });
}

export function classifyHospital(state, replayId, hospitalId) {
  const { plan, batch } = requireBatch(state, replayId, hospitalId);
  if (!batch.replay_version) throw fail("BATCH_NOT_REPLAYED", `医院 ${hospitalId} 批次尚未重放`);
  const full = recomputePlan(state, plan.request);
  const view = classifyView(full, hospitalId);
  return makeEvent("DIFF_CLASSIFIED", {
    replay_id: replayId,
    hospital_id: hospitalId,
    replay_version: batch.replay_version,
    result_hash: batch.result_hash,
    classes: view.classes,
    cross_hospital_divergence: view.cross_hospital_divergence,
  });
}

export function signBatch(state, replayId, hospitalId, role, signerId) {
  if (!SIGN_ROLES.includes(role)) throw fail("UNKNOWN_ROLE", `未知签署角色: ${role}`);
  const { batch } = requireBatch(state, replayId, hospitalId);
  if (!batch.classified_event_id) throw fail("BATCH_NOT_CLASSIFIED", "差异尚未分类，不能签署");
  if (batch.signatures[role]) {
    throw fail("ALREADY_SIGNED", `${role} 已由 ${batch.signatures[role].signer_id} 签署`);
  }
  return makeEvent("RELEASE_SIGNED", {
    replay_id: replayId,
    hospital_id: hospitalId,
    replay_version: batch.replay_version,
    result_hash: batch.result_hash,
    role,
    signer_id: signerId,
  });
}

export function openWindow(state, replayId, windowId) {
  const plan = state.replays.get(replayId);
  if (!plan) throw fail("REPLAY_NOT_FOUND", `重放计划不存在: ${replayId}`);
  for (const [hospitalId, batch] of plan.hospitals) {
    const missing = SIGN_ROLES.filter((role) => !batch.signatures[role]);
    if (missing.length) throw fail("SIGNATURES_INCOMPLETE", `医院 ${hospitalId} 缺少签署: ${missing.join("、")}`);
  }
  if (plan.window_id) throw fail("WINDOW_ALREADY_OPENED", `发布窗口已打开: ${plan.window_id}`);
  return makeEvent("RELEASE_WINDOW_OPENED", { replay_id: replayId, window_id: windowId });
}

export function markCheckpoint(state, replayId, hospitalId, stage) {
  if (!CHECKPOINT_STAGES.includes(stage)) throw fail("UNKNOWN_STAGE", `未知检查点阶段: ${stage}`);
  const { plan, batch } = requireBatch(state, replayId, hospitalId);
  if (!plan.window_id) throw fail("WINDOW_NOT_OPENED", "发布窗口尚未打开");
  if (batch.checkpoints.has(stage)) return null; // 幂等：恢复时不重复记录
  if (batch.publish) throw fail("ALREADY_PUBLISHED", "批次已发布，检查点已封闭");
  return makeEvent("RELEASE_CHECKPOINT", { replay_id: replayId, hospital_id: hospitalId, stage });
}

// 发布准备：返回需要追加的检查点事件（已完成阶段自动跳过）。
// 调用方在真实切换中逐阶段执行；每个阶段成功后追加对应检查点，故障后凭 resume 继续。
export function prepareHospitalSwitch(state, replayId, hospitalId) {
  const { plan, batch } = requireBatch(state, replayId, hospitalId);
  if (!plan.window_id) throw fail("WINDOW_NOT_OPENED", "发布窗口尚未打开");
  const events = [];
  for (const stage of CHECKPOINT_STAGES) {
    if (!batch.checkpoints.has(stage) && !batch.publish) {
      events.push(makeEvent("RELEASE_CHECKPOINT", { replay_id: replayId, hospital_id: hospitalId, stage }));
    }
  }
  return events;
}

export function publishHospital(state, replayId, hospitalId, evidence = {}) {
  const { plan, batch } = requireBatch(state, replayId, hospitalId);
  if (!plan.window_id) throw fail("WINDOW_NOT_OPENED", "发布窗口尚未打开");
  if (batch.publish) return null; // 幂等：绝不重复发布
  for (const stage of CHECKPOINT_STAGES) {
    if (!batch.checkpoints.has(stage)) {
      throw fail("CHECKPOINT_INCOMPLETE", `医院 ${hospitalId} 未完成检查点: ${stage}`, { remaining: remainingStages(batch) });
    }
  }
  return makeEvent("RESULT_PUBLISHED", {
    replay_id: replayId,
    hospital_id: hospitalId,
    replay_version: batch.replay_version,
    result_hash: batch.result_hash,
    evidence: { window_id: plan.window_id, ...evidence },
  });
}

// 已发布结果的更正：追加新版本解释，原证据保留不动。
export function issueCorrection(state, replayId, hospitalId, { correction_version, reason }) {
  const { batch } = requireBatch(state, replayId, hospitalId);
  if (!batch.publish) throw fail("NOT_PUBLISHED", "只有已发布结果才能发更正版本");
  if (batch.corrections.some((c) => c.correction_version === correction_version)) {
    throw fail("VERSION_DUPLICATED", `更正版本已存在: ${correction_version}`);
  }
  return makeEvent("CORRECTION_ISSUED", {
    replay_id: replayId,
    hospital_id: hospitalId,
    original_publish_event_id: batch.publish.event_id,
    correction_version,
    reason,
  });
}

function remainingStages(batch) {
  return CHECKPOINT_STAGES.filter((stage) => !batch.checkpoints.has(stage));
}

// 切换失败后恢复：列出未完成医院及其剩余阶段；登记 RELEASE_RESUMED 事件。
export function resume(state, replayId) {
  const plan = state.replays.get(replayId);
  if (!plan) throw fail("REPLAY_NOT_FOUND", `重放计划不存在: ${replayId}`);
  const pending = [];
  for (const [hospitalId, batch] of plan.hospitals) {
    if (batch.publish) continue;
    pending.push({ hospital_id: hospitalId, remaining: remainingStages(batch) });
  }
  if (!pending.length) return { event: null, pending: [] };
  const event = makeEvent("RELEASE_RESUMED", {
    replay_id: replayId,
    pending_hospital_ids: pending.map((p) => p.hospital_id),
    remaining: pending,
  });
  return { event, pending };
}

// ---- 事件 fold ------------------------------------------------------------

function applyEvent(state, event) {
  const p = event.payload;
  switch (event.kind) {
    case "CATALOG_FROZEN": {
      state.catalogs.set(p.catalog_version, { catalog_version: p.catalog_version, frozen_at: p.frozen_at, entries: p.entries });
      state.catalogVersion = p.catalog_version;
      break;
    }
    case "HOSPITAL_MAPPING_SUBMITTED":
    case "MAPPING_REVISED": {
      state.mappingVersions.set(mvKey(p.hospital_id, p.mapping_version), { ...p, decisions: p.decisions });
      state.mappingCurrent.set(p.hospital_id, p.mapping_version);
      break;
    }
    case "CLAIM_SNAPSHOT_CAPTURED": {
      state.snapshotVersions.set(mvKey(p.hospital_id, p.snapshot_version), { ...p, claims: p.claims });
      state.snapshotCurrent.set(p.hospital_id, p.snapshot_version);
      break;
    }
    case "PERSONAL_RULES_LOCKED": {
      state.rulesVersions.set(p.rules_version, { rules_version: p.rules_version, rules: p.rules });
      state.rulesVersion = p.rules_version;
      break;
    }
    case "TEST_SCENARIO_LOCKED": {
      state.scenarioVersions.set(p.scenario_version, { scenario_version: p.scenario_version, scenarios: p.scenarios });
      state.scenarioVersion = p.scenario_version;
      break;
    }
    case "REPLAY_REQUESTED": {
      const hospitals = [...new Set([...Object.keys(p.mapping_versions), ...Object.keys(p.snapshot_versions)])].sort();
      state.replays.set(p.replay_id, {
        request: p,
        window_id: null,
        hospitals: new Map(
          hospitals.map((h) => [
            h,
            {
              hospital_id: h,
              replay_version: null,
              result_hash: null,
              lines: [],
              totals: null,
              monthly: {},
              classes: {},
              divergence: [],
              duplicates: [],
              replay_event_id: null,
              classified_event_id: null,
              signatures: {},
              checkpoints: new Set(),
              publish: null,
              corrections: [],
              status: null,
            },
          ])
        ),
      });
      break;
    }
    case "CLAIM_REPLAYED": {
      const { plan, batch } = requireBatch(state, p.replay_id, p.hospital_id);
      const full = recomputePlan(state, plan.request);
      const computed = full.hospitals.find((h) => h.hospital_id === p.hospital_id);
      if (p.replay_version !== computed.replay_version) {
        throw fail("HASH_MISMATCH", `医院 ${p.hospital_id}  replay_version 与钉住版本重算结果不符`, {
          event_id: event.event_id,
        });
      }
      if (p.result_hash !== computed.result_hash) {
        throw fail("HASH_MISMATCH", `医院 ${p.hospital_id} result_hash 与重算结果不符`, { event_id: event.event_id });
      }
      Object.assign(batch, {
        replay_version: computed.replay_version,
        result_hash: computed.result_hash,
        bindings: computed.bindings,
        lines: computed.lines,
        totals: computed.totals,
        monthly: computed.monthly,
        classes: computed.classes,
        divergence: classifyView(full, p.hospital_id).cross_hospital_divergence,
        duplicates: full.duplicates.filter((d) => d.hospital_id === p.hospital_id),
        replay_event_id: event.event_id,
        classified_event_id: null,
        status: BATCH_STATUS.REPLAYED,
      });
      // 新重放结果自动作废此前分类与签署（能走到这里说明本就未签署）。
      batch.signatures = {};
      break;
    }
    case "DIFF_CLASSIFIED": {
      const { plan, batch } = requireBatch(state, p.replay_id, p.hospital_id);
      if (p.result_hash !== batch.result_hash) {
        throw fail("HASH_MISMATCH", "分类事件引用的结果哈希与当前批次不符", { event_id: event.event_id });
      }
      const view = classifyView(recomputePlan(state, plan.request), p.hospital_id);
      if (canonicalJSON(p.classes) !== canonicalJSON(view.classes)) {
        throw fail("HASH_MISMATCH", "分类计数与重算结果不符", { event_id: event.event_id });
      }
      batch.classes = view.classes;
      batch.divergence = view.cross_hospital_divergence;
      batch.classified_event_id = event.event_id;
      batch.status = BATCH_STATUS.CLASSIFIED;
      break;
    }
    case "RELEASE_SIGNED": {
      const { batch } = requireBatch(state, p.replay_id, p.hospital_id);
      if (p.result_hash !== batch.result_hash) {
        throw fail("HASH_MISMATCH", "签署事件引用的结果哈希与当前批次不符", { event_id: event.event_id });
      }
      batch.signatures[p.role] = { signer_id: p.signer_id, event_id: event.event_id };
      if (SIGN_ROLES.every((role) => batch.signatures[role])) batch.status = BATCH_STATUS.SIGNED;
      break;
    }
    case "RELEASE_WINDOW_OPENED": {
      state.replays.get(p.replay_id).window_id = p.window_id;
      state.windows.set(p.window_id, p.replay_id);
      break;
    }
    case "RELEASE_CHECKPOINT": {
      requireBatch(state, p.replay_id, p.hospital_id).batch.checkpoints.add(p.stage);
      break;
    }
    case "RESULT_PUBLISHED": {
      const { batch } = requireBatch(state, p.replay_id, p.hospital_id);
      if (p.result_hash !== batch.result_hash) {
        throw fail("HASH_MISMATCH", "发布事件引用的结果哈希与当前批次不符", { event_id: event.event_id });
      }
      batch.publish = { event_id: event.event_id, evidence: p.evidence, occurred_at: event.occurred_at };
      batch.status = BATCH_STATUS.PUBLISHED;
      break;
    }
    case "CORRECTION_ISSUED": {
      const { batch } = requireBatch(state, p.replay_id, p.hospital_id);
      if (!batch.publish || batch.publish.event_id !== p.original_publish_event_id) {
        throw fail("ORIGINAL_EVIDENCE_MISMATCH", "更正必须引用该批次原始发布事件", { event_id: event.event_id });
      }
      batch.corrections.push({
        event_id: event.event_id,
        correction_version: p.correction_version,
        reason: p.reason,
        occurred_at: event.occurred_at,
      });
      batch.status = BATCH_STATUS.CORRECTED;
      break;
    }
    case "RELEASE_RESUMED":
      break;
    default:
      throw fail("UNKNOWN_EVENT_KIND", `未知事件类型: ${event.kind}`);
  }
  return state;
}

// 从事件日志重建状态；任何哈希/基线不符都会抛出，日志不可被静默篡改。
export function fold(events) {
  let state = emptyState();
  for (const event of events) state = applyEvent(state, event);
  return state;
}

// ---- 对账：每项金额变化 → 目录条目 → 映射决定 → 签署人 → 发布/更正证据 ----

export function reconciliationReport(state, replayId) {
  const plan = state.replays.get(replayId);
  if (!plan) throw fail("REPLAY_NOT_FOUND", `重放计划不存在: ${replayId}`);
  const catalog = state.catalogs.get(plan.request.catalog_version);
  const catalogByCode = new Map(catalog.entries.map((e) => [e.entry_code, e]));

  const hospitals = [];
  for (const [hospitalId, batch] of plan.hospitals) {
    const mapping = state.mappingVersions.get(mvKey(hospitalId, plan.request.mapping_versions[hospitalId]));
    const decisionByCode = new Map(mapping.decisions.map((d) => [d.entry_code, d]));
    const trace = batch.lines.map((line) => {
      const decision = decisionByCode.get(line.entry_code) ?? null;
      return {
        claim_id: line.claim_id,
        entry_code: line.entry_code,
        attributed_month: line.attributed_month,
        old_category: line.old_category,
        new_category: line.new_category,
        old_self_pay_cents: line.old_self_pay_cents,
        new_self_pay_cents: line.new_self_pay_cents,
        delta_cents: line.delta_cents,
        diff_class: line.diff_class,
        catalog_entry: catalogByCode.get(line.entry_code) ?? null,
        mapping_decision: decision ? { mapping_version: mapping.mapping_version, ...decision } : null,
        signers: Object.fromEntries(
          SIGN_ROLES.map((role) => [role, batch.signatures[role] ? { ...batch.signatures[role] } : null])
        ),
        publication: batch.publish
          ? {
              event_id: batch.publish.event_id,
              replay_version: batch.replay_version,
              result_hash: batch.result_hash,
              evidence: batch.publish.evidence,
            }
          : null,
        corrections: batch.corrections,
      };
    });
    hospitals.push({
      hospital_id: hospitalId,
      status: batch.status,
      replay_version: batch.replay_version,
      result_hash: batch.result_hash,
      pinned_versions: {
        catalog_version: plan.request.catalog_version,
        mapping_version: plan.request.mapping_versions[hospitalId],
        snapshot_version: plan.request.snapshot_versions[hospitalId],
        rules_version: plan.request.rules_version,
        scenario_version: plan.request.scenario_version,
        attribution_basis: plan.request.attribution_basis,
      },
      totals: batch.totals,
      monthly: batch.monthly,
      checkpoints: [...batch.checkpoints],
      duplicates: batch.duplicates,
      cross_hospital_divergence: batch.divergence,
      trace,
    });
  }
  return { replay_id: replayId, window_id: plan.window_id, hospitals };
}

// 便捷封装：追加事件并返回最新状态。
export class ReleaseChain {
  constructor(events = []) {
    this.state = emptyState();
    this.events = [];
    for (const event of events) this.append(event);
  }

  append(event) {
    if (!event) return { skipped: true };
    applyEvent(this.state, event);
    this.events.push(event);
    return { skipped: false, event };
  }

  appendAll(events) {
    return events.map((event) => this.append(event));
  }

  resume(replayId) {
    const result = resume(this.state, replayId);
    if (result.event) this.append(result.event);
    return result;
  }

  report(replayId) {
    return reconciliationReport(this.state, replayId);
  }
}
