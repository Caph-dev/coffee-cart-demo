import test from 'node:test';
import assert from 'node:assert/strict';
import { MENU } from './menu.mjs';
import { buildChoiceQuestion, buildQuantityQuestion } from './jev.mjs';
import { classifyQuantity, runCart } from './cart.mjs';

function choice(id, confidence = 0.99) {
  return { answers: { next_item: { choice: id, confidence } } };
}

function quantity(value, confidence = 0.97) {
  return { answers: { quantity: { choice: value, confidence } } };
}

function check(noul = 0.9) {
  return { answers: { check_last_added: { noul } } };
}

function script(steps) {
  const calls = [];
  let index = 0;
  const callJev = async (_config, payload) => {
    calls.push(payload);
    const step = steps[index];
    index += 1;
    if (!step) throw new Error(`unexpected Jev call #${index}`);
    return step(payload, calls);
  };
  return { callJev, calls, get index() { return index; } };
}

test('classifyQuantity accepts only one, two, three, and invalid', () => {
  assert.deepEqual(classifyQuantity('two'), { raw: 'two', quantity: 'two', count: 2 });
  assert.deepEqual(classifyQuantity(' ONE '), { raw: 'one', quantity: 'one', count: 1 });
  assert.equal(classifyQuantity('three').count, 3);
  assert.deepEqual(classifyQuantity('invalid'), { raw: 'invalid', quantity: 'invalid', count: null });

  for (const raw of ['0.7', '-1', '2^32', '2', '两', '两杯', '0', '4', 'four', '100', '', null, 2]) {
    const got = classifyQuantity(raw);
    assert.equal(got.quantity, 'invalid', String(raw));
    assert.equal(got.count, null, String(raw));
  }
});

test('quantity criteria name Arabic, Chinese, and English counts plus the invalid bucket', () => {
  const question = buildQuantityQuestion({ id: 'latte', name: '拿铁' });
  assert.equal(question.type, 'choice');
  assert.deepEqual(Object.keys(question.criteria), ['one', 'two', 'three', 'invalid']);
  const blob = JSON.stringify(question.criteria);
  for (const token of ['一杯', '一份', '两杯', '三杯', '一', '二', '两', '三', 'one', 'two', 'three', '0.7', '-1', '2^32']) {
    assert.ok(blob.includes(token), `missing ${token}`);
  }
  assert.match(question.instructions, /拿铁/);
});

test('the next item Choice drops items already found', () => {
  const first = buildChoiceQuestion(MENU, []);
  assert.ok(first.criteria.latte);
  assert.ok(first.criteria.done);
  assert.match(first.instructions, /还没有/);

  const next = buildChoiceQuestion(
    MENU.filter((item) => item.id !== 'latte'),
    ['拿铁'],
  );
  assert.equal(next.criteria.latte, undefined);
  assert.ok(next.criteria.muffin);
  assert.ok(next.criteria.done);
  assert.match(next.instructions, /拿铁/);
});

test('两杯拿铁 writes two lattes and then stops on done', async () => {
  const { callJev, calls } = script([
    () => choice('latte', 1),
    (payload) => {
      assert.equal(payload.state.item, '拿铁');
      assert.match(payload.questions.quantity.criteria.two, /两杯/);
      assert.match(payload.questions.quantity.criteria.two, /two/);
      return quantity('two', 1);
    },
    () => check(0.93),
    (payload) => {
      assert.equal(payload.questions.next_item.criteria.latte, undefined);
      assert.ok(payload.questions.next_item.criteria.done);
      assert.ok(payload.questions.next_item.criteria.muffin);
      return choice('done', 1);
    },
  ]);
  const events = [];
  const summary = await runCart({ model: 'test' }, '来两杯拿铁', (event) => events.push(event), { callJev });

  assert.deepEqual(summary.cart, ['拿铁', '拿铁']);
  assert.deepEqual(summary.items, [{ name: '拿铁', count: 2 }]);
  assert.equal(summary.total, 2);
  assert.equal(summary.stoppedByLimit, false);
  assert.equal(calls.length, 4);
  assert.equal(events.filter((event) => event.type === 'added').length, 1);
  assert.equal(events.find((event) => event.type === 'added').count, 2);
  assert.equal(events.find((event) => event.type === 'quantity').quantity, 'two');
  assert.equal(events.some((event) => event.type === 'invalid'), false);
  assert.equal(events.find((event) => event.type === 'done').empty, false);
});

test('invalid quantities do not enter the cart', async () => {
  for (const phrase of ['0.7杯', '2^32杯', '-1杯']) {
    const { callJev, calls } = script([
      () => choice('latte'),
      (payload) => {
        assert.equal(payload.state.request, `来${phrase}拿铁`);
        return quantity('invalid', 0.8);
      },
      () => choice('done'),
    ]);
    const events = [];
    const summary = await runCart({}, `来${phrase}拿铁`, (event) => events.push(event), { callJev });

    assert.deepEqual(summary.cart, [], phrase);
    assert.equal(summary.total, 0, phrase);
    assert.equal(events.some((event) => event.type === 'added'), false, phrase);
    const invalid = events.find((event) => event.type === 'invalid');
    assert.equal(invalid.item, '拿铁', phrase);
    assert.equal(invalid.message, '数量非法，无法满足', phrase);
    assert.equal(calls.length, 3, phrase);
    assert.equal(calls.some((payload) => payload.questions.check_last_added), false, phrase);
  }
});

test('a quantity token outside the closed set is not expanded', async () => {
  for (const token of ['0.7', '-1', '2^32', '2', '两']) {
    const { callJev } = script([
      () => choice('latte'),
      () => quantity(token),
      () => choice('done'),
    ]);
    const events = [];
    const summary = await runCart({}, `来${token}杯拿铁`, (event) => events.push(event), { callJev });
    assert.equal(summary.cart.length, 0, token);
    assert.ok(summary.cart.length < 3, token);
    assert.equal(events.some((event) => event.type === 'added'), false, token);
    assert.equal(events.find((event) => event.type === 'invalid').reason, 'quantity_unrecognized', token);
  }
});

test('两杯燕麦拿铁再来个麦芬 keeps both lines and shrinks the menu', async () => {
  const { callJev } = script([
    () => choice('oat_latte'),
    () => quantity('two'),
    () => check(0.9),
    (payload) => {
      const criteria = payload.questions.next_item.criteria;
      assert.equal(criteria.oat_latte, undefined);
      assert.ok(criteria.muffin);
      return choice('muffin');
    },
    () => quantity('one'),
    () => check(0.84),
    (payload) => {
      const criteria = payload.questions.next_item.criteria;
      assert.equal(criteria.oat_latte, undefined);
      assert.equal(criteria.muffin, undefined);
      return choice('done');
    },
  ]);
  const summary = await runCart({}, '来两杯燕麦拿铁，再来个麦芬', () => {}, { callJev });
  assert.deepEqual(summary.items, [
    { name: '燕麦拿铁', count: 2 },
    { name: '麦芬', count: 1 },
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.stoppedByLimit, false);
});

test('抹茶 resolves to done and an empty cart', async () => {
  const { callJev, calls } = script([() => choice('done', 0.52)]);
  const events = [];
  const summary = await runCart({}, '那个绿色抹茶拿铁', (event) => events.push(event), { callJev });
  assert.deepEqual(summary.cart, []);
  assert.equal(summary.total, 0);
  assert.equal(events.find((event) => event.type === 'done').empty, true);
  assert.equal(calls.length, 1);
  assert.equal(events.some((event) => event.type === 'quantity'), false);
});

test('an invalid line does not block a later legal item', async () => {
  const { callJev, calls } = script([
    () => choice('latte'),
    () => quantity('invalid'),
    (payload) => {
      assert.equal(payload.questions.next_item.criteria.latte, undefined);
      return choice('muffin');
    },
    () => quantity('one'),
    () => check(0.9),
    () => choice('done'),
  ]);
  const events = [];
  const summary = await runCart({}, '来0.7杯拿铁和一个麦芬', (event) => events.push(event), { callJev });
  assert.deepEqual(summary.cart, ['麦芬']);
  assert.equal(events.filter((event) => event.type === 'invalid').length, 1);
  assert.equal(events.filter((event) => event.type === 'added').length, 1);
  assert.equal(calls.some((payload) => payload.state.item === '拿铁' && payload.questions.check_last_added), false);
});

test('a failed check removes every copy from that quantity', async () => {
  const { callJev } = script([
    () => choice('latte'),
    () => quantity('two'),
    () => check(0.1),
    () => choice('done'),
  ]);
  const events = [];
  const summary = await runCart({}, '来两杯拿铁', (event) => events.push(event), { callJev });
  assert.deepEqual(summary.cart, []);
  const rejected = events.find((event) => event.type === 'check');
  assert.equal(rejected.kept, false);
  assert.equal(rejected.count, 2);
});

test('an item already found cannot be added again', async () => {
  const { callJev } = script([
    () => choice('拿铁'),
    () => quantity('one'),
    () => check(0.95),
    () => choice('latte'),
    () => choice('done'),
  ]);
  const events = [];
  const summary = await runCart({}, '来一杯拿铁', (event) => events.push(event), { callJev });
  assert.deepEqual(summary.cart, ['拿铁']);
  assert.equal(events.filter((event) => event.type === 'ignored').length, 1);
  assert.equal(summary.stoppedByLimit, false);
});

test('the request cap stops the loop before an unbounded cart', async () => {
  const { callJev, calls } = script([
    () => choice('latte'),
    () => quantity('three'),
    () => check(0.99),
    () => choice('muffin'),
  ]);
  const summary = await runCart({}, '来三杯拿铁再来麦芬', () => {}, {
    callJev,
    maxRequests: 3,
  });
  assert.deepEqual(summary.cart, ['拿铁', '拿铁', '拿铁']);
  assert.equal(summary.stoppedByLimit, true);
  assert.equal(calls.length, 3);
  assert.ok(summary.cart.length <= 3);
});

test('every menu item is found at most once when the menu runs out', async () => {
  const ids = MENU.map((item) => item.id);
  const steps = ids.flatMap((id) => [() => choice(id), () => quantity('one'), () => check(0.9)]);
  const { callJev, calls } = script(steps);
  const events = [];
  const summary = await runCart({}, '菜单上每样都来一份', (event) => events.push(event), { callJev });
  assert.equal(summary.total, MENU.length);
  assert.equal(new Set(summary.cart).size, MENU.length);
  assert.equal(summary.stoppedByLimit, false);
  assert.equal(events.filter((event) => event.type === 'done').length, 1);
  assert.equal(calls.length, MENU.length * 3);
  const offered = calls
    .filter((payload) => payload.questions.next_item)
    .map((payload) => Object.keys(payload.questions.next_item.criteria).filter((key) => key !== 'done'));
  assert.deepEqual(offered.map((keys) => keys.length), ids.map((_, index) => ids.length - index));
});
