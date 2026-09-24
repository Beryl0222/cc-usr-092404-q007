// 纯领域计算：给定冻结目录、各医院映射版本、理赔快照、自付规则、场景与归属基准，
// 确定性地重放并分类差异。无 I/O、无时钟、无随机数——同样的五要素版本必然得到
// 同样的 replay_version 与 result_hash，这是“可复算”的根基。
//
// 金额全部为分（非负整数）；新自付额按整数截断计算，不引入浮点。

import { createHash } from "node:crypto";

// 差异分类
export const DIFF_CLASSES = Object.freeze({
  SELF_PAY_INCREASE: "SELF_PAY_INCREASE", // 个人自付增加
  SELF_PAY_DECREASE: "SELF_PAY_DECREASE", // 个人自付减少
  CATEGORY_SHIFT_NO_AMOUNT: "CATEGORY_SHIFT_NO_AMOUNT", // 支付类别变化但金额不变
  MAPPING_GAP: "MAPPING_GAP", // 医院映射缺少该条目
  NO_CHANGE: "NO_CHANGE",
});

export function attributedMonth(claim, basis) {
  const date = basis === "SETTLEMENT_DATE" ? claim.settlement_date : claim.service_date;
  return date.slice(0, 7); // YYYY-MM
}

// 对象键排序的确定性 JSON
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const parts = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}

function indexBy(list, key) {
  return new Map((list ?? []).map((row) => [row[key], row]));
}

// 计算一次重放。入参全部为已解析对象：
// {
//   replay_id, catalog:{catalog_version, entries:[...]},
//   mappings:[{hospital_id, mapping_version, decisions:[...]}],
//   snapshots:[{hospital_id, snapshot_version, claims:[...]}],
//   rules:{rules_version, rules:[{rule_id,payment_category,coinsurance_bp}]},
//   scenario:{scenario_version, scenarios:[...]}, attribution_basis,
//   scenario_id（可选，只重放该测试场景覆盖的理赔）
// }
export function computeReplay(input) {
  const { replay_id: replayId, catalog, mappings, snapshots, rules, scenario, attribution_basis: basis, scenario_id: scenarioId } = input;

  const catalogEntries = indexBy(catalog.entries, "entry_code");
  const rulesByCategory = indexBy(rules.rules, "payment_category");

  // 医院顺序固定，保证跨医院去重的“首次入账医院”等结果可复算。
  const orderedMappings = [...mappings].sort((a, b) => (a.hospital_id < b.hospital_id ? -1 : 1));
  const orderedSnapshots = [...snapshots].sort((a, b) => (a.hospital_id < b.hospital_id ? -1 : 1));

  let allowedClaimIds = null;
  if (scenarioId) {
    const picked = (scenario.scenarios ?? []).find((s) => s.scenario_id === scenarioId);
    if (!picked) throw Object.assign(new Error(`未知测试场景: ${scenarioId}`), { code: "UNKNOWN_SCENARIO" });
    if (picked.attribution_basis !== basis) {
      throw Object.assign(new Error(`场景 ${scenarioId} 要求归属基准 ${picked.attribution_basis}，与重放请求 ${basis} 不一致`), {
        code: "BASIS_MISMATCH",
      });
    }
    allowedClaimIds = new Set(picked.claim_ids);
  }

  // 批次绑定版本 → replay_version：只包含该医院的映射/快照版本，
  // 因此某家医院的映射修订只会使该院批次产生新版本，不影响他院已签署结果。
  const replayIdValue = replayId;
  const commonBindings = {
    replay_id: replayIdValue,
    catalog_version: catalog.catalog_version,
    rules_version: rules.rules_version,
    scenario_version: scenario.scenario_version,
    attribution_basis: basis,
  };

  // 全局理赔去重：同一 claim_id 在任何医院只计一次，重复件登记但不入账。
  const seenClaims = new Map();
  const duplicates = [];
  const perHospital = new Map();

  for (const snap of orderedSnapshots) {
    const mapping = orderedMappings.find((m) => m.hospital_id === snap.hospital_id);
    const decisions = indexBy(mapping?.decisions ?? [], "entry_code");
    const bindings = {
      ...commonBindings,
      hospital_id: snap.hospital_id,
      mapping_version: mapping?.mapping_version ?? null,
      snapshot_version: snap.snapshot_version,
    };
    const replayVersion = digest(bindings);

    const lines = [];
    for (const claim of snap.claims) {
      if (allowedClaimIds && !allowedClaimIds.has(claim.claim_id)) continue;
      if (seenClaims.has(claim.claim_id)) {
        duplicates.push({ claim_id: claim.claim_id, hospital_id: snap.hospital_id, first_seen_hospital_id: seenClaims.get(claim.claim_id) });
        continue;
      }
      seenClaims.set(claim.claim_id, snap.hospital_id);

      const entry = catalogEntries.get(claim.entry_code);
      const decision = decisions.get(claim.entry_code);
      const effectiveCategory = decision?.payment_category ?? entry?.payment_category ?? null;
      const rule = rulesByCategory.get(effectiveCategory);

      const oldSelfPay = claim.prior_self_pay_cents;
      let newSelfPay = oldSelfPay;
      let diffClass;
      if (!effectiveCategory || !rule) {
        newSelfPay = oldSelfPay;
        diffClass = DIFF_CLASSES.MAPPING_GAP;
      } else {
        // 整数截断，避免浮点金额
        newSelfPay = Math.trunc((claim.amount_cents * rule.coinsurance_bp) / 10000);
        const delta = newSelfPay - oldSelfPay;
        if (delta > 0) diffClass = DIFF_CLASSES.SELF_PAY_INCREASE;
        else if (delta < 0) diffClass = DIFF_CLASSES.SELF_PAY_DECREASE;
        else if (claim.prior_category !== effectiveCategory) diffClass = DIFF_CLASSES.CATEGORY_SHIFT_NO_AMOUNT;
        else diffClass = DIFF_CLASSES.NO_CHANGE;
      }

      lines.push({
        claim_id: claim.claim_id,
        entry_code: claim.entry_code,
        attributed_month: attributedMonth(claim, basis),
        old_category: claim.prior_category,
        new_category: effectiveCategory,
        old_self_pay_cents: oldSelfPay,
        new_self_pay_cents: newSelfPay,
        delta_cents: newSelfPay - oldSelfPay,
        diff_class: diffClass,
      });
    }

    lines.sort((a, b) => (a.claim_id < b.claim_id ? -1 : 1));

    const monthly = new Map();
    const totals = { claim_count: lines.length, old_self_pay_cents: 0, new_self_pay_cents: 0, delta_cents: 0 };
    const classes = {};
    for (const line of lines) {
      totals.old_self_pay_cents += line.old_self_pay_cents;
      totals.new_self_pay_cents += line.new_self_pay_cents;
      totals.delta_cents += line.delta_cents;
      classes[line.diff_class] = (classes[line.diff_class] ?? 0) + 1;
      const bucket = monthly.get(line.attributed_month) ?? { claim_count: 0, old_self_pay_cents: 0, new_self_pay_cents: 0, delta_cents: 0 };
      bucket.claim_count += 1;
      bucket.old_self_pay_cents += line.old_self_pay_cents;
      bucket.new_self_pay_cents += line.new_self_pay_cents;
      bucket.delta_cents += line.delta_cents;
      monthly.set(line.attributed_month, bucket);
    }

    const resultHash = digest({
      replay_version: replayVersion,
      hospital_id: snap.hospital_id,
      mapping_version: mapping?.mapping_version ?? null,
      snapshot_version: snap.snapshot_version,
      lines,
    });

    perHospital.set(snap.hospital_id, {
      hospital_id: snap.hospital_id,
      replay_version: replayVersion,
      mapping_version: mapping?.mapping_version ?? null,
      snapshot_version: snap.snapshot_version,
      bindings,
      lines,
      classes,
      monthly: Object.fromEntries([...monthly.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      totals,
      result_hash: resultHash,
    });
  }

  // 跨医院映射分歧：同一目录条目在≥2家医院的映射决定中落入不同支付类别。
  const categoriesByEntry = new Map();
  for (const m of orderedMappings) {
    for (const d of m.decisions ?? []) {
      if (!categoriesByEntry.has(d.entry_code)) categoriesByEntry.set(d.entry_code, new Map());
      categoriesByEntry.get(d.entry_code).set(m.hospital_id, d.payment_category);
    }
  }
  const crossHospitalDivergence = [];
  for (const [entryCode, byHospital] of categoriesByEntry) {
    const categories = [...new Set(byHospital.values())];
    if (byHospital.size >= 2 && categories.length >= 2) {
      crossHospitalDivergence.push({ entry_code: entryCode, by_hospital: Object.fromEntries(byHospital) });
    }
  }
  crossHospitalDivergence.sort((a, b) => (a.entry_code < b.entry_code ? -1 : 1));

  return {
    replay_id: replayId,
    attribution_basis: basis,
    common_bindings: commonBindings,
    hospitals: [...perHospital.values()],
    cross_hospital_divergence: crossHospitalDivergence,
    duplicates,
  };
}

// 仅构造差异分类事件所需的聚合视图（按医院）。
export function classifyView(replayResult, hospitalId) {
  const hospital = replayResult.hospitals.find((h) => h.hospital_id === hospitalId);
  if (!hospital) throw Object.assign(new Error(`重放结果中没有医院 ${hospitalId}`), { code: "UNKNOWN_HOSPITAL" });
  return {
    classes: hospital.classes,
    cross_hospital_divergence: replayResult.cross_hospital_divergence.filter((d) =>
      Object.prototype.hasOwnProperty.call(d.by_hospital, hospitalId)
    ),
  };
}
