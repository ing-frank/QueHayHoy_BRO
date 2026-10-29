/**
 * QueHayHoy BRO — app.js v4
 * Utilidades globales, AI Assistant, WebSocket GPS, Web Push, OAuth, offline
 */

/* ═══════════════════════════════════════════════
   1. THEME MANAGER
═══════════════════════════════════════════════ */
const Theme = {
  STORAGE_KEY: 'qhh_theme',
  ACCENT_KEY: 'qhh_accent',
  SIZE_KEY: 'qhh_textsize',

  init() {
    const saved = this.get();
    this.apply(saved);
    // Escuchar cambios del sistema
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      if (this.get() === 'auto') this.apply('auto');
    });
  },

  get() {
    try { return localStorage.getItem(this.STORAGE_KEY) || 'dark'; } catch { return 'dark'; }
  },

  set(value) {
    try { localStorage.setItem(this.STORAGE_KEY, value); } catch {}
    this.apply(value);
    // Sincronizar con backend si está logueado
    if (API && API.auth.isLoggedIn()) {
      API.request('PATCH', '/api/users/preferences', { theme: value }).catch(() => {});
    }
  },

  apply(value) {
    const root = document.documentElement;
    if (value === 'light') {
      root.setAttribute('data-theme', 'light');
    } else if (value === 'auto') {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', isDark ? 'dark' : 'light');
    } else {
      root.removeAttribute('data-theme');
    }
  },

  setAccent(color) {
    try { localStorage.setItem(this.ACCENT_KEY, color); } catch {}
    document.documentElement.style.setProperty('--primary', color);
  },

  getAccent() {
    try { return localStorage.getItem(this.ACCENT_KEY) || '#6366F1'; } catch { return '#6366F1'; }
  },

  setTextSize(size) {
    // size: 'sm' | 'md' | 'lg' | 'xl'
    const sizes = { sm: '14px', md: '16px', lg: '18px', xl: '20px' };
    try { localStorage.setItem(this.SIZE_KEY, size); } catch {}
    document.documentElement.style.setProperty('--text-base', sizes[size] || '16px');
  }
};

/* ═══════════════════════════════════════════════
   2. TOAST NOTIFICATIONS
═══════════════════════════════════════════════ */
const Toast = {
  container: null,
  queue: [],
  active: 0,
  MAX: 3,

  _ensureContainer() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = 'toast-container';
      this.container.setAttribute('aria-live', 'polite');
      this.container.setAttribute('aria-atomic', 'false');
      this.container.style.cssText = `
        position: fixed; top: 1rem; right: 1rem; z-index: 9999;
        display: flex; flex-direction: column; gap: 0.5rem;
        pointer-events: none;
      `;
      document.body.appendChild(this.container);
    }
    return this.container;
  },

  show(message, type = 'info', duration = 3500) {
    if (this.active >= this.MAX) {
      this.queue.push({ message, type, duration });
      return;
    }
    this.active++;
    const c = this._ensureContainer();
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', 'alert');
    el.style.cssText = `pointer-events: all; cursor: pointer;`;
    el.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-msg">${this._esc(message)}</span>`;
    el.addEventListener('click', () => this._dismiss(el));
    c.appendChild(el);
    // Animar entrada
    requestAnimationFrame(() => el.classList.add('toast-visible'));
    setTimeout(() => this._dismiss(el), duration);
  },

  _dismiss(el) {
    if (!el.parentNode) return;
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => {
      el.remove();
      this.active = Math.max(0, this.active - 1);
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        this.show(next.message, next.type, next.duration);
      }
    }, { once: true });
  },

  _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  },

  success(msg, d) { this.show(msg, 'success', d); },
  error(msg, d)   { this.show(msg, 'error', d); },
  warning(msg, d) { this.show(msg, 'warning', d); },
  info(msg, d)    { this.show(msg, 'info', d); }
};

/* ═══════════════════════════════════════════════
   3. OFFLINE BANNER
═══════════════════════════════════════════════ */
const OfflineBanner = {
  el: null,
  init() {
    this.el = document.getElementById('offline-banner');
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.id = 'offline-banner';
      this.el.textContent = 'Sin conexión — modo offline';
      document.body.prepend(this.el);
    }
    window.addEventListener('online',  () => { this.hide(); Toast.success('Conexión restaurada'); });
    window.addEventListener('offline', () => { this.show(); Toast.warning('Sin conexión a internet'); });
    if (!navigator.onLine) this.show();
  },
  show() { this.el && this.el.classList.add('visible'); },
  hide() { this.el && this.el.classList.remove('visible'); }
};

/* ═══════════════════════════════════════════════
   4. SERVICE WORKER (PWA)
═══════════════════════════════════════════════ */
const SW = {
  async register() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      console.log('[SW] Registrado:', reg.scope);
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            Toast.info('Nueva versión disponible. Recarga para actualizar.');
          }
        });
      });
      return reg;
    } catch (err) {
      console.warn('[SW] Error:', err);
    }
  }
};

/* ═══════════════════════════════════════════════
   5. WEB PUSH NOTIFICATIONS
═══════════════════════════════════════════════ */
const PushManager = {
  VAPID_PUBLIC_KEY: '__VAPID_PUBLIC_KEY__', // Reemplazar en producción

  async subscribe() {
    if (!('PushManager' in window)) {
      Toast.warning('Tu navegador no soporta notificaciones push');
      return null;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        Toast.warning('Notificaciones denegadas');
        return null;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this._urlBase64ToUint8Array(this.VAPID_PUBLIC_KEY)
      });
      // Enviar suscripción al backend
      await API.request('POST', '/api/users/push-subscription', sub.toJSON());
      Toast.success('Notificaciones activadas 🔔');
      return sub;
    } catch (err) {
      console.warn('[Push]', err);
      Toast.error('No se pudieron activar las notificaciones');
      return null;
    }
  },

  async unsubscribe() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
        await API.request('DELETE', '/api/users/push-subscription').catch(() => {});
        Toast.info('Notificaciones desactivadas');
      }
    } catch (err) {
      console.warn('[Push] Unsubscribe:', err);
    }
  },

  async getStatus() {
    if (!('PushManager' in window)) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'subscribed' : 'unsubscribed';
  },

  _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }
};

/* ═══════════════════════════════════════════════
   6. SEARCH — Intelligent debounced search
═══════════════════════════════════════════════ */
const Search = {
  _timers: {},
  debounce(key, fn, delay = 350) {
    clearTimeout(this._timers[key]);
    this._timers[key] = setTimeout(fn, delay);
  },

  async query(term, filters = {}) {
    if (!term || term.length < 2) return [];
    try {
      const params = new URLSearchParams({ q: term, ...filters });
      const res = await API.request('GET', `/api/search?${params}`);
      return res.results || [];
    } catch {
      return [];
    }
  },

  highlight(text, term) {
    if (!term) return text;
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(re, '<mark>$1</mark>');
  }
};

/* ═══════════════════════════════════════════════
   7. PROVINCE SELECTOR
═══════════════════════════════════════════════ */
const Province = {
  STORAGE_KEY: 'qhh_province',
  LIST: [
    { code: 'SD', name: 'Santo Domingo', emoji: '🏙️' },
    { code: 'STG', name: 'Santiago', emoji: '⛰️' },
    { code: 'PUJ', name: 'Punta Cana', emoji: '🌴' },
    { code: 'LR', name: 'La Romana', emoji: '🎭' },
    { code: 'SFM', name: 'San Francisco de Macorís', emoji: '🌿' },
    { code: 'BAR', name: 'Barahona', emoji: '🏖️' },
    { code: 'MAO', name: 'Valverde (Mao)', emoji: '🌾' },
    { code: 'SAMA', name: 'Samaná', emoji: '🐋' },
    { code: 'PMP', name: 'Puerto Plata', emoji: '🏔️' },
    { code: 'HIG', name: 'Higüey', emoji: '⛪' },
    { code: 'AZU', name: 'Azua', emoji: '🏜️' },
    { code: 'COT', name: 'Cotui', emoji: '🌲' },
    { code: 'MOC', name: 'Moca', emoji: '☕' },
    { code: 'NAV', name: 'Neiba', emoji: '🍇' },
    { code: 'SJM', name: 'San Juan de la Maguana', emoji: '🌻' },
    { code: 'EL_SEY', name: 'El Seibo', emoji: '🌿' },
    { code: 'HAT_M', name: 'Hato Mayor', emoji: '🐄' },
    { code: 'JAR', name: 'Jarabacoa', emoji: '🏞️' },
    { code: 'CON', name: 'Constanza', emoji: '🍓' },
    { code: 'OTRO', name: 'Toda RD', emoji: '🇩🇴' }
  ],

  get() {
    try { return JSON.parse(localStorage.getItem(this.STORAGE_KEY)) || this.LIST[0]; }
    catch { return this.LIST[0]; }
  },

  set(province) {
    try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(province)); } catch {}
    document.dispatchEvent(new CustomEvent('province:change', { detail: province }));
    // Actualizar banner si existe
    const banner = document.getElementById('province-name');
    if (banner) banner.textContent = province.name;
    const emoji = document.getElementById('province-emoji');
    if (emoji) emoji.textContent = province.emoji;
  },

  openModal() {
    const existing = document.getElementById('province-modal');
    if (existing) { existing.remove(); return; }
    const modal = document.createElement('div');
    modal.id = 'province-modal';
    modal.className = 'modal-overlay active';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Seleccionar provincia');
    const current = this.get();
    modal.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-header">
          <h3 class="modal-title">¿Dónde estás?</h3>
          <button class="modal-close" onclick="document.getElementById('province-modal').remove()" aria-label="Cerrar">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;max-height:60vh;overflow-y:auto;padding:1rem 0;">
          ${this.LIST.map(p => `
            <button onclick="Province._select(${JSON.stringify(p).replace(/"/g,'&quot;')})"
              class="btn ${p.code === current.code ? 'btn-primary' : 'btn-ghost'}"
              style="justify-content:flex-start;gap:0.5rem;">
              ${p.emoji} ${p.name}
            </button>
          `).join('')}
        </div>
      </div>`;
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('active'));
  },

  _select(province) {
    this.set(province);
    const modal = document.getElementById('province-modal');
    if (modal) modal.remove();
    Toast.success(`Provincia: ${province.emoji} ${province.name}`);
  }
};

/* ═══════════════════════════════════════════════
   8. AI ASSISTANT (Claude Haiku)
═══════════════════════════════════════════════ */
const AIAssistant = {
  isOpen: false,
  history: [],
  STORAGE_KEY: 'qhh_ai_history',

  init() {
    if (!document.getElementById('ai-fab')) this._injectUI();
    try {
      const saved = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '[]');
      this.history = saved.slice(-20); // últimos 20 mensajes
    } catch { this.history = []; }
  },

  _injectUI() {
    const container = document.createElement('div');
    container.innerHTML = `
      <button id="ai-fab" class="ai-fab" onclick="AIAssistant.toggle()"
        aria-label="Asistente IA" aria-expanded="false">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z"/>
          <path d="M12 8v4M12 16h.01"/>
        </svg>
        <span class="ai-pulse"></span>
      </button>
      <div id="ai-chat" class="ai-chat" role="dialog" aria-label="Asistente IA" aria-hidden="true">
        <div class="ai-chat-header">
          <div class="ai-chat-title">
            <div class="ai-avatar">🤖</div>
            <div>
              <div style="font-weight:700;font-size:0.9rem;">BRO Assistant</div>
              <div style="font-size:0.75rem;color:var(--success);">● En línea</div>
            </div>
          </div>
          <button onclick="AIAssistant.close()" class="btn btn-ghost" style="padding:0.4rem;" aria-label="Cerrar chat">✕</button>
        </div>
        <div id="ai-messages" class="ai-messages" aria-live="polite" aria-label="Mensajes del asistente">
          <div class="ai-message ai-bot">
            <div class="ai-bubble">¡Hola! 🇩🇴 Soy tu asistente BRO. ¿Qué planes tienes para hoy? Te ayudo a encontrar eventos, lugares o lo que necesites en tu zona.</div>
          </div>
        </div>
        <div class="ai-input-row">
          <input id="ai-input" type="text" class="ai-input" placeholder="Pregúntame algo..."
            autocomplete="off" maxlength="500"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();AIAssistant.send();}"/>
          <button onclick="AIAssistant.send()" class="ai-send" aria-label="Enviar mensaje">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </div>`;
    document.body.appendChild(container);
  },

  toggle() {
    this.isOpen ? this.close() : this.open();
  },

  open() {
    this.isOpen = true;
    const chat = document.getElementById('ai-chat');
    const fab  = document.getElementById('ai-fab');
    if (chat) { chat.classList.add('open'); chat.setAttribute('aria-hidden', 'false'); }
    if (fab)  fab.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.getElementById('ai-input')?.focus(), 300);
  },

  close() {
    this.isOpen = false;
    const chat = document.getElementById('ai-chat');
    const fab  = document.getElementById('ai-fab');
    if (chat) { chat.classList.remove('open'); chat.setAttribute('aria-hidden', 'true'); }
    if (fab)  fab.setAttribute('aria-expanded', 'false');
  },

  async send() {
    const input = document.getElementById('ai-input');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    this._addMessage('user', msg);
    this.history.push({ role: 'user', content: msg });
    this._showTyping();
    try {
      const province = Province.get();
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(API.auth.getToken() ? { 'Authorization': `Bearer ${API.auth.getToken()}` } : {})
        },
        body: JSON.stringify({
          message: msg,
          history: this.history.slice(-10),
          context: { province: province.name, app: 'QueHayHoyBRO' }
        })
      });
      this._removeTyping();
      if (!res.ok) throw new Error('Error del servidor');
      const data = await res.json();
      const reply = data.reply || data.message || 'No entendí, ¿puedes repetirlo?';
      this._addMessage('bot', reply);
      this.history.push({ role: 'assistant', content: reply });
      try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.history.slice(-20))); } catch {}
    } catch {
      this._removeTyping();
      this._addMessage('bot', '¡Ups! No pude conectarme. Intenta de nuevo en un momento 🙏');
    }
  },

  _addMessage(role, text) {
    const msgs = document.getElementById('ai-messages');
    if (!msgs) return;
    const el = document.createElement('div');
    el.className = `ai-message ai-${role}`;
    el.innerHTML = `<div class="ai-bubble">${this._formatText(text)}</div>`;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  },

  _showTyping() {
    const msgs = document.getElementById('ai-messages');
    if (!msgs) return;
    const el = document.createElement('div');
    el.id = 'ai-typing';
    el.className = 'ai-message ai-bot';
    el.innerHTML = `<div class="ai-bubble ai-typing-indicator">
      <span></span><span></span><span></span>
    </div>`;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  },

  _removeTyping() {
    document.getElementById('ai-typing')?.remove();
  },

  _formatText(text) {
    return text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }
};

/* ═══════════════════════════════════════════════
   9. WEBSOCKET GPS (Ambulancias / Tiempo real)
═══════════════════════════════════════════════ */
const RealtimeGPS = {
  ws: null,
  listeners: {},
  reconnectDelay: 3000,
  _reconnectTimer: null,

  connect(token) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/gps${token ? `?token=${token}` : ''}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.onopen    = () => { console.log('[GPS WS] Conectado'); clearTimeout(this._reconnectTimer); };
    this.ws.onmessage = (e) => { try { this._handle(JSON.parse(e.data)); } catch {} };
    this.ws.onclose   = () => { this._reconnect(token); };
    this.ws.onerror   = () => {};
  },

  disconnect() {
    clearTimeout(this._reconnectTimer);
    if (this.ws) { this.ws.close(); this.ws = null; }
  },

  _reconnect(token) {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.connect(token), this.reconnectDelay);
  },

  _handle(data) {
    const { type, ...payload } = data;
    (this.listeners[type] || []).forEach(cb => cb(payload));
    (this.listeners['*'] || []).forEach(cb => cb(data));
  },

  on(type, callback) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(callback);
  },

  off(type, callback) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter(cb => cb !== callback);
  },

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
};

/* ═══════════════════════════════════════════════
   10. USER PREFERENCES (Settings)
═══════════════════════════════════════════════ */
const Prefs = {
  STORAGE_KEY: 'qhh_prefs',

  defaults: {
    theme: 'dark',
    accentColor: '#6366F1',
    textSize: 'md',
    language: 'es',
    reduceMotion: false,
    autoplay: true,
    dataMode: false,
    // Privacidad
    profileVisibility: 'public',
    showOnlineStatus: true,
    showLastSeen: true,
    allowMessages: 'all',
    allowComments: 'all',
    // Notificaciones
    notifLikes: true,
    notifComments: true,
    notifFollowers: true,
    notifMessages: true,
    notifPush: true,
    notifEmail: false,
    notifSounds: true,
    quietHoursEnabled: false,
    quietHoursStart: '22:00',
    quietHoursEnd: '08:00',
    // Bienestar
    dailyLimit: 0,
    breakReminder: false,
    breakInterval: 60,
    // Accesibilidad
    highContrast: false,
    largeText: false,
    screenReader: false,
    // Contenido
    defaultAudience: 'public',
    autoplayVideos: true,
    videoQuality: 'auto',
  },

  _cache: null,

  get(key) {
    if (!this._cache) this._load();
    return key ? this._cache[key] ?? this.defaults[key] : { ...this.defaults, ...this._cache };
  },

  set(key, value) {
    if (!this._cache) this._load();
    this._cache[key] = value;
    this._save();
    document.dispatchEvent(new CustomEvent('pref:change', { detail: { key, value } }));
    // Aplicar inmediatamente si aplica
    if (key === 'theme') Theme.set(value);
    if (key === 'accentColor') Theme.setAccent(value);
    if (key === 'textSize') Theme.setTextSize(value);
    if (key === 'reduceMotion') {
      document.documentElement.classList.toggle('reduce-motion', value);
    }
  },

  setMany(obj) {
    if (!this._cache) this._load();
    Object.assign(this._cache, obj);
    this._save();
    Object.entries(obj).forEach(([k, v]) => {
      document.dispatchEvent(new CustomEvent('pref:change', { detail: { key: k, value: v } }));
    });
  },

  _load() {
    try {
      this._cache = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
    } catch { this._cache = {}; }
  },

  _save() {
    try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._cache)); } catch {}
    // Sync remoto (debounced)
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      if (API && API.auth.isLoggedIn()) {
        API.request('PATCH', '/api/users/preferences', this._cache).catch(() => {});
      }
    }, 1500);
  },

  async syncFromServer() {
    if (!API || !API.auth.isLoggedIn()) return;
    try {
      const serverPrefs = await API.request('GET', '/api/users/preferences');
      if (serverPrefs) {
        this._cache = { ...(this._cache || {}), ...serverPrefs };
        try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._cache)); } catch {}
        // Aplicar tema del servidor
        if (serverPrefs.theme) Theme.apply(serverPrefs.theme);
      }
    } catch {}
  },

  reset() {
    this._cache = { ...this.defaults };
    this._save();
    Toast.info('Preferencias restablecidas');
  }
};

/* ═══════════════════════════════════════════════
   11. DIGITAL WELLBEING
═══════════════════════════════════════════════ */
const Wellbeing = {
  STORAGE_KEY: 'qhh_wellbeing',
  _startTime: Date.now(),
  _todayKey: null,
  _checkTimer: null,

  init() {
    this._todayKey = new Date().toDateString();
    this._checkTimer = setInterval(() => this._check(), 60000);
    window.addEventListener('beforeunload', () => this._save());
  },

  getTimeToday() {
    const data = this._load();
    const todayMs = data[this._todayKey] || 0;
    const sessionMs = Date.now() - this._startTime;
    return todayMs + sessionMs;
  },

  getTimeTodayFormatted() {
    const ms = this.getTimeToday();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}min`;
    return `${Math.floor(mins/60)}h ${mins%60}min`;
  },

  _check() {
    const limit = Prefs.get('dailyLimit');
    if (!limit) return;
    const minutes = Math.floor(this.getTimeToday() / 60000);
    if (minutes >= limit && !this._limitNotified) {
      this._limitNotified = true;
      Toast.warning(`⏰ Llevas ${this.getTimeTodayFormatted()} en la app hoy`);
    }
  },

  _load() {
    try { return JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}'); } catch { return {}; }
  },

  _save() {
    try {
      const data = this._load();
      const sessionMs = Date.now() - this._startTime;
      data[this._todayKey] = (data[this._todayKey] || 0) + sessionMs;
      // Limpiar datos > 30 días
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      Object.keys(data).forEach(k => {
        if (new Date(k) < cutoff) delete data[k];
      });
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }
};

/* ═══════════════════════════════════════════════
   12. BLOCKED USERS (Privacy)
═══════════════════════════════════════════════ */
const BlockList = {
  async getList() {
    try { return await API.request('GET', '/api/users/blocked'); } catch { return []; }
  },
  async block(userId) {
    await API.request('POST', `/api/users/${userId}/block`);
    Toast.success('Usuario bloqueado');
  },
  async unblock(userId) {
    await API.request('DELETE', `/api/users/${userId}/block`);
    Toast.success('Usuario desbloqueado');
  }
};

/* ═══════════════════════════════════════════════
   13. SESSION MANAGER (Security)
═══════════════════════════════════════════════ */
const Sessions = {
  async getAll() {
    try { return await API.request('GET', '/api/users/sessions'); } catch { return []; }
  },
  async revoke(sessionId) {
    await API.request('DELETE', `/api/users/sessions/${sessionId}`);
    Toast.success('Sesión cerrada');
  },
  async revokeAll() {
    await API.request('DELETE', '/api/users/sessions');
    API.auth.clearTokens();
    Toast.success('Todas las sesiones cerradas');
    setTimeout(() => window.location.href = '/login.html', 1200);
  }
};

/* ═══════════════════════════════════════════════
   14. DATA EXPORT
═══════════════════════════════════════════════ */
const DataExport = {
  async request() {
    try {
      await API.request('POST', '/api/users/data-export');
      Toast.success('Solicitud enviada. Recibirás un email en 24-48 horas.');
    } catch {
      Toast.error('Error al solicitar datos. Intenta más tarde.');
    }
  }
};

/* ═══════════════════════════════════════════════
   15. ACCOUNT MANAGER (Delete / Deactivate)
═══════════════════════════════════════════════ */
const Account = {
  async deactivate(password) {
    try {
      await API.request('POST', '/api/users/deactivate', { password });
      API.auth.clearTokens();
      Toast.info('Cuenta desactivada. Hasta pronto 👋');
      setTimeout(() => window.location.href = '/login.html', 1500);
    } catch (err) {
      Toast.error(err.message || 'Error al desactivar cuenta');
      throw err;
    }
  },

  async delete(password, reason) {
    try {
      await API.request('DELETE', '/api/users/account', { password, reason });
      API.auth.clearTokens();
      Toast.info('Cuenta eliminada permanentemente');
      setTimeout(() => window.location.href = '/login.html', 1500);
    } catch (err) {
      Toast.error(err.message || 'Error al eliminar cuenta');
      throw err;
    }
  }
};

/* ═══════════════════════════════════════════════
   16. REPORT SYSTEM
═══════════════════════════════════════════════ */
const Report = {
  CATEGORIES: [
    'Spam o contenido engañoso',
    'Acoso o bullying',
    'Contenido inapropiado',
    'Información falsa',
    'Violación de privacidad',
    'Venta de productos ilegales',
    'Otro'
  ],

  async submit({ type, targetId, category, description }) {
    try {
      await API.request('POST', '/api/reports', { type, targetId, category, description });
      Toast.success('Reporte enviado. Lo revisaremos pronto.');
    } catch {
      Toast.error('Error al enviar reporte');
    }
  },

  openModal(type, targetId) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Reportar');
    modal.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-header">
          <h3 class="modal-title">Reportar</h3>
          <button onclick="this.closest('.modal-overlay').remove()" class="modal-close" aria-label="Cerrar">✕</button>
        </div>
        <div style="padding:1rem 0;">
          <p style="color:var(--gris);margin-bottom:1rem;font-size:0.9rem;">Selecciona el motivo del reporte:</p>
          ${this.CATEGORIES.map((cat, i) => `
            <label style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem 0;border-bottom:1px solid var(--negro3);cursor:pointer;">
              <input type="radio" name="report-cat" value="${cat}" ${i===0?'checked':''} style="accent-color:var(--primary);">
              <span>${cat}</span>
            </label>
          `).join('')}
          <textarea id="report-desc" placeholder="Detalles adicionales (opcional)"
            style="width:100%;margin-top:1rem;background:var(--negro3);border:1px solid var(--negro4);border-radius:8px;padding:0.75rem;color:var(--blanco);font-family:inherit;resize:vertical;min-height:80px;"></textarea>
          <button class="btn btn-primary btn-full" style="margin-top:1rem;" onclick="
            const cat = document.querySelector('input[name=report-cat]:checked')?.value;
            const desc = document.getElementById('report-desc').value;
            Report.submit({type:'${type}',targetId:'${targetId}',category:cat,description:desc});
            this.closest('.modal-overlay').remove();
          ">Enviar reporte</button>
        </div>
      </div>`;
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('active'));
  }
};

/* ═══════════════════════════════════════════════
   17. QUIET HOURS
═══════════════════════════════════════════════ */
const QuietHours = {
  isActive() {
    if (!Prefs.get('quietHoursEnabled')) return false;
    const now = new Date();
    const [sh, sm] = (Prefs.get('quietHoursStart') || '22:00').split(':').map(Number);
    const [eh, em] = (Prefs.get('quietHoursEnd') || '08:00').split(':').map(Number);
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;
    if (startMins > endMins) {
      return nowMins >= startMins || nowMins < endMins;
    }
    return nowMins >= startMins && nowMins < endMins;
  }
};

/* ═══════════════════════════════════════════════
   18. ACCESSIBILITY
═══════════════════════════════════════════════ */
const A11y = {
  init() {
    if (Prefs.get('reduceMotion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.documentElement.classList.add('reduce-motion');
    }
    if (Prefs.get('highContrast')) {
      document.documentElement.classList.add('high-contrast');
    }
    // Focus visible polyfill
    document.addEventListener('mousedown', () => document.body.classList.add('using-mouse'));
    document.addEventListener('keydown',   () => document.body.classList.remove('using-mouse'));
  }
};

/* ═══════════════════════════════════════════════
   19. INIT — Arrancar todo
═══════════════════════════════════════════════ */
(function init() {
  // Esperar DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

  function _boot() {
    Theme.init();
    A11y.init();
    OfflineBanner.init();
    SW.register();
    AIAssistant.init();
    Wellbeing.init();

    // Si hay usuario logueado
    if (typeof API !== 'undefined' && API.auth.isLoggedIn()) {
      Prefs.syncFromServer().catch(() => {});
    }

    // Aplicar preferencias guardadas al inicio
    const accent = Theme.getAccent();
    if (accent !== '#6366F1') Theme.setAccent(accent);

    const textSize = Prefs.get('textSize');
    if (textSize !== 'md') Theme.setTextSize(textSize);

    // Keyboard shortcut: Escape para cerrar modales
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal = document.querySelector('.modal-overlay.active');
        if (modal) modal.remove();
        if (AIAssistant.isOpen) AIAssistant.close();
      }
    });

    console.log('🇩🇴 QueHayHoy BRO v4 — Ready');
  }
})();
