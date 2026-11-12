// サーバーとの通信と、画面共通の小さな道具
(() => {
  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { 'X-Requested-With': 'koshu', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
    } catch {
      const e = new Error('通信できませんでした。電波の状態を確かめて、もう一度お試しください');
      e.network = true;
      throw e;
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      const e = new Error((data && data.error) || `エラーが発生しました（${res.status}）`);
      e.status = res.status;
      e.data = data || {};
      throw e;
    }
    return data;
  }

  const api = {
    get: path => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /** 要素を作る：h('td', {class:'num'}, '文字', 子要素…) */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  let toastTimer;
  function toast(message, bad = false) {
    let el = $('.toast');
    if (!el) document.body.append((el = h('div', { class: 'toast', role: 'status' })));
    el.textContent = message;
    el.classList.toggle('bad', bad);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), bad ? 6000 : 2500);
  }

  // 画面ごとの設定の記憶（使えない環境では何もしない）
  const memo = {
    get(key, fallback = null) {
      try {
        const v = localStorage.getItem('koshu.' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('koshu.' + key, JSON.stringify(value));
      } catch {}
    },
  };

  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

  /** ログイン確認。role が合わなければログイン画面へ戻す。 */
  async function requireLogin(role) {
    try {
      const me = await api.get('/api/me');
      if (role === 'admin' && me.role !== 'admin') throw new Error('not admin');
      return me;
    } catch {
      location.replace('/');
      return new Promise(() => {});
    }
  }

  async function logout() {
    try {
      await api.post('/api/logout');
    } catch {}
    location.replace('/');
  }

  window.koshu = { api, $, $$, h, toast, memo, newId, requireLogin, logout };
})();
