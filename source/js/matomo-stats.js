/**
 * Matomo Stats for Hexo Butterfly Theme
 * 通过代理接口安全获取并展示访问统计
 */

;(function () {
  'use strict';

  // ============ 配置 ============
  const PROXY_BASE = '/mstats';

  // 数字滚动动画
  function animateNumber(el, target, duration = 1200) {
    if (!el || target === 0) {
      if (el) el.textContent = '0';
      return;
    }
    const start = 0;
    const startTime = performance.now();

    function update(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const current = Math.floor(start + (target - start) * eased);
      el.textContent = current.toLocaleString();
      if (progress < 1) requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
  }

  // ============ 插入文章页访问量 DOM ============
  function insertPostViews() {
    if (!document.querySelector('#post')) return;
    const postMeta = document.querySelector('#post-meta .post-meta-date')
      || document.querySelector('.post-meta-date');
    if (!postMeta || document.getElementById('matomo-page-pv')) return;

    const viewsSpan = document.createElement('span');
    viewsSpan.innerHTML = `
      <span class="post-meta-separator">|</span>
      <span class="matomo-post-views">
        <span class="view-icon">👁️</span>
        <span class="view-count" id="matomo-page-pv">-</span> 次浏览
      </span>
    `;
    postMeta.parentNode.insertBefore(viewsSpan, postMeta.nextSibling);
  }

  // ============ 网站总量统计（页脚） ============
  async function loadSiteStats() {
    const pvEl = document.getElementById('matomo-site-pv');
    const uvEl = document.getElementById('matomo-site-uv');
    if (!pvEl && !uvEl) return;

    try {
      const res = await fetch(`${PROXY_BASE}/api/site-stats?period=month&date=today`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();

      if (pvEl) animateNumber(pvEl, data.totalPageViews);
      if (uvEl) animateNumber(uvEl, data.totalUniqueVisitors);

      const todayPvEl = document.getElementById('matomo-today-pv');
      const todayUvEl = document.getElementById('matomo-today-uv');
      if (todayPvEl) animateNumber(todayPvEl, data.today.pageViews);
      if (todayUvEl) animateNumber(todayUvEl, data.today.uniqueVisitors);
    } catch (err) {
      console.warn('[Matomo Stats] Failed to load site stats:', err.message);
      if (pvEl) pvEl.textContent = '-';
      if (uvEl) uvEl.textContent = '-';
    }
  }

  // ============ 文章访问量（文章页） ============
  async function loadPageStats() {
    const el = document.getElementById('matomo-page-pv');
    if (!el) return;

    const pagePath = window.location.pathname;

    try {
      const res = await fetch(
        `${PROXY_BASE}/api/page-stats?url=${encodeURIComponent(pagePath)}`
      );
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();

      animateNumber(el, data.pageViews);

      const uvEl = document.getElementById('matomo-page-uv');
      if (uvEl) animateNumber(uvEl, data.uniquePageViews);
    } catch (err) {
      console.warn('[Matomo Stats] Failed to load page stats:', err.message);
      el.textContent = '-';
    }
  }

  // ============ 初始化 ============
  function init() {
    insertPostViews();
    loadSiteStats();
    loadPageStats();
  }

  document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('pjax:complete', init);
  window.addEventListener('popstate', function () {
    setTimeout(init, 100);
  });
})();