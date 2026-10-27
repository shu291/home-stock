// 商品名の検索(通信まわり)。ブラウザの fetch / localStorage を使うが、すべて差し替えられる(単体テスト: barcode.test.mjs)。
//  - 番号の種類で問い合わせ先を振り分ける(店内用コードなどは外部に問い合わせない)
//  - 楽天は直列キュー+最小間隔(約1リクエスト/秒の制限に合わせる)。429/503 は1回だけ待って再試行
//  - 結果は端末内(localStorage)に保存: 見つかった名前は長く、見つからなかった結果は短く。上限件数あり。通信の失敗は保存しない
import { normalizeScan, classify, noLookup, sourcePlan } from './lookup-code.js';
import { pickRakuten, offName, bookName, gbooksName } from './lookup-name.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;

// 直列キュー: 前の開始から minGap ミリ秒あけて次を始める。fn には ping(今リクエストを出した、の印)を渡す
export function createQueue({ minGap = 1100, now = () => Date.now(), wait = sleep } = {}) {
  let tail = Promise.resolve(), last = -Infinity;
  const ping = () => { last = now(); };
  return (fn) => {
    const run = tail.then(async () => { const d = last + minGap - now(); if (d > 0) await wait(d); ping(); return fn(ping); });
    tail = run.catch(() => {});
    return run;
  };
}

// 検索結果の保存(端末内のみ)。値: [名前('' は見つからなかった印), 保存時刻, 出典]
export function createCache({ storage, key = 'hs-bc-cache-v1', max = 300, hitTtl = 90 * DAY, missTtl = DAY, now = () => Date.now() } = {}) {
  const st = storage === undefined ? (() => { try { return globalThis.localStorage; } catch { return null; } })() : storage;
  const read = () => { try { const o = JSON.parse(st.getItem(key) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
  const write = (o) => { try { st.setItem(key, JSON.stringify(o)); } catch { /* 容量不足など: 保存できなくても動く */ } };
  return {
    get(code) {
      if (!st) return null;
      const e = read()[code]; if (!Array.isArray(e)) return null;
      const [name, at, src] = e;
      if (now() - at > (name ? hitTtl : missTtl)) return null;
      return name ? { name, src } : { miss: true };
    },
    put(code, name, src = '') {
      if (!st) return;
      const o = read(); o[code] = [String(name || ''), now(), src];
      const keys = Object.keys(o);
      if (keys.length > max) for (const k of keys.sort((a, b) => o[a][1] - o[b][1]).slice(0, keys.length - max)) delete o[k];
      write(o);
    },
    clear() { try { st?.removeItem(key); } catch { /* 何もしない */ } },
    size() { return Object.keys(read()).length; },
  };
}

const FACTS = { off: 'world.openfoodfacts.org', obf: 'world.openbeautyfacts.org', opf: 'world.openproductsfacts.org', opff: 'world.openpetfoodfacts.org' };

// 戻り値の形: { st: 'ok', name } 見つかった / 見つからなかった(name は '')、{ st: 'skip' } 使えない設定、{ st: 'err' } 通信の失敗
export function createLookup(opt = {}) {
  const doFetch = opt.fetch || ((...a) => globalThis.fetch(...a));
  const rk = opt.rakutenApi || {};
  const wait = opt.sleep || sleep;
  const now = opt.now || (() => Date.now());
  const queue = opt.queue || createQueue({ minGap: opt.minGap ?? 1100, now, wait });
  const cache = opt.cache || createCache({ storage: opt.storage, now });
  const timeout = (ms) => { try { return AbortSignal.timeout(ms); } catch { return undefined; } };
  const online = opt.online || (() => globalThis.navigator?.onLine !== false);
  const json = async (url, ms = 6000) => doFetch(url, { signal: timeout(ms) });

  const S = {
    async openbd(code) {
      const r = await json(`https://api.openbd.jp/v1/get?isbn=${code}`, 5000);
      if (!r.ok) return { st: 'err' };
      return { st: 'ok', name: bookName((await r.json())?.[0]?.summary) };
    },
    async gbooks(code) {
      const r = await json(`https://www.googleapis.com/books/v1/volumes?q=isbn:${code}&maxResults=1&fields=items(volumeInfo(title))`, 5000);
      if (r.status === 429) return { st: 'skip' }; // キーなしの利用は混雑で 429 になりやすい。補助の出典なので「通信の不調」にはせず、見つからない結果も保存しない
      if (!r.ok) return { st: 'err' };
      return { st: 'ok', name: gbooksName((await r.json())?.items?.[0]?.volumeInfo) };
    },
    async rakuten(code) {
      if (!rk.applicationId || !rk.accessKey) return { st: 'skip' };
      const u = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701?applicationId=${encodeURIComponent(rk.applicationId)}&accessKey=${encodeURIComponent(rk.accessKey)}&format=json&formatVersion=2&hits=10&keyword=${code}`;
      return queue(async (ping) => {
        let r = await json(u, 6000);
        if (r.status === 429 || r.status === 503) { await wait(1500); ping(); r = await json(u, 6000); } // 1回だけ待って再試行
        if (r.status === 401 || r.status === 403) return { st: 'skip' };   // 登録していないサイトから開いている等。名前が見つからないのとは別
        if (!r.ok) return { st: 'err' };
        const j = await r.json();
        const items = (j.Items || j.items || []).map((x) => x.Item || x.item || x);
        const out = {}, name = pickRakuten(items, code, { out });
        return { st: 'ok', name, approx: !!out.approx };
      });
    },
  };
  for (const [k, host] of Object.entries(FACTS)) {
    S[k] = async (code) => {
      const r = await json(`https://${host}/api/v2/product/${code}.json?fields=product_name,product_name_ja,brands,quantity,generic_name`, 5000);
      if (r.status === 404) return { st: 'ok', name: '' };
      if (!r.ok) return { st: 'err' };
      const j = await r.json().catch(() => null);
      return j ? { st: 'ok', name: offName(j.product) } : { st: 'err' };
    };
  }
  const safe = (k, code) => Promise.resolve().then(() => S[k](code)).catch(() => ({ st: 'err' }));

  const inflight = new Map();
  // 番号から商品名を調べる。戻り値: { code, kind, name, from, reason, cached }
  //   name が空のとき reason: 'instore' などの種類 / 'notfound'(登録なし) / 'offline' / 'error'(通信の不調)
  async function lookup(raw, { force = false } = {}) {
    const n = normalizeScan(raw), code = n?.code || String(raw || '');
    const kind = classify(code), base = { code, kind, name: '', from: '', reason: '' };
    if (noLookup(kind)) return { ...base, reason: kind };
    if (!force) {
      const c = cache.get(code);
      if (c?.name) return { ...base, name: c.name, from: c.src, cached: true };
      if (c?.miss) return { ...base, reason: 'notfound', cached: true };
    }
    if (!online()) return { ...base, reason: 'offline' };
    if (inflight.has(code)) return inflight.get(code);
    const p = (async () => {
      const plan = sourcePlan(kind);
      const runs = plan.map((k) => safe(k, code)); // 同時に始め、結果は優先順に見る
      let err = false, skip = false;
      for (let i = 0; i < plan.length; i++) {
        const r = await runs[i];
        if (r.st === 'ok' && r.name) { const from = plan[i] + (r.approx ? '~' : ''); cache.put(code, r.name, from); return { ...base, name: r.name, from }; }
        if (r.st === 'err') err = true; else if (r.st === 'skip') skip = true;
      }
      if (err) return { ...base, reason: online() ? 'error' : 'offline' };
      if (!skip) cache.put(code, '', '');
      return { ...base, reason: 'notfound' };
    })().finally(() => inflight.delete(code));
    inflight.set(code, p);
    return p;
  }
  return { lookup, cache, queue, sources: S };
}
