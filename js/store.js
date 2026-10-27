import { firebaseConfig } from './config.js';

export const CLOUD = !!(firebaseConfig && firebaseConfig.apiKey);
const V = '10.12.2';
const G = (m) => `https://www.gstatic.com/firebasejs/${V}/firebase-${m}.js`;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

// ---- ローカル(お試し)ストア ----
function localStore() {
  const KEY = 'hs-items';
  let listener = null;
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
  const save = (a) => { localStorage.setItem(KEY, JSON.stringify(a)); listener && listener(a); };
  return {
    mode: 'local',
    async init(onState) { onState({ user: { name: 'この端末', uid: 'local' }, household: { id: 'local', name: 'お試しモード' } }); },
    subscribe(cb) { listener = cb; cb(load()); return () => { listener = null; }; },
    async save(item) {
      const a = load(); const i = a.findIndex((x) => x.id === item.id);
      const rec = { ...item, id: item.id || uid(), updatedAt: Date.now() };
      i >= 0 ? (a[i] = rec) : a.push(rec); save(a);
    },
    async remove(id) { save(load().filter((x) => x.id !== id)); },
    async signIn() {}, async signOut() {}, async createHousehold() {}, async joinHousehold() {},
  };
}

// ---- Firebase ストア ----
async function cloudStore() {
  const [appM, authM, fs] = await Promise.all([import(G('app')), import(G('auth')), import(G('firestore'))]);
  const app = appM.initializeApp(firebaseConfig);
  const auth = authM.getAuth(app);
  let db;
  try { db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache() }); } catch { db = fs.getFirestore(app); }
  let hid = null; let user = null; let onStateCb = null;

  const emit = async () => {
    if (!user) return onStateCb({ user: null, household: null });
    const snap = await fs.getDoc(fs.doc(db, 'users', user.uid));
    hid = snap.exists() ? snap.data().hid : null;
    if (!hid) return onStateCb({ user: me(), household: null });
    const h = await fs.getDoc(fs.doc(db, 'households', hid));
    onStateCb({ user: me(), household: h.exists() ? { id: hid, ...h.data() } : null });
  };
  const me = () => ({ uid: user.uid, name: user.displayName || user.email });
  const items = () => fs.collection(db, 'households', hid, 'items');

  return {
    mode: 'cloud',
    async init(cb) { onStateCb = cb; authM.onAuthStateChanged(auth, (u) => { user = u; emit(); }); },
    async signIn() {
      const p = new authM.GoogleAuthProvider();
      try { await authM.signInWithPopup(auth, p); } catch (e) { if (e.code !== 'auth/popup-closed-by-user') await authM.signInWithRedirect(auth, p); }
    },
    async signOut() { await authM.signOut(auth); },
    async createHousehold(name) {
      const id = newCode();
      await fs.setDoc(fs.doc(db, 'households', id), { name, members: [user.uid], createdAt: Date.now() });
      await fs.setDoc(fs.doc(db, 'users', user.uid), { hid: id });
      await emit();
    },
    async joinHousehold(code) {
      const id = code.trim().toUpperCase();
      await fs.updateDoc(fs.doc(db, 'households', id), { members: fs.arrayUnion(user.uid) });
      await fs.setDoc(fs.doc(db, 'users', user.uid), { hid: id });
      await emit();
    },
    // cb(品目一覧, {pending: 送信待ちあり}) / 失敗時は onErr(エラー)
    subscribe(cb, onErr) {
      return fs.onSnapshot(items(), { includeMetadataChanges: true },
        (s) => cb(s.docs.map((d) => ({ ...d.data(), id: d.id })), { pending: s.metadata.hasPendingWrites }),
        (e) => onErr?.(e));
    },
    async save(item) {
      const id = item.id || uid();
      // Firestore は undefined を含む保存を拒否するので取り除く
      const rec = JSON.parse(JSON.stringify({ ...item, id, updatedAt: Date.now(), updatedBy: user.displayName || user.email }));
      await fs.setDoc(fs.doc(items(), id), rec);
    },
    async remove(id) { await fs.deleteDoc(fs.doc(items(), id)); },
  };
}

export const createStore = () => (CLOUD ? cloudStore() : Promise.resolve(localStore()));
