import test from 'node:test';
import assert from 'node:assert/strict';
import { MENU, findMenuChoice, EVERYTHING_CHOICES } from './menu.mjs';
import {
  buildChoiceQuestion,
  buildQuantityQuestion,
  buildTemperatureQuestion,
  buildExactQuestion,
  buildCheckQuestion,
  buildOnMenuQuestion,
  buildOneOfEachQuestion,
  buildOrderTemperatureQuestion,
} from './jev.mjs';
import { classifyQuantity, classifyTemperature, runCart, OFF_MENU_MESSAGE, INVALID_QTY_MESSAGE } from './cart.mjs';

function choice(id, confidence = 0.99, noul = 0.96) {
  return { answers: { next_item: { choice: id, confidence }, on_menu: { noul } } };
}

function quantity(value, confidence = 0.97, extras = {}) {
  const answers = {
    quantity: { choice: value, confidence },
    exact_item: { noul: Object.hasOwn(extras, 'exact') ? extras.exact : 0.96 },
  };
  if (Object.hasOwn(extras, 'temperature')) {
    answers.temperature = {
      choice: extras.temperature,
      confidence: extras.temperatureConfidence ?? 0.98,
    };
  }
  return { answers };
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
  const { callJev, calls } = script([() => choice('done', 0.52, 0.2)]);
  const events = [];
  const summary = await runCart({}, '那个绿色抹茶拿铁', (event) => events.push(event), { callJev });
  assert.deepEqual(summary.cart, []);
  assert.equal(summary.total, 0);
  assert.equal(summary.outcome, 'off_menu');
  assert.equal(summary.message, OFF_MENU_MESSAGE);
  assert.equal(events.find((event) => event.type === 'done').empty, true);
  assert.equal(events.find((event) => event.type === 'choice').offMenu, true);
  assert.equal(calls.length, 1);
  assert.equal(events.some((event) => event.type === 'quantity'), false);
  assert.equal(summary.cart.includes('拿铁'), false);
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
    .map((payload) =>
      Object.keys(payload.questions.next_item.criteria).filter((key) => key !== 'done' && key !== 'all'),
    );
  assert.deepEqual(offered.map((keys) => keys.length), ids.map((_, index) => ids.length - index));
});

test('near-miss names do not match a shorter menu item', () => {
  for (const phrase of ['抹茶拿铁', '那个绿色抹茶拿铁', '绿色抹茶拿铁', '香草拿铁', '焦糖拿铁', '拿']) {
    assert.equal(findMenuChoice(phrase), null, phrase);
  }
  assert.equal(findMenuChoice('latte').id, 'latte');
  assert.equal(findMenuChoice('拿铁').id, 'latte');
  assert.equal(findMenuChoice('拿铁咖啡').id, 'latte');
  assert.equal(findMenuChoice('燕麦拿铁').id, 'oat_latte');
  assert.equal(findMenuChoice('latte（拿铁）').id, 'latte');
  assert.equal(findMenuChoice('oat_latte（燕麦拿铁）').id, 'oat_latte');
  assert.equal(findMenuChoice('抹茶拿铁（latte）'), null);
  assert.equal(findMenuChoice('done').id, 'done');
});

test('choice, exact, and check criteria refuse to substitute 拿铁 for 抹茶拿铁', () => {
  const choiceQuestion = buildChoiceQuestion(MENU, []);
  const latte = JSON.stringify(choiceQuestion.criteria.latte);
  const done = JSON.stringify(choiceQuestion.criteria.done);
  assert.match(latte, /抹茶拿铁/);
  assert.match(latte, /香草拿铁/);
  assert.match(done, /不要用最像的菜单项顶替/);
  assert.match(done, /抹茶拿铁/);

  const onMenu = JSON.stringify(buildOnMenuQuestion(MENU));
  assert.match(onMenu, /那个绿色抹茶拿铁/);
  assert.match(onMenu, /香草拿铁/);
  assert.match(onMenu, /不要因为里面有「拿铁」两个字就答 yes/);

  const exact = JSON.stringify(buildExactQuestion(MENU.find((item) => item.id === 'latte')));
  assert.match(exact, /抹茶拿铁/);
  assert.match(exact, /绿色抹茶拿铁/);

  const check = JSON.stringify(buildCheckQuestion());
  assert.match(check, /那个绿色抹茶拿铁/);
  assert.match(check, /共享「拿铁」两个字不算点了拿铁/);
});

test('抹茶拿铁 cannot add 拿铁 when choice returns latte', async () => {
  const { callJev, calls } = script([
    (payload) => {
      assert.match(JSON.stringify(payload.questions.next_item.criteria.latte), /抹茶拿铁/);
      assert.equal(payload.questions.on_menu.type, 'noul');
      return {
        answers: {
          next_item: { choice: 'latte', confidence: 0.54 },
          on_menu: { noul: 0.12 },
        },
      };
    },
  ]);
  const events = [];
  const summary = await runCart({}, '那个绿色抹茶拿铁', (event) => events.push(event), { callJev });

  assert.deepEqual(summary.cart, []);
  assert.equal(summary.outcome, 'off_menu');
  assert.equal(summary.message, OFF_MENU_MESSAGE);
  assert.equal(summary.cart.some((name) => name.includes('拿铁')), false);
  assert.equal(events.some((event) => event.type === 'added'), false);
  assert.equal(events.some((event) => event.type === 'quantity'), false);
  assert.equal(calls.some((payload) => payload.questions.quantity), false);
  assert.equal(calls.length, 1);
  const choiceEvent = events.find((event) => event.type === 'choice');
  assert.equal(choiceEvent.matched, null);
  assert.equal(choiceEvent.rejected, 'not_on_menu');
});

test('a raw near-miss choice is not parsed into 拿铁', async () => {
  const { callJev } = script([
    () => ({
      answers: {
        next_item: { choice: '抹茶拿铁', confidence: 0.4 },
        on_menu: { noul: 0.08 },
      },
    }),
  ]);
  const summary = await runCart({}, '抹茶拿铁', () => {}, { callJev });
  assert.deepEqual(summary.cart, []);
  assert.equal(summary.message, OFF_MENU_MESSAGE);
  assert.equal(summary.cart.some((name) => name.includes('拿铁')), false);
});

test('抹茶拿铁再来个麦芬 drops the latte stand-in and keeps the muffin', async () => {
  const { callJev } = script([
    () => choice('latte', 0.65, 0.9),
    (payload) => {
      assert.match(JSON.stringify(payload.questions.exact_item), /抹茶拿铁/);
      return quantity('one', 1, { exact: 0.1, temperature: 'hot' });
    },
    (payload) => {
      assert.equal(payload.questions.next_item.criteria.latte, undefined);
      assert.ok(payload.questions.next_item.criteria.muffin);
      assert.equal(payload.questions.temperature, undefined);
      return choice('muffin', 0.96, 0.95);
    },
    (payload) => {
      assert.equal(payload.questions.temperature, undefined);
      assert.ok(payload.questions.exact_item);
      return quantity('one');
    },
    () => check(0.93),
    () => choice('done', 1, 0.2),
  ]);
  const events = [];
  const summary = await runCart({}, '抹茶拿铁，再来个麦芬', (event) => events.push(event), { callJev });
  assert.deepEqual(summary.cart, ['麦芬']);
  assert.equal(summary.cart.some((name) => name.includes('拿铁')), false);
  assert.equal(events.some((event) => event.type === 'added' && String(event.item).includes('拿铁')), false);
  assert.equal(events.some((event) => event.type === 'unmet'), true);
});

test('classifyTemperature only accepts hot, iced, and unspecified', () => {
  assert.deepEqual(classifyTemperature('iced'), { raw: 'iced', temperature: 'iced' });
  assert.deepEqual(classifyTemperature(' HOT '), { raw: 'hot', temperature: 'hot' });
  assert.equal(classifyTemperature('unspecified').temperature, 'unspecified');
  for (const raw of ['热', '冰', '常温', 'both', 'invalid', 'warm', '', null]) {
    assert.equal(classifyTemperature(raw).temperature, 'unspecified', String(raw));
  }
});

test('temperature criteria cover 热, 冰, 常温, hot, and iced', () => {
  const question = buildTemperatureQuestion({ id: 'americano', name: '美式' });
  assert.equal(question.type, 'choice');
  assert.deepEqual(Object.keys(question.criteria), ['hot', 'iced', 'unspecified']);
  const blob = JSON.stringify(question);
  for (const token of ['热', '冰', '常温', 'hot', 'iced']) {
    assert.ok(blob.includes(token), token);
  }
  assert.match(question.instructions, /unspecified/);
  assert.match(question.instructions, /不要替客人猜/);
});

test('冰美式 is iced on the receipt and 热拿铁 is hot', async () => {
  const iced = script([
    () => choice('americano'),
    (payload) => {
      assert.equal(payload.state.item, '美式');
      assert.deepEqual(Object.keys(payload.questions.temperature.criteria), ['hot', 'iced', 'unspecified']);
      return quantity('one', 1, { temperature: 'iced' });
    },
    () => check(0.95),
    () => choice('done'),
  ]);
  const icedSummary = await runCart({}, '一杯冰美式', () => {}, { callJev: iced.callJev });
  assert.deepEqual(icedSummary.cart, ['美式 · 冰']);
  assert.deepEqual(icedSummary.items, [{ name: '美式 · 冰', count: 1 }]);

  const hot = script([
    () => choice('latte'),
    () => quantity('two', 1, { temperature: 'hot' }),
    () => check(0.96),
    () => choice('done'),
  ]);
  const hotEvents = [];
  const hotSummary = await runCart({}, '两杯热拿铁', (event) => hotEvents.push(event), { callJev: hot.callJev });
  assert.deepEqual(hotSummary.cart, ['拿铁 · 热', '拿铁 · 热']);
  assert.equal(hotEvents.find((event) => event.type === 'temperature').temperature, 'hot');
  assert.equal(hotEvents.find((event) => event.type === 'added').item, '拿铁 · 热');
});

test('unmentioned or illegal temperature stays unspecified and is not invented', async () => {
  for (const token of [undefined, 'unspecified', 'both', '常温']) {
    const { callJev } = script([
      () => choice('americano'),
      () => quantity('one', 1, { temperature: token }),
      () => check(0.94),
      () => choice('done'),
    ]);
    const events = [];
    const summary = await runCart({}, '来一杯美式', (event) => events.push(event), { callJev });
    assert.deepEqual(summary.cart, ['美式'], String(token));
    assert.equal(events.find((event) => event.type === 'temperature').temperature, 'unspecified', String(token));
    assert.equal(summary.cart.some((name) => name.includes('热') || name.includes('冰')), false);
  }
});

test('热巧克力 is hot-only and does not get a temperature choice', async () => {
  const { callJev } = script([
    (payload) => {
      const criteria = JSON.stringify(payload.questions.next_item.criteria.hot_chocolate);
      assert.match(criteria, /冰巧克力/);
      return choice('hot_chocolate');
    },
    (payload) => {
      assert.equal(payload.questions.temperature, undefined);
      assert.ok(payload.questions.quantity);
      assert.ok(payload.questions.exact_item);
      return quantity('one');
    },
    () => check(0.9),
    () => choice('done'),
  ]);
  const events = [];
  const summary = await runCart({}, '热巧克力', (event) => events.push(event), { callJev });
  assert.deepEqual(summary.cart, ['热巧克力']);
  assert.equal(events.some((event) => event.type === 'temperature'), false);
});

test('an invalid quantity still reports 数量非法 and does not become an off-menu ticket', async () => {
  const { callJev } = script([
    () => choice('latte'),
    () => quantity('invalid'),
    () => choice('done'),
  ]);
  const summary = await runCart({}, '来0.7杯拿铁', () => {}, { callJev });
  assert.deepEqual(summary.cart, []);
  assert.equal(summary.outcome, 'invalid_quantity');
  assert.equal(summary.message, INVALID_QTY_MESSAGE);
});

const ONE_EACH = MENU.map((item) => item.name);

function everythingAnswer({ choice: picked = 'done', noul = 0.92, onMenu = 0.12, temperature = 'unspecified' } = {}) {
  return {
    answers: {
      next_item: { choice: picked, confidence: 0.9 },
      on_menu: { noul: onMenu },
      one_of_each: { noul },
      order_temperature: { choice: temperature, confidence: 0.9 },
    },
  };
}

test('everything phrases are choice tokens and are taught to Jev', () => {
  for (const phrase of ['all', 'ALL', 'one of each', 'all of them', 'everything', '所有的都来一份', '全部来一份', '每样都来一份']) {
    assert.equal(findMenuChoice(phrase).id, 'all', phrase);
  }
  assert.equal(findMenuChoice('抹茶拿铁'), null);
  assert.equal(findMenuChoice('宫保鸡丁'), null);
  assert.equal(findMenuChoice('拿铁').id, 'latte');

  const choiceQuestion = buildChoiceQuestion(MENU, []);
  assert.ok(choiceQuestion.criteria.all);
  assert.ok(choiceQuestion.criteria.done);
  const taught = JSON.stringify(choiceQuestion) + JSON.stringify(buildOneOfEachQuestion(MENU));
  for (const phrase of EVERYTHING_CHOICES) assert.ok(taught.includes(phrase), phrase);
  assert.match(taught, /宫保鸡丁/);
  assert.match(taught, /所有的都来两份/);
  assert.deepEqual(Object.keys(buildOrderTemperatureQuestion().criteria), ['hot', 'iced', 'unspecified']);
});

test('所有的都来一份 yields one of every menu item', async () => {
  const { callJev, calls } = script([
    (payload) => {
      assert.equal(payload.questions.one_of_each.type, 'noul');
      assert.equal(payload.questions.order_temperature.type, 'choice');
      assert.match(payload.questions.next_item.instructions, /所有的都来一份/);
      assert.match(JSON.stringify(payload.questions.one_of_each), /one of each/);
      return everythingAnswer({ choice: '所有的都来一份', noul: 0.2, onMenu: 0.08 });
    },
  ]);
  const events = [];
  const summary = await runCart({}, '所有的都来一份', (event) => events.push(event), { callJev });

  assert.deepEqual(summary.cart, ONE_EACH);
  assert.deepEqual(summary.items, ONE_EACH.map((name) => ({ name, count: 1 })));
  assert.equal(summary.total, MENU.length);
  assert.equal(summary.outcome, 'items');
  assert.equal(summary.message, '');
  assert.equal(summary.stoppedByLimit, false);
  assert.equal(calls.length, 1);
  assert.equal(calls.some((payload) => payload.questions.quantity), false);
  assert.equal(events.some((event) => event.type === 'invalid'), false);
  assert.equal(events.some((event) => event.type === 'unmet'), false);
  assert.equal(events.filter((event) => event.type === 'added').length, MENU.length);
  assert.ok(events.filter((event) => event.type === 'quantity').every((event) => event.quantity === 'one' && event.count === 1));
  assert.equal(summary.cart.some((name) => name.includes('·')), false);
  const temperatures = events.filter((event) => event.type === 'temperature');
  assert.equal(temperatures.length, MENU.filter((item) => item.temperature).length);
  assert.ok(temperatures.every((event) => event.temperature === 'unspecified'));
});

test('one of each and 全部来一份 use the same whole-menu path', async () => {
  for (const phrase of ['one of each', '全部来一份', 'all of them']) {
    const { callJev } = script([() => everythingAnswer({ choice: phrase, noul: 0.1 })]);
    const summary = await runCart({}, phrase, () => {}, { callJev });
    assert.deepEqual(summary.cart, ONE_EACH, phrase);
    assert.equal(summary.outcome, 'items', phrase);
  }
});

test('a one_of_each noul expands the menu when the item choice is done', async () => {
  const { callJev, calls } = script([
    () => everythingAnswer({ choice: 'done', noul: 0.93, onMenu: 0.11, temperature: 'unspecified' }),
  ]);
  const events = [];
  const summary = await runCart({}, '菜单上每样都来一份', (event) => events.push(event), { callJev });
  assert.deepEqual(summary.cart, ONE_EACH);
  assert.equal(events.find((event) => event.type === 'choice').matched.id, 'all');
  assert.equal(calls.length, 1);
  assert.equal(events.some((event) => event.type === 'check'), false);
});

test('iced everything marks coffees and leaves hot chocolate and pastry unmarked', async () => {
  const { callJev } = script([
    () => everythingAnswer({ choice: 'all', noul: 0.88, temperature: 'iced' }),
  ]);
  const summary = await runCart({}, '所有的都来一份，都要冰的', () => {}, { callJev });
  assert.deepEqual(summary.cart, [
    '美式 · 冰',
    '拿铁 · 冰',
    '燕麦拿铁 · 冰',
    '卡布奇诺 · 冰',
    '热巧克力',
    '麦芬',
    '司康',
  ]);
});

test('all plus an off-menu item still fills the on-menu set only', async () => {
  const { callJev } = script([
    () => everythingAnswer({ choice: 'all', noul: 0.9, onMenu: 0.15 }),
  ]);
  const summary = await runCart({}, '所有的都来一份，再来份宫保鸡丁', () => {}, { callJev });
  assert.deepEqual(summary.cart, ONE_EACH);
  assert.equal(summary.outcome, 'items');
  assert.equal(JSON.stringify(summary.cart).includes('宫保鸡丁'), false);
  assert.equal(JSON.stringify(summary.cart).includes('抹茶'), false);
});

test('抹茶 and 宫保鸡丁 alone stay off the menu when one_of_each is not confirmed', async () => {
  for (const phrase of ['抹茶', '来一份宫保鸡丁，再来碗炒饭']) {
    const { callJev, calls } = script([
      () => everythingAnswer({ choice: 'done', noul: 0.08, onMenu: 0.1 }),
    ]);
    const summary = await runCart({}, phrase, () => {}, { callJev });
    assert.deepEqual(summary.cart, [], phrase);
    assert.equal(summary.outcome, 'off_menu', phrase);
    assert.equal(summary.message, OFF_MENU_MESSAGE, phrase);
    assert.equal(calls.length, 1, phrase);
  }
});

test('one_of_each below the threshold does not expand and does not scan the sentence', async () => {
  const { callJev } = script([
    () => everythingAnswer({ choice: 'done', noul: 0.44, onMenu: 0.2 }),
  ]);
  const summary = await runCart({}, '所有的都来一份', () => {}, { callJev });
  assert.deepEqual(summary.cart, []);
  assert.equal(summary.outcome, 'off_menu');
});

test('one of each after a named item adds only what is still remaining', async () => {
  const { callJev } = script([
    () => choice('latte'),
    () => quantity('one', 1, { temperature: 'unspecified' }),
    () => check(0.95),
    (payload) => {
      assert.equal(payload.questions.next_item.criteria.latte, undefined);
      assert.ok(payload.questions.next_item.criteria.all);
      const remainingNames = payload.questions.one_of_each.instructions.remaining.split('、');
      assert.equal(remainingNames.includes('拿铁'), false);
      assert.ok(remainingNames.includes('燕麦拿铁'));
      return everythingAnswer({ choice: 'all', noul: 0.2 });
    },
  ]);
  const summary = await runCart({}, '先来一杯拿铁，其余每样一份', () => {}, { callJev });
  assert.deepEqual(summary.items, [
    { name: '拿铁', count: 1 },
    { name: '美式', count: 1 },
    { name: '燕麦拿铁', count: 1 },
    { name: '卡布奇诺', count: 1 },
    { name: '热巧克力', count: 1 },
    { name: '麦芬', count: 1 },
    { name: '司康', count: 1 },
  ]);
});
