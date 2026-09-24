// 个人信息最小可见：事件本身只允许假名（见 events.js 的黑名单校验）；
// 这里再按“查看者被授权的医院范围”做投影——未授权医院的理赔明细不可见，
// 授权医院也只返回对账所需的最小字段白名单，不返回快照中其余内容。

// 授权医院可见的理赔字段白名单（其余字段一律剥离）。
// attributed_month 是重放时按政策基准计算出的派生字段，不在原始快照中。
export const MINIMAL_CLAIM_FIELDS = Object.freeze([
  "claim_id",
  "person_pseudonym",
  "service_date",
  "settlement_date",
  "entry_code",
  "amount_cents",
  "prior_category",
  "prior_self_pay_cents",
]);

export function isAuthorizedFor(viewer, hospitalId) {
  return Array.isArray(viewer?.authorized_hospital_ids) && viewer.authorized_hospital_ids.includes(hospitalId);
}

// 单条快照事件的授权投影。
export function redactSnapshotEvent(event, viewer) {
  if (event.kind !== "CLAIM_SNAPSHOT_CAPTURED") return event;
  const hospitalId = event.payload.hospital_id;
  if (!isAuthorizedFor(viewer, hospitalId)) {
    return {
      ...event,
      payload: {
        hospital_id: hospitalId,
        snapshot_version: event.payload.snapshot_version,
        catalog_version: event.payload.catalog_version,
        claims_redacted: true,
        claim_count: event.payload.claims.length,
      },
    };
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      claims: event.payload.claims.map((claim) =>
        Object.fromEntries(MINIMAL_CLAIM_FIELDS.filter((f) => f in claim).map((f) => [f, claim[f]]))
      ),
    },
  };
}

// 对 reconciliationReport 做同样的按医院裁剪：
// - 授权医院：保留逐项追溯（trace 行内本就不含假名以外的身份字段，假名也不出现在 trace 中）；
// - 未授权医院：只保留状态与钉住版本，金额、明细、重复件与分歧内容全部脱敏。
export function redactReport(report, viewer) {
  return {
    ...report,
    hospitals: report.hospitals.map((hospital) => {
      if (isAuthorizedFor(viewer, hospital.hospital_id)) return hospital;
      return {
        hospital_id: hospital.hospital_id,
        status: hospital.status,
        replay_version: hospital.replay_version,
        result_hash: hospital.result_hash,
        pinned_versions: hospital.pinned_versions,
        redacted: true,
      };
    }),
  };
}
