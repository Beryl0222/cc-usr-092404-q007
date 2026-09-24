// insurance_shadow_settlement 领域资料的基础结构。
// 完整事件契约已迁移到 ./events.js；这里保留历史导出路径。
export {
  EVENT_KINDS,
  PAYLOAD_REQUIRED,
  SIGN_ROLES,
  ATTRIBUTION_BASES,
  CHECKPOINT_STAGES,
  FORBIDDEN_PII_FIELDS,
  validateEvent,
  makeEvent,
} from "./events.js";
