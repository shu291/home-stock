// 期限の予測エンジン(純粋関数・端末内・通信なし)。データは shelflife-data.js。
//
// 【これは何か / 何を保証しないか】
//  品名から「その種類の食品の標準的な賞味/消費期間」を引き、購入時点での残り日数に直して予測する。
//  公的機関・業界団体・主要メーカーが公開する標準的な期間との一致を評価の正解にしており(評価は別途 scratchpad の shelflife-eval)、
//  個々の商品パッケージの表示との一致は保証しない(メーカー・商品ごとに違う)。画面では必ず「予測」と表示し、手で直せる前提で使うこと。
//  確信が足りなければ null を返す(予測しない)。conf は「標準的な期間と許容範囲内で一致する確率」の見積り(規則ごとに評価データで較正)。
//  【段階 level】 high=予測(適合率9割超) / mid=目安(公開資料で幅が分かる品) / low=おおよそ(種類は分かるが製品で期間が割れる。幅の短い側の控えめな日数)。
//  既定(opts 無し)は従来どおり high 相当のみ(MIN_CONF=0.85)。opts.minConf は従来どおり確信度の下限。opts.level='mid'|'low' で受け入れる最低の段階を下げる(新しい品も答える)。
//  low は「おおよその目安」であり、実際のパッケージ表示と違うことが多い(basis にも明記)。
//
// 【考え方】 days = 製造日からの標準期間 P × 購入時点の残存率(店頭で消費済みの分を引く: P<=10日は0.6、それ以上は0.65)。
//  家庭で開封後・家庭での保存の目安(生鮮など)は店頭消費がないので、その期間をそのまま使う。
import { cleanName, guessClass } from './category.js';
import { RULES, MIN_CONF, GX, retail } from './shelflife-data.js';

let COMPILED = null;
const NEW0 = RULES.findIndex((r) => r.id === 'none-salt-sugar'); // これ以降は level 指定が無い従来の呼び出しでは返さない(新しい段階用の規則)
let GRE = null;
const hira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const RANK = { low: 0, mid: 1, high: 2 };
// 段階: 確信度 0.85以上=high, 0.65以上=mid, それ未満=low。規則に lv(上限)があればそれより高くしない。
const levelOf = (conf, cap) => { const l = conf >= MIN_CONF ? 'high' : conf >= 0.65 ? 'mid' : 'low'; return cap && RANK[cap] < RANK[l] ? cap : l; };
const compile = () => (COMPILED ||= RULES.map((r, i) => ({ kd: '賞味', l: '常', nw: i >= NEW0, ...r, mre: new RegExp(hira(r.m.toLowerCase())), xre: r.x ? new RegExp(hira(r.x.toLowerCase())) : null })));

const NONFOOD = new Set(['日用品', '洗剤・掃除', '美容・ケア']);
const FREEZE = new Set(['冷凍庫']);
const ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const parse = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
const localToday = () => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()); };

// 画面に出す根拠文。b は '種類名|補足|?' (? は検証データ不足)。例: 「カップ麺の標準的な賞味期間(6か月)」
const why = (r, mode, level) => {
  const [name, note, unv] = r.b.split('|');
  if (r.cr) return `${name}の期限は箱に印字されています。必ず箱の表示を確認してください(これは標準的な期間からのおおよその目安です)`;
  if (/目安|印字/.test(name)) return name;
  const tail = level === 'low' && !mode ? '。おおよその目安で、製品により期間が違い実際の表示と違うことがあります' : '';
  const term = mode === '開封後' ? '開封後の使用期間の目安' : mode === '冷凍保存' ? '冷凍保存の目安' : r.h ? '保存の目安' : `標準的な${r.kd === '消費' ? '消費期限' : '賞味期間'}`;
  return `${name}の${term}${note && !mode ? `(${note})` : ''}${unv ? '(検証データ不足)' : ''}${tail}`;
};
const rangeOf = (r) => { if (!r.R) return null; const f = (P) => (r.h ? P : Math.max(1, Math.round(P * retail(P)))); const a = f(r.R[0]), b = f(r.R[1]); return a === b ? `${a}日` : `${a}〜${b}日`; };

// 品名 → 規則(最初に当たったもの。P が 0 で開封後 o も無い規則は「期限が本当に無い品」で null。理由は rule.b)
export function matchRule(name, sub = '') {
  const t = cleanName(name);
  if (!t) return null;
  const sb = sub || guessClass(name).sub;
  GRE ||= new RegExp(hira(GX));
  for (const r of compile()) if (r.mre.test(t) && !(r.xre && r.xre.test(t)) && !(r.fb ? !sb || !r.s.includes(sb) : r.s && !r.s.includes(sb)) && !(r.n && t.length > r.n) && !(r.g && GRE.test(t))) return r;
  return null;
}

// predictExpiry({ name, category, sub, location, boughtAt, today, opened }, { minConf, level }) → { date:'YYYY-MM-DD', days, kind:'賞味'|'消費', conf, level:'high'|'mid'|'low', range:'3〜7日'|null, basis } | null
//  level を指定すると「その段階以上」を返す(既定=従来どおり minConf のみで、新しく足した low/mid 専用の規則は返さない)。minConf も併せて渡せばその確信度も満たすものだけ。
//  boughtAt: 購入日(無ければ today、それも無ければ端末の今日)。opened:true は「開封後の使用期間の目安」(起算は today)。
//  location:'冷凍庫' は家庭で冷凍した場合の目安(規則に無ければ null)。category/sub は無ければ guessClass(name) で補う。洗剤・日用品・美容は null。
//  days は「購入(または開封)から何日後まで」。date = 起算日 + days。
export function predictExpiry(it = {}, opts = {}) {
  const name = String(it.name ?? '');
  const minConf = opts.minConf ?? MIN_CONF;
  if (opts.level != null && !(opts.level in RANK)) throw new RangeError("level は 'high' | 'mid' | 'low'");
  const cat = it.category || guessClass(name).category;
  if (NONFOOD.has(cat)) return null;
  const r = matchRule(name, it.sub);
  if (!r || (!r.P && !(it.opened && r.o))) return null;
  const loc = it.location || '';
  let days, conf = r.c, basis = '', kind = r.kd;
  if (it.opened) {
    if (!r.o) return null;
    days = r.o; conf = r.oc ?? Math.min(r.c, 0.8); basis = '開封後';
  } else if (FREEZE.has(loc) && r.l !== '凍') {
    if (!r.fz) return null;
    days = r.fz; conf = r.fzc ?? 0.7; basis = '冷凍保存';
  } else if (r.l === '凍' && loc && !FREEZE.has(loc)) {
    return null; // 冷凍食品を冷凍庫以外に置く: 解凍後の扱いは分からない
  } else if (r.h) days = r.P;
  else days = Math.max(1, Math.round(r.P * retail(r.P)));
  const level = levelOf(conf, r.lv);
  if (opts.level) { if (RANK[level] < RANK[opts.level] || (opts.minConf != null && conf < minConf)) return null; }
  else if ((r.nw && !basis) || r.cr || conf < minConf) return null; // 従来の呼び出し: 新しい段階専用(nw)の規則・要確認(cr)の品は返さず、確信度だけで判定
  const base = parse(it.boughtAt) || parse(it.today) || localToday();
  const start = it.opened ? (parse(it.today) || localToday()) : base;
  const d = new Date(start + days * 86400000);
  return { date: ymd(d), days, kind, conf: Math.round(conf * 100) / 100, level, range: basis ? null : rangeOf(r), ...(r.cr ? { critical: true } : {}), basis: why(r, basis, level) };
}
