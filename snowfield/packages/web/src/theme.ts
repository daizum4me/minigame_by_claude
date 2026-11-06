/* 色の定義。プロトタイプ（prototype.dc.html）の値をそのまま使用。フラットな vars は CSS 変数として出力する */
export interface Theme {
  vars: Record<string, string>; road: string; roadBd: string; hpTrack: string; hpOk: string; hpLow: string; penA: string; penB: string; pA?: string;
  temp: string; tempLow: string; food: string; foodLow: string; redFg: string; ok: string; ng: string;
  card: Record<string, string[]>; chip: Record<string, string[]>; fireOn: string; fireOff: string;
  res: Record<string, string[]>; item: Record<string, string[]>; tint: Record<string, string>; flake: string; rain: string;
}
export const LIGHT: Theme = {
  vars: { bg: '#e9eff4', panel: '#ffffff', pb: '#d3dee7', text: '#24323f', muted: '#5d6f7e', muted2: '#44525e', chip: '#eef3f7', tile: '#f8fafc', reach: '#e8f1f7', grid: '#dbe5ed', mb: '#c3d1dc', accent: '#2f6fb5', accBg: '#dbe9f6', accFg: '#1d4f86', btn: '#ffffff', bb: '#c9d6e0', btn2: '#f7fafc', track: '#dfe8ef', ap: '#2f6fb5', menu: 'rgba(255,255,255,0.72)', menuBtn: 'rgba(255,255,255,0.6)', menuB: 'rgba(36,50,63,0.22)', shadow: '0 8px 24px rgba(36,50,63,0.22)', redFg: '#8f261e', redBg: '#fbe0dd', grnBg: '#dcf0e4', grnFg: '#1d5a3a', orgBg: '#ffe9d6', orgFg: '#8a3a0e' },
  road: '#c3cfd8', roadBd: '#8497a8', hpTrack: 'rgba(36,50,63,.16)', hpOk: '#3c8f66', hpLow: '#c0463b', penA: '#2d5b88', penB: '#8a97a3', pA: '#2d5b88',
  temp: '#4a90c8', tempLow: '#c0463b', food: '#e0a030', foodLow: '#c0463b', redFg: '#a8312a', ok: '#2f9a6a', ng: '#c0463b',
  card: { fire: ['#fff1e4', '#e9722f', '#5c2a0c'], igloo: ['#e6f0f8', '#8fb2cf', '#24323f'], storage: ['#e7eaee', '#8a97a5', '#24323f'], tower: ['#eef0e6', '#9aa684', '#33402a'], off: ['#eceff1', '#b7c0c8', '#5d6f7e'] },
  chip: { ok: ['#dcf0e4', '#1d5a3a'], lost: ['#fbe0dd', '#8f261e'], fire: ['#ffe0c8', '#8a3a0e'] },
  fireOn: '#e9722f', fireOff: '#f3d9c6',
  res: { tree: ['#e3f1e8', '#3c8f66', '#2c6e4c'], stone: ['#e9edf1', '#7d8b97', '#55626d'], veg: ['#fdeccf', '#d98a2b', '#8a520f'], animal: ['#f6e4da', '#b4694a', '#7c4128'], plant: ['#eef7e4', '#7aa84a', '#4a7a22'] },
  item: { wood: ['#f3e8dc', '#8a5a2b'], stone: ['#e9edf1', '#55626d'], veg: ['#fdeccf', '#8a520f'], meat: ['#f8e1dc', '#9b3a2e'], snow: ['#e1eefa', '#2f6fb5'], sapling: ['#e3f1e8', '#2c6e4c'] },
  tint: { clear: 'rgba(255,236,190,0.10)', snow: 'rgba(120,150,185,0.10)', blizzard: 'rgba(120,150,185,0.22)', rain: 'rgba(70,105,150,0.18)', final: 'rgba(55,85,130,0.34)' },
  flake: '#7fa3c2', rain: '#4b79a8'
};
export const DARK: Theme = {
  vars: { bg: '#0f1620', panel: '#17212d', pb: '#2b3a4a', text: '#e6edf3', muted: '#9fb0bf', muted2: '#b7c5d1', chip: '#223142', tile: '#121b26', reach: '#1b2a3b', grid: '#25364a', mb: '#35485c', accent: '#5aa0e6', accBg: '#1f3a57', accFg: '#a9d0f7', btn: '#1d2a38', bb: '#35485c', btn2: '#1b2733', track: '#2a3a4b', ap: '#5aa0e6', menu: 'rgba(20,30,42,0.72)', menuBtn: 'rgba(255,255,255,0.09)', menuB: 'rgba(180,205,230,0.28)', shadow: '0 8px 28px rgba(0,0,0,0.5)', redFg: '#ff9a90', redBg: '#4a2224', grnBg: '#1c3d2e', grnFg: '#8fe0b3', orgBg: '#4a2f1a', orgFg: '#ffc9a0' },
  road: '#3a4958', roadBd: '#7089a0', hpTrack: 'rgba(255,255,255,.16)', hpOk: '#4fb27f', hpLow: '#ff6b5e', penA: '#7fb4e8', penB: '#9fb0bf',
  temp: '#5aaee8', tempLow: '#ff6b5e', food: '#f0b94a', foodLow: '#ff6b5e', redFg: '#ff9a90', ok: '#4fb27f', ng: '#ff6b5e',
  card: { fire: ['#3a2314', '#e9722f', '#ffd9bd'], igloo: ['#1b2e42', '#4a7aa6', '#dbe9f6'], storage: ['#252e39', '#6f7f90', '#e6edf3'], tower: ['#2a3220', '#7c8a5f', '#dfe8cf'], off: ['#1f2730', '#4a5663', '#8d9dab'] },
  chip: { ok: ['#1c3d2e', '#8fe0b3'], lost: ['#4a2224', '#ffab9f'], fire: ['#4a2f1a', '#ffc9a0'] },
  fireOn: '#f08a4b', fireOff: '#4a3526',
  res: { tree: ['#1a3326', '#4fb27f', '#8fe0b3'], stone: ['#252e37', '#8696a5', '#c2cfda'], veg: ['#3a2b14', '#e0a040', '#ffd08a'], animal: ['#3a2619', '#d08a66', '#f1c0a6'], plant: ['#24331a', '#8cc25a', '#c4e89a'] },
  item: { wood: ['#3a2c1e', '#e0b27a'], stone: ['#2a323b', '#b7c4cf'], veg: ['#3a2b14', '#ffd08a'], meat: ['#3d2220', '#f2a89c'], snow: ['#1a2e44', '#8ec3f5'], sapling: ['#1a3326', '#8fe0b3'] },
  tint: { clear: 'rgba(0,0,0,0)', snow: 'rgba(150,185,225,0.07)', blizzard: 'rgba(170,200,235,0.16)', rain: 'rgba(40,80,140,0.22)', final: 'rgba(190,215,245,0.26)' },
  flake: '#b8d4ee', rain: '#6f9fd0'
};
