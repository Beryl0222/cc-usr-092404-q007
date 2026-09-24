// 可复算上线链的链上不变量。
// 输入为按发生顺序排列的事件数组，返回问题列表（空数组表示链有效）。
// 单事件字段校验见 insurance_shadow_settlement.js 的 validateEvent。

export function validateChain(events) {
  const problems = [];
  const baselines = new Set(); // 已冻结的基线版本
  let currentBaseline = null; // 当前（最近一次冻结）基线
  const replays = new Map(); // `${baseline_version}|${claim_id}` -> replay_id，用于去重
  const replayIds = new Set();
  const signoffs = new Map(); // signoff_id -> payload
  const approvedRoles = new Map(); // batch_id -> Set<role>
  const windows = new Set(); // 已进入发布窗口的 batch_id
  const publications = new Map(); // `${batch_id}|${hospital_id}` -> publication_id
  const publicationIds = new Set();
  const checkpoints = new Set();
  const staleSubmissions = new Map(); // 基线不符、尚未被驳回的 submission_id

  for (const event of events) {
    const p = event.payload ?? {};
    switch (event.kind) {
      case "BASELINE_FROZEN":
        baselines.add(p.baseline_version);
        currentBaseline = p.baseline_version;
        break;
      case "MAPPING_SUBMITTED":
        // 并发提交时检测基线版本：不是当前基线的提交必须被驳回。
        if (p.baseline_version !== currentBaseline) staleSubmissions.set(p.submission_id, event.event_id);
        break;
      case "MAPPING_REJECTED":
        staleSubmissions.delete(p.submission_id);
        break;
      case "CLAIM_REPLAYED": {
        if (!baselines.has(p.baseline_version)) problems.push(`unknown-baseline:${event.event_id}`);
        // 重复理赔不重复计入：同一基线同一理赔只重放一次。
        const key = `${p.baseline_version}|${p.claim_id}`;
        if (replays.has(key)) problems.push(`duplicate-replay:${p.claim_id}`);
        else replays.set(key, p.replay_id);
        replayIds.add(p.replay_id);
        break;
      }
      case "REPLAY_SKIPPED":
        // 跳过留证必须能指到已计入的那一次重放。
        if (p.reason === "DUPLICATE" && !replays.has(`${p.baseline_version}|${p.claim_id}`)) {
          problems.push(`skip-without-original:${p.claim_id}`);
        }
        break;
      case "DIFF_CLASSIFIED":
        // 每项金额变化都要能追到一次重放。
        if (!replayIds.has(p.replay_id)) problems.push(`diff-without-replay:${p.diff_id}`);
        break;
      case "RELEASE_SIGNED": {
        signoffs.set(p.signoff_id, p);
        if (p.decision === "APPROVE") {
          if (!approvedRoles.has(p.batch_id)) approvedRoles.set(p.batch_id, new Set());
          approvedRoles.get(p.batch_id).add(p.role);
        }
        break;
      }
      case "RELEASE_WINDOW_OPENED": {
        // 影子结果只用于评估：财务与政策分别批准后才可进入发布窗口。
        const roles = approvedRoles.get(p.batch_id) ?? new Set();
        if (!roles.has("FINANCE") || !roles.has("POLICY")) problems.push(`window-without-signoffs:${p.batch_id}`);
        for (const [field, role] of [
          ["finance_signoff_id", "FINANCE"],
          ["policy_signoff_id", "POLICY"],
        ]) {
          const signoff = signoffs.get(p[field]);
          if (!signoff || signoff.batch_id !== p.batch_id || signoff.role !== role) {
            problems.push(`window-signoff-mismatch:${p.window_id}`);
          }
        }
        windows.add(p.batch_id);
        break;
      }
      case "RESULT_PUBLISHED": {
        if (!windows.has(p.batch_id)) problems.push(`publish-without-window:${p.publication_id}`);
        // 恢复后也不重复发布：同一批次同一医院只发布一次。
        const key = `${p.batch_id}|${p.hospital_id}`;
        if (publications.has(key)) problems.push(`duplicate-publication:${key}`);
        else publications.set(key, p.publication_id);
        publicationIds.add(p.publication_id);
        break;
      }
      case "CORRECTION_ISSUED":
        // 更正版本必须指向已发布的结果，原证据保留。
        if (!publicationIds.has(p.corrects_publication_id)) {
          problems.push(`correction-target-missing:${p.correction_id}`);
        }
        break;
      case "MAPPING_REVISED":
        // 映射修订只重算未签署（未进入发布窗口）的批次。
        for (const batchId of p.affected_batch_ids ?? []) {
          if (windows.has(batchId)) problems.push(`revision-touches-released-batch:${batchId}`);
        }
        break;
      case "CHECKPOINT_RECORDED":
        checkpoints.add(p.checkpoint_id);
        break;
      case "RECOVERY_RESUMED":
        // 切换失败只能从已记录的检查点恢复。
        if (!checkpoints.has(p.checkpoint_id)) problems.push(`recovery-checkpoint-missing:${p.recovery_id}`);
        break;
      default:
        break;
    }
  }

  for (const submissionId of staleSubmissions.keys()) {
    problems.push(`stale-mapping-not-rejected:${submissionId}`);
  }
  return problems;
}
