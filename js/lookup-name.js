// 検索結果(楽天・Open *Facts・openBD・Google Books の応答)から、商品名を選んで整える純関数。fetch は持たない(単体テスト: barcode.test.mjs)。
// 方針: 誤った商品名を返さないこと(適合率)を、見つかる数より優先する。

const JAN_RE = /(?<!\d)\d{13}(?!\d)/g;
const gs1Ok = (c) => { const d = c.split('').map(Number), l = d.pop(); return (10 - (d.reverse().reduce((a, x, i) => a + x * (i % 2 ? 1 : 3), 0) % 10)) % 10 === l; };
// 文章中の「13桁の商品コード」(チェックディジットが正しいもの)の種類
const codesIn = (t) => new Set((String(t).match(JAN_RE) || []).filter(gs1Ok));

// 出品名の宣伝文句を除いて、商品の核(メーカー・商品名・容量)だけにする。
//   例) 「【送料無料】ママレモン 中 00106ライオン 台所洗剤 食器用洗剤 ママレモン 中サイズ 800ml キッチン…」→「ママレモン 中 ライオン 台所洗剤 食器用洗剤 800ml」(同じ語は1回、容量までで切る)
const CAP = '(?:ml|mL|ML|L|l|g|kg|mg|枚|ロール|R|m|cm|mm|錠|粒|包|食|組|巻|W|V|%)';
const SET_WORDS = /セット販売|まとめ買い|ケース販売|ケース売り|[1１]ケース|[0-9]+\s*(?:個|本|袋|箱|パック|缶|点|コ(?![ァ-ヶ])|ケース|セット)\s*(?:セット|入り?|組|まとめ買い)?|ケース|セット数|業務用|大容量|お得|お買い得|送料無料|送料込み?|代引[き]?不可|あす楽|メール便|ポイント\d*倍?|P\d+倍|在庫限り|数量限定|新品|訳あり|取り?寄せ[商品]*|取寄[品]*|お一人様[^\s)）]*|\bJAN\b|\bjan\b|\d{4}\/\d{1,2}\/\d{1,2}発売|\d{4}年\d{1,2}月\d{1,2}日(?:賞味期限|消費期限|まで|限定)?|全国|一部地域/g;
const FORMAT_SEG = /^(?:DVD|CD|BD|Blu-?ray|ブルーレイ|本|コミック|文庫|新書|雑誌|ゲーム|アニメ|キッズ|邦楽|洋楽)$/i; // 「DVD / ジャンル / 題名 / 型番」形式の出品で、題名以外の区切り
export function tidyName(raw) {
  let n = String(raw || '').normalize('NFKC');
  n = n.replace(/(?<!\d)\d{13}(?!\d)/g, ' ')                                    // 商品コード
    .replace(/【[^】]*】|\[[^\]]*\]|［[^］]*］|◆[^◆]*◆|★[^★]*★|☆[^☆]*☆|＼[^／]*／|<[^>]*>|＜[^＞]*＞|《[^》]*》/g, ' ') // 飾りの括弧
    .replace(/[☆★♪◆◇●○▼▲■□※▽△♥♡]/g, ' ')
    // 「(300g*2個セット)」→「300g」(容量は残し、個数は捨てる)
    .replace(new RegExp(`[（(]\\s*(\\d[\\d.]*\\s?${CAP})\\s*[*×xX＊]\\s*\\d+[^)）]*[)）]`, 'g'), ' $1 ')
    .replace(/[（(][^）)]*(?:送料|限定|特売|P\d|ポイント|クーポン|OFF|取寄|まとめ|あす楽|発送|セット|ケース|入り|[0-9]個|[0-9]本|[0-9]袋|JAN|商品)[^）)]*[）)]/g, ' ')
    .replace(/(?<![\d.])\d{4,6}(?!\d|年|月|日|円|g|kg|ml|mL|L|枚|個|本|粒|錠|W|V)(?=\s|[ぁ-んァ-ヶ一-龠]|$)/g, ' ') // 品番らしい4〜6桁の数字(2024年・1000円・500mlなどは残す)
    .replace(/[|｜]/g, ' ')
    .split(/※|\s[-ー－]\s/)[0];
  { // 「A / B / C」形式: 形式名(DVD など)と型番の区切りを除き、先頭が短い(アーティスト名など)なら次とつなぐ
    const segs = n.split(/\s+\/\s+/).map((x) => x.trim()).filter((x) => x && !FORMAT_SEG.test(x) && !/^[A-Za-z0-9][A-Za-z0-9\-－]{4,}$/.test(x));
    n = segs.length > 1 && Array.from(segs[0]).length <= 14 ? `${segs[0]} ${segs[1]}` : (segs[0] || '');
  }
  n = n.replace(/\s*(?:[×*＊]|(?<=\d|\s|ml|mL|kg|g|L|枚)[xX])\s*\d+\s*(?:個|本|袋|箱|パック|缶|点|コ(?![ァ-ヶ])|ケース|セット|入)*\s*(?:\(\s*[^)]*\))?/g, ' ') // 「×12個」「*48本セット」(型番の X5 は残す)
    .replace(SET_WORDS, ' ').replace(/[（(]\s*[)）]/g, ' ');
  n = n.replace(/[【［\[(（][^】］\])）]*$/, ' ').replace(/\s+/g, ' ').replace(/^[\s\-－×*＊・,、.:：]+|[\s\-－×*＊・,、(（:：]+$/g, '').trim();
  // 同じ語は最初の1回だけ残す(「ママレモン … ママレモン」)
  const seen = new Set(); let words = n.split(' ').filter((w) => { if (!w) return false; const k = w.toLowerCase(); if (seen.has(k) && k.length > 1) return false; seen.add(k); return true; });
  // 容量・内容量(500ml / 4kg / 30枚 / 12ロール など)が出てきたら、そこまでを商品名とし、後ろの宣伝用キーワードは捨てる
  const capRe = new RegExp(`^(?:約)?\\d+(?:\\.\\d+)?\\s?${CAP}$`);
  const cap = words.findIndex((w, i) => i >= 1 && capRe.test(w));
  if (cap >= 1 && cap <= 9) words = words.slice(0, cap + 1);
  else if (words.length > 7) words = words.slice(0, 7);
  let out = words.join(' ').replace(/\s+/g, ' ').replace(/[\s(（\-－×*＊]+$/, '').trim();
  if (Array.from(out).length > 48) out = Array.from(out).slice(0, 48).join('').replace(/\s\S*$/, '').trim() || Array.from(out).slice(0, 48).join('');
  return out;
}

// 楽天の検索結果 items(各: { itemName, catchcopy, itemCaption })から、この番号の商品名を選ぶ。選べなければ ''。
// 条件: ① その出品の名前か説明に、この番号がそのまま(前後が数字でなく)入っている ② その出品に載っている商品コードが、この番号だけ(詰め合わせ・アソートの出品は、
// 名前が特定の1商品を表さないので使わない)。名前に番号が入っているものを優先し、同じなら「セット・ケース」でないものを優先。
export function pickRakuten(items, code, opt = {}) {
  const re = new RegExp(`(?<!\\d)${code}(?!\\d)`);
  const rows = (items || []).map((i) => {
    const name = String(i.itemName || ''), text = `${name} ${i.catchcopy || ''} ${i.itemCaption || ''}`;
    return { name, text, hasCode: re.test(text), inName: re.test(name), codes: codesIn(text) };
  }).filter((r) => r.name && r.hasCode);
  const only = rows.filter((r) => r.codes.size <= 1);
  const pool = only.some((r) => r.inName) ? only.filter((r) => r.inName) : only;
  const isSet = (n) => /セット|ケース|まとめ買い|\d+\s*(個|本|袋|箱|パック)\s*入|×\s*\d{2,}/.test(n);
  const cost = (r) => (isSet(r.name) ? 100 : 0) + (/^(?:DVD|CD|BD|Blu-?ray)\s*\//i.test(r.name) ? 50 : 0) + Array.from(tidyName(r.name)).length;
  const best = pool.sort((a, b) => cost(a) - cost(b))[0];
  if (best) { const n = tidyName(best.name); if (Array.from(n).length >= 2) return n; }
  if (opt.consensus === false) return '';
  const c = consensusName(items); if (c && opt.out) opt.out.approx = true; // 出品名に番号がなく、複数の出品の共通部分から作った名前
  return c;
}

// 番号が出品名・説明に載っていなくても、楽天は番号で検索すると同じ商品の出品が返ることが多い。そこで、
// 上位の出品(最大6件)のうち「2件以上の出品に共通する、連続した語の並び」(メーカー名+商品名など)を、名前として返す。
// 共通部分が短い・語が1つだけ・共通する出品が全体の半分に満たないときは返さない(別の商品を返さないことを優先)。
export function consensusName(items, opt = {}) {
  // 同じお店の出品は1件と数える(同じ店の重複出品で「共通」になってしまわないように)
  const seenShop = new Set(), rows = [];
  for (const it of items || []) {
    const shop = it.shopCode || it.shopName || String(it.itemCode || '').split(':')[0] || String(rows.length);
    if (seenShop.has(shop)) continue; seenShop.add(shop);
    const t = tidyName(it.itemName).split(' ').filter(Boolean); if (t.length) rows.push(t);
    if (rows.length >= (opt.top || 6)) break;
  }
  const minSup = opt.minSupport || 3;
  // 2つの店の出品名が(整形後に)まったく同じなら、それも「共通」とみなす
  if (rows.length === 2 && rows[0].join(' ').toLowerCase() === rows[1].join(' ').toLowerCase() && Array.from(rows[0].join('')).length >= 8) return rows[0].join(' ');
  if (rows.length < minSup) return '';
  const key = (w) => w.toLowerCase();
  const has = (t, run) => { for (let i = 0; i + run.length <= t.length; i++) if (run.every((w, k) => key(t[i + k]) === key(w))) return true; return false; };
  let best = null;
  for (let a = 0; a < rows.length; a++) for (let i = 0; i < rows[a].length; i++) for (let len = Math.min(8, rows[a].length - i); len >= 1; len--) {
    const run = rows[a].slice(i, i + len), chars = Array.from(run.join('')).length;
    if (chars < (opt.minChars || 8)) continue;
    const sup = rows.filter((t) => has(t, run)).length;
    if (sup < minSup || sup < rows.length * 0.6) continue;
    const score = sup * 100 + chars + (i === 0 ? 5 : 0);
    if (!best || score > best.score) best = { run, score };
    break; // この開始位置では最長のものだけ見る
  }
  return best ? best.run.join(' ') : '';
}

// Open Food Facts 系(Food / Beauty / Products / Pet Food)の product から名前を作る。ブランド名が入っていなければ先頭に付ける
export function offName(p) {
  if (!p || typeof p !== 'object') return '';
  const name = String(p.product_name_ja || p.product_name || p.generic_name || '').replace(/\s+/g, ' ').trim();
  if (!name) return '';
  const brand = String(p.brands || '').split(',')[0].trim();
  const q = String(p.quantity || '').replace(/\s+/g, '').trim();
  let out = brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name;
  if (q && q.length <= 12 && !out.replace(/\s/g, '').includes(q)) out += ` ${q}`;
  return Array.from(out).slice(0, 60).join('');
}

// openBD の summary → 書名(巻数つき)
export function bookName(m) {
  if (!m?.title) return '';
  return [m.title, m.volume].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 60);
}

// Google Books の volumeInfo → 書名(副題・巻数は title に含まれるものだけ)
export function gbooksName(v) {
  if (!v?.title) return '';
  return String(v.title).replace(/\s+/g, ' ').slice(0, 60);
}

// 雑誌(491)の出品名: 【中古】や [雑誌] などを除く(tidyName が行う)。号・発売日(2024年 7/13号)は残す
