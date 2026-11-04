/**
 * 固定菜单。抹茶故意不在菜单里。
 * 相近名称（抹茶拿铁、香草拿铁）不是菜单项，也不能收成拿铁。
 * 冷热只加在标明 temperature 的咖啡上。客人没说时，店规默认冰，由购物车在归类之后落单。
 * 热巧克力只卖热的，不再单问冷热，也不套用默认冰。
 * Choice 仍可答 unspecified；这里的默认不写进归类提示，避免模型替客人改成 iced。
 */
export const DEFAULT_TEMPERATURE = 'iced';

export const MENU = [
  {
    id: 'americano',
    name: '美式',
    aliases: ['美式咖啡', 'americano'],
    desc: '美式咖啡，浓缩咖啡加热水，可选热或冰',
    temperature: true,
  },
  {
    id: 'latte',
    name: '拿铁',
    aliases: ['拿铁咖啡', 'latte'],
    desc: '拿铁咖啡，浓缩咖啡加牛奶，可选热或冰',
    temperature: true,
    not: ['抹茶拿铁', '绿色抹茶拿铁', '香草拿铁', '焦糖拿铁', '燕麦拿铁'],
  },
  {
    id: 'oat_latte',
    name: '燕麦拿铁',
    aliases: ['燕麦奶拿铁', 'oat latte', 'oat_latte'],
    desc: '燕麦拿铁，浓缩咖啡加燕麦奶，可选热或冰',
    temperature: true,
    not: ['拿铁', '抹茶拿铁', '香草拿铁'],
  },
  {
    id: 'cappuccino',
    name: '卡布奇诺',
    aliases: ['cappuccino'],
    desc: '卡布奇诺，浓缩咖啡、牛奶与奶泡，可选热或冰',
    temperature: true,
  },
  {
    id: 'hot_chocolate',
    name: '热巧克力',
    aliases: ['热巧', 'hot chocolate', 'hot_chocolate'],
    desc: '热巧克力，只做热的可可饮品，不含咖啡，不能点成冰的',
    not: ['冰巧克力', '冰可可', '冰的热巧克力'],
  },
  {
    id: 'muffin',
    name: '麦芬',
    aliases: ['马芬', 'muffin'],
    desc: '麦芬蛋糕，烘焙点心',
  },
  {
    id: 'scone',
    name: '司康',
    aliases: ['scone'],
    desc: '司康，烘焙点心',
  },
];

/** 菜单名列表，用于提示和日志。 */
export function menuNames() {
  return MENU.map((item) => item.name);
}

/**
 * Choice 可以回这些词，表示剩下的在售每一件各来一份。
 * 只做整段相等，不扫用户原文。宫保鸡丁、抹茶不在这里。
 */
export const EVERYTHING_CHOICES = [
  'all',
  'everything',
  'one of each',
  'one of everything',
  'all of them',
  'everything on the menu',
  '所有的都来一份',
  '全部来一份',
  '每样一份',
  '每样来一份',
  '每样都来一份',
  '一样来一个',
  '菜单上每样都来一份',
];

function normalize(value) {
  return String(value).trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * 把模型返回的 choice 收成菜单项。
 * 只接受 id / 名称 / 别名的整段相等，或括号里每一段都指向同一件
 * （例如 oat_latte（燕麦拿铁））。
 * 不做子串包含：抹茶拿铁里的「拿铁」不能收成拿铁。
 * 返回 null 表示不在菜单内。
 */
export function findMenuChoice(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const whole = normalize(value);
  if (whole === 'done' || whole === 'nothingelse') return { id: 'done', name: 'done' };
  if (EVERYTHING_CHOICES.some((token) => normalize(token) === whole)) {
    return { id: 'all', name: 'all' };
  }

  const keys = (item) => [item.id, item.name, ...item.aliases].map(normalize);
  const exact = MENU.find((item) => keys(item).includes(whole));
  if (exact) return exact;

  const tokens = value
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => normalize(token))
    .filter(Boolean);
  if (tokens.length < 2) return null;

  const hits = tokens.map((token) => MENU.find((item) => keys(item).includes(token)) ?? null);
  if (hits.some((item) => item == null)) return null;
  const ids = new Set(hits.map((item) => item.id));
  if (ids.size !== 1) return null;
  return hits[0];
}
