// Facebook Ad Remover — content script.
//
// Detection (verified against facebook.com, Sep 2026):
// - Feed, primary signal: on ads, the timestamp link in the post header
//   (<a target="_blank">) starts with a U+2060 WORD JOINER text node, right where the
//   "Ad" label is drawn. Normal posts have no such node. This stays in the DOM.
// - Feed, backup signal: that link wraps a span with aria-labelledby pointing to a hidden
//   <span id="..."> reading "Ad"/"Sponsored" (or a date on normal posts). Facebook only
//   attaches it for about a second, so it is checked right inside the observer callback.
// - Feed post container: the child of the feed list; the list's parent starts with the
//   visually hidden "Feed posts" <h3>. Fallback: nearest ancestor holding the like button.
// - Sidebar: the [role=complementary] section whose <h3> reads "Sponsored".
// - Marketplace: ad tiles in the listing grid carry a plain-text "Ad" leaf (with a
//   leading zero-width space). The tile is the highest ancestor holding no
//   /marketplace/item/ links whose parent (the grid row) does.
// - Reels (/reel/...): ad reels carry a plain-text "Ad" leaf at the bottom of the card.
//   The reel's slot is the highest ancestor whose parent (the reels list, which keeps
//   the previous/current/next reels mounted) holds more than one <video>. The card is the
//   narrower column inside that full-width slot. In Hide mode, an ad reel that becomes
//   the current reel is skipped (Next/Previous Card, following the user's direction)
//   and a short "Ad skipped" toast is shown.
//
// Scanning is incremental: the MutationObserver only queues the subtrees Facebook adds,
// and they are processed in requestIdleCallback. The whole page is never re-scanned
// after the first pass.

(() => {
  const AD_LABELS = new Set([
    'ad', 'ads', 'sponsored', 'publicidad', 'patrocinado', 'sponsorisé', 'gesponsert',
    'sponsorizzato', 'gesponsord', 'reklama', 'реклама', 'sponsorlu', 'bersponsor',
    'được tài trợ', 'may sponsor', '広告', '광고', '赞助内容', '贊助',
  ]);

  const PROFILE_NAME = '[data-ad-rendering-role="profile_name"]';
  const ITEM_LINK = 'a[href*="/marketplace/item/"]';

  const clean = (s) => (s || '').replace(/[​-‏⁠﻿]/g, '').trim().toLowerCase();
  const isAdText = (s) => AD_LABELS.has(clean(s));

  const labelText = (el) => {
    const target = document.getElementById(el.getAttribute('aria-labelledby'));
    return target ? target.textContent : '';
  };

  // querySelectorAll that also tests the root itself.
  function selectIn(root, selector) {
    const found = [...root.querySelectorAll(selector)];
    if (root.matches(selector)) found.push(root);
    return found;
  }

  let currentMode = 'grey';

  function setMode(mode) {
    currentMode = mode;
    document.documentElement.setAttribute('data-far-mode', mode);
  }

  chrome.storage.sync.get({ mode: 'grey' }, ({ mode }) => setMode(mode));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.mode) setMode(changes.mode.newValue);
  });

  function mark(el, kind) {
    if (el.getAttribute('data-far-ad') !== kind) el.setAttribute('data-far-ad', kind);
  }

  // ---- Feed ----

  // Cheap check used for every queued subtree: pointer walk only, no queries.
  function feedPostOf(el) {
    for (let u = el; u && u.parentElement; u = u.parentElement) {
      const list = u.parentElement;
      if (list.childElementCount > 1 && list.parentElement?.firstElementChild?.tagName === 'H3') {
        return u;
      }
    }
    return null;
  }

  function findFeedPost(el) {
    const post = feedPostOf(el);
    if (post) return post;
    for (let u = el.parentElement; u && u !== document.body; u = u.parentElement) {
      if (u.querySelector('[data-ad-rendering-role="like_button"]')) return u;
    }
    return null;
  }

  // Timestamp link in the header that owns this profile name.
  function headerLink(profileName) {
    let h = profileName;
    for (let i = 0; i < 6 && h; i++, h = h.parentElement) {
      const a = h.querySelector('a[target="_blank"]');
      if (a) return a;
    }
    return null;
  }

  const hasAdMarker = (a) =>
    [...a.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.data.includes('⁠'));

  function checkProfileName(pn) {
    const a = headerLink(pn);
    if (!a) return;
    const post = findFeedPost(pn);
    if (!post) return;
    if (hasAdMarker(a)) {
      mark(post, 'feed');
    } else if (post.getAttribute('data-far-ad') === 'feed' && pn === post.querySelector(PROFILE_NAME)) {
      // Virtualized feed may reuse a container for a different post.
      post.removeAttribute('data-far-ad');
    }
  }

  function checkLabel(el) {
    if (el.closest('[data-far-ad], [role="complementary"]')) return;
    if (!isAdText(labelText(el))) return;
    const post = findFeedPost(el);
    if (post) mark(post, 'feed');
  }

  function scanFeed(root, dirtyPosts) {
    // A change inside an existing post (e.g. the header link filled in later) means the
    // whole post needs a fresh look.
    const post = feedPostOf(root);
    if (post) dirtyPosts.add(post);
    else for (const pn of selectIn(root, PROFILE_NAME)) checkProfileName(pn);
    for (const el of selectIn(root, '[aria-labelledby]')) checkLabel(el);
  }

  // ---- Sidebar ----

  function scanSidebar() {
    for (const h of document.querySelectorAll('[role="complementary"] h3')) {
      if (!isAdText(h.textContent)) continue;
      let section = h;
      while (section.parentElement && section.parentElement.querySelectorAll('h3').length === 1) {
        section = section.parentElement;
      }
      mark(section, 'sidebar');
    }
  }

  const touchesSidebar = (root) =>
    !!(root.closest('[role="complementary"]') || root.querySelector('[role="complementary"]'));

  // ---- Marketplace ----

  // "Ad" leaves whose grid row had not rendered yet; retried on every pass.
  const waitingLeaves = new Set();

  function markTile(leaf) {
    const main = leaf.closest('[role="main"]');
    if (!main || leaf.closest('[data-far-ad]')) return true;
    let tile = leaf;
    while (tile.parentElement && tile.parentElement !== main && !tile.parentElement.querySelector(ITEM_LINK)) {
      tile = tile.parentElement;
    }
    if (tile.parentElement === main) return false;
    mark(tile, 'marketplace');
    return true;
  }

  function scanMarketplace(root) {
    // After in-app navigation Facebook keeps the previous page's hidden [role=main]
    // mounted for a while, so walk whichever main(s) the change belongs to.
    const inside = root.closest('[role="main"]');
    const roots = inside ? [root] : selectIn(root, '[role="main"]');
    for (const r of roots) {
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.data.length > 20 || !isAdText(n.data)) continue;
        const leaf = n.parentElement;
        if (!leaf || leaf.childElementCount) continue;
        if (!markTile(leaf)) waitingLeaves.add(leaf);
      }
    }
  }

  function retryWaitingLeaves() {
    for (const leaf of waitingLeaves) {
      if (!leaf.isConnected || markTile(leaf)) waitingLeaves.delete(leaf);
    }
  }

  // ---- Reels ----

  // "Ad" leaves whose reels list had not rendered a second video yet.
  const waitingReelLeaves = new Set();

  function markReel(leaf) {
    const main = leaf.closest('[role="main"]');
    if (!main || leaf.closest('[data-far-ad]')) return true;
    let slot = leaf;
    while (slot.parentElement && slot.parentElement !== main && slot.parentElement.querySelectorAll('video').length < 2) {
      slot = slot.parentElement;
    }
    if (slot.parentElement === main || !slot.querySelector('video')) return false;
    const slotWidth = slot.getBoundingClientRect().width;
    let card = leaf;
    while (card.parentElement !== slot && card.parentElement.getBoundingClientRect().width < slotWidth) {
      card = card.parentElement;
    }
    mark(card.getBoundingClientRect().width < slotWidth ? card : slot, 'reel');
    return true;
  }

  function scanReels(root) {
    const inside = root.closest('[role="main"]');
    const roots = inside ? [root] : selectIn(root, '[role="main"]');
    for (const r of roots) {
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.data.length > 20 || !isAdText(n.data)) continue;
        const leaf = n.parentElement;
        if (!leaf || leaf.childElementCount) continue;
        if (!markReel(leaf)) waitingReelLeaves.add(leaf);
      }
    }
  }

  function retryWaitingReelLeaves() {
    for (const leaf of waitingReelLeaves) {
      if (!leaf.isConnected || markReel(leaf)) waitingReelLeaves.delete(leaf);
    }
  }

  // Direction the user is moving through reels, so a skip continues the same way.
  let reelDirection = 'next';
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element && e.target.closest('[aria-label="Previous Card"], [aria-label="Next Card"]');
    if (btn) reelDirection = btn.getAttribute('aria-label') === 'Previous Card' ? 'prev' : 'next';
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') reelDirection = 'prev';
    else if (e.key === 'ArrowDown') reelDirection = 'next';
  }, true);
  document.addEventListener('wheel', (e) => {
    if (e.deltaY) reelDirection = e.deltaY < 0 ? 'prev' : 'next';
  }, { capture: true, passive: true });

  let lastSkip = 0;

  function isCurrentReel(card) {
    const r = card.getBoundingClientRect();
    const mid = innerHeight / 2;
    return r.height > 0 && r.top <= mid && r.bottom >= mid;
  }

  function skipAdReel() {
    if (currentMode !== 'hide' || !location.pathname.startsWith('/reel')) return;
    if (Date.now() - lastSkip < 1000) return;
    const card = [...document.querySelectorAll('[data-far-ad="reel"]')].find(isCurrentReel);
    if (!card) return;
    for (const v of card.querySelectorAll('video')) v.pause();
    const label = reelDirection === 'prev' ? 'Previous Card' : 'Next Card';
    const btn = document.querySelector(`[aria-label="${label}"]`);
    if (!btn) return;
    lastSkip = Date.now();
    // Anchor to the video itself; the card also includes the like/comment column.
    const video = card.querySelector('video');
    const rect = (video && video.getBoundingClientRect().width ? video : card).getBoundingClientRect();
    btn.click();
    showToast('Ad skipped', rect);
  }

  // The reel slides into place over a few hundred ms and may settle with no further
  // DOM changes, so keep checking for a short while after activity on a reels page.
  let skipPollUntil = 0;
  let skipPollTimer = null;

  function pollSkip() {
    skipPollUntil = Date.now() + 2000;
    if (skipPollTimer) return;
    const tick = () => {
      skipAdReel();
      if (Date.now() < skipPollUntil) skipPollTimer = setTimeout(tick, 250);
      else skipPollTimer = null;
    };
    tick();
  }

  let toast = null;
  let toastTimer = null;

  // Shown centred on the reel, 10% of the reel's height above its bottom edge.
  function showToast(text, rect) {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'far-toast';
      toast.setAttribute('role', 'status');
      document.documentElement.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.left = `${rect.left + rect.width / 2}px`;
    toast.style.top = `${rect.top + rect.height * 0.9}px`;
    toast.classList.add('far-toast--show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('far-toast--show'), 1000);
  }

  // ---- Queue ----

  const pending = new Set();
  let queued = false;

  const idle = window.requestIdleCallback
    ? (fn) => requestIdleCallback(fn, { timeout: 300 })
    : (fn) => setTimeout(() => fn({ timeRemaining: () => 50, didTimeout: true }), 150);

  function enqueue(el) {
    if (el) pending.add(el);
    if (!queued) {
      queued = true;
      idle(process);
    }
  }

  // Drop disconnected roots and roots nested inside another queued root.
  function takeRoots() {
    const roots = [];
    for (const el of pending) {
      if (!el.isConnected) continue;
      let nested = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (pending.has(p)) { nested = true; break; }
      }
      if (!nested) roots.push(el);
    }
    pending.clear();
    return roots;
  }

  let lastPath = null;

  function process(deadline) {
    queued = false;
    const onMarketplace = location.pathname.startsWith('/marketplace');
    const onReels = location.pathname.startsWith('/reel');
    // In-app navigation can render the new page before the URL changes, so re-check
    // the page's main areas once whenever the path changes.
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      for (const main of document.querySelectorAll('[role="main"]')) pending.add(main);
    }
    const roots = takeRoots();
    const dirtyPosts = new Set();
    let sidebar = false;

    for (let i = 0; i < roots.length; i++) {
      // Out of idle time: put the rest back for the next idle period.
      if (i > 0 && !deadline.didTimeout && deadline.timeRemaining() < 1) {
        for (const r of roots.slice(i)) pending.add(r);
        enqueue();
        break;
      }
      const root = roots[i];
      scanFeed(root, dirtyPosts);
      if (!sidebar && touchesSidebar(root)) sidebar = true;
      if (onMarketplace) scanMarketplace(root);
      if (onReels) scanReels(root);
    }

    for (const post of dirtyPosts) {
      for (const pn of post.querySelectorAll(PROFILE_NAME)) checkProfileName(pn);
    }
    if (sidebar) scanSidebar();
    if (onMarketplace && waitingLeaves.size) retryWaitingLeaves();
    if (onReels && waitingReelLeaves.size) retryWaitingReelLeaves();
    if (onReels && currentMode === 'hide') pollSkip();
  }

  // Label targets live for about a second, so resolve them as soon as they appear.
  // Everything else is only queued here.
  function onMutations(mutations) {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        checkLabel(m.target);
        continue;
      }
      if (m.addedNodes.length === 0) continue;
      for (const n of m.addedNodes) {
        if (n.nodeType === Node.TEXT_NODE) {
          enqueue(n.parentElement);
          continue;
        }
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        enqueue(n);
        const ids = n.id ? [n] : n.querySelectorAll('[id^="_r_"]');
        for (const t of ids) {
          if (t.childElementCount || !isAdText(t.textContent)) continue;
          for (const el of document.querySelectorAll(`[aria-labelledby="${CSS.escape(t.id)}"]`)) checkLabel(el);
        }
      }
    }
  }

  new MutationObserver(onMutations).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-labelledby'],
  });
  enqueue(document.documentElement);

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'far:count') {
      reply({
        feed: document.querySelectorAll('[data-far-ad="feed"]').length,
        sidebar: document.querySelectorAll('[data-far-ad="sidebar"]').length,
        marketplace: document.querySelectorAll('[data-far-ad="marketplace"]').length,
        reel: document.querySelectorAll('[data-far-ad="reel"]').length,
      });
    }
  });
})();
