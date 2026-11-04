/**
 * Shopping-cart choice loop. Emits structured events for CLI or web SSE.
 *
 * 1. Find each menu item at most once: each Choice only offers items not yet
 *    found, plus done (the nothing_else sentinel). Stop on done.
 * 2. For each found item, a quantity Choice returns one / two / three / invalid.
 *    Legal counts are written as repeated names. invalid does not touch the cart.
 *    This file does not parse digits, exponents, or number words from the order.
 * 3. A last_added noul check still runs after a legal quantity is written.
 */
import { MENU, menuNames, findMenuChoice } from './menu.mjs';
import {
  callJev,
  buildPayload,
  buildChoiceQuestion,
  buildQuantityQuestion,
  buildCheckQuestion,
  readAnswer,
} from './jev.mjs';

/** Item-finding Choice calls, including the done sentinel. */
export const MAX_ITEM_REQUESTS = MENU.length + 1;
/** Every Jev call in one order: find + quantity + check. */
export const MAX_REQUESTS = MAX_ITEM_REQUESTS * 3;
export const NOUL_THRESHOLD = 0.45;

const QUANTITY_COUNTS = { one: 1, two: 2, three: 3 };

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
  /** @type {null | 'done' | 'unrecognized_streak' | 'request_cap' | 'menu_exhausted'} */
  let stopReason = null;

  const capped = (nextIsItem = false) =>
    requests >= maxRequests || (nextIsItem && itemRequests >= maxItemRequests);

  async function jev(state, questions, nextIsItem = false) {
    requests += 1;
    if (nextIsItem) itemRequests += 1;
    return ask(config, buildPayload(config, state, questions));
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
      { next_item: buildChoiceQuestion(remaining, foundNames) },
      true,
    );
    const choiceAnswer = readAnswer(choiceResponse, 'next_item');
    const rawChoice = typeof choiceAnswer?.choice === 'string' ? choiceAnswer.choice : '';
    const matched = findMenuChoice(rawChoice);
    const confidence = formatConfidence(choiceAnswer);
    const stillOffered =
      matched && matched.id !== 'done' && remaining.some((item) => item.id === matched.id);

    await emit({
      type: 'choice',
      round,
      raw: rawChoice,
      matched:
        matched && (matched.id === 'done' || stillOffered)
          ? { id: matched.id, name: matched.name }
          : null,
      confidence,
      cart: [...cart],
    });

    if (!matched || (matched.id !== 'done' && !stillOffered)) {
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
      await emit({
        type: 'done',
        round,
        empty: cart.length === 0,
        menu: menuNames(),
        cart: [...cart],
      });
      stopReason = 'done';
      break;
    }

    remaining = remaining.filter((item) => item.id !== matched.id);
    found.push(matched);

    if (capped(false)) {
      stopReason = 'request_cap';
      break;
    }

    const quantityState = {
      request,
      cart: [...cart],
      item: matched.name,
      found: found.map((item) => item.name),
    };
    const quantityResponse = await jev(quantityState, {
      quantity: buildQuantityQuestion(matched),
    });
    const quantityAnswer = readAnswer(quantityResponse, 'quantity');
    const quantity = classifyQuantity(quantityAnswer?.choice);
    const quantityConfidence = formatConfidence(quantityAnswer);

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
      await emit({
        type: 'invalid',
        round,
        item: matched.name,
        reason: quantity.raw === 'invalid' ? 'invalid_quantity' : 'quantity_unrecognized',
        message: '数量非法，无法满足',
        cart: [...cart],
        menu: menuNames(),
      });
      continue;
    }

    for (let i = 0; i < quantity.count; i += 1) cart.push(matched.name);
    await emit({
      type: 'added',
      round,
      item: matched.name,
      count: quantity.count,
      cart: [...cart],
    });

    if (capped(false)) {
      stopReason = 'request_cap';
      break;
    }

    const checkState = { request, cart: [...cart], last_added: matched.name };
    const checkResponse = await jev(checkState, { check_last_added: buildCheckQuestion() });
    const checkAnswer = readAnswer(checkResponse, 'check_last_added');
    const check = readCheckValue(checkAnswer);

    if (check.value === null) {
      await emit({
        type: 'check',
        round,
        item: matched.name,
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
      for (let i = 0; i < quantity.count; i += 1) cart.pop();
    }
    await emit({
      type: 'check',
      round,
      item: matched.name,
      count: quantity.count,
      value: check.value,
      kind: check.kind,
      threshold: NOUL_THRESHOLD,
      kept,
      cart: [...cart],
      ...(kept ? {} : { menu: menuNames() }),
    });
  }

  if (!stopReason) stopReason = remaining.length === 0 ? 'menu_exhausted' : 'request_cap';

  if (stopReason === 'menu_exhausted') {
    await emit({
      type: 'done',
      round,
      empty: cart.length === 0,
      menu: menuNames(),
      cart: [...cart],
    });
  }

  const summary = {
    type: 'final',
    cart: [...cart],
    items: summarizeCart(cart),
    total: cart.length,
    stoppedByLimit: stopReason === 'request_cap',
    menu: menuNames(),
  };
  await emit(summary);
  return summary;
}
