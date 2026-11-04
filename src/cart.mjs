/**
 * Shopping-cart choice loop. Emits structured events for CLI or web SSE.
 */
import { MENU, menuNames, findMenuChoice } from './menu.mjs';
import {
  callJev,
  buildPayload,
  buildChoiceQuestion,
  buildCheckQuestion,
  readAnswer,
} from './jev.mjs';

export const MAX_ROUNDS = 12;
export const NOUL_THRESHOLD = 0.45;

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
 * @param {object} config readConfig()
 * @param {string} request
 * @param {(event: object) => void | Promise<void>} onEvent
 */
export async function runCart(config, request, onEvent = () => {}) {
  const emit = async (event) => {
    await onEvent(event);
  };

  const cart = [];
  const rejectedCounts = new Map();
  let finished = false;
  let unrecognizedStreak = 0;
  let stoppedByLimit = false;

  await emit({ type: 'start', request, menu: menuNames() });

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    await emit({ type: 'round', round, cart: [...cart] });

    const choiceState = { request, cart: [...cart], last_added: cart.at(-1) ?? null };
    const choiceResponse = await callJev(
      config,
      buildPayload(config, choiceState, { next_item: buildChoiceQuestion(MENU) }),
    );
    const choiceAnswer = readAnswer(choiceResponse, 'next_item');
    const rawChoice = typeof choiceAnswer?.choice === 'string' ? choiceAnswer.choice : '';
    const matched = findMenuChoice(rawChoice);
    const confidence = formatConfidence(choiceAnswer);

    await emit({
      type: 'choice',
      round,
      raw: rawChoice,
      matched: matched ? { id: matched.id, name: matched.name } : null,
      confidence,
      cart: [...cart],
    });

    if (!matched) {
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
        finished = true;
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
      finished = true;
      break;
    }

    cart.push(matched.name);
    const lastAdded = matched.name;
    await emit({ type: 'added', round, item: lastAdded, cart: [...cart] });

    const checkState = { request, cart: [...cart], last_added: lastAdded };
    const checkResponse = await callJev(
      config,
      buildPayload(config, checkState, { check_last_added: buildCheckQuestion() }),
    );
    const checkAnswer = readAnswer(checkResponse, 'check_last_added');
    const check = readCheckValue(checkAnswer);

    if (check.value === null) {
      await emit({
        type: 'check',
        round,
        item: lastAdded,
        value: null,
        kind: null,
        kept: true,
        cart: [...cart],
      });
      continue;
    }

    const kept = check.value >= NOUL_THRESHOLD;
    if (kept) {
      await emit({
        type: 'check',
        round,
        item: lastAdded,
        value: check.value,
        kind: check.kind,
        threshold: NOUL_THRESHOLD,
        kept: true,
        cart: [...cart],
      });
      continue;
    }

    cart.pop();
    const times = (rejectedCounts.get(lastAdded) ?? 0) + 1;
    rejectedCounts.set(lastAdded, times);
    await emit({
      type: 'check',
      round,
      item: lastAdded,
      value: check.value,
      kind: check.kind,
      threshold: NOUL_THRESHOLD,
      kept: false,
      cart: [...cart],
      menu: menuNames(),
    });

    if (times >= 2) {
      await emit({ type: 'stop', reason: 'reject_streak', item: lastAdded });
      finished = true;
      break;
    }
  }

  if (!finished) stoppedByLimit = true;

  const summary = {
    type: 'final',
    cart: [...cart],
    items: summarizeCart(cart),
    total: cart.length,
    stoppedByLimit,
    menu: menuNames(),
  };
  await emit(summary);
  return summary;
}
