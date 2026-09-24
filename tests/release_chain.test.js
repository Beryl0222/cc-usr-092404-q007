import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateChain } from "../src/release_chain.js";

const loadChain = async () =>
  JSON.parse(await readFile(new URL("../data/release_chain_sample.json", import.meta.url), "utf8"));

test("完整上线链通过全部不变量", async () => {
  assert.deepEqual(validateChain(await loadChain()), []);
});

test("重复理赔不会重复计入", async () => {
  const chain = await loadChain();
  const replay = chain.find((event) => event.kind === "CLAIM_REPLAYED");
  chain.push(structuredClone(replay));
  assert.ok(validateChain(chain).includes(`duplicate-replay:${replay.payload.claim_id}`));
});

test("差异必须能追到一次重放", async () => {
  const chain = (await loadChain()).filter(
    (event) => !(event.kind === "CLAIM_REPLAYED" && event.payload.replay_id === "rpl-0001"),
  );
  const problems = validateChain(chain);
  assert.ok(problems.includes("diff-without-replay:diff-0001"));
  assert.ok(problems.includes("skip-without-original:clm-1001"));
});

test("缺少任一方签署不能进入发布窗口", async () => {
  const chain = (await loadChain()).filter(
    (event) => !(event.kind === "RELEASE_SIGNED" && event.payload.role === "POLICY"),
  );
  const problems = validateChain(chain);
  assert.ok(problems.includes("window-without-signoffs:b-2026.10-01"));
  assert.ok(problems.includes("window-signoff-mismatch:win-0001"));
});

test("未进入发布窗口不能发布", async () => {
  const chain = (await loadChain()).filter((event) => event.kind !== "RELEASE_WINDOW_OPENED");
  const problems = validateChain(chain);
  assert.ok(problems.includes("publish-without-window:pub-0001"));
  assert.ok(problems.includes("publish-without-window:pub-0002"));
});

test("同一批次同一医院不能重复发布", async () => {
  const chain = await loadChain();
  const published = chain.find((event) => event.kind === "RESULT_PUBLISHED");
  chain.push(structuredClone(published));
  assert.ok(validateChain(chain).includes("duplicate-publication:b-2026.10-01|hosp-01"));
});

test("更正版本必须指向已发布结果", async () => {
  const chain = await loadChain();
  chain.find((event) => event.kind === "CORRECTION_ISSUED").payload.corrects_publication_id = "pub-9999";
  assert.ok(validateChain(chain).includes("correction-target-missing:cor-0001"));
});

test("过时基线的映射提交必须被驳回", async () => {
  const chain = (await loadChain()).filter((event) => event.kind !== "MAPPING_REJECTED");
  assert.ok(validateChain(chain).includes("stale-mapping-not-rejected:sub-0002"));
});

test("映射修订只重算未签署批次", async () => {
  const chain = await loadChain();
  chain.find((event) => event.kind === "MAPPING_REVISED").payload.affected_batch_ids = ["b-2026.10-01"];
  assert.ok(validateChain(chain).includes("revision-touches-released-batch:b-2026.10-01"));
});

test("恢复必须引用已记录的检查点", async () => {
  const chain = await loadChain();
  chain.find((event) => event.kind === "RECOVERY_RESUMED").payload.checkpoint_id = "ckp-9999";
  assert.ok(validateChain(chain).includes("recovery-checkpoint-missing:rec-0001"));
});
