// insurance_shadow_settlement 领域资料的基础结构。
//
// 可复算上线链的顺序：冻结目录与基线 → 医院提交映射 → 按基线重放理赔 →
// 分类差异 → 财务与政策分别签署 → 进入发布窗口 → 按医院发布 →（更正版本 / 检查点恢复）。
// 影子结果只用于评估；已发布结果只允许用更正版本解释，不能覆盖原证据。

export const EVENT_KINDS = Object.freeze([
  "CATALOG_FROZEN", // 目录冻结
  "BASELINE_FROZEN", // 重放基线冻结：目录、映射、理赔快照、自付规则、测试场景绑定为同一版本
  "MAPPING_SUBMITTED", // 医院提交映射，携带基线版本用于并发检测
  "MAPPING_REJECTED", // 基线版本不符，映射提交被驳回
  "MAPPING_REVISED", // 映射修订，只重算未签署批次
  "CLAIM_REPLAYED", // 按基线重放历史理赔
  "REPLAY_SKIPPED", // 重复或越界理赔被跳过，留下不重复计入的证据
  "DIFF_CLASSIFIED", // 重放差异分类
  "RELEASE_SIGNED", // 财务或政策单方签署
  "RELEASE_WINDOW_OPENED", // 双方签署齐全，进入发布窗口
  "RESULT_PUBLISHED", // 结果按医院对外发布
  "CORRECTION_ISSUED", // 更正版本，解释已发布结果，不覆盖原证据
  "CHECKPOINT_RECORDED", // 切换检查点
  "RECOVERY_RESUMED", // 从检查点恢复未完成的医院
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// 每种事件在 payload 中至少需要的字段。
export const PAYLOAD_REQUIREMENTS = Object.freeze({
  CATALOG_FROZEN: ["catalog_version", "effective_from", "frozen_by"],
  BASELINE_FROZEN: [
    "baseline_version",
    "catalog_version",
    "mapping_version",
    "claim_snapshot_id",
    "copay_rule_version",
    "scenario_version",
    "frozen_by",
  ],
  MAPPING_SUBMITTED: ["submission_id", "hospital_id", "baseline_version", "mapping_version", "items", "submitted_by"],
  MAPPING_REJECTED: ["submission_id", "hospital_id", "expected_baseline_version", "actual_baseline_version", "reason"],
  MAPPING_REVISED: ["revision_id", "hospital_id", "mapping_version", "base_mapping_version", "affected_batch_ids", "revised_by"],
  CLAIM_REPLAYED: [
    "replay_id",
    "batch_id",
    "baseline_version",
    "mapping_version",
    "claim_snapshot_id",
    "claim_id",
    "hospital_id",
    "service_period",
    "settlement_period",
    "attributed_period",
    "attribution_policy",
    "shadow_amount",
    "currency",
  ],
  REPLAY_SKIPPED: ["claim_id", "baseline_version", "reason", "original_replay_id"],
  DIFF_CLASSIFIED: [
    "diff_id",
    "replay_id",
    "claim_id",
    "batch_id",
    "baseline_version",
    "category",
    "amount_delta",
    "currency",
    "catalog_item_code",
    "mapping_ref",
  ],
  RELEASE_SIGNED: ["signoff_id", "batch_id", "baseline_version", "role", "decision", "signed_by"],
  RELEASE_WINDOW_OPENED: ["window_id", "batch_id", "baseline_version", "finance_signoff_id", "policy_signoff_id", "opened_by"],
  RESULT_PUBLISHED: ["publication_id", "batch_id", "window_id", "hospital_id", "published_version", "published_by"],
  CORRECTION_ISSUED: ["correction_id", "corrects_publication_id", "batch_id", "reason", "corrected_by"],
  CHECKPOINT_RECORDED: ["checkpoint_id", "batch_id", "hospital_id", "completed_steps", "pending_steps"],
  RECOVERY_RESUMED: ["recovery_id", "checkpoint_id", "batch_id", "hospital_id", "resumed_by"],
});

// 枚举取值。
export const SIGNOFF_ROLES = Object.freeze(["FINANCE", "POLICY"]);
export const SIGNOFF_DECISIONS = Object.freeze(["APPROVE", "REJECT"]);
export const DIFF_CATEGORIES = Object.freeze(["MAPPING_CHANGE", "CATALOG_CHANGE", "COPAY_CHANGE", "NO_CHANGE"]);
export const SKIP_REASONS = Object.freeze(["DUPLICATE", "OUT_OF_SNAPSHOT"]);
export const ATTRIBUTION_POLICIES = Object.freeze(["SERVICE_MONTH", "SETTLEMENT_MONTH"]);

const ENUM_FIELDS = Object.freeze({
  RELEASE_SIGNED: { role: SIGNOFF_ROLES, decision: SIGNOFF_DECISIONS },
  DIFF_CLASSIFIED: { category: DIFF_CATEGORIES },
  REPLAY_SKIPPED: { reason: SKIP_REASONS },
  CLAIM_REPLAYED: { attribution_policy: ATTRIBUTION_POLICIES },
});

// 个人信息最小可见：payload 任何层级都不允许出现原始身份字段，
// 只能使用脱敏编号（claim_id、subject_id 等），下游按 hospital_id 限定授权医院的可见范围。
export const FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
  "patient_name",
  "id_card_number",
  "social_security_number",
  "phone_number",
  "home_address",
  "bank_account",
]);

function findForbiddenKeys(value, path, found) {
  if (value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenKeys(item, `${path}[${index}]`, found));
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) found.push(childPath);
    else findForbiddenKeys(child, childPath, found);
  }
  return found;
}

// 返回问题列表，空数组表示事件符合领域约定。
export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) {
    problems.push("kind");
    return problems;
  }
  if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
    problems.push("payload");
    return problems;
  }
  for (const name of PAYLOAD_REQUIREMENTS[record.kind]) {
    if (!(name in record.payload)) problems.push(`payload.${name}`);
  }
  for (const [field, allowed] of Object.entries(ENUM_FIELDS[record.kind] ?? {})) {
    if (field in record.payload && !allowed.includes(record.payload[field])) problems.push(`payload.${field}`);
  }
  return problems.concat(findForbiddenKeys(record.payload, "payload", []));
}
