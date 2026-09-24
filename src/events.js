// 上线链事件契约：冻结目录 → 医院映射 → 历史理赔快照 → 个人自付规则 → 测试场景
// → 同版本重放 → 差异分类 → 财务/政策双签署 → 发布窗口 → 检查点/更正。
// 所有跨环节交换都以事件为唯一载体；事件一经追加不可修改，更正只能追加新版本。
//
// 约定：
// - 金额一律为以“分”为单位的非负整数，禁止浮点金额；
// - 人只允许出现假名（person_pseudonym），禁止真实姓名、证件号、手机号等原始个人信息；
// - 所有 *_version 为调用方给出的非空字符串，基线并发检测以版本号为准。

import { randomUUID } from "node:crypto";

export const EVENT_KINDS = Object.freeze([
  // 旧有五类事件名称保持不变
  "CATALOG_FROZEN", // 目录冻结
  "CLAIM_REPLAYED", // 某医院批次按绑定版本重放完成
  "DIFF_CLASSIFIED", // 重放差异完成分类
  "MAPPING_REVISED", // 医院映射修订（初始提交见 HOSPITAL_MAPPING_SUBMITTED）
  "RELEASE_SIGNED", // 财务或政策对某医院批次签署
  // 上线链新增事件
  "HOSPITAL_MAPPING_SUBMITTED", // 医院首次提交映射（带基线版本）
  "CLAIM_SNAPSHOT_CAPTURED", // 历史理赔快照
  "PERSONAL_RULES_LOCKED", // 个人自付规则锁定
  "TEST_SCENARIO_LOCKED", // 测试场景锁定
  "REPLAY_REQUESTED", // 五要素按同一版本绑定，发起重放
  "RELEASE_WINDOW_OPENED", // 双角色签署齐备，打开发布窗口
  "RESULT_PUBLISHED", // 某医院影子结果对外发布（证据固化，不可覆盖）
  "CORRECTION_ISSUED", // 对已发布结果追加更正版本，不覆盖原证据
  "RELEASE_CHECKPOINT", // 发布检查点：按医院、按阶段记录
  "RELEASE_RESUMED", // 切换失败后从检查点恢复
]);

export const SIGN_ROLES = Object.freeze(["FINANCE", "POLICY"]);
export const ATTRIBUTION_BASES = Object.freeze(["SERVICE_DATE", "SETTLEMENT_DATE"]);
// 单家医院发布时需要逐一完成的检查点阶段
export const CHECKPOINT_STAGES = Object.freeze(["MAPPING_LIVE", "DIFF_CONFIRMED"]);

// 原始个人信息字段黑名单：事件载荷任何层级出现这些键都视为违约。
export const FORBIDDEN_PII_FIELDS = Object.freeze(
  ["name", "real_name", "id_card", "id_card_no", "id_number", "phone", "mobile", "address", "birth_date"]
);

// 每类事件 payload 的必填字段
export const PAYLOAD_REQUIRED = Object.freeze({
  CATALOG_FROZEN: ["catalog_version", "frozen_at", "entries"],
  HOSPITAL_MAPPING_SUBMITTED: ["hospital_id", "mapping_version", "base_mapping_version", "catalog_version", "decisions"],
  MAPPING_REVISED: ["hospital_id", "mapping_version", "base_mapping_version", "catalog_version", "decisions"],
  CLAIM_SNAPSHOT_CAPTURED: ["hospital_id", "snapshot_version", "catalog_version", "claims"],
  PERSONAL_RULES_LOCKED: ["rules_version", "rules"],
  TEST_SCENARIO_LOCKED: ["scenario_version", "scenarios"],
  REPLAY_REQUESTED: [
    "replay_id",
    "catalog_version",
    "mapping_versions",
    "snapshot_versions",
    "rules_version",
    "scenario_version",
    "attribution_basis",
  ],
  CLAIM_REPLAYED: ["replay_id", "hospital_id", "replay_version", "result_hash", "bindings", "lines", "totals"],
  DIFF_CLASSIFIED: ["replay_id", "hospital_id", "replay_version", "result_hash", "classes", "cross_hospital_divergence"],
  RELEASE_SIGNED: ["replay_id", "hospital_id", "replay_version", "result_hash", "role", "signer_id"],
  RELEASE_WINDOW_OPENED: ["replay_id", "window_id"],
  RESULT_PUBLISHED: ["replay_id", "hospital_id", "replay_version", "result_hash", "evidence"],
  CORRECTION_ISSUED: ["replay_id", "hospital_id", "original_publish_event_id", "correction_version", "reason"],
  RELEASE_CHECKPOINT: ["replay_id", "hospital_id", "stage"],
  RELEASE_RESUMED: ["replay_id", "pending_hospital_ids", "remaining"],
});

// 嵌套数组元素的必填字段
const NESTED_FIELDS = Object.freeze({
  entries: ["entry_code", "payment_category"],
  decisions: ["entry_code", "payment_category"],
  claims: ["claim_id", "person_pseudonym", "service_date", "settlement_date", "entry_code", "amount_cents", "prior_category", "prior_self_pay_cents"],
  rules: ["rule_id", "payment_category", "coinsurance_bp"],
  scenarios: ["scenario_id", "attribution_basis", "claim_ids"],
  lines: ["claim_id", "entry_code", "attributed_month", "old_self_pay_cents", "new_self_pay_cents", "delta_cents"],
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENVELOPE_FIELDS = ["event_id", "kind", "occurred_at", "subject_id", "payload"];

const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

function scanForbiddenPii(value, path, problems) {
  if (Array.isArray(value)) {
    value.forEach((item) => scanForbiddenPii(item, path, problems));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_PII_FIELDS.includes(key.toLowerCase())) {
        problems.push(`payload.${path}${key}: 禁止出现原始个人信息字段，请改用假名`);
      }
      scanForbiddenPii(child, path ? `${path}${key}.` : `${key}.`, problems);
    }
  }
}

// 校验单条事件，返回问题字符串数组；空数组表示合规。保持历史 API 形态。
export function validateEvent(record) {
  record = record ?? {};
  const problems = ENVELOPE_FIELDS.filter((name) => !(name in record));

  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  if ("event_id" in record && (typeof record.event_id !== "string" || !record.event_id)) problems.push("event_id");
  if ("occurred_at" in record && (typeof record.occurred_at !== "string" || !record.occurred_at)) problems.push("occurred_at");
  if ("subject_id" in record && (typeof record.subject_id !== "string" || !record.subject_id)) problems.push("subject_id");
  if (!("payload" in record) || !record.payload || typeof record.payload !== "object") {
    if ("payload" in record) problems.push("payload");
    return problems;
  }

  const payload = record.payload;
  for (const name of PAYLOAD_REQUIRED[record.kind] ?? []) {
    if (!(name in payload) || payload[name] === undefined) problems.push(`payload.${name}`);
  }

  const checkNested = (key) => {
    const rows = payload[key];
    if (!Array.isArray(rows)) return;
    rows.forEach((row, i) => {
      if (!row || typeof row !== "object") {
        problems.push(`payload.${key}[${i}]`);
        return;
      }
      for (const f of NESTED_FIELDS[key]) {
        if (!(f in row) || row[f] === undefined || row[f] === "") problems.push(`payload.${key}[${i}].${f}`);
      }
    });
  };
  ["entries", "decisions", "claims", "rules", "scenarios", "lines"].forEach(checkNested);

  // 类型与取值域
  if (record.kind === "CATALOG_FROZEN") {
    if (!DATE_RE.test(payload.frozen_at)) problems.push("payload.frozen_at");
    (payload.entries ?? []).forEach((e, i) => {
      if (e && !isNonNegInt(e.price_cents) && e.price_cents !== undefined) problems.push(`payload.entries[${i}].price_cents`);
    });
  }
  if (record.kind === "HOSPITAL_MAPPING_SUBMITTED" || record.kind === "MAPPING_REVISED") {
    if (payload.base_mapping_version !== null && typeof payload.base_mapping_version !== "string") {
      problems.push("payload.base_mapping_version");
    }
  }
  if (record.kind === "CLAIM_SNAPSHOT_CAPTURED") {
    (payload.claims ?? []).forEach((c, i) => {
      if (!c) return;
      if (!DATE_RE.test(c.service_date)) problems.push(`payload.claims[${i}].service_date`);
      if (!DATE_RE.test(c.settlement_date)) problems.push(`payload.claims[${i}].settlement_date`);
      if (!isNonNegInt(c.amount_cents)) problems.push(`payload.claims[${i}].amount_cents`);
      if (!isNonNegInt(c.prior_self_pay_cents)) problems.push(`payload.claims[${i}].prior_self_pay_cents`);
    });
  }
  if (record.kind === "PERSONAL_RULES_LOCKED") {
    (payload.rules ?? []).forEach((r, i) => {
      if (r && (!Number.isInteger(r.coinsurance_bp) || r.coinsurance_bp < 0 || r.coinsurance_bp > 10000)) {
        problems.push(`payload.rules[${i}].coinsurance_bp`);
      }
    });
  }
  if (record.kind === "TEST_SCENARIO_LOCKED") {
    (payload.scenarios ?? []).forEach((s, i) => {
      if (s && !ATTRIBUTION_BASES.includes(s.attribution_basis)) problems.push(`payload.scenarios[${i}].attribution_basis`);
      if (s && !Array.isArray(s.claim_ids)) problems.push(`payload.scenarios[${i}].claim_ids`);
    });
  }
  if (record.kind === "REPLAY_REQUESTED" && !ATTRIBUTION_BASES.includes(payload.attribution_basis)) {
    problems.push("payload.attribution_basis");
  }
  if (record.kind === "RELEASE_SIGNED" && !SIGN_ROLES.includes(payload.role)) {
    problems.push("payload.role");
  }
  if (record.kind === "RELEASE_CHECKPOINT" && !CHECKPOINT_STAGES.includes(payload.stage)) {
    problems.push("payload.stage");
  }
  if (record.kind === "CLAIM_REPLAYED") {
    (payload.lines ?? []).forEach((l, i) => {
      if (!l) return;
      for (const f of ["old_self_pay_cents", "new_self_pay_cents", "delta_cents"]) {
        if (!Number.isInteger(l[f])) problems.push(`payload.lines[${i}].${f}`);
      }
    });
  }

  scanForbiddenPii(payload, "", problems);
  return problems;
}

// 构造一条合规事件；不合规直接抛错，避免脏事件进入链路。
export function makeEvent(kind, payload, envelope = {}) {
  const subject =
    envelope.subject_id ??
    payload.hospital_id ??
    payload.replay_id ??
    payload.catalog_version ??
    payload.rules_version ??
    "system";
  const event = {
    event_id: envelope.event_id ?? randomUUID(),
    kind,
    occurred_at: envelope.occurred_at ?? new Date().toISOString(),
    subject_id: subject,
    payload,
  };
  const problems = validateEvent(event);
  if (problems.length) {
    const err = new Error(`事件不合规 (${kind}): ${problems.join("; ")}`);
    err.code = "INVALID_EVENT";
    err.problems = problems;
    throw err;
  }
  return event;
}
