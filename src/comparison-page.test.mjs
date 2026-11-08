import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = path.join(root, 'web/data/luna-20261108.json');
const pagePath = path.join(root, 'web/index.html');

function round1(value) {
  return (Math.round(value * 10) / 10).toFixed(1);
}

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const page = fs.readFileSync(pagePath, 'utf8');

test('the published record is the 2026-11-08 Luna run on the pinned commit', () => {
  assert.equal(data.benchmark, 'coffee-cart-20261108');
  assert.equal(data.generated_at, '2026-11-08T07:57:36.537Z');
  assert.equal(data.window_sgt, '2026-11-08 15:56–15:57');
  assert.equal(data.code_sha, 'a28b202306300924a46a2fdf1ecdf61b568ae627');
  assert.equal(data.gateway, 'https://ai.caph.me/v1');
  assert.equal(data.vendor_direct, false);
  assert.equal(data.schedule.measured_orders_per_side, 25);
  assert.equal(data.schedule.reps_per_side_per_sample, 5);
  assert.equal(data.schedule.warmups_per_side, 1);
  assert.equal(data.schedule.retries, 0);
  assert.equal(data.schedule.concurrency, 1);
  assert.equal(data.schedule.order, 'AB/BA alternating');
  assert.equal(data.http.scored_requests.jev, 80);
  assert.equal(data.http.scored_requests.luna, 25);
  assert.equal(data.http.this_run_including_warmups, 110);
  assert.equal(data.http.independent_probe, 1);
  assert.equal(data.http.total_with_probe, 111);
});

test('headline medians, correctness, and the pooled reduction match the record', () => {
  assert.equal(data.sides.jev.response_model, 'jev-1.14.0');
  assert.equal(data.sides.jev.correct_orders, 25);
  assert.equal(data.sides.jev.order_ms.median, 897.608);
  assert.equal(data.sides.jev.order_ms.min, 283.352);
  assert.equal(data.sides.jev.order_ms.max, 2134.6);
  assert.equal(data.sides.luna.response_model, 'gpt-6-luna');
  assert.equal(data.sides.luna.requested_model, 'gpt-6-luna');
  assert.equal(data.sides.luna.correct_orders, 25);
  assert.equal(data.sides.luna.order_ms.median, 1683.659);
  assert.equal(data.sides.luna.order_ms.min, 1309.25);
  assert.equal(data.sides.luna.order_ms.max, 8118.829);
  assert.equal(data.sides.luna.strict_schema, false);
  assert.equal(data.sides.luna.response_format, 'json_object');
  assert.equal(data.sides.luna.requested_reasoning_effort, 'none');
  assert.equal(data.sides.luna.reasoning_effort_honored_proven, false);
  assert.equal(data.sides.luna.reasoning_tokens.field, 'absent');
  assert.equal(data.sides.luna.reasoning_tokens.absence_is_not_zero, true);
  assert.equal(data.sides.jev.usage.total_tokens_field, 'absent');
  assert.equal(data.sides.jev.usage.absence_is_not_zero, true);
  assert.equal(data.sides.jev.usage.input_tokens, 178645);
  assert.equal(data.sides.jev.usage.output_tokens, 9555);
  assert.equal(data.sides.luna.usage.prompt_tokens, 30355);
  assert.equal(data.sides.luna.usage.completion_tokens, 825);
  assert.equal(data.sides.luna.usage.total_tokens, 31180);

  const reduction =
    (data.sides.luna.order_ms.median - data.sides.jev.order_ms.median) /
    data.sides.luna.order_ms.median;
  assert.equal(round1(reduction * 100), '46.7');
  assert.ok(Math.abs(reduction - data.pooled_median_relative_reduction.value) < 1e-12);
});

test('the two-item sample is the one where Luna is faster and the ranges overlap', () => {
  const sample = data.samples.find((item) => item.id === 'iced_oat_muffin');
  assert.equal(sample.lower_median, 'luna');
  assert.equal(sample.ranges_overlap, true);
  assert.equal(sample.jev.median_ms, 2091.922);
  assert.equal(sample.luna.median_ms, 1956.019);
  const overlapStart = Math.max(sample.jev.min_ms, sample.luna.min_ms);
  const overlapEnd = Math.min(sample.jev.max_ms, sample.luna.max_ms);
  assert.ok(overlapStart <= overlapEnd);
  assert.deepEqual(
    data.samples.map((item) => item.id),
    [
      'latte_unspecified',
      'iced_oat_muffin',
      'green_matcha_rejected',
      'four_latte_invalid',
      'everything_all_hot',
    ],
  );
  assert.equal(
    data.samples.reduce((sum, item) => sum + item.jev.requests, 0),
    80,
  );
  assert.equal(
    data.samples.reduce((sum, item) => sum + item.luna.requests, 0),
    25,
  );
});

test('the page shows the rounded record and keeps the order form', () => {
  for (const snippet of [
    'id="dialog"',
    'id="compose"',
    'id="result"',
    'id="bench"',
    '2026-11-08 15:56–15:57',
    'a28b202306300924a46a2fdf1ecdf61b568ae627',
    'jev-1.14.0',
    'gpt-6-luna',
    `${round1(data.sides.jev.order_ms.median)}`,
    `${round1(data.sides.luna.order_ms.median)}`,
    '46.7%',
    '1956.0 ms',
    '2091.9 ms',
    '范围重叠',
    '不是每一单的降幅',
    'json_object',
    'reasoning_effort: none',
    'reasoning_tokens',
    '缺字段不是',
    '1309.25 ms',
    '1309.3',
    'DeepSeek',
    'luna-20261108.json',
  ]) {
    assert.equal(page.includes(snippet), true, snippet);
  }

  assert.equal(page.includes('1309.2–'), false);
  for (const sample of data.samples) {
    assert.equal(page.includes(`${round1(sample.jev.median_ms)} ms`), true, sample.id);
    assert.equal(page.includes(`${round1(sample.luna.median_ms)} ms`), true, sample.id);
    assert.equal(
      page.includes(`${round1(sample.jev.min_ms)}–${round1(sample.jev.max_ms)}`),
      true,
      `${sample.id} jev range`,
    );
    assert.equal(
      page.includes(`${round1(sample.luna.min_ms)}–${round1(sample.luna.max_ms)}`),
      true,
      `${sample.id} luna range`,
    );
  }
});

test('the comparison table does not show a scored-request column', () => {
  const table = page.slice(page.indexOf('<table class="bench__table">'), page.indexOf('</table>'));
  const notes = page.slice(page.indexOf('<details class="bench__notes">'));
  const css = fs.readFileSync(path.join(root, 'web/styles.css'), 'utf8');
  assert.equal(table.includes('计分请求'), false);
  assert.equal(table.includes('data-label="计分请求"'), false);
  assert.equal(page.includes('计分请求一列是 Jev / Luna'), false);
  for (const ratio of ['20 / 5', '35 / 5', '15 / 5', '5 / 5']) {
    assert.equal(table.includes(ratio), false, ratio);
  }
  assert.equal(css.includes('bench__footnote'), false);
  assert.equal((table.match(/<th scope="col">/g) || []).length, 4);
  assert.equal((table.match(/data-label="正确"/g) || []).length, 5);
  assert.equal(notes.includes('计分请求 Jev 80 次、Luna 25 次'), true);
  assert.equal(notes.includes('一单多次请求'), true);
  assert.equal(notes.includes('一次整单'), true);
});

test('the new record does not carry secrets or another model round', () => {
  const bench = page.slice(page.indexOf('id="bench"'));
  const published = `${JSON.stringify(data)}\n${bench}`;
  assert.equal(/api[_-]?key\s*[:=]/i.test(published), false);
  assert.equal(published.includes('sk-'), false);
  assert.equal(published.includes('Bearer '), false);
  assert.equal(/deepseek[-_ ]?\d/i.test(published), false);
  assert.equal(JSON.stringify(data.sides).toLowerCase().includes('deepseek'), false);
  assert.equal(bench.includes('DeepSeek'), true);
});
