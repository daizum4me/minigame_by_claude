/*
 * Snowfield — ルール説明（項目ごとのページ）とチュートリアル
 * ルールの数値は engine の RULES / BUILD から作るので、ルールを調整しても説明がずれない。
 * チュートリアルは、CPU 2人と同じ部屋で、実際に操作しながら進む（その場で状態を整えて、操作できたかを見て次へ進む）。
 */
(function () {
  'use strict';

  const E = window.SnowEngine, B = window.SnowBoard, R = E.RULES, N = E.ITEM_NAMES;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------- 部品 ----------
  const costStr = c => Object.keys(c).map(k => N[k] + c[k]).join('＋');
  const ic = (name, size) => `<span class="gi">${B.svgIcon(name, size || 18)}</span>`;
  const ii = k => ic(B.ITEM_ICON[k], 16);                       // アイテムの絵
  const withIc = (name, text, size) => `${ic(name, size)}${text}`;
  const table = (head, rows) => `<table class="gt"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const ul = items => `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
  const note = t => `<div class="gnote">${t}</div>`;
  const W = E.WEATHER_NAMES, wsum = Object.keys(R.weights).reduce((s, k) => s + R.weights[k], 0);
  const wi = { clear: 'sun', snow: 'snow', blizzard: 'blizzard', rain: 'rain', storm: 'storm' };
  const rw = R.resWeights, rsum = rw.tree + rw.stone + rw.veg;
  const fireSizes = [3, 4, 5].map(n => `${n}人＝${E.fireSize(n)}×${E.fireSize(n)}`).join('、') + `。${R.twoFiresFrom}人以上は焚き火が<b>2つ</b>になり（16人なら8人ずつ＝${E.fireSize(8)}×${E.fireSize(8)}）、プレイヤーが分かれて始まります`;

  // ---------- ルールのページ ----------
  const PAGES = [
    { id: 'goal', icon: 'flag', title: 'ゲームの目的', html: () => `
      <p>雪の極寒世界で、みんなで資源を集め、寒さと空腹をしのいで生き延びる<b>協力型</b>のゲームです（${R.minPlayers}〜${R.maxPlayers}人）。</p>
      ${table(['', '内容'], [
        [withIc('flag', '<b>クリア</b>'), `準備期間 <b>${R.prepRounds}ラウンド</b> → 最終猛吹雪 <b>${R.finalRounds}ラウンド</b>（合計${E.totalRoundsOf(3)}ラウンド。人数によらず同じ）を生き延びる`],
        [withIc('temp', '<b>ゲームオーバー</b>'), `<b>全員が同時に</b>行動不能になる（ひとりでも動けるあいだは続きます）。${R.downFrom}人以上では、行動不能の人が<b>${Math.round(R.downLoseRatio * 100)}%以上</b>（最低2人）になると負けです`],
        [withIc('fire', '<b>ゲームオーバー</b>'), `<b>すべての焚き火が消えたまま</b>（火力0でラウンドが終わる）が<b>${R.fireOutLimit}ラウンド連続</b>で続く。どれかの焚き火が点いた状態でラウンドが終われば、数え直しです`],
      ])}
      <p>最終猛吹雪が来ることは、最初からわかっています。準備期間のうちに、食料と薪を貯め、体を温める仕組みを作っておきましょう。</p>
      <h4>はじまりの状態</h4>
      ${ul([withIc('fire', `真ん中に<b>焚き火</b>があり、人数が多いほど大きくなります（${fireSizes}）。全員が焚き火の上から始まります`), withIc('veg', `人数ぶんの野菜と薪、雪（${R.startSnow}個。人数の半分のほうが多ければ、その数）が配られます`)])}
      <h4>画面の見方</h4>
      ${ul([
        withIc('people', '<b>左</b>：プレイヤーの一覧（体温・満腹度。自分は行動力も。大人数のときは、ほかの人は1行に詰めて表示）。行動中は「このまま手番を終えると」の予測。下に、建設カードやレシピの一覧'),
        withIc('move', '<b>中央</b>：マップ（ドラッグで視点移動・ホイールで拡大縮小）。自分の駒をクリックすると行動のメニュー'),
        withIc('wood', '<b>右</b>：共有アイテム、最終猛吹雪に必要な食料、建物の詳細、お絵かき'),
        withIc('clock', '<b>上のバー</b>：ラウンド、天候、手番の人（同時に動くときは、終えた人数）と残り時間、手番（行動）を終えるボタン'),
      ])}` },

    { id: 'turn', icon: 'clock', title: '手番とラウンド', html: () => `
      <p>ゲームは<b>ラウンド</b>で進みます。天候の決定・作物の成長・猛吹雪の建物のダメージ・焚き火の火力の低下は、ラウンドごとに行われます。ロビーで、動き方を選べます。</p>
      ${table(['動き方', '内容'], [
        [withIc('people', '<b>同時に動く</b>（初期設定）'), `ラウンドの中で、<b>全員が同時に</b>行動します。全員が「行動を終える」を押すか、<b>${R.roundLimitMs / 1000}秒</b>の制限時間が切れると、ラウンドが終わります`],
        [withIc('clock', '<b>順番に動く</b>'), `1人ずつ手番を行います（人間の手番に${R.turnLimitMs / 1000}秒の制限時間）。全員が1回ずつ手番を行うと、ラウンドが終わります`],
      ])}
      <h4>ラウンドの流れ</h4>
      <ol>
        <li>${ic('bolt')}<b>始め</b>：行動力が${R.maxAp}になります（使い切らなくてOK・持ち越しなし）。猛吹雪のあいだは、建物のHPが${R.stormDmg}減ります。</li>
        <li>${ic('hand')}<b>行動</b>：移動は行動力0。ほかの行動は、それぞれの行動力を使います。</li>
        <li>${ic('clock')}<b>自分の手番（行動）の終わり</b>：${ic('food', 16)}満腹度 −${R.hunger}、${ic('temp', 16)}体温が下がる（場所と天候で決まる）、${ic('bolt', 16)}行動不能の判定。</li>
        <li>${ic('fire', 16)}<b>ラウンドの終わり</b>：焚き火の火力が、<b>その焚き火で始まる人数÷${R.fireDrainDiv}の切り上げ</b>だけ減る（雨ならさらに−1。3人なら−2）。${ic('animal', 16)}動物と${ic('fish', 16)}魚が${R.animalSteps}マスずつ動きます。</li>
      </ol>
      ${note('行動中の左には、「このまま手番を終えると」満腹度・体温・火力がどうなるかが出ます。行動不能になりそうなときや、焚き火が消えたままで敗北に近づくときは、赤く警告します。')}
      <p>${ic('fire')}<b>すべての焚き火が消えたまま</b>（火力0でラウンドが終わる）が<b>${R.fireOutLimit}ラウンド連続</b>で続くと、ゲームオーバーです。上のバーに、いま何回目かが出ます。</p>
      <h4>行動を終えたあと・手番でないとき</h4>
      ${ul([`${ic('move')}「移動」${ic('pencil')}「お絵かき」${ic('check')}「捨てる投票」だけできます（建設・集めるなどは、自分の行動のあいだだけ）`, '雪原に入ると体温が減るのは、同じです'])}
      <h4>制限時間</h4>
      <p>${ic('clock')}人間がいるときは、時間が切れると自動で終わります（CPUだけのときは制限がありません）。</p>` },

    { id: 'stats', icon: 'temp', title: '体温と満腹度', html: () => `
      <p>${ic('temp')}体温と${ic('food')}満腹度は、どちらも<b>最大${R.maxTemp}</b>、最初は${R.maxTemp}です。<b>どちらか0になる</b>と行動不能になります。</p>
      <h4>体温の低下（手番の終わり）</h4>
      <p>「いる場所の基本値」に「天候の補正」を足した分だけ、体温が下がります。</p>
      ${table(['いる場所', '基本値', '天候補正'], [
        [withIc('fire', '焚き火の上'), R.base.fire, '軽減なし'],
        [withIc('storage', '倉庫の中（防寒が有効）'), R.base.warm, `最大${R.relief}まで軽減`],
        [withIc('road', '雪原・道・かまくら・見張り台・作業場・防寒が切れた倉庫'), R.base.out, '軽減なし'],
      ])}
      <h4>夜の寒さ（かまくら）</h4>
      <p>${ic('snow')}準備期間の最初の${R.coldFreeRounds}ラウンドが過ぎたあとは、ラウンドの終わりに、<b>どこにいても、晴れでも、全員の体温がさらに −${R.coldExtra}</b>されます（夜の寒さ）。</p>
      ${ul([`${ic('igloo', 16)}<b>かまくら1個</b>で、<b>${R.iglooCover}人ぶん</b>の夜の寒さを防げます。かまくらの中にいなくても、<b>どこにいても</b>効きます`, '防げる人は、<b>体温が低い人から</b>（同じなら参加順）。枠が足りないときは、体温の低い人が優先です', 'かまくらのHPが半分以下になると、その分は防げなくなります（猛吹雪で壊れやすいので、直しましょう）', `${ic('coat', 16)}防寒着を着ていれば、夜の寒さも合わせて${R.coatRelief}減ります`, `人数ぶんの枠をそろえるには、<b>人数÷${R.iglooCover}の切り上げ</b>個のかまくらが必要です`])}
      <p>例：${ic('storm')}猛吹雪（補正+${R.tempMod.storm}）のとき → 雪原 ${R.base.out}+${R.tempMod.storm}＝<b>${R.base.out + R.tempMod.storm}</b>、焚き火の上 ${R.base.fire}+${R.tempMod.storm}＝<b>${R.base.fire + R.tempMod.storm}</b>、防寒の中 ${R.base.warm}+(${R.tempMod.storm}−${R.relief})＝<b>${R.base.warm + R.tempMod.storm - R.relief}</b></p>
      <h4>回復する</h4>
      ${table(['行動', '行動力', '回復'], [
        [withIc('fire', '温まる'), R.ap.warm, '焚き火の上＝火力の値／防寒が有効な倉庫の中＝+1／それ以外＝0'],
        [withIc('meat', '食べる（肉）'), 0, `満腹度 +${R.eat.meat}`],
        [withIc('fish', '食べる（魚）'), 0, `満腹度 +${R.eat.fish}`],
        [withIc('veg', '食べる（野菜）'), 0, `満腹度 +${R.eat.veg}`],
        [withIc('steak', '食べる（ステーキ）'), 0, `満腹度 +${R.eat.steak}（焚き火で、肉1から作れます）`],
        [withIc('grilled', '食べる（焼き魚）'), 0, `満腹度 +${R.eat.grilled}（焚き火で、魚1から作れます）`],
        [withIc('soup', '食べる（スープ）'), 0, `満腹度 +${R.eat.soup}（焚き火で、野菜2と雪1から3個作れます）`],
      ])}
      <p>${ic('coat')}<b>防寒着</b>を着ると、ラウンド（手番）の終わりの体温の低下が${R.coatRelief}減ります（0より下にはなりません）。</p>
      ${note(`満腹度は毎ラウンド−${R.hunger}です。最終猛吹雪を生き延びるのに必要な食料は、右の「最終猛吹雪を生き延びるのに必要な食料」で確認できます。`)}` },

    { id: 'weather', icon: 'sun', title: '天候', html: () => `
      <p>ラウンドの始めに天候が決まり、そのラウンドのあいだ続きます。${ic('tower')}<b>見張り台</b>を建てると、1ラウンド先の予報が見えます。</p>
      ${table(['天候', '出やすさ', '効果'], [
        [withIc(wi.clear, W.clear), `${R.weights.clear}/${wsum}`, '補正なし'],
        [withIc(wi.snow, W.snow), `${R.weights.snow}/${wsum}`, `体温の低下 +${R.tempMod.snow}`],
        [withIc(wi.blizzard, W.blizzard), `${R.weights.blizzard}/${wsum}`, `体温の低下 +${R.tempMod.blizzard}`],
        [withIc(wi.rain, W.rain), `${R.weights.rain}/${wsum}`, '焚き火の火力が、さらに1下がる（−1が−2に）'],
        [withIc(wi.storm, `<b>${W.storm}</b>`), '最終猛吹雪のみ', `体温の低下 +${R.tempMod.storm}・ラウンドの始めに建物のHPが${R.stormDmg}減る`],
      ])}
      ${ul([`最終猛吹雪（準備期間のあとの最後の数ラウンド）は、必ず${W.storm}です。準備期間に猛吹雪は来ません`, `${ic('fire', 16)}焚き火と道は、猛吹雪でも壊れません`])}` },

    { id: 'move', icon: 'move', title: '移動', html: () => `
      <p>自分の駒をドラッグして、行きたいマスで離します。<b>行動力は0</b>で、手番でないときもできます。</p>
      ${ul([
        `移動できるのは、<b>建物（道を含む）から${R.moveRange}マス以内</b>のマスです。${ic('tower', 16)}<b>見張り台からは${R.towerRange}マス以内</b>です`,
        `${ic('snow', 16)}雪原のマスに<b>入るたび体温 −1</b>。建物・道の上に入るときは減りません（${ic('road', 16)}道を伸ばすと、体温を減らさずに遠くへ行けます）`,
        '動物や、ほかのプレイヤーのいるマスには入れません（資源のマスには入れます）',
        '建物と生物は、同じマスにいられます',
        'ドラッグ中は、移動先のマスが緑（行ける）か赤（行けない）で表示され、体温の減り方も出ます',
      ])}
      <h4>${ic('people')}ほかの駒が道をふさいでいるとき</h4>
      <p>行きたい場所までの道を、ほかの人やCPUの駒がふさいでいて、ドラッグしても行けないときは、<b>どいてもらうようお願い</b>できます（ふさいでいる駒の名前のボタンが出ます。ほかの人の駒を直接クリックしても、お願いできます）。CPUはすぐに道を空けます。人には確認が届き、「場所を空ける」を押すと、自動で近くのマスへ動きます。</p>
      ${note('行動不能のあいだは、移動できません。')}` },

    { id: 'actions', icon: 'hand', title: '基本の行動', html: () => `
      <p>自分の駒をクリックすると、行動のメニューが開きます（手番のみ）。</p>
      ${table(['行動', '行動力', 'できること'], [
        [withIc('fire', '温まる'), R.ap.warm, '体温を回復（焚き火の上は火力ぶん）'],
        [withIc('firewood', '焚べる'), R.ap.stoke, `薪（なければ木材）1個で火力+1（最大は、その焚き火で始まる人数。最低${R.fireMaxMin}）。焚き火の上かすぐ隣で`],
        [withIc('meat', '食べる'), 0, '右の共有アイテム（肉・野菜・ステーキ・スープ）をクリックして「食べる」'],
        [withIc('hand', '集める'), R.ap.collect, '資源のマスで、体力−1につき1個。雪原なら雪も1個'],
        [withIc('sword', '攻撃'), R.ap.attack, `隣のマス（上下左右）の動物の体力−1（弓を着けていれば${R.bowRange}マス以内）`],
        [withIc('sapling', '植える'), R.ap.plant, '雪原の空きマスに、野菜2個→野菜の苗／苗木1個→樹木の苗'],
        [withIc('hammer', '建てる'), '建物による', '左下の「建てる」の建設カードを盤面へ置く（「建物と作る」を参照）'],
        [withIc('steak', '作る'), '1', '焚き火の上かすぐ隣で料理（ステーキ・スープ）。作業場の上かすぐ隣で、薪・防寒着・道具'],
        [withIc('axe', '着ける'), 0, '右の共有アイテムの防寒着・道具をクリックして「着ける」（同じ枠に着けているものがあれば、外すのに行動力1）'],
        [withIc('hand', '外す'), 1, '着けているものを外して、持ち物に戻す'],
        [withIc('wrench', '直す'), '直径ぶん', '建物に隣接して、石材（直径÷2・切り上げ）でHP+2'],
      ])}` },

    { id: 'resources', icon: 'tree', title: '資源・動物・苗', html: () => `
      <h4>資源（丸）</h4>
      <table class="gt"><tbody><tr><td>${ic('tree', 22)}木（木材）</td><td>${ic('stone', 22)}石（石材）</td><td>${ic('veg', 22)}野菜</td></tr><tr><td colspan="3">出る比率は <b>木${rw.tree}：石${rw.stone}：野菜${rw.veg}</b>（生成されたマスの約${Math.round(R.resChance * 100)}%に置かれます）</td></tr></tbody></table>
      ${ul([
        `外側の線の<b>区切り1つが体力1</b>（体力${R.resHpMin}〜${R.resHpMax}）。集めるたびに1減り、0で消えます`,
        `${ic('tree', 16)}木は、なくなるとき${Math.round(R.sapChance * 100)}%で${ic('sapling', 16)}<b>苗木</b>を落とします`,
        `${ic('stone', 16)}<b>石材は再び生えません</b>（建物の材料と修理に使います）`,
      ])}
      <h4>${ic('animal')}動物（丸）</h4>
      ${ul([
        `常に（人数＋少し）体（3人なら${3 + E.animalsExtraOf(3)}体、16人なら${16 + E.animalsExtraOf(16)}体。少人数ほど多めです）。体力${R.animalHpMin}〜${R.animalHpMax}。反撃はしません`,
        `ラウンドの終わりに、ランダムな方向へ${R.animalSteps}マス動きます`,
        `倒すと${ic('meat', 16)}肉が${R.meatMin}〜${R.meatMax}個と、${ic('fur', 16)}毛皮が${R.furMin}〜${R.furMax}個。倒された動物は、別の雪原に新しく現れます`,
      ])}
      <h4>${ic('fish')}川と魚</h4>
      ${ul([
        `マップの端には、ゆるく曲がった太さ${R.riverWidth}マスほどの<b>川</b>（青いマス）が、まっすぐ長く流れています（${R.riverPeriod}マスおきに1本）。雪原ではないので、<b>移動も建設もできません</b>（焚き火の周り${R.riverClear}マスには川はありません）`,
        `${ic('bridge', 16)}<b>橋</b>（木材1）を川にだけ建てると、道と同じように歩けます。橋の上には、ほかの建物を建てて上書きもできます`,
        `川には、常に（人数×${R.fishPerPlayer}）匹の<b>魚</b>がいます。体力${R.fishHpMin}〜${R.fishHpMax}。川の上だけを、ラウンドの終わりに${R.fishSteps}マス動きます`,
        `魚は、${ic('rod', 16)}<b>釣り竿</b>（作業場で、木材1・石材1）を着けると、<b>${R.fishRange}マス以内</b>から攻撃できます。倒すと${ic('fish', 16)}魚が${R.fishMin}〜${R.fishMax}個（食べると満腹度+${R.eat.fish}。焚き火で${ic('grilled', 16)}焼き魚にすると+${R.eat.grilled}）。倒された魚は、別の川に新しく現れます`,
      ])}
      <h4>苗</h4>
      <table class="gt"><tbody><tr><td>${ic('sapling', 22)}<b>木の苗</b>（苗木1個で植える）→ 木になる</td><td>${ic('plant', 22)}<b>野菜の苗</b>（野菜2個で植える）→ 野菜になる</td></tr></tbody></table>
      ${ul([`植えてから<b>${R.growMin}〜${R.growMax}ラウンド後</b>に、資源になります（外側の線の区切り1つが「あと1ラウンド」）`, `育つと、体力${R.resHpMin}〜${R.resHpMax}の資源になります`])}` },

    { id: 'buildings', icon: 'hammer', title: '建物と作る', html: () => {
      const feat = { road: '建物の仲間。移動できる範囲を広げ、体温を減らさず歩ける', bridge: '川にだけ建てられる。道と同じ。橋の上には、ほかの建物を建てられる（上書き）', igloo: '1個で2人ぶんの夜の寒さ（体温-1）を、どこにいても防ぐ（HPが半分以下で消える）', storage: '防寒施設。共有アイテムの上限+10', tower: `屋外。1ラウンド先の天候予報。ここから${R.towerRange}マス以内に移動できる`, workshop: '屋外。上かすぐ隣で「作る」と、薪・防寒着・道具が作れる' };
      const rows = [[withIc('fire', '焚き火'), '人数で変わる', '最初からある', '—', '壊れない', `火力${R.fireInit}から（最大は、そこで始まる人数。最低${R.fireMaxMin}）。上で温まると火力ぶん回復`]];
      Object.keys(E.BUILD).forEach(k => { const d = E.BUILD[k]; rows.push([withIc(k, d.name), `${d.size}×${d.size}`, costStr(d.cost), d.ap, E.isPath(k) ? '壊れない' : d.size * 2, feat[k]]); });
      return `
      <p>建設は、カードを盤面へドラッグして置くか、カードをクリックで選んでマップをクリックして置きます（自分の手番のみ。選んだままなら続けて置けます。Escか右クリックで解除）。</p>
      ${table(['建物', 'サイズ', '材料', '行動力', 'HP', '特徴'], rows)}
      ${ul([
        '<b>既存の建物（道を含む）に隣接する場所</b>にだけ建てられます（道に隣接して、道を伸ばせます）',
        '<b>資源のあるマスにも建てられます</b>（その資源は消えます）。苗のあるマスには建てられません。道の上には建てられます（道は消えます）',
        '建てると、その周囲8マスが新しく生成されます。絵が描かれていたマスの絵は消えます',
        `建物のHPは直径×2。<b>猛吹雪のあいだ、ラウンドの始めにHPが${R.stormDmg}減り</b>、0で壊れます（焚き火と道は壊れません）。${ic('wrench', 16)}「直す」は石材（直径÷2の切り上げ。倉庫は2個）でHP+2`,
      ])}
      <h4>${ic('workshop')}作る</h4>
      <p>レシピの一覧は、次の「料理と装備」のページにあります。</p>
      ${note('「建てる」「作る」は、左下のボタンで切り替えます（一覧は、建てても閉じません）。カードやレシピにカーソルを合わせると、材料と説明が出ます。')}`;
    } },

    { id: 'gear', icon: 'axe', title: '料理と装備', html: () => {
      const rows = Object.keys(E.RECIPES).map(k => {
        const rc = E.RECIPES[k], g = rc.gear ? E.GEAR[rc.gear] : null;
        const out = g ? withIc(rc.gear, g.name) : Object.keys(rc.out).map(o => `${ii(o)}${N[o]}${rc.out[o]}`).join('・');
        return [E.STATION_NAMES[rc.station], Object.keys(rc.in).map(i => `${ii(i)}${N[i]}${rc.in[i]}`).join('・'), out, rc.ap, g ? g.desc + (g.slot === 'tool' ? `（耐久度${R.toolDur}）` : '') : ({ steak: `食べると満腹度 +${R.eat.steak}`, grilled: `食べると満腹度 +${R.eat.grilled}`, soup: `食べると満腹度 +${R.eat.soup}`, firewood: '焚べるとき、木材より先に使う' })[k]];
      });
      return `
      <p>「作る」は、焚き火か作業場の<b>上かすぐ隣</b>にいるときに、行動力1でできます（駒をクリック →「作る」→ 左の一覧）。</p>
      ${table(['場所', '材料', 'できるもの', '行動力', '効果'], rows)}
      <h4>${ic('coat')}装備と${ic('axe')}道具</h4>
      ${ul([
        '作った防寒着・道具は、まず<b>みんなの持ち物</b>に入ります（上限に数えます）。駒をクリック →「着ける」で、自分が着けます',
        '枠は<b>装備（防寒着）1つ</b>と<b>道具1つ</b>。着けるのは<b>行動力0</b>、外すのは<b>行動力1</b>（外したものは持ち物に戻ります）。同じ枠に着けているものがあるときは、入れ替えで外す行動力1がかかります',
        `${ic('axe', 16)}斧・${ic('pick', 16)}ツルハシ・${ic('shovel', 16)}シャベルは、それぞれ木・石・野菜を「集める」とき、体力が1余計に減る代わりに、<b>得る量も+1</b>。${ic('spear', 16)}槍は動物への攻撃力+1。${ic('bow', 16)}弓は、<b>${R.bowRange}マス以内</b>（縦横斜め）の動物を攻撃できます（攻撃力は素手と同じ）`,
        `道具は使うたびに耐久度が1減り、0で壊れます（耐久度${R.toolDur}）。防寒着は壊れません`,
        '防寒着は、手番の終わりの体温の低下が1減ります（焚き火の上で、もともと0のときは変わりません）',
      ])}
      ${note('動物を倒すと毛皮が手に入ります。毛皮は、防寒着（3個）と道具（1個）の材料です。')}`;
    } },

    { id: 'items', icon: 'wood', title: '共有アイテム', html: () => `
      <p>${['wood', 'firewood', 'stone', 'veg', 'meat', 'fish', 'fur', 'steak', 'grilled', 'soup', 'snow', 'sapling'].map(k => `${ii(k)}${N[k]}`).join('　')}と、作った防寒着・道具は、<b>全員で共有</b>します（着けるまでは、持ち物として上限に数えます）。</p>
      ${ul([
        `所持上限は <b>2×人数＋${R.capBase}＋${R.capPerStorage}×倉庫の数</b>（苗木も上限に含みます）`,
        `ゲーム開始時に、人数ぶんの野菜と薪、雪${R.startSnow}個が配られます`,
      ])}
      <h4>上限を超えたとき</h4>
      <p>集める・動物を倒す・苗木を落とすで、上限を超える分が出たら、本人が選びます。</p>
      ${ul(['持っている物を捨てて入れ替える（種類と個数を選べます）', '新しく得た物を捨てる', `${ic('snow', 16)}雪（雪原で集めると付いてくる分）も、入らなければ同じように選びます（自動では捨てません）`])}
      <h4>${ic('check')}捨てる投票</h4>
      <p>右の共有アイテムのアイコンをクリックすると、その物を1個捨てる投票が始まります。全員が賛成／反対を投票し、<b>過半数の賛成</b>で捨てます（反対が半数以上で否決）。手番に関係なくでき、切断中の人は反対として数えます。</p>` },

    { id: 'down', icon: 'snow', title: '行動不能とゲームオーバー', html: () => `
      <p>手番の終わりの処理のあとで、${ic('temp', 16)}体温か${ic('food', 16)}満腹度が<b>0</b>になると、行動不能になります。</p>
      ${ul([
        `${ic('fire', 16)}<b>焚き火へ強制的に移動</b>し、0だった数値が<b>${R.recoverTo}</b>に回復します（両方0なら両方）`,
        '行動不能のあいだは、移動できません',
        '<b>次の自分の手番</b>は「温まる」「食べる」だけできます。その次の手番から、ふつうに行動できます',
        '手番はスキップされません（復帰の手番になります）',
      ])}
      <p><b>全員が同時に行動不能</b>になると、ゲームオーバーです。</p>
      ${note('復帰した手番の終わりに、また体温か満腹度が0になると、もう一度行動不能になります。食べる・温まるを先に済ませましょう。')}` },

    { id: 'ui', icon: 'pencil', title: '画面の操作・お絵かき', html: () => `
      ${table(['やりたいこと', '操作'], [
        [withIc('eye', '視点を動かす'), 'マップの背景をドラッグ'],
        [withIc('eye', '拡大・縮小'), 'ホイール、または右上の＋−ボタン（「リセット」で元に戻す）'],
        [withIc('move', '移動'), '自分の駒をドラッグ'],
        [withIc('hand', '行動'), '自分の駒をクリック → メニュー'],
        [withIc('hammer', '建設'), '左下の「建てる」→ カードをドラッグ、またはクリックで選んでマップをクリック'],
        [withIc('workshop', '作る'), '左下の「作る」→ レシピをクリック（焚き火か作業場のそばで）'],
        [withIc('igloo', '建物の説明'), '建物をクリック（右に詳細）。カーソルを合わせても説明が出ます'],
        [withIc('meat', '食べる・着ける・捨てる投票'), '右の共有アイテムのアイコンをクリック → 出てくるボタンから選ぶ'],
        [withIc('clock', '手番を終える'), '上のバーのボタン'],
      ])}
      <h4>${ic('pencil')}お絵かき</h4>
      <p>ゲームの効果はない、飾りです。<b>手番でないとき</b>に、右の「お絵かきモード」で、生成済みの雪原に描けます。ペン・消しゴムと、青／灰の2色があり、ほかの人の絵も同時に編集できます。建物や道が建ったマスの絵は消えます。</p>
      <h4>その他</h4>
      ${ul(['上のバーの「テーマ」でライト／ダーク、「音」で効果音のON／OFF', '「ログ」で、最近の出来事の一覧を見られます'])}` },

    { id: 'online', icon: 'people', title: 'オンライン・CPU', html: () => `
      ${ul([
        `${ic('people', 16)}人数は<b>${R.minPlayers}〜${R.maxPlayers}人</b>。足りないときは、ロビーでCPUを足せます`,
        '<b>部屋を作る</b>と、部屋IDと招待URLが出ます。ほかの人は、URLを開くか、部屋IDを入れて参加します',
        'ゲームは、部屋を作った人（ホスト）のブラウザで進みます。<b>ホストはゲーム中にページを閉じたり再読み込みしたりしないでください</b>（部屋が終わります）',
        'ホスト以外の人は、切断しても、同じブラウザで招待URLを開き直せば戻れます。切断中の手番は自動で終わります',
        '<b>CPUと遊ぶ</b>なら、ひとりで通信なしで遊べます',
        'ロビーで、自分の駒の形（6種）と色（12色）を選べます（色はほかの人と重なれません）',
      ])}` },
  ];

  // ---------- チュートリアル ----------
  function create(ctx) {
    const { app, $ } = ctx;
    let page = 0;

    // ---- ルール ----
    function renderRules() {
      $('#rules-nav').innerHTML = PAGES.map((p, i) => `<button class="${i === page ? 'on' : ''}" data-rpage="${i}">${ic(p.icon, 16)}${i + 1}. ${esc(p.title)}</button>`).join('');
      $('#rules-body').innerHTML = `<h3>${ic(PAGES[page].icon, 24)}${esc(PAGES[page].title)}</h3>` + PAGES[page].html();
      $('#rules-body').scrollTop = 0;
      $('#rules-pos').textContent = `${page + 1} / ${PAGES.length}`;
      $('#rules-prev').disabled = page === 0;
      $('#rules-next').disabled = page === PAGES.length - 1;
    }
    function openRules(id) {
      if (typeof id === 'string') page = Math.max(0, PAGES.findIndex(p => p.id === id));
      renderRules();
      $('#rules').hidden = false;
    }
    $('#rules-nav').addEventListener('click', e => { const b = e.target.closest('[data-rpage]'); if (b) { page = +b.dataset.rpage; renderRules(); } });
    $('#rules-prev').onclick = () => { if (page > 0) { page--; renderRules(); } };
    $('#rules-next').onclick = () => { if (page < PAGES.length - 1) { page++; renderRules(); } };

    // ---- チュートリアル ----
    const T = { active: false, i: -1, snap: null, target: null, advancing: false, raf: 0 };
    const game = () => app.game;
    const me = () => (app.game ? E.pl(app.game, app.me) : null);
    const mine = () => { const g = game(); return g ? g.stats.players[app.me] : null; };
    const room = () => (app.conn && app.conn.room) || null;
    const fireRect = g => { const f = E.fireOf(g); return { x: f.x, y: f.y, w: f.w, h: f.h }; };
    const push = () => { const r = room(); if (r) r.changed(); };
    // 状態を整えるときは、部屋（ホスト）が持つ本物の状態を書き換える（画面に届くのは複製）
    const rg = () => (room() && room().game) || game();

    // 動物・資源・ほかの駒のいない、移動できる空きの雪原（焚き火にいちばん近いもの）
    function freeTile(g) {
      let best = null;
      for (let y = -4; y <= 4; y++) {
        for (let x = -4; x <= 4; x++) {
          if (!E.reach(g, x, y) || E.bAt(g, x, y) || E.resAt(g, x, y) || E.animalAt(g, x, y) || E.playerAt(g, x, y) || E.plantAt(g, x, y)) continue;
          const d = Math.abs(x) + Math.abs(y) + (x >= 2 ? 0 : 3);
          if (!best || d < best.d) best = { x, y, d };
        }
      }
      return best;
    }
    const ensure = (g, k, n) => { if (g.items[k] < n) g.items[k] = n; };
    const refill = g => { const p = E.pl(g, app.me); p.ap = R.maxAp; };

    const STEPS = [
      { title: 'ようこそ', next: true,
        text: () => '実際に操作しながら、基本を覚えましょう。あなたの駒は、焚き火の下にいる駒です（自分の駒には外側にリングが付いています）。<br>左＝プレイヤー、中央＝マップ、右＝共有アイテム。まずは、このまま「次へ」。' },
      { title: '移動する', page: 'move',
        enter(g) { T.target = freeTile(g); const p = E.pl(g, app.me); T.target && (g.res[E.key(T.target.x, T.target.y)] = { t: 'tree', hp: 3, max: 3 }); refill(g); },
        text: () => '自分の駒を<b>ドラッグ</b>して、光っているマス（木）へ動かしましょう。移動は行動力0ですが、<b>雪原に入ると体温が1減ります</b>。移動できるのは、建物から1マス以内です。',
        hl: () => T.target && { x: T.target.x, y: T.target.y, w: 1, h: 1 },
        done: () => T.target && me().x === T.target.x && me().y === T.target.y },
      { title: '資源を集める', page: 'actions',
        enter(g) { refill(g); T.snap = Object.assign({}, mine()); },
        text: () => '木の上で、<b>自分の駒をクリック</b>して、メニューから「集める」を選びましょう（行動力1）。木材が手に入ります。雪原では、雪もおまけで1個付いてきます。',
        done: () => mine().collect > T.snap.collect },
      { title: '焚き火に焚べる', page: 'actions',
        enter(g) { ensure(g, 'wood', 1); g.fire = 2; refill(g); T.snap = Object.assign({}, mine()); push(); },
        text: () => `焚き火は、ラウンドの終わりに、そこで始まる人数÷${R.fireDrainDiv}の切り上げだけ（3人なら−2）減ります。<b>焚き火の上か隣</b>へ移動して、駒をクリック →「焚べる」。薪（なければ木材）1個で、火力が+1されます。`,
        hl: () => fireRect(game()),
        done: () => mine().stoked > T.snap.stoked },
      { title: '温まる', page: 'stats',
        enter(g) { const p = E.pl(g, app.me); p.temp = 5; refill(g); T.snap = Object.assign({}, mine()); push(); },
        text: () => '体温が下がってきました（左の体温の数字）。<b>焚き火の上</b>に立って、「温まる」を選びましょう（行動力2）。回復する量は<b>火力の値</b>です。',
        hl: () => fireRect(game()),
        done: () => mine().warmed > T.snap.warmed },
      { title: '食べる', page: 'stats',
        enter(g) { const p = E.pl(g, app.me); p.food = 5; ensure(g, 'veg', 1); T.snap = Object.assign({}, mine()); push(); },
        text: () => `満腹度は、ラウンドの終わりに−${R.hunger}されます。<b>右の共有アイテムの野菜のアイコンをクリック</b>して、出てくる「食べる」を押しましょう（行動力0）。野菜は満腹度+2、肉は+3（ステーキは+5）です。`,
        done: () => mine().eaten > T.snap.eaten },
      { title: '建てる', page: 'buildings',
        enter(g) { ensure(g, 'snow', 1); refill(g); T.snap = Object.assign({}, mine()); push(); },
        text: () => '左下の<b>「建てる」</b>に、建設カードが並んでいます。<b>道</b>のカードを、<b>焚き火のとなり</b>へドラッグして置きましょう（雪1個）。建物は、既存の建物に隣接する場所にだけ建てられます。道を伸ばすと、体温を減らさずに遠くへ行けます。',
        hl: () => fireRect(game()),
        done: () => mine().built > T.snap.built },
      { title: 'そのほかの建物', next: true, page: 'buildings',
        text: () => 'ほかにも、<b>かまくら</b>（1個で2人ぶんの夜の寒さを防ぐ）、<b>倉庫</b>（防寒施設。持ち物の上限+10）、<b>見張り台</b>（天気予報、ここから2マス以内に移動できる）、<b>作業場</b>（薪・防寒着・道具を作る）があります。焚き火の近くでは、肉からステーキも作れます。くわしくは、ルールの「建物と作る」「料理と装備」を見てください。' },
      { title: '手番を終える', page: 'turn',
        enter(g) { refill(g); push(); },
        text: () => '左の「このまま手番を終えると」で、満腹度・体温・火力がどう変わるか確認できます。確認したら、上のバーの<b>「手番を終える」</b>を押しましょう。',
        hlEl: '#btn-endturn',
        done: () => E.cur(game()).id !== app.me },
      { title: 'ほかの人の手番', page: 'turn',
        text: () => 'CPUが手番を行っています。手番でない間は、<b>移動</b>と<b>お絵かき</b>と<b>捨てる投票</b>だけできます（右の「お絵かきモード」で絵が描けます）。あなたの手番に戻るまで待ちましょう。',
        done: () => E.cur(game()).id === app.me && game().phase === 'play' },
      { title: '持ち物と食料', next: true, page: 'items',
        text: () => '共有アイテムには上限があります。上限を超えたときは、持っている物と入れ替えるか選べます。右の「最終猛吹雪を生き延びるのに必要な食料」は、猛吹雪に向けた食料の目安です。食料と薪を貯めて、最終猛吹雪の3ラウンドを乗り越えましょう。' },
      { title: 'おしまい', end: true,
        text: () => '基本はこれで終わりです。ルールのページに、くわしい説明があります。ゲーム中も、上のバーの「ルール」でいつでも読めます。' },
    ];

    function setHl() {
      const st = STEPS[T.i], hl = $('#tut-hl');
      $$el().forEach(e => e.classList.remove('tut-pulse'));
      if (!T.active || !st) { hl.hidden = true; return; }
      if (st.hlEl) $(st.hlEl).classList.add('tut-pulse');
      hl.hidden = true;
    }
    const $$el = () => Array.from(document.querySelectorAll('.tut-pulse'));
    function loop() {
      if (!T.active) return;
      const st = STEPS[T.i], hl = $('#tut-hl'), b = ctx.board();
      const r = st && st.hl && game() && st.hl();
      if (r && b) {
        const a = b.tileScreen(r.x, r.y), z = a.size;
        hl.hidden = false;
        hl.style.left = a.x + 'px'; hl.style.top = a.y + 'px'; hl.style.width = r.w * z + 'px'; hl.style.height = r.h * z + 'px';
      } else hl.hidden = true;
      T.raf = requestAnimationFrame(loop);
    }

    function render() {
      const el = $('#tutor');
      if (!T.active) { el.hidden = true; return; }
      const st = STEPS[T.i], n = STEPS.length;
      el.hidden = false;
      const dots = STEPS.map((_, i) => `<i class="${i < T.i ? 'done' : i === T.i ? 'cur' : ''}"></i>`).join('');
      el.innerHTML = `<div class="tut-head"><span>チュートリアル ${T.i + 1} / ${n}</span><button class="x" data-tut="quit" aria-label="チュートリアルをやめる">×</button></div>
        <div class="tut-dots">${dots}</div>
        <b class="tut-title">${esc(st.title)}</b>
        <div class="tut-text">${st.text()}</div>
        ${st.page ? `<button class="link tut-link" data-tut="rule" data-page="${st.page}">くわしくはルールを見る</button>` : ''}
        <div class="row tut-btns">
          <button data-tut="prev" ${T.i === 0 ? 'disabled' : ''}>← 前へ</button>
          ${st.end ? '<button class="primary" data-tut="rules">ルールを読む</button><button data-tut="quit">トップへ戻る</button>'
    : (st.next ? '<button class="primary" data-tut="next">次へ →</button>' : '<button data-tut="next">スキップ →</button>')}
        </div>`;
    }

    function go(i) {
      T.i = Math.max(0, Math.min(STEPS.length - 1, i));
      T.advancing = false;
      const st = STEPS[T.i], g = rg();
      if (st.enter && g) st.enter(g);
      setHl();
      render();
      if (st.enter) push();
    }
    function start() {
      T.active = true; T.i = -1; T.advancing = false;
      cancelAnimationFrame(T.raf); T.raf = requestAnimationFrame(loop);
    }
    function stop() {
      T.active = false; T.i = -1;
      cancelAnimationFrame(T.raf);
      $('#tutor').hidden = true; $('#tut-hl').hidden = true;
      $$el().forEach(e => e.classList.remove('tut-pulse'));
    }
    // 状態が届くたびに呼ぶ：最初の状態でゲームを整え、操作できたら次へ進める
    function onState() {
      if (!T.active) return;
      const g = game();
      if (!g || g.phase !== 'play' && T.i < 0) return;
      if (T.i < 0) {
        const rgm = rg(); rgm.weather = 'clear'; rgm.next = 'clear';
        go(0);
        return;
      }
      render();
      const st = STEPS[T.i];
      if (st && st.done && !T.advancing && st.done()) {
        T.advancing = true;
        ctx.sound && ctx.sound.play('turn');
        setTimeout(() => { if (T.active && STEPS[T.i] === st) go(T.i + 1); }, 700);
      }
    }
    $('#tutor').addEventListener('click', e => {
      const b = e.target.closest('[data-tut]');
      if (!b) return;
      const a = b.dataset.tut;
      if (a === 'next') go(T.i + 1);
      else if (a === 'prev') go(T.i - 1);
      else if (a === 'quit') { stop(); ctx.leave(); }
      else if (a === 'rule') openRules(b.dataset.page);
      else if (a === 'rules') openRules('goal');
    });

    return { openRules, start, stop, onState, active: () => T.active, pages: PAGES };
  }

  window.SnowGuide = { create, PAGES };
})();
