# 医保目录影子结算上线链

医保目录调整前，结算团队不再依赖零散样本：目录冻结、医院映射、历史理赔快照、个人自付规则、测试场景五要素按版本钉住，按同一版本确定性重放并分类差异；影子结果仅供评估，经**财务与政策双角色签署**后才进入发布窗口。本仓库是这条上线链的领域约定、纯计算模型与事件溯源状态机，只含虚构数据，不含真实个人信息、生产连接或外部账号。

## 上线链与事件

```
CATALOG_FROZEN
  → HOSPITAL_MAPPING_SUBMITTED / MAPPING_REVISED（基线版本并发检测）
  → CLAIM_SNAPSHOT_CAPTURED（历史理赔快照）
  → PERSONAL_RULES_LOCKED（个人自付规则）
  → TEST_SCENARIO_LOCKED（测试场景）
  → REPLAY_REQUESTED（五要素按同一版本钉住）
  → CLAIM_REPLAYED（按医院批次重放，附 replay_version / result_hash）
  → DIFF_CLASSIFIED（差异分类 + 跨医院映射分歧）
  → RELEASE_SIGNED × {FINANCE, POLICY}（财务、政策分别签署）
  → RELEASE_WINDOW_OPENED
  → RELEASE_CHECKPOINT × {MAPPING_LIVE, DIFF_CONFIRMED}（按医院）
  → RESULT_PUBLISHED（证据固化）
  ── 失败：RELEASE_RESUMED 从检查点恢复未完成医院
  ── 更正：CORRECTION_ISSUED 旁挂更正版本，不覆盖原证据
```

## 关键不变量

- **可复算**：`replay_version` 是该医院批次五要素版本 + 归属基准的哈希；`result_hash` 覆盖逐行结果。事件入账时按钉住版本重算核对，哈希不符（`HASH_MISMATCH`）拒绝入账。输入顺序不影响结果。
- **并发映射**：提交/修订必须带 `base_mapping_version`，与当前基线不一致即 `BASE_VERSION_CONFLICT`；首次提交基线为 `null`。
- **修订只重算未签署批次**：已有任一签署的批次冻结；已发布结果只能追加 `CORRECTION_ISSUED`，原 `RESULT_PUBLISHED` 证据永不覆盖，更正必须引用原发布事件。
- **重复理赔不计两次**：同一 `claim_id` 全局只在首入账医院计一次，重复件登记在 `duplicates` 中。
- **跨月归属**：`SERVICE_DATE` / `SETTLEMENT_DATE` 两种政策基准分别归属到服务月或结算月，月度聚合与总额都可核对。
- **双签署门**：未分类不能签；计划内所有医院都具备 FINANCE + POLICY 签署才能打开发布窗口；窗口打开且两检查点齐备才能发布。
- **故障恢复**：检查点按医院、按阶段（`MAPPING_LIVE`、`DIFF_CONFIRMED`）记录；重启仅凭事件日志 fold 重建，`resume` 列出未完成医院与剩余阶段。检查点与发布均幂等——不重复发布，也不重复/丢失差异确认。
- **逐项对账**：对账报告中每行金额变化都可追到目录条目、映射版本与决定、两位签署人、发布事件与证据、旁挂更正版本。
- **个人信息最小可见**：事件载荷任何层级出现真实姓名/证件号/手机号等原始 PII 字段即不合规，只允许 `person_pseudonym`；查看者只能看到其 `authorized_hospital_ids` 内医院的明细，未授权医院只见状态与钉住版本。
- **金额纪律**：所有金额为以“分”为单位的非负整数，自付按整数截断，不使用浮点。

## 目录

- `src/events.js`：事件种类、按种类的必填字段、取值域、PII 黑名单、`validateEvent` / `makeEvent`。
- `src/model.js`：纯函数重放引擎——版本绑定、自付计算、归属、去重、跨医院分歧、差异分类、确定性哈希。
- `src/chain.js`：事件溯源状态机——并发检测、签署门、发布/更正策略、检查点恢复、对账报告、`ReleaseChain` / `fold`。
- `src/privacy.js`：按授权医院范围的最小可见投影。
- `src/insurance_shadow_settlement.js`：历史导出入口，保持向后兼容。
- `examples/demo_chain.js`：端到端演示（并发冲突、双基准归属、修订、签署门、故障恢复、更正、对账、脱敏）。
- `tests/`：契约、模型、链路、隐私四组测试（`node:test`）。
- `data/sample.json`：虚构事件，用于核对资料格式。

## 测试、构建与演示

```bash
npm test     # 28 项测试：契约/计算/状态机/隐私
npm run build # 全部源文件语法检查
npm run demo  # 端到端演示
```

## 使用形态

写命令只产出待追加的合规事件，状态只能由事件 fold 得到，因此任何时刻都可以从事件日志完整重建：

```js
import { ReleaseChain, freezeCatalog, requestReplay, replayHospital } from "./src/chain.js";

const chain = new ReleaseChain();
chain.append(freezeCatalog(chain.state, { catalog_version: "cat-1", frozen_at: "2026-09-20", entries: [...] }));
// ……提交映射、快照、规则、场景……
chain.append(requestReplay(chain.state, { replay_id: "r1", /* 五要素版本 */ attribution_basis: "SERVICE_DATE" }));
chain.append(replayHospital(chain.state, "r1", "H-001"));
const report = chain.report("r1"); // 逐项金额 → 目录条目 → 映射决定 → 签署人 → 发布证据
```
