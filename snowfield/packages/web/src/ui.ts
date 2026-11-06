import { BUILDING_DEFS, ITEM_LABEL, type Building, type GameState, type ItemKey } from '@snowfield/core';

export const T = 52;

export const costText = (t: keyof typeof BUILDING_DEFS) => {
  const d = BUILDING_DEFS[t];
  return '行動力' + d.ap + '・' + (Object.entries(d.cost) as Array<[ItemKey, number]>).map(([k, n]) => ITEM_LABEL[k] + n).join(' ');
};

/** 説明文は、その要素に固有の内容だけにする */
export const DESC: Record<string, { name: string; tip: string; desc: string; eff: string[]; build: string; repair: string }> = {
  fire: {
    name: '焚き火', tip: '上で温まると火力ぶん回復。薪を焚べると火力+1。',
    desc: '唯一の本格的な暖房。上に立って「温まる」と、火力の値だけ体温が回復する。',
    eff: ['焚き火の上の体温低下は 0＋天候補正（軽減なし）', '温まる：行動力2、火力の値だけ体温回復', '焚べる：行動力1＋木材1 → 火力+1（最大5）'],
    build: '最初からある', repair: '壊れない',
  },
  road: {
    name: '道', tip: '雪1個で作れる最小の建物。建物同士をつなぐ。',
    desc: '雪1個で作れる最小の建物。置くと建物同士がつながる通路になる。',
    eff: ['隣り合う道は一つにつながって表示される'], build: costText('road'), repair: '壊れない',
  },
  igloo: {
    name: 'かまくら', tip: '防寒施設。中では体温低下が軽くなる。', desc: '雪で作る防寒施設。',
    eff: ['体温低下 -1＋天候補正（補正は最大2まで軽減）', '温まる回復量 +1'], build: costText('igloo'), repair: '行動力2＋石材1 → HP+2',
  },
  storage: {
    name: '倉庫', tip: '防寒施設。共有アイテムの上限が+10される。', desc: '大きな防寒施設。',
    eff: ['共有アイテムの上限 +10', '防寒効果はかまくらと同じ'], build: costText('storage'), repair: '行動力4＋石材1 → HP+2',
  },
  tower: {
    name: '見張り台', tip: '建てると1ラウンド先の天候予報が見える。', desc: '高い場所から先を見渡す。',
    eff: ['1ラウンド先の天候の予報が見える'], build: costText('tower'), repair: '行動力2＋石材1 → HP+2',
  },
};

export const IDESC: Record<ItemKey, string> = {
  wood: '焚き火に焚べると火力+1。倉庫・見張り台の建設に使う。',
  stone: '建物の修理に使う（1個でHP+2）。倉庫・見張り台の建設に使う。',
  veg: '食べると満腹度+2。2個で野菜の苗を植えられる。',
  meat: '食べると満腹度+3。',
  snow: 'かまくら・道の建設に使う。雪原で資源を集めると1個ついてくる。',
  sapling: '植えると樹木の苗になる。木を集めたとき50%で落ちる。',
};

export const WEATHER_FX = {
  clear: '補正なし', snow: '体温低下 +1', blizzard: '体温低下 +2', rain: '焚き火の火力低下 +1', final: '体温低下 +4・建物HP減少',
} as const;

export const isWarm = (b: Building) => b.t === 'igloo' || b.t === 'storage';

export function phaseLabel(g: GameState): { round: string; until: string | null } {
  const c = g.config;
  if (g.round <= c.prepRounds) {
    return { round: `ラウンド ${g.round} / ${c.prepRounds}（準備期間）`, until: `最終猛吹雪まで あと${c.prepRounds - g.round + 1}ラウンド` };
  }
  return { round: `最終猛吹雪 ${g.round - c.prepRounds} / ${c.finalRounds}`, until: null };
}
