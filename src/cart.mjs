/**
 * Shopping-cart choice loop. Emits structured events for CLI or web SSE.
 *
 * 1. Find each menu item at most once. The Choice offers items not yet found,
 *    plus all (one of every remaining item) and done. A companion noul asks
 *    whether any remaining item was named exactly. A near-miss (抹茶拿铁 for
 *    拿铁) is not a menu hit. This file does not parse the order.
 * 2. all, or a confirmed one_of_each noul, writes one of every remaining
 *    sellable item. Those requests do not name each SKU, so the per-item
 *    exact and last_added checks would reject them and are skipped. Quantity
 *    is one. Temperature stays unspecified unless that same response's
 *    order_temperature choice is hot or iced, and the mark is applied only
 *    to coffees that have a temperature. Hot chocolate is left as-is.
 *    An off-menu extra in the same sentence is not added.
 * 3. For a named item, one request asks exact-item, quantity
 *    (one / two / three / invalid), and temperature (hot / iced / unspecified)
 *    when that drink has a temperature. exact failure does not touch the cart.
 *    invalid quantity does not touch the cart.
 * 4. A legal named line is written, then the last_added noul check still runs.
 */
import { MENU, menuNames, findMenuChoice } from './menu.mjs';
import {
  callJev,
  buildPayload,
  buildChoiceQuestion,
  buildOnMenuQuestion,
  buildOneOfEachQuestion,
  buildOrderTemperatureQuestion,
  buildQuantityQuestion,
  buildTemperatureQuestion,
  buildExactQuestion,
  buildCheckQuestion,
  readAnswer,
} from './jev.mjs';

/** Item-finding Choice calls, including the done sentinel. */
export const MAX_ITEM_REQUESTS = MENU.length + 1;
/** Every Jev call in one order: find + fields + check. */
export const MAX_REQUESTS = MAX_ITEM_REQUESTS * 3;
export const NOUL_THRESHOLD = 0.45;

export const OFF_MENU_MESSAGE = '不在菜单，菜单无法满足';
export const INVALID_QTY_MESSAGE = '数量非法，无法满足';

const QUANTITY_COUNTS = { one: 1, two: 2, three: 3 };
const TEMPERATURES = new Set(['hot', 'iced', 'unspecified']);
const TEMPERATURE_MARK = { hot: '热', iced: '冰' };

function formatConfidence(answer) {
  return typeof answer?.confidence === 'number' ? answer.confidence : null;
}

function readCheckValue(answer) {
  if (typeof answer?.noul === 'number') return { value: answer.noul, kind: 'noul' };
  if (typeof answer?.score === 'number') {
    const value = answer.score > 1 ? answer.score / 4 : answer.score;
    return { value, kind: 'score' };
  }
  return { value: null, kind: null };
}

function confirmed(answer) {
  const check = readCheckValue(answer);
  return check.value !== null && check.value >= NOUL_THRESHOLD;
}

function summarizeCart(cart) {
  const counts = new Map();
  for (const name of cart) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

/**
 * Map a quantity Choice onto the closed set.
 * Anything other than one / two / three / invalid is invalid.
 * Does not read the user's order text.
 */
export function classifyQuantity(choice) {
  const raw = typeof choice === 'string' ? choice.trim().toLowerCase() : '';
  if (raw === 'invalid') return { raw, quantity: 'invalid', count: null };
  if (Object.hasOwn(QUANTITY_COUNTS, raw)) {
    return { raw, quantity: raw, count: QUANTITY_COUNTS[raw] };
  }
  return { raw, quantity: 'invalid', count: null };
}

/**
 * Map a temperature Choice onto hot / iced / unspecified.
 * Anything else, including a missing answer, stays unspecified. Does not guess.
 */
export function classifyTemperature(choice) {
  const raw = typeof choice === 'string' ? choice.trim().toLowerCase() : '';
  if (TEMPERATURES.has(raw)) return { raw, temperature: raw };
  return { raw, temperature: 'unspecified' };
}

/** Receipt line. Temperature is shown only when the guest stated hot or iced. */
export function lineName(name, temperature) {
  const mark = TEMPERATURE_MARK[temperature];
  return mark ? `${name} · ${mark}` : name;
}

/**
 * @param {object} config readConfig()
 * @param {string} request
 * @param {(event: object) => void | Promise<void>} onEvent
 * @param {{ callJev?: typeof callJev, maxRequests?: number, maxItemRequests?: number }} [options]
 */
export async function runCart(config, request, onEvent = () => {}, options = {}) {
  const ask = options.callJev ?? callJev;
  const maxRequests = options.maxRequests ?? MAX_REQUESTS;
  const maxItemRequests = options.maxItemRequests ?? MAX_ITEM_REQUESTS;

  const emit = async (event) => {
    await onEvent(event);
  };

  const cart = [];
  const found = [];
  let remaining = MENU.slice();
  let requests = 0;
  let itemRequests = 0;
  let round = 0;
  let unrecognizedStreak = 0;
  let sawOffMenu = false;
  let sawInvalid = false;
  /** @type {null | 'done' | 'unrecognized_streak' | 'request_cap' | 'menu_exhausted'} */
  let stopReason = null;

  const capped = (nextIsItem = false) =>
    requests >= maxRequests || (nextIsItem && itemRequests >= maxItemRequests);

  function resolution(reason) {
    if (cart.length > 0) return { outcome: 'items', message: '' };
    if (sawInvalid && !sawOffMenu) return { outcome: 'invalid_quantity', message: INVALID_QTY_MESSAGE };
    if (reason === 'unrecognized_streak') return { outcome: 'empty', message: '无法识别，没有可下单的商品' };
    if (reason === 'request_cap') return { outcome: 'empty', message: '没有可下单的商品' };
    return { outcome: 'off_menu', message: OFF_MENU_MESSAGE };
  }

  async function jev(state, questions, nextIsItem = false) {
    requests += 1;
    if (nextIsItem) itemRequests += 1;
    return ask(config, buildPayload(config, state, questions));
  }

  async function expandRemaining(temperatureAnswer, confidence) {
    const classified = classifyTemperature(temperatureAnswer?.choice);
    const stated =
      classified.temperature === 'hot' || classified.temperature === 'iced'
        ? classified.temperature
        : null;
    const temperatureConfidence = formatConfidence(temperatureAnswer);
    await emit({
      type: 'choice',
      round,
      raw: 'all',
      matched: { id: 'all', name: '每样一份' },
      confidence,
      cart: [...cart],
    });
    const batch = remaining.slice();
    for (const item of batch) {
      const temperature = item.temperature ? stated ?? 'unspecified' : null;
      await emit({
        type: 'quantity',
        round,
        item: item.name,
        raw: 'one',
        quantity: 'one',
        count: 1,
        confidence: null,
        cart: [...cart],
      });
      if (item.temperature) {
        await emit({
          type: 'temperature',
          round,
          item: item.name,
          raw: stated ? classified.raw : 'unspecified',
          temperature: stated ?? 'unspecified',
          confidence: temperatureConfidence,
          cart: [...cart],
        });
      }
      const label = lineName(item.name, temperature);
      found.push(item);
      cart.push(label);
      await emit({
        type: 'added',
        round,
        item: label,
        base: item.name,
        temperature,
        count: 1,
        cart: [...cart],
      });
    }
    remaining = [];
  }

  async function finishOffMenu() {
    sawOffMenu = true;
    const done = resolution('done');
    await emit({
      type: 'unmet',
      round,
      message: OFF_MENU_MESSAGE,
      menu: menuNames(),
      cart: [...cart],
    });
    await emit({
      type: 'done',
      round,
      empty: cart.length === 0,
      reason: done.outcome === 'items' ? 'complete' : 'off_menu',
      message: cart.length === 0 ? OFF_MENU_MESSAGE : '',
      menu: menuNames(),
      cart: [...cart],
    });
    stopReason = 'done';
  }

  await emit({ type: 'start', request, menu: menuNames() });

  while (remaining.length > 0 && !stopReason) {
    if (capped(true)) {
      stopReason = 'request_cap';
      break;
    }

    round += 1;
    const foundNames = found.map((item) => item.name);
    await emit({ type: 'round', round, cart: [...cart], found: [...foundNames] });

    const choiceState = {
      request,
      cart: [...cart],
      found: foundNames,
      last_added: cart.at(-1) ?? null,
    };
    const choiceResponse = await jev(
      choiceState,
      {
        next_item: buildChoiceQuestion(remaining, foundNames),
        on_menu: buildOnMenuQuestion(remaining),
        one_of_each: buildOneOfEachQuestion(remaining),
        order_temperature: buildOrderTemperatureQuestion(),
      },
      true,
    );
    const choiceAnswer = readAnswer(choiceResponse, 'next_item');
    const onMenuAnswer = readAnswer(choiceResponse, 'on_menu');
    const oneOfEachAnswer = readAnswer(choiceResponse, 'one_of_each');
    const rawChoice = typeof choiceAnswer?.choice === 'string' ? choiceAnswer.choice : '';
    const matched = findMenuChoice(rawChoice);
    const confidence = formatConfidence(choiceAnswer);
    const wantsEverything = confirmed(oneOfEachAnswer) || matched?.id === 'all';
    if (wantsEverything) {
      unrecognizedStreak = 0;
      const everythingConfidence = formatConfidence(oneOfEachAnswer) ?? confidence;
      await expandRemaining(readAnswer(choiceResponse, 'order_temperature'), everythingConfidence);
      continue;
    }
    const stillOffered =
      matched && matched.id !== 'done' && remaining.some((item) => item.id === matched.id);
    const menuConfirmed = confirmed(onMenuAnswer);
    const accepted =
      matched && (matched.id === 'done' || (stillOffered && menuConfirmed));
    const rejectedNearMiss = !accepted && Boolean(onMenuAnswer) && !menuConfirmed;
    const doneOffMenu = accepted && matched.id === 'done' && resolution('done').outcome === 'off_menu';

    await emit({
      type: 'choice',
      round,
      raw: rawChoice,
      matched: accepted ? { id: matched.id, name: matched.name } : null,
      ...(rejectedNearMiss ? { rejected: 'not_on_menu' } : {}),
      ...(doneOffMenu ? { offMenu: true } : {}),
      confidence,
      cart: [...cart],
    });

    if (!matched || (matched.id !== 'done' && !stillOffered)) {
      if (onMenuAnswer && !menuConfirmed) {
        await finishOffMenu();
        break;
      }
      unrecognizedStreak += 1;
      await emit({
        type: 'ignored',
        round,
        reason: 'choice_not_on_menu',
        menu: menuNames(),
        cart: [...cart],
      });
      if (unrecognizedStreak >= 2) {
        await emit({ type: 'stop', reason: 'unrecognized_streak' });
        stopReason = 'unrecognized_streak';
        break;
      }
      continue;
    }
    unrecognizedStreak = 0;

    if (matched.id === 'done') {
      const done = resolution('done');
      await emit({
        type: 'done',
        round,
        empty: cart.length === 0,
        reason: cart.length === 0 ? done.outcome : 'complete',
        message: cart.length === 0 ? done.message : '',
        menu: menuNames(),
        cart: [...cart],
      });
      stopReason = 'done';
      break;
    }

    if (!menuConfirmed) {
      await finishOffMenu();
      break;
    }

    remaining = remaining.filter((item) => item.id !== matched.id);

    if (capped(false)) {
      stopReason = 'request_cap';
      break;
    }

    const fieldQuestions = {
      quantity: buildQuantityQuestion(matched),
      exact_item: buildExactQuestion(matched),
    };
    if (matched.temperature) fieldQuestions.temperature = buildTemperatureQuestion(matched);

    const fieldState = {
      request,
      cart: [...cart],
      item: matched.name,
      found: found.map((item) => item.name),
    };
    const fieldResponse = await jev(fieldState, fieldQuestions);
    const exactAnswer = readAnswer(fieldResponse, 'exact_item');
    const quantityAnswer = readAnswer(fieldResponse, 'quantity');
    const quantity = classifyQuantity(quantityAnswer?.choice);
    const quantityConfidence = formatConfidence(quantityAnswer);

    if (!confirmed(exactAnswer)) {
      sawOffMenu = true;
      await emit({
        type: 'unmet',
        round,
        message: OFF_MENU_MESSAGE,
        menu: menuNames(),
        cart: [...cart],
      });
      continue;
    }

    await emit({
      type: 'quantity',
      round,
      item: matched.name,
      raw: quantity.raw,
      quantity: quantity.quantity,
      count: quantity.count,
      confidence: quantityConfidence,
      cart: [...cart],
    });

    if (quantity.count == null) {
      sawInvalid = true;
      found.push(matched);
      await emit({
        type: 'invalid',
        round,
        item: matched.name,
        reason: quantity.raw === 'invalid' ? 'invalid_quantity' : 'quantity_unrecognized',
        message: INVALID_QTY_MESSAGE,
        cart: [...cart],
        menu: menuNames(),
      });
      continue;
    }

    let temperature = null;
    if (matched.temperature) {
      const temperatureAnswer = readAnswer(fieldResponse, 'temperature');
      const classified = classifyTemperature(temperatureAnswer?.choice);
      temperature = classified.temperature;
      await emit({
        type: 'temperature',
        round,
        item: matched.name,
        raw: classified.raw,
        temperature,
        confidence: formatConfidence(temperatureAnswer),
        cart: [...cart],
      });
    }

    const label = lineName(matched.name, temperature);
    found.push(matched);
    for (let i = 0; i < quantity.count; i += 1) cart.push(label);
    await emit({
      type: 'added',
      round,
      item: label,
      base: matched.name,
      temperature,
      count: quantity.count,
      cart: [...cart],
    });

    if (capped(false)) {
      stopReason = 'request_cap';
      break;
    }

    const checkState = {
      request,
      cart: [...cart],
      last_added: matched.name,
      temperature,
    };
    const checkResponse = await jev(checkState, { check_last_added: buildCheckQuestion() });
    const checkAnswer = readAnswer(checkResponse, 'check_last_added');
    const check = readCheckValue(checkAnswer);

    if (check.value === null) {
      await emit({
        type: 'check',
        round,
        item: label,
        base: matched.name,
        count: quantity.count,
        value: null,
        kind: null,
        kept: true,
        cart: [...cart],
      });
      continue;
    }

    const kept = check.value >= NOUL_THRESHOLD;
    if (!kept) {
      sawOffMenu = true;
      for (let i = 0; i < quantity.count; i += 1) cart.pop();
    }
    await emit({
      type: 'check',
      round,
      item: label,
      base: matched.name,
      count: quantity.count,
      value: check.value,
      kind: check.kind,
      threshold: NOUL_THRESHOLD,
      kept,
      cart: [...cart],
      ...(kept ? {} : { menu: menuNames(), message: OFF_MENU_MESSAGE }),
    });
  }

  if (!stopReason) stopReason = remaining.length === 0 ? 'menu_exhausted' : 'request_cap';

  if (stopReason === 'menu_exhausted') {
    const done = resolution('menu_exhausted');
    await emit({
      type: 'done',
      round,
      empty: cart.length === 0,
      reason: cart.length === 0 ? done.outcome : 'complete',
      message: cart.length === 0 ? done.message : '',
      menu: menuNames(),
      cart: [...cart],
    });
  }

  const done = resolution(stopReason);
  const summary = {
    type: 'final',
    cart: [...cart],
    items: summarizeCart(cart),
    total: cart.length,
    stoppedByLimit: stopReason === 'request_cap',
    outcome: done.outcome,
    message: done.message,
    menu: menuNames(),
  };
  await emit(summary);
  return summary;
}
