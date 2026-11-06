import type { ReactNode } from 'react';

/** 線画アイコン（線の太さ 2.6 を維持）。形はプロトタイプのもの */
const P: Record<string, ReactNode> = {
  fire: <path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.2 1-3.6 2.4-5 .2 1.8 1 2.6 2 2.6C11.4 8.6 11 6 12 3z" />,
  igloo: <><path d="M3 19a9 9 0 0 1 18 0z" /><path d="M10 19v-3a2 2 0 0 1 4 0v3" /></>,
  storage: <><path d="M3 10l9-6 9 6v10H3z" /><path d="M9 20v-6h6v6" /></>,
  tower: <><path d="M8 21l2-12h4l2 12" /><path d="M7 9h10l-1-4H8z" /><path d="M9 15h6" /></>,
  tree: <><path d="M12 3l6 9h-3l4 6H5l4-6H6z" /><path d="M12 18v3" /></>,
  stone: <path d="M4 18l3-9 6-4 6 6 2 7z" />,
  veg: <><path d="M12 21c-4-3-5-8-2-12 3 1 5 3 5 6 0 2-1 4-3 6z" /><path d="M10 9c0-3 2-5 4-6" /></>,
  animal: <><ellipse cx="11" cy="15" rx="6" ry="4.5" /><circle cx="17" cy="9" r="2.6" /><path d="M16 6.5l1-3M18.5 7l2-2" /></>,
  plant: <><path d="M12 21v-9" /><path d="M12 12c0-4-3-6-7-6 0 4 3 6 7 6z" /><path d="M12 14c0-3 2-5 6-5 0 3-2 5-6 5z" /></>,
  // アイテム
  wood: <><rect x="3" y="8" width="18" height="9" rx="2" /><ellipse cx="18" cy="12.5" rx="1.6" ry="2.4" /><path d="M7 10.5h6" /></>,
  istone: <><path d="M4 9l8-4 8 4v7l-8 4-8-4z" /><path d="M4 9l8 4 8-4M12 13v7" /></>,
  meat: <><path d="M5 14c0-5 4-9 9-9a5 5 0 0 1 5 5c0 5-4 9-9 9-3 0-5-2-5-5z" /><path d="M8.5 15.5L4 20M4 20l-1.5-.5M4 20l.5-1.5" /></>,
  snow: <><path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9" /><path d="M9.5 4.8L12 6.5l2.5-1.7M9.5 19.2L12 17.5l2.5 1.7" /></>,
  sapling: <><path d="M12 21v-9" /><path d="M12 12l-4-3M12 15l4-3" /><circle cx="8" cy="7.5" r="2.5" /><circle cx="16" cy="9" r="2.5" /><circle cx="12" cy="5" r="2.5" /></>,
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  // アイテムの「石材」は資源の石と形が違う
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{P[name]}</svg>
  );
}

export const itemIcon = (k: string) => (k === 'stone' ? 'istone' : k);
