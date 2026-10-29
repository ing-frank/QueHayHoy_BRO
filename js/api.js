/**
 * QueHayHoy BRO — API Client v4
 * Módulo central de comunicación con el backend FastAPI
 * Maneja auth tokens, refresh automático, interceptores y errores
 */

const API = (() => {
  /* ─── Config ─── */
  const BASE_URL = (() => {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return 'http://localhost:8000';
    }
    return 'https://api.quehayhoy.do'; // Producción — pendiente configurar
  })();

  const TIMEOUT_MS = 12000;

  /* ─── Token storage ─── */
  const auth = {
    getAccessToken: () => localStorage.getItem('qhh_access_token'),
    getRefreshToken: () => localStorage.getItem('qhh_refresh_token'),
    setTokens: (access, refresh) => {
      localStorage.setItem('qhh_access_token', access);
      if (refresh) localStorage.setItem('qhh_refresh_token', refresh);
    },
    clearTokens: () => {
      localStorage.removeItem('qhh_access_token');
      localStorage.removeItem('qhh_refresh_token');
      localStorage.removeItem('qhh_user');
    },
    isLoggedIn: () => !!localStorage.getItem('qhh_access_token'),
    getUser: () => {
      try { return JSON.parse(localStorage.getItem('qhh_user') || 'null'); }
      catch { return null; }
    },
    setUser: (user) => localStorage.setItem('qhh_user', JSON.stringify(user)),
  };

  /* ─── Request core ─── */
  let _refreshing = false;
  let _refreshQueue = [];

  async function _doRefresh() {
    const rt = auth.getRefreshToken();
    if (!rt) throw new Error('NO_REFRESH_TOKEN');
    const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (!res.ok) throw new Error('REFRESH_FAILED');
    const data = await res.json();
    auth.setTokens(data.access_token, data.refresh_token);
    return data.access_token;
  }

  async function request(method, path, body = undefined, opts = {}) {
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const headers = { ...(opts.headers || {}) };
    if (!(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    const token = auth.getAccessToken();
    if (token && !opts.skipAuth) headers['Authorization'] = `Bearer ${token}`;

    const fetchOpts = {
      method,
      headers,
      signal: controller.signal,
    };
    if (body !== undefined) {
      fetchOpts.body = body instanceof FormData ? body : JSON.stringify(body);
    }

    try {
      let res = await fetch(url, fetchOpts);

      /* Auto-refresh on 401 */
      if (res.status === 401 && !opts.skipAuth && !opts._retried) {
        if (!_refreshing) {
          _refreshing = true;
          try {
            const newToken = await _doRefresh();
            _refreshQueue.forEach(r => r(newToken));
          } catch (e) {
            _refreshQueue.forEach(r => r(null));
            auth.clearTokens();
            window.location.href = '/pages/auth.html';
            return;
          } finally {
            _refreshing = false;
            _refreshQueue = [];
          }
        } else {
          await new Promise(resolve => _refreshQueue.push(resolve));
        }
        return request(method, path, body, { ...opts, _retried: true });
      }

      clearTimeout(timer);

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const errData = await res.json();
          errMsg = errData.detail || errData.message || errMsg;
        } catch {}
        const err = new Error(errMsg);
        err.status = res.status;
        throw err;
      }

      if (res.status === 204) return null;
      return await res.json();

    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('TIMEOUT');
      throw e;
    }
  }

  /* ─── Auth endpoints ─── */
  const authAPI = {
    login: (email, password) =>
      request('POST', '/api/auth/login', { email, password }, { skipAuth: true }),

    register: (data) =>
      request('POST', '/api/auth/register', data, { skipAuth: true }),

    logout: async () => {
      try { await request('POST', '/api/auth/logout'); } catch {}
      auth.clearTokens();
      window.location.href = '/pages/auth.html';
    },

    forgotPassword: (email) =>
      request('POST', '/api/auth/forgot-password', { email }, { skipAuth: true }),

    resetPassword: (token, password) =>
      request('POST', '/api/auth/reset-password', { token, password }, { skipAuth: true }),

    me: () => request('GET', '/api/users/me'),

    changePassword: (current, newPwd) =>
      request('POST', '/api/auth/change-password', {
        current_password: current,
        new_password: newPwd,
      }),

    sessions: () => request('GET', '/api/auth/sessions'),
    revokeSession: (id) => request('DELETE', `/api/auth/sessions/${id}`),
    revokeAllSessions: () => request('DELETE', '/api/auth/sessions'),

    setup2FA: () => request('POST', '/api/auth/totp/setup'),
    enable2FA: (code) => request('POST', '/api/auth/2fa/enable', { code }),
  };

  /* ─── Events endpoints ─── */
  const eventsAPI = {
    list: (params = {}) => {
      const q = new URLSearchParams(params).toString();
      return request('GET', `/api/events${q ? '?' + q : ''}`);
    },
    get: (id) => request('GET', `/api/events/${id}`),
    create: (data) => request('POST', '/api/events', data),
    update: (id, data) => request('PATCH', `/api/events/${id}`, data),
    delete: (id) => request('DELETE', `/api/events/${id}`),
    near: (lat, lng, radius = 5000) =>
      request('GET', `/api/events/near?lat=${lat}&lng=${lng}&radius=${radius}`),
    rsvp: (id) => request('POST', `/api/events/${id}/rsvp`),
    cancelRsvp: (id) => request('DELETE', `/api/events/${id}/rsvp`),
  };

  /* ─── Venues endpoints ─── */
  const venuesAPI = {
    list: (params = {}) => {
      const q = new URLSearchParams(params).toString();
      return request('GET', `/api/venues${q ? '?' + q : ''}`);
    },
    get: (id) => request('GET', `/api/venues/${id}`),
    near: (lat, lng, radius = 5000) =>
      request('GET', `/api/venues/near?lat=${lat}&lng=${lng}&radius=${radius}`),
    reviews: (id) => request('GET', `/api/venues/${id}/reviews`),
    addReview: (id, data) => request('POST', `/api/venues/${id}/reviews`, data),
    photos: (id) => request('GET', `/api/venues/${id}/photos`),
    checkin: (id) => request('POST', `/api/venues/${id}/checkin`),
    favorite: (id) => request('POST', `/api/venues/${id}/favorite`),
    unfavorite: (id) => request('DELETE', `/api/venues/${id}/favorite`),
  };

  /* ─── Users/Profile endpoints ─── */
  const usersAPI = {
    profile: (id) => request('GET', `/api/users/${id}`),
    updateProfile: (data) => request('PATCH', '/api/users/profile', data),
    uploadAvatar: (file) => {
      const fd = new FormData();
      fd.append('file', file);
      return request('POST', '/api/users/avatar', fd);
    },
    follow: (id) => request('POST', `/api/users/${id}/follow`),
    unfollow: (id) => request('DELETE', `/api/users/${id}/follow`),
    followers: (id) => request('GET', `/api/users/${id}/followers`),
    following: (id) => request('GET', `/api/users/${id}/following`),
    block: (id) => request('POST', `/api/users/${id}/block`),
    blocked: () => request('GET', '/api/users/blocked'),
    preferences: (data) => request('PATCH', '/api/users/preferences', data),
    exportData: () => request('POST', '/api/users/export-data'),
    deactivate: (pwd) => request('POST', '/api/users/deactivate', { password: pwd }),
    deleteAccount: (pwd) => request('DELETE', '/api/users/account', { password: pwd }),
  };

  /* ─── Posts/Feed endpoints ─── */
  const postsAPI = {
    feed: (cursor) => request('GET', `/api/feed${cursor ? '?cursor=' + cursor : ''}`),
    get: (id) => request('GET', `/api/posts/${id}`),
    create: (data) => request('POST', '/api/posts', data),
    delete: (id) => request('DELETE', `/api/posts/${id}`),
    like: (id) => request('POST', `/api/posts/${id}/like`),
    unlike: (id) => request('DELETE', `/api/posts/${id}/like`),
    save: (id) => request('POST', `/api/posts/${id}/save`),
    unsave: (id) => request('DELETE', `/api/posts/${id}/save`),
    comments: (id) => request('GET', `/api/posts/${id}/comments`),
    addComment: (id, text) => request('POST', `/api/posts/${id}/comments`, { text }),
    report: (id, reason) => request('POST', `/api/posts/${id}/report`, { reason }),
  };

  /* ─── Stories endpoints ─── */
  const storiesAPI = {
    list: (province) => request('GET', `/api/stories?province=${encodeURIComponent(province)}`),
    get: (id) => request('GET', `/api/stories/${id}`),
    create: (data) => request('POST', '/api/stories', data),
    view: (id) => request('POST', `/api/stories/${id}/view`),
    react: (id, emoji) => request('POST', `/api/stories/${id}/react`, { emoji }),
  };

  /* ─── Search endpoints ─── */
  const searchAPI = {
    all: (q, province) =>
      request('GET', `/api/search?q=${encodeURIComponent(q)}&province=${encodeURIComponent(province || '')}`),
    events: (q, params = {}) =>
      request('GET', `/api/search/events?q=${encodeURIComponent(q)}&${new URLSearchParams(params)}`),
    venues: (q, params = {}) =>
      request('GET', `/api/search/venues?q=${encodeURIComponent(q)}&${new URLSearchParams(params)}`),
    users: (q) =>
      request('GET', `/api/search/users?q=${encodeURIComponent(q)}`),
  };

  /* ─── AI endpoints ─── */
  const aiAPI = {
    chat: (message, context = {}) =>
      request('POST', '/api/ai/chat', { message, context }),
    recommend: (province, prefs = {}) =>
      request('POST', '/api/ai/recommend', { province, preferences: prefs }),
  };

  /* ─── Notifications endpoints ─── */
  const notifAPI = {
    list: (cursor) => request('GET', `/api/notifications${cursor ? '?cursor=' + cursor : ''}`),
    markRead: (id) => request('PATCH', `/api/notifications/${id}/read`),
    markAllRead: () => request('PATCH', '/api/notifications/read-all'),
    count: () => request('GET', '/api/notifications/count'),
  };

  /* ─── Uploads ─── */
  const uploadsAPI = {
    image: (file, type = 'post') => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('type', type);
      return request('POST', '/api/uploads/image', fd);
    },
    video: (file) => {
      const fd = new FormData();
      fd.append('file', file);
      return request('POST', '/api/uploads/video', fd);
    },
  };

  /* ─── Reports ─── */
  const reportsAPI = {
    user: (userId, reason, detail) =>
      request('POST', '/api/reports/user', { user_id: userId, reason, detail }),
    content: (contentId, type, reason) =>
      request('POST', '/api/reports/content', { content_id: contentId, content_type: type, reason }),
    bug: (data) =>
      request('POST', '/api/reports/bug', data),
    emergency: (data) =>
      request('POST', '/api/emergency', data),
  };

  /* ─── Business/Negocio endpoints ─── */
  const businessAPI = {
    profile: () => request('GET', '/api/business/me'),
    updateProfile: (data) => request('PATCH', '/api/business/profile', data),
    events: (params = {}) => request('GET', `/api/business/events?${new URLSearchParams(params)}`),
    createEvent: (data) => request('POST', '/api/business/events', data),
    stats: () => request('GET', '/api/business/stats'),
    connectedApps: () => request('GET', '/api/users/connected-apps'),
    revokeApp: (id) => request('DELETE', `/api/users/connected-apps/${id}`),
  };

  /* ─── WebSocket helper ─── */
  const ws = {
    _socket: null,
    _handlers: {},
    connect: (path) => {
      const wsBase = BASE_URL.replace(/^http/, 'ws');
      const token = auth.getAccessToken();
      ws._socket = new WebSocket(`${wsBase}${path}?token=${token}`);
      ws._socket.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          const h = ws._handlers[data.type];
          if (h) h(data);
          const all = ws._handlers['*'];
          if (all) all(data);
        } catch {}
      };
      ws._socket.onclose = () => setTimeout(() => ws.connect(path), 3000);
      return ws._socket;
    },
    on: (type, handler) => { ws._handlers[type] = handler; },
    send: (type, payload) => {
      if (ws._socket?.readyState === WebSocket.OPEN) {
        ws._socket.send(JSON.stringify({ type, ...payload }));
      }
    },
    disconnect: () => {
      if (ws._socket) { ws._socket.onclose = null; ws._socket.close(); ws._socket = null; }
    },
  };

  /* ─── Geolocation helper ─── */
  const geo = {
    _cached: null,
    get: () => new Promise((resolve, reject) => {
      if (geo._cached) return resolve(geo._cached);
      if (!navigator.geolocation) return reject(new Error('NO_GEO'));
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          geo._cached = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
          setTimeout(() => { geo._cached = null; }, 60000); // expire 1 min
          resolve(geo._cached);
        },
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      );
    }),
    watch: (callback) => {
      if (!navigator.geolocation) return null;
      return navigator.geolocation.watchPosition(
        (pos) => callback({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        null,
        { enableHighAccuracy: true, maximumAge: 5000 }
      );
    },
    stopWatch: (id) => navigator.geolocation?.clearWatch(id),
  };

  /* ─── Device detection ─── */
  const device = {
    isMobile: () => window.innerWidth < 768,
    isIOS: () => /iPad|iPhone|iPod/.test(navigator.userAgent),
    isAndroid: () => /Android/.test(navigator.userAgent),
    isPWA: () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true,
    isOnline: () => navigator.onLine,
    prefersDark: () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    prefersReducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    safeAreaBottom: () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sab') || '0'),
    viewport: () => ({ w: window.innerWidth, h: window.innerHeight }),
  };

  /* ─── Offline queue ─── */
  const _queue = [];
  window.addEventListener('online', async () => {
    while (_queue.length) {
      const { method, path, body, resolve, reject } = _queue.shift();
      try { resolve(await request(method, path, body)); }
      catch (e) { reject(e); }
    }
  });

  function queueWhenOffline(method, path, body) {
    if (navigator.onLine) return request(method, path, body);
    return new Promise((resolve, reject) => {
      _queue.push({ method, path, body, resolve, reject });
    });
  }

  /* ─── Public API ─── */
  return {
    BASE_URL,
    auth,
    request,
    queueWhenOffline,
    ws,
    geo,
    device,
    events: eventsAPI,
    venues: venuesAPI,
    users: usersAPI,
    posts: postsAPI,
    stories: storiesAPI,
    search: searchAPI,
    ai: aiAPI,
    notifications: notifAPI,
    uploads: uploadsAPI,
    reports: reportsAPI,
    business: businessAPI,
  };
})();

/* Exponer globalmente */
window.API = API;
