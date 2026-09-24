import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EVENT_KINDS, validateEvent } from "../src/insurance_shadow_settlement.js";

const load = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));

test("样例符合领域约定", async () => {
  const record = await load("sample.json");
  assert.deepEqual(validateEvent(record), []);
});

test("上线链样例覆盖全部事件种类且逐条有效", async () => {
  const chain = await load("release_chain_sample.json");
  const kinds = new Set(chain.map((event) => event.kind));
  for (const kind of EVENT_KINDS) assert.ok(kinds.has(kind), `样例缺少事件种类 ${kind}`);
  for (const event of chain) assert.deepEqual(validateEvent(event), [], event.event_id);
});

test("缺少必备字段会被指出", async () => {
  const record = await load("sample.json");
  delete record.occurred_at;
  delete record.payload.catalog_version;
  assert.deepEqual(validateEvent(record), ["occurred_at", "payload.catalog_version"]);
});

test("未知事件种类会被指出", () => {
  const record = { event_id: "x", kind: "NOPE", occurred_at: "t", subject_id: "s", payload: {} };
  assert.deepEqual(validateEvent(record), ["kind"]);
});

test("payload 不是对象时会被指出", () => {
  const record = { event_id: "x", kind: "CATALOG_FROZEN", occurred_at: "t", subject_id: "s", payload: [] };
  assert.deepEqual(validateEvent(record), ["payload"]);
});

test("枚举取值受领域约定约束", async () => {
  const chain = await load("release_chain_sample.json");
  const signoff = structuredClone(chain.find((event) => event.kind === "RELEASE_SIGNED"));
  signoff.payload.role = "VENDOR";
  assert.deepEqual(validateEvent(signoff), ["payload.role"]);
});

test("payload 任何层级都不允许出现原始个人信息", async () => {
  const chain = await load("release_chain_sample.json");
  const replay = structuredClone(chain.find((event) => event.kind === "CLAIM_REPLAYED"));
  replay.payload.patient_name = "张三";
  replay.payload.items = [{ phone_number: "13800000000" }];
  assert.deepEqual(validateEvent(replay), ["payload.patient_name", "payload.items[0].phone_number"]);
});
