import { googleClientId } from './config.js';
import { parseOrderMail } from './parse.js';

export const gmailAvailable = !!googleClientId;
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
let token = null;

function loadGsi() {
  return new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.onload = res; s.onerror = () => rej(new Error('Google認証の読み込みに失敗'));
    document.head.appendChild(s);
  });
}

async function getToken() {
  if (token) return token;
  await loadGsi();
  return new Promise((res, rej) => {
    google.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      callback: (r) => (r.access_token ? (token = r.access_token, setTimeout(() => (token = null), 3000 * 1000), res(token)) : rej(new Error(r.error || '認証失敗'))),
      error_callback: (e) => rej(new Error(e.type || '認証キャンセル')),
    }).requestAccessToken();
  });
}

const api = async (path) => {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${await getToken()}` } });
  if (r.status === 401) { token = null; throw new Error('認証が切れました。もう一度試してください'); }
  if (!r.ok) throw new Error(`Gmail API ${r.status}`);
  return r.json();
};

const b64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

function bodyText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return b64(part.body.data);
  for (const p of part.parts || []) { const t = bodyText(p); if (t) return t; }
  if (part.mimeType === 'text/html' && part.body?.data)
    return b64(part.body.data).replace(/<(br|\/p|\/tr|\/div|\/li)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
  return '';
}

const QUERIES = {
  amazon: { q: 'from:(auto-confirm@amazon.co.jp) subject:(注文)', label: 'Amazon' },
  rakuten: { q: 'from:(order@rakuten.co.jp) subject:(注文)', label: '楽天市場' },
};

// 注文確認メールから品目候補を取り出す
export async function fetchOrders(kind, months, onProgress) {
  const { q } = QUERIES[kind];
  const list = await api(`/messages?maxResults=100&q=${encodeURIComponent(`${q} newer_than:${months}m`)}`);
  const ids = (list.messages || []).map((m) => m.id);
  const items = [];
  for (let i = 0; i < ids.length; i++) {
    onProgress?.(i + 1, ids.length);
    const m = await api(`/messages/${ids[i]}?format=full`);
    const date = new Date(+m.internalDate).toISOString().slice(0, 10);
    items.push(...parseOrderMail(bodyText(m.payload), { date, key: ids[i], source: kind }));
  }
  return items;
}
