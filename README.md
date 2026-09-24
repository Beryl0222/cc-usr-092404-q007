# 医保目录影子结算

本项目用于整理医保目录影子结算领域中的事件名称、交换字段与脱敏样例，方便业务、运营和研发人员在同一套术语下讨论后续服务。资料只包含领域约定，不包含真实个人信息、生产连接或外部账号。

## 可复算的上线链

目录调整的影响评估按同一条事件链推进，每个环节都能重放、能追责：

1. **冻结**：`CATALOG_FROZEN` 冻结目录版本；`BASELINE_FROZEN` 把目录、医院映射、历史理赔快照、个人自付规则和测试场景绑定为同一基线版本，后续重放只认这个版本。
2. **映射**：医院通过 `MAPPING_SUBMITTED` 并发提交映射，事件携带基线版本；与当前基线不符的提交必须被 `MAPPING_REJECTED` 驳回。`MAPPING_REVISED` 表示映射修订，只允许重算尚未签署的批次。
3. **重放**：`CLAIM_REPLAYED` 按基线重放历史理赔。同一 `(baseline_version, claim_id)` 只计入一次，重复提交由 `REPLAY_SKIPPED` 留证。服务日期与结算日期跨月时，`service_period`、`settlement_period`、`attributed_period` 与 `attribution_policy` 分别记录归属口径。
4. **分类**：`DIFF_CLASSIFIED` 对每项金额变化分类，并通过 `catalog_item_code` 与 `mapping_ref` 追到目录条目和映射决定。
5. **签署**：影子结果只用于评估。`RELEASE_SIGNED` 记录财务（`FINANCE`）或政策（`POLICY`）单方签署；两方都批准后才出现 `RELEASE_WINDOW_OPENED`。
6. **发布**：`RESULT_PUBLISHED` 按医院发布，同一批次同一医院只发布一次。已发布结果只能用 `CORRECTION_ISSUED` 出更正版本解释，不能覆盖原证据。
7. **恢复**：切换过程写入 `CHECKPOINT_RECORDED`；失败后用 `RECOVERY_RESUMED` 从检查点恢复未完成的医院，既不重复发布，也不丢失已确认的差异。

最终对账时，任何一项金额变化都能沿 `DIFF_CLASSIFIED → CLAIM_REPLAYED → BASELINE_FROZEN` 追到目录条目、映射决定，以及 `RELEASE_WINDOW_OPENED` 引用的财务与政策两位签署人。

## 事件种类

| kind | 含义 | 关键 payload 字段 |
| --- | --- | --- |
| `CATALOG_FROZEN` | 目录冻结 | `catalog_version`、`effective_from`、`frozen_by` |
| `BASELINE_FROZEN` | 五类输入绑定为同一基线 | `baseline_version`、`catalog_version`、`mapping_version`、`claim_snapshot_id`、`copay_rule_version`、`scenario_version` |
| `MAPPING_SUBMITTED` | 医院提交映射 | `submission_id`、`hospital_id`、`baseline_version`、`items` |
| `MAPPING_REJECTED` | 基线不符被驳回 | `submission_id`、`expected_baseline_version`、`actual_baseline_version`、`reason` |
| `MAPPING_REVISED` | 映射修订 | `revision_id`、`mapping_version`、`base_mapping_version`、`affected_batch_ids` |
| `CLAIM_REPLAYED` | 按基线重放理赔 | `replay_id`、`claim_id`、`service_period`、`settlement_period`、`attributed_period`、`attribution_policy`、`shadow_amount` |
| `REPLAY_SKIPPED` | 重复理赔留证 | `claim_id`、`reason`、`original_replay_id` |
| `DIFF_CLASSIFIED` | 差异分类 | `diff_id`、`replay_id`、`category`、`amount_delta`、`catalog_item_code`、`mapping_ref` |
| `RELEASE_SIGNED` | 财务或政策签署 | `signoff_id`、`batch_id`、`role`、`decision`、`signed_by` |
| `RELEASE_WINDOW_OPENED` | 进入发布窗口 | `window_id`、`finance_signoff_id`、`policy_signoff_id` |
| `RESULT_PUBLISHED` | 按医院发布 | `publication_id`、`batch_id`、`hospital_id`、`published_version` |
| `CORRECTION_ISSUED` | 更正版本 | `correction_id`、`corrects_publication_id`、`reason` |
| `CHECKPOINT_RECORDED` | 切换检查点 | `checkpoint_id`、`completed_steps`、`pending_steps` |
| `RECOVERY_RESUMED` | 从检查点恢复 | `recovery_id`、`checkpoint_id`、`hospital_id` |

枚举取值：签署角色 `FINANCE` / `POLICY`，签署决定 `APPROVE` / `REJECT`，差异分类 `MAPPING_CHANGE` / `CATALOG_CHANGE` / `COPAY_CHANGE` / `NO_CHANGE`，跳过原因 `DUPLICATE` / `OUT_OF_SNAPSHOT`，归属政策 `SERVICE_MONTH` / `SETTLEMENT_MONTH`。

## 链上不变量

`src/release_chain.js` 的 `validateChain` 按发生顺序检查整条事件链：

- 重放必须引用已冻结的基线；同一 `(baseline_version, claim_id)` 不得重复计入，跳过留证必须能指到已计入的重放。
- 基线版本不符的映射提交必须被驳回。
- 发布窗口开启前必须有同一批次的财务与政策两条批准签署，且窗口引用的签署编号与批次、角色一致。
- 未进入发布窗口不得发布；同一批次同一医院只发布一次。
- 更正版本必须指向已发布的结果。
- 映射修订只能影响尚未进入发布窗口的批次。
- 恢复必须引用已记录的检查点；每项差异分类必须能追到一次重放。

## 个人信息可见性

payload 的任何层级都不允许出现原始身份字段（见 `FORBIDDEN_PAYLOAD_KEYS`），只能使用脱敏编号；下游服务按事件中的 `hospital_id` 把可见范围限定在授权医院的最小范围内。

## 目录

- `src/insurance_shadow_settlement.js`：事件种类、字段校验与个人信息禁带字段。
- `src/release_chain.js`：上线链不变量校验。
- `data/sample.json`：用于核对资料格式的虚构事件。
- `data/release_chain_sample.json`：一条覆盖全部事件种类的虚构上线链。
- `tests/`：保证样例与领域约定保持一致。

## 测试与构建

```bash
npm test
npm run build
```
