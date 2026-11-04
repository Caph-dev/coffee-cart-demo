/**
 * 固定菜单。抹茶（matcha）故意不在菜单里，用来测试 check 环节能否把菜单外商品踢掉。
 */
export const MENU = [
  {
    id: 'americano',
    name: '美式',
    aliases: ['美式咖啡', 'americano'],
    desc: '美式咖啡，浓缩咖啡加热水，可选热或冰',
  },
  {
    id: 'latte',
    name: '拿铁',
    aliases: ['拿铁咖啡', 'latte'],
    desc: '拿铁咖啡，浓缩咖啡加牛奶，可选热或冰',
  },
  {
    id: 'oat_latte',
    name: '燕麦拿铁',
    aliases: ['燕麦奶拿铁', 'oat latte', 'oat_latte'],
    desc: '燕麦拿铁，浓缩咖啡加燕麦奶，可选热或冰',
  },
  {
    id: 'cappuccino',
    name: '卡布奇诺',
    aliases: ['cappuccino'],
    desc: '卡布奇诺，浓缩咖啡、牛奶与奶泡',
  },
  {
    id: 'hot_chocolate',
    name: '热巧克力',
    aliases: ['热巧', 'hot chocolate', 'hot_chocolate'],
    desc: '热巧克力，可可饮品，不含咖啡',
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

function normalize(value) {
  return String(value).trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * 把 Jev choice 的返回值解析成菜单项。
 * 先精确匹配 id / 名称 / 别名，再做包含匹配，容忍模型返回 "oat_latte（燕麦拿铁）"。
 * 返回 null 表示不在菜单内。
 */
export function findMenuChoice(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const v = normalize(value);
  if (v === 'done') return { id: 'done', name: 'done' };

  const keys = (item) => [item.id, item.name, ...item.aliases].map(normalize);
  const exact = MENU.find((item) => keys(item).includes(v));
  if (exact) return exact;

  return (
    MENU.find((item) => keys(item).some((key) => v.includes(key) || key.includes(v))) ?? null
  );
}
