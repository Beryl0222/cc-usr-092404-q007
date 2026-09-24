import assert from "node:assert/strict";
import test from "node:test";
import {
  ReleaseChain,
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
  prepareHospitalSwitch,
  publishHospital,
  issueCorrection,
  fold,
  reconciliationReport,
  BATCH_STATUS,
} from "../src/chain.js";
import * as fx from "./fixtures.js";

function bootstrap() {
  const chain = new ReleaseChain();
  const run = (fn) => chain.append(fn(chain.state));
  run((s) => freezeCatalog(s, fx.catalog()));
  run((s) => submitMapping(s, fx.mappingH1()));
  run((s) => submitMapping(s, fx.mappingH2()));
  run((s) => captureSnapshot(s, fx.snapshotH1()));
  run((s) => captureSnapshot(s, fx.snapshotH2()));
  run((s) => lockPersonalRules(s, fx.rules()));
  run((s) => lockTestScenarios(s, fx.scenarios()));
  return chain;
}

function replayAndClassify(chain, replayId, hospitals = ["H-001", "H-002"]) {
  for (const h of hospitals) {
    chain.append(replayHospital(chain.state, replayId, h));
    chain.append(classifyHospital(chain.state, replayId, h));
  }
}

test("医院并发提交映射：基线版本过期被检测，正确基线通过", () => {
  const chain = bootstrap();
  assert.throws(
    () => chain.append(reviseMapping(chain.state, { ...fx.mappingH1("map-h1-v2"), base_mapping_version: "stale" })),
    { code: "BASE_VERSION_CONFLICT" }
  );
  assert.doesNotThrow(() =>
    chain.append(reviseMapping(chain.state, fx.mappingH1("map-h1-v2")))
  );
  // 两个医院都从 v1 起步做修订时，只有先到者成功
  chain.append(reviseMapping(chain.state, fx.mappingH2("map-h2-v2", "CAT_II")));
  assert.throws(
    () => chain.append(reviseMapping(chain.state, fx.mappingH2("map-h2-v3", "CAT_II"))),
    { code: "BASE_VERSION_CONFLICT" }
  );
});

test("映射决定只能引用冻结目录中的条目", () => {
  const chain = bootstrap();
  assert.throws(
    () =>
      chain.append(
        reviseMapping(chain.state, {
          ...fx.mappingH1("map-h1-bad"),
          decisions: [{ entry_code: "GHOST", payment_category: "CAT_I" }],
        })
      ),
    { code: "UNKNOWN_CATALOG_ENTRY" }
  );
});

test("五要素按版本钉住：计划发起后的映射修订不影响在跑批次", () => {
  const chain = bootstrap();
  chain.append(requestReplay(chain.state, fx.planInput("replay-a")));
  const before = replayHospital(chain.state, "replay-a", "H-002");
  const beforeHash = before.payload.result_hash;
  // 计划发起后修订 H-002（消除 B002 分歧）
  chain.append(reviseMapping(chain.state, fx.mappingH2("map-h2-v2", "CAT_II")));
  // 在跑计划仍钉住 map-h2-v1：用当前状态重算得到的命令事件与之前完全一致
  const after = replayHospital(chain.state, "replay-a", "H-002");
  assert.equal(after.payload.result_hash, beforeHash);
  assert.equal(after.payload.bindings.mapping_version, "map-h2-v1");
});

test("哈希防篡改：伪造 result_hash 的事件无法入账", () => {
  const chain = bootstrap();
  chain.append(requestReplay(chain.state, fx.planInput("replay-tamper")));
  const event = replayHospital(chain.state, "replay-tamper", "H-001");
  event.payload.result_hash = "fake";
  assert.throws(() => chain.append(event), { code: "HASH_MISMATCH" });
});

test("签署门：未分类不能签，单角色签署不能开窗，双角色齐备才开窗", () => {
  const chain = bootstrap();
  chain.append(requestReplay(chain.state, fx.planInput("replay-gate")));
  assert.throws(() => chain.append(signBatch(chain.state, "replay-gate", "H-001", "FINANCE", "f1")), {
    code: "BATCH_NOT_CLASSIFIED",
  });
  replayAndClassify(chain, "replay-gate");
  chain.append(signBatch(chain.state, "replay-gate", "H-001", "FINANCE", "f1"));
  chain.append(signBatch(chain.state, "replay-gate", "H-001", "POLICY", "p1"));
  // H-002 还没签
  assert.throws(() => chain.append(openWindow(chain.state, "replay-gate", "w1")), {
    code: "SIGNATURES_INCOMPLETE",
  });
  chain.append(signBatch(chain.state, "replay-gate", "H-002", "FINANCE", "f1"));
  assert.throws(() => chain.append(openWindow(chain.state, "replay-gate", "w1")), {
    code: "SIGNATURES_INCOMPLETE",
  });
  chain.append(signBatch(chain.state, "replay-gate", "H-002", "POLICY", "p1"));
  chain.append(openWindow(chain.state, "replay-gate", "w1"));
  // 同一角色不能重复签署
  assert.throws(() => chain.append(signBatch(chain.state, "replay-gate", "H-001", "FINANCE", "f2")), {
    code: "ALREADY_SIGNED",
  });
});

test("映射修订只能重算未签署批次；已签署批次拒绝重算", () => {
  const chain = bootstrap();
  chain.append(requestReplay(chain.state, fx.planInput("replay-lock")));
  replayAndClassify(chain, "replay-lock");
  chain.append(signBatch(chain.state, "replay-lock", "H-001", "FINANCE", "f1"));
  assert.throws(() => chain.append(replayHospital(chain.state, "replay-lock", "H-001")), {
    code: "BATCH_ALREADY_SIGNED",
  });
  // 未签署的 H-002 可以重算
  assert.doesNotThrow(() => chain.append(replayHospital(chain.state, "replay-lock", "H-002")));
});

test("检查点未完成不能发布；窗口未开不能发布", () => {
  const chain = bootstrap();
  chain.append(requestReplay(chain.state, fx.planInput("replay-pub")));
  replayAndClassify(chain, "replay-pub");
  for (const h of ["H-001", "H-002"]) {
    chain.append(signBatch(chain.state, "replay-pub", h, "FINANCE", "f1"));
    chain.append(signBatch(chain.state, "replay-pub", h, "POLICY", "p1"));
  }
  assert.throws(() => chain.append(publishHospital(chain.state, "replay-pub", "H-001", {})), {
    code: "WINDOW_NOT_OPENED",
  });
  chain.append(openWindow(chain.state, "replay-pub", "w1"));
  assert.throws(() => chain.append(publishHospital(chain.state, "replay-pub", "H-001", {})), {
    code: "CHECKPOINT_INCOMPLETE",
  });
});

test("切换失败后从检查点恢复：不重复发布、不重复差异确认、不丢失未完成医院", () => {
  const chain = bootstrap();
  chain.append(requestReplay(chain.state, fx.planInput("replay-fail")));
  replayAndClassify(chain, "replay-fail");
  for (const h of ["H-001", "H-002"]) {
    chain.append(signBatch(chain.state, "replay-fail", h, "FINANCE", "f1"));
    chain.append(signBatch(chain.state, "replay-fail", h, "POLICY", "p1"));
  }
  chain.append(openWindow(chain.state, "replay-fail", "w1"));
  // H-001 全部检查点完成并发布
  for (const ev of prepareHospitalSwitch(chain.state, "replay-fail", "H-001")) chain.append(ev);
  const pubH1 = publishHospital(chain.state, "replay-fail", "H-001", {});
  chain.append(pubH1);
  // H-002 只完成 MAPPING_LIVE 后进程崩溃
  chain.append(markCheckpoint(chain.state, "replay-fail", "H-002", "MAPPING_LIVE"));
  const eventCount = chain.events.length;

  // 重启：仅凭事件日志重建
  const restarted = new ReleaseChain(chain.events);
  assert.equal(restarted.events.length, eventCount);
  const result = restarted.resume("replay-fail");
  assert.deepEqual(result.pending, [{ hospital_id: "H-002", remaining: ["DIFF_CONFIRMED"] }]);
  // 恢复事件已追加
  assert.equal(chain.events.length + 1, restarted.events.length);

  // 重放检查点记录是幂等的：重复 MAPPING_LIVE 不产生事件
  const dup = markCheckpoint(restarted.state, "replay-fail", "H-002", "MAPPING_LIVE");
  assert.equal(dup, null);
  restarted.append(markCheckpoint(restarted.state, "replay-fail", "H-002", "DIFF_CONFIRMED"));
  // 发布 H-002
  restarted.append(publishHospital(restarted.state, "replay-fail", "H-002", {}));
  // H-001 再次发布返回 null（绝不重复发布），且事件数不再增加
  const again = restarted.append(publishHospital(restarted.state, "replay-fail", "H-001", {}));
  assert.equal(again.skipped, true);

  const report = reconciliationReport(restarted.state, "replay-fail");
  for (const h of report.hospitals) {
    assert.equal(h.status, BATCH_STATUS.PUBLISHED);
    assert.deepEqual(h.checkpoints, ["MAPPING_LIVE", "DIFF_CONFIRMED"]);
  }
});

test("已发布结果不可覆盖，只能追加更正版本并引用原发布事件", () => {
  const chain = bootstrap();
  chain.append(
    requestReplay(chain.state, fx.planInput("replay-corr", "SERVICE_DATE", {
      mapping_versions: { "H-001": "map-h1-v1" },
      snapshot_versions: { "H-001": "snap-h1-v1" },
    }))
  );
  replayAndClassify(chain, "replay-corr", ["H-001"]);
  chain.append(signBatch(chain.state, "replay-corr", "H-001", "FINANCE", "f1"));
  chain.append(signBatch(chain.state, "replay-corr", "H-001", "POLICY", "p1"));
  chain.append(openWindow(chain.state, "replay-corr", "w1"));
  for (const ev of prepareHospitalSwitch(chain.state, "replay-corr", "H-001")) chain.append(ev);
  const published = publishHospital(chain.state, "replay-corr", "H-001", {});
  chain.append(published);
  const originalEventId = published.event_id;

  // 已发布批次不能重算
  assert.throws(() => chain.append(replayHospital(chain.state, "replay-corr", "H-001")), {
    code: "BATCH_ALREADY_SIGNED",
  });
  // 未发布的批次不能发更正（另建一条只到签署的计划）
  chain.append(
    requestReplay(chain.state, fx.planInput("replay-notpub", "SERVICE_DATE", {
      mapping_versions: { "H-001": "map-h1-v1" },
      snapshot_versions: { "H-001": "snap-h1-v1" },
    }))
  );
  replayAndClassify(chain, "replay-notpub", ["H-001"]);
  assert.throws(
    () =>
      chain.append(
        issueCorrection(chain.state, "replay-notpub", "H-001", { correction_version: "c9", reason: "x" })
      ),
    { code: "NOT_PUBLISHED" }
  );
  chain.append(
    issueCorrection(chain.state, "replay-corr", "H-001", { correction_version: "corr-1", reason: "政策解释" })
  );
  const batch = chain.state.replays.get("replay-corr").hospitals.get("H-001");
  // 原证据保持不变
  assert.equal(batch.publish.event_id, originalEventId);
  assert.equal(batch.corrections.length, 1);
  assert.equal(batch.corrections[0].correction_version, "corr-1");
  assert.equal(batch.status, BATCH_STATUS.CORRECTED);
  // 更正版本号不能重复
  assert.throws(
    () =>
      chain.append(
        issueCorrection(chain.state, "replay-corr", "H-001", { correction_version: "corr-1", reason: "重复" })
      ),
    { code: "VERSION_DUPLICATED" }
  );
  // 伪造原发布事件引用的更正不能入账
  const forged = issueCorrection(chain.state, "replay-corr", "H-001", {
    correction_version: "corr-2",
    reason: "x",
  });
  forged.payload.original_publish_event_id = "other-event";
  assert.throws(() => chain.append(forged), { code: "ORIGINAL_EVIDENCE_MISMATCH" });
});

test("最终对账：逐项金额变化可追到目录条目、映射版本决定与签署人", () => {
  const chain = bootstrap();
  chain.append(requestReplay(chain.state, fx.planInput("replay-recon")));
  replayAndClassify(chain, "replay-recon");
  for (const h of ["H-001", "H-002"]) {
    chain.append(signBatch(chain.state, "replay-recon", h, "FINANCE", "fin-zhang"));
    chain.append(signBatch(chain.state, "replay-recon", h, "POLICY", "pol-li"));
  }
  const report = reconciliationReport(chain.state, "replay-recon");
  const h1 = report.hospitals.find((h) => h.hospital_id === "H-001");
  for (const row of h1.trace) {
    assert.ok(row.catalog_entry.entry_code === row.entry_code);
    assert.equal(row.mapping_decision.mapping_version, "map-h1-v1");
    assert.equal(row.signers.FINANCE.signer_id, "fin-zhang");
    assert.equal(row.signers.POLICY.signer_id, "pol-li");
    // 未发布时 publication 为空
    assert.equal(row.publication, null);
  }
  // 行级金额之和等于总计，月度之和也等于总计
  const sumDelta = h1.trace.reduce((acc, r) => acc + r.delta_cents, 0);
  assert.equal(sumDelta, h1.totals.delta_cents);
  const monthlyDelta = Object.values(h1.monthly).reduce((acc, m) => acc + m.delta_cents, 0);
  assert.equal(monthlyDelta, h1.totals.delta_cents);
  // 钉住版本完整记录五要素+归属基准
  assert.deepEqual(h1.pinned_versions, {
    catalog_version: "cat-v1",
    mapping_version: "map-h1-v1",
    snapshot_version: "snap-h1-v1",
    rules_version: "rules-v1",
    scenario_version: "scen-v1",
    attribution_basis: "SERVICE_DATE",
  });
});

test("事件日志重放确定性：从同一日志 fold 出的状态逐医院哈希一致", () => {
  const chain = bootstrap();
  chain.append(requestReplay(chain.state, fx.planInput("replay-fold")));
  replayAndClassify(chain, "replay-fold");
  const rebuilt = fold(chain.events);
  for (const [hospitalId, batch] of chain.state.replays.get("replay-fold").hospitals) {
    const other = rebuilt.replays.get("replay-fold").hospitals.get(hospitalId);
    assert.equal(other.result_hash, batch.result_hash);
    assert.equal(other.replay_version, batch.replay_version);
  }
});
