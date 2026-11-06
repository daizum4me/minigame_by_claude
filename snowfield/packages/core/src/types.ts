export type ItemKey = 'wood' | 'stone' | 'veg' | 'meat' | 'snow' | 'sapling';
export const ITEM_ORDER: ItemKey[] = ['wood', 'stone', 'veg', 'meat', 'snow', 'sapling'];
export type Items = Record<ItemKey, number>;

export type BuildingType = 'fire' | 'road' | 'igloo' | 'storage' | 'tower';
export type BuildableType = Exclude<BuildingType, 'fire'>;
export type Weather = 'clear' | 'snow' | 'blizzard' | 'rain' | 'final';
export type ResourceType = 'tree' | 'stone' | 'veg';
export type PlantKind = 'veg' | 'tree';

export interface Player {
  name: string;
  color: string;
  x: number;
  y: number;
  temp: number;
  food: number;
  ap: number;
  /** 行動不能の状態で次の手番を迎える（温まる／食べるだけ可能） */
  incapacitated: boolean;
}

export interface Building {
  id: number;
  t: BuildingType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 道・焚き火は null（壊れない） */
  hp: number | null;
  max: number | null;
}

export interface Resource { id: number; t: ResourceType; x: number; y: number; hp: number }
export interface Animal { id: number; x: number; y: number; hp: number }
export interface Plant { id: number; t: PlantKind; x: number; y: number; growIn: number }

export interface Vote {
  item: ItemKey;
  /** プレイヤーごと 1=賛成 / -1=反対 / 0=未投票 */
  votes: number[];
}

/** お絵かき：1×1マス単位。各マスはワールド座標の線分を持つ（マス境界でクリップ済み） */
export interface Seg { x0: number; y0: number; x1: number; y1: number; c: string }
export type Drawing = Record<string, Seg[]>;

export type Phase = 'playing' | 'won' | 'lost';

export interface GameState {
  config: GameConfig;
  phase: Phase;
  /** 1始まり。prepRounds までが準備期間、その後が最終猛吹雪 */
  round: number;
  turn: number;
  weather: Weather;
  /** 次ラウンドの天候（見張り台で見える） */
  nextWeather: Weather | null;
  fire: number;
  items: Items;
  players: Player[];
  buildings: Building[];
  resources: Resource[];
  animals: Animal[];
  plants: Plant[];
  vote: Vote | null;
  drawing: Drawing;
  nextId: number;
  /** 乱数状態（mulberry32） */
  rng: number;
  endReason?: string;
}

export interface GameConfig {
  cols: number;
  rows: number;
  /** 【未確定】プレイヤー人数の範囲 */
  minPlayers: number;
  maxPlayers: number;
  prepRounds: number;
  finalRounds: number;
  maxTemp: number;
  maxFood: number;
  apPerTurn: number;
  foodPerTurn: number;
  maxFire: number;
  initialFire: number;
  /** 【未確定】開始時の共有アイテム */
  initialItems: Partial<Items>;
  /** 【未確定】準備期間の天候抽選の重み（final=ランダム猛吹雪） */
  weatherWeights: Record<Weather, number>;
  /** 【未確定】猛吹雪中、各手番開始時の建物HP減少量 */
  blizzardBuildingDamage: number;
  /** 【未確定】true: 行動不能の直後の手番で、再び0になったら敗北 */
  loseOnRepeatedIncapacitation: boolean;
  /** 【未確定】苗の成長ラウンド数の範囲（一様乱数） */
  growMin: number;
  growMax: number;
  /** 成長後の資源HPの範囲 */
  grownHpMin: number;
  grownHpMax: number;
  /** 【未確定】動物のHP範囲 */
  animalHpMin: number;
  animalHpMax: number;
  /** 【未確定】焚べられる範囲（焚き火から何マスまで） */
  stokeRange: number;
  /** 【未確定】初期配置：資源数（reachZone=焚き火の2マス以内に必ず置く数、それ以外は radius 以内） */
  initialSpawn: {
    tree: number; stone: number; veg: number; animal: number;
    guaranteedNearFire: number; scatterRadius: number;
  };
  /** 【未確定】お絵かきの色（資料は青・灰の2色） */
  penColors: string[];
}
