// 分類の体系(大分類→小分類・置き場所)。DOM/Firestore 非依存の純粋なデータ+小さな関数。
// 品目は { category(大分類), sub(小分類・任意), location(置き場所) } を持つ。どれも自由文字列を許す
// (既定に無い値は「使用中のもの」として一覧に出る=家族で自然に共有される)。
// 古い版の文字列(洗剤・衛生/薬/消耗品/風呂・トイレ/押入れ)も有効で、表示・絞り込み時に canon* で新体系へ読み替える。

// 色トークン: 画面側は var(--c-<token>-bg / -fg) として使う。ライト/ダークとも文字と背景のコントラスト比 4.5 以上(category.test.mjs で検証)。
export const COLOR_TOKENS = {
  green:  { light: { bg: '#dff3e2', fg: '#17572a' }, dark: { bg: '#1c3a25', fg: '#a9e4b8' } },
  blue:   { light: { bg: '#dcebfb', fg: '#16457a' }, dark: { bg: '#1b3250', fg: '#b0d3fa' } },
  amber:  { light: { bg: '#fbefd0', fg: '#6b4700' }, dark: { bg: '#473514', fg: '#f6d792' } },
  teal:   { light: { bg: '#d8f1f0', fg: '#0f5753' }, dark: { bg: '#173c3a', fg: '#9fe0dc' } },
  pink:   { light: { bg: '#fbe0ec', fg: '#8a1e55' }, dark: { bg: '#4a1f35', fg: '#f8b9d6' } },
  red:    { light: { bg: '#fbe0df', fg: '#8c2020' }, dark: { bg: '#4a2020', fg: '#f8b8b6' } },
  purple: { light: { bg: '#ebe2fa', fg: '#4e2a8c' }, dark: { bg: '#35255a', fg: '#d3bff8' } },
  orange: { light: { bg: '#fde5d2', fg: '#7d3a05' }, dark: { bg: '#4a2e14', fg: '#f8c9a0' } },
  gray:   { light: { bg: '#e8e9ec', fg: '#3b3f47' }, dark: { bg: '#34373d', fg: '#cfd2d8' } },
};

export const TAXONOMY = [
  { name: '食品', icon: '🍚', color: 'green', subs: ['米・パン', '麺・パスタ', '調味料・粉', '缶詰・レトルト', '乾物', '冷凍食品', '乳製品・卵', '豆腐・納豆', '肉・魚', '野菜・果物', 'お菓子', '朝食・シリアル', 'その他'] },
  { name: '飲料', icon: '🥤', color: 'blue', subs: ['水・炭酸水', 'お茶', 'コーヒー・紅茶', 'ジュース・炭酸', '乳飲料', 'お酒', 'その他'] },
  { name: '日用品', icon: '🧻', color: 'amber', subs: ['ティッシュ・ペーパー', 'キッチン用品', '文具・事務', '電池・電球', '生活雑貨', 'その他'] },
  { name: '洗剤・掃除', icon: '🧴', color: 'teal', subs: ['洗濯', '食器', 'お風呂', 'トイレ', '掃除・消臭', 'その他'] },
  { name: '美容・ケア', icon: '🪥', color: 'pink', subs: ['シャンプー・ボディ', 'スキンケア', '歯みがき・口腔', '衛生用品', 'その他'] },
  { name: '薬・健康', icon: '💊', color: 'red', subs: ['常備薬', '絆創膏・衛生材料', 'サプリ', 'その他'] },
  { name: 'ベビー・キッズ', icon: '🍼', color: 'orange', subs: ['おむつ・おしりふき', 'ミルク・離乳食', 'ケア・用品', 'その他'] },
  { name: 'ペット', icon: '🐾', color: 'purple', subs: ['フード', 'トイレ・シート', 'ケア・用品', 'その他'] },
  { name: 'その他', icon: '📦', color: 'gray', subs: [] },
];

export const LOCATIONS = [
  { name: '冷蔵庫', icon: '🧊' }, { name: '冷凍庫', icon: '❄️' }, { name: 'パントリー', icon: '🥫' }, { name: 'キッチン', icon: '🍳' },
  { name: '洗面所', icon: '🚿' }, { name: 'お風呂', icon: '🛁' }, { name: 'トイレ', icon: '🚽' }, { name: '押入れ・収納', icon: '🗄️' },
  { name: '玄関', icon: '🚪' }, { name: 'ベランダ', icon: '🌿' }, { name: '車', icon: '🚗' }, { name: 'その他', icon: '📦' },
];

// 互換の配列(app.js が従来どおり .map / .includes / .indexOf できる)
export const CATS = TAXONOMY.map((c) => c.name);
export const LOCS = LOCATIONS.map((l) => l.name);

// 古い版の文字列 → 新体系。値が配列なら先頭が既定で、品名から判断できればその候補を選ぶ
export const LEGACY_CATEGORY = { '洗剤・衛生': ['洗剤・掃除', '美容・ケア', '薬・健康'], 薬: ['薬・健康'], 消耗品: ['日用品', '洗剤・掃除'] };
export const LEGACY_LOCATION = { '風呂・トイレ': ['お風呂', 'トイレ'], 押入れ: ['押入れ・収納'] };
// 新しい置き場所 → 古い版でも通じる置き場所(opts.locs が古い一覧のときの代替)
const LOC_FALLBACK = { 冷蔵庫: ['キッチン'], 冷凍庫: ['キッチン'], パントリー: ['キッチン'], お風呂: ['風呂・トイレ'], トイレ: ['風呂・トイレ'], '押入れ・収納': ['押入れ'] };

// 小分類ごとの既定の置き場所 [場所, 確信度]。0.6 未満は使われない(家ごとに違うものは持たない)
export const SUB_LOC = {
  食品: { 米・パン: ['パントリー', 0.65], 麺・パスタ: ['パントリー', 0.65], 調味料・粉: ['パントリー', 0.65], 缶詰・レトルト: ['パントリー', 0.7], 乾物: ['パントリー', 0.65], 冷凍食品: ['冷凍庫', 0.9], 乳製品・卵: ['冷蔵庫', 0.85], 豆腐・納豆: ['冷蔵庫', 0.85], 肉・魚: ['冷蔵庫', 0.8], 野菜・果物: ['冷蔵庫', 0.6], お菓子: ['パントリー', 0.65], '朝食・シリアル': ['パントリー', 0.65] },
  飲料: { '水・炭酸水': ['パントリー', 0.6], お茶: ['パントリー', 0.6], 'コーヒー・紅茶': ['パントリー', 0.65], 'ジュース・炭酸': ['パントリー', 0.6], 乳飲料: ['冷蔵庫', 0.85], お酒: ['パントリー', 0.6] },
  日用品: { キッチン用品: ['キッチン', 0.8] },
  洗剤・掃除: { 洗濯: ['洗面所', 0.7], 食器: ['キッチン', 0.85], お風呂: ['お風呂', 0.8], トイレ: ['トイレ', 0.85] },
  美容・ケア: { 'シャンプー・ボディ': ['洗面所', 0.7], スキンケア: ['洗面所', 0.65], '歯みがき・口腔': ['洗面所', 0.8], 衛生用品: ['洗面所', 0.6] },
};
// 大分類だけ分かっているときの既定
export const CAT_LOC = { 食品: ['キッチン', 0.7], 飲料: ['キッチン', 0.7], 洗剤・掃除: ['洗面所', 0.65], 美容・ケア: ['洗面所', 0.7] };

const BY_CAT = new Map(TAXONOMY.map((c) => [c.name, c]));
const BY_LOC = new Map(LOCATIONS.map((l) => [l.name, l]));
const s = (v) => (typeof v === 'string' ? v.trim() : '');

// 大分類を新体系の名前に読み替える。legacy は品名(任意)から候補を選ぶ。分類が空・未知(自由文字列)はそのまま返す。
// guess: 品名から推定した大分類(category.js の guessClass(name).category)
export function canonCategory(cat, guess = '') {
  const c = s(cat), cand = LEGACY_CATEGORY[c];
  if (!cand) return c;
  return cand.includes(guess) ? guess : cand[0];
}
// 置き場所を新体系の名前に読み替える。hint: 品名(トイレ/風呂を含めば「風呂・トイレ」を振り分ける)
export function canonLocation(loc, hint = '') {
  const l = s(loc), cand = LEGACY_LOCATION[l];
  if (!cand) return l;
  const h = String(hint || '').normalize('NFKC');
  return cand.find((x) => x !== '押入れ・収納' && h.includes(x.replace('お', ''))) || cand[0];
}
// opts.locs(利用可能な置き場所の一覧)に合わせて置き場所を返す。無ければ古い版の代替名、それも無ければ ''
export function fitLocation(loc, locs) {
  if (!loc) return '';
  if (!locs || locs.includes(loc)) return loc;
  return (LOC_FALLBACK[loc] || []).find((x) => locs.includes(x)) || '';
}

export const catInfo = (cat, guess) => { const c = canonCategory(cat, guess); return BY_CAT.get(c) || { name: c, icon: '🏷️', color: 'gray', subs: [], custom: true }; };
export const locInfo = (loc, hint) => { const l = canonLocation(loc, hint); return BY_LOC.get(l) || { name: l, icon: '📍', custom: true }; };
export const colorOf = (cat, guess) => COLOR_TOKENS[catInfo(cat, guess).color];

// 一覧の合成: 既定 + 品目で使われているもの(自由文字列・古い版の文字列は読み替え後)。既定の順→使用中は出現回数の多い順。
function merge(defaults, used) {
  const cnt = new Map();
  for (const u of used) if (u) cnt.set(u, (cnt.get(u) || 0) + 1);
  const extra = [...cnt].filter(([u]) => !defaults.includes(u)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja')).map(([u]) => u);
  return [...defaults, ...extra];
}
export const categoryOptions = (items = []) => merge(CATS, items.map((i) => canonCategory(i?.category, '')));
// cat の小分類。cat が自由文字列でも、品目で使われている sub が出る。
export function subOptions(cat, items = []) {
  const c = canonCategory(cat, '');
  return merge(BY_CAT.get(c)?.subs || [], items.filter((i) => canonCategory(i?.category, '') === c).map((i) => s(i.sub)));
}
export const locationOptions = (items = []) => merge(LOCS, items.map((i) => canonLocation(i?.location, i?.name)));

// 絞り込み用の一致判定(古い版の文字列も新体系で一致する)。filter が空なら常に true
export const matchCategory = (item, filter) => !filter || canonCategory(item?.category, '') === canonCategory(filter, '') || item?.category === filter;
export const matchLocation = (item, filter) => !filter || canonLocation(item?.location, item?.name) === canonLocation(filter, '') || item?.location === filter;

// 保存用: 値が空なら含めない({}) → undefined を Firestore に入れない。使い方: { ...rec, ...classFields(cat, sub) }
export const classFields = (category, sub) => ({ ...(s(category) ? { category: s(category) } : {}), ...(s(sub) ? { sub: s(sub) } : {}) });
