// content.js - 平衡响应速度与稳定性

const DEFAULTS = {
  enabled: true,
  windowMinutes: 120,
  matchMode: "symbol",
  showMode: "all",
  onlyWithinWindow: true,
  language: "auto"
};

const i18n = {
  en: {
    firstLaunch: "First",
    notFirst: "Not First",
    gotoFirst: "Open First"
  },
  zh: {
    firstLaunch: "首发",
    notFirst: "非首发",
    gotoFirst: "打开首发"
  }
};

let cfg = { ...DEFAULTS };
let currentLang = "en";

// 稳定索引
let stableFirstIndex = new Map();
let stableDupKeys = new Set();

// 已处理元素缓存
let elementStateCache = new WeakMap();
// 已知地址集合 - 用于判断是否为新元素
let knownAddresses = new Set();

// 处理控制
let isProcessing = false;
let pendingScan = false;
let scanGeneration = 0;

// 区分快速扫描和完整扫描
let lastFullScanTime = 0;
const FULL_SCAN_INTERVAL = 500;

function detectLanguage() {
  const browserLang = navigator.language || navigator.userLanguage || "en";
  if (browserLang.toLowerCase().startsWith("zh")) return "zh";
  return "en";
}

function getCurrentLang() {
  if (cfg.language === "auto") return detectLanguage();
  return cfg.language;
}

function t(key) {
  return i18n[currentLang]?.[key] || i18n.en[key] || key;
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fa5 ]+/g, "");
}

function parseAgeToMs(t) {
  const s = (t || "").trim().toLowerCase();
  const m = s.match(/^(\d+)\s*([smhd])$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const map = { s: 1000, m: 60e3, h: 3600e3, d: 86400e3 };
  return n * map[unit];
}

function parseTokenHref(href) {
  const m = (href || "").match(/^\/([^/]+)\/token\/([^/?#]+)/);
  if (!m) return null;
  return { chain: m[1], address: m[2] };
}

function buildKeys({ symbol, name }) {
  const S = normalize(symbol);
  const N = normalize(name);

  if (cfg.matchMode === "symbol") return S ? ["S:" + S] : [];
  if (cfg.matchMode === "name") return N ? ["N:" + N] : [];
  if (cfg.matchMode === "both") return (S && N) ? ["SN:" + S + "|" + N] : [];

  const keys = [];
  if (S) keys.push("S:" + S);
  if (N) keys.push("N:" + N);
  return keys;
}

function extractSymbolAndName(rowEl) {
  let symbol = "";
  let name = "";

  let symbolEl = rowEl.querySelector("span.whitespace-nowrap.font-medium");
  if (symbolEl) {
    symbol = (symbolEl.textContent || "").trim();
  }

  if (!symbol) {
    const symbolCandidates = rowEl.querySelectorAll('span.font-medium[class*="text-[16px]"]');
    for (const el of symbolCandidates) {
      const text = (el.textContent || "").trim();
      if (text && text.length < 20) {
        symbol = text;
        break;
      }
    }
  }

  if (!symbol) {
    const el = rowEl.querySelector('[class*="text-[16px]"][class*="font-medium"]');
    if (el) {
      symbol = (el.textContent || "").trim();
    }
  }

  let nameEl = rowEl.querySelector("div.text-text-300.font-medium");
  if (nameEl) {
    name = (nameEl.textContent || "").trim();
  }

  if (!name) {
    const nameCandidates = rowEl.querySelectorAll('div[class*="text-text-300"]');
    for (const el of nameCandidates) {
      const text = (el.textContent || "").trim();
      if (text && text.length > 1 && text !== symbol && !/^[\d.%]+$/.test(text)) {
        name = text;
        break;
      }
    }
  }

  if (!name) {
    const el = rowEl.querySelector('[class*="truncate"][class*="text-[14px]"]');
    if (el) {
      name = (el.textContent || "").trim();
    }
  }

  return { symbol, name };
}

function extractAge(rowEl) {
  const ageSelectors = [
    '.text-green-50',
    '.text-green-100',
    '[class*="text-green-50"]',
    '[class*="text-green-100"]'
  ];

  for (const selector of ageSelectors) {
    const ageEl = rowEl.querySelector(selector);
    if (ageEl) {
      const text = (ageEl.textContent || "").trim();
      if (/^\d+\s*[smhd]$/i.test(text)) {
        return text;
      }
    }
  }

  const candidates = rowEl.querySelectorAll("div, span, p");
  for (const el of candidates) {
    const txt = (el.textContent || "").trim();
    if (/^\d+\s*[smhd]$/i.test(txt)) {
      return txt;
    }
  }

  return null;
}

function getRowElement(slot) {
  let rowEl = slot.querySelector('div[href^="/"][href*="/token/"]');
  
  if (!rowEl) {
    rowEl = slot.querySelector('div[href*="/token/"]');
  }

  if (!rowEl) {
    const candidates = slot.querySelectorAll('div[href]');
    for (const el of candidates) {
      const href = el.getAttribute("href") || "";
      if (href.includes("/token/")) {
        rowEl = el;
        break;
      }
    }
  }

  if (!rowEl) {
    rowEl = slot.querySelector('div[class*="cursor-pointer"][class*="group/a"]');
    if (rowEl) {
      const linkEl = rowEl.querySelector('a[href*="/token/"]');
      if (linkEl) {
        rowEl.setAttribute('data-token-href', linkEl.getAttribute('href'));
      }
    }
  }

  return rowEl;
}

function extractTokenFromRow(rowEl, slot) {
  let href = rowEl.getAttribute("href") || "";
  
  if (!href) {
    href = rowEl.getAttribute("data-token-href") || "";
  }
  
  if (!href) {
    const linkEl = rowEl.querySelector('a[href*="/token/"]');
    if (linkEl) {
      href = linkEl.getAttribute("href") || "";
    }
  }

  const parsed = parseTokenHref(href);
  if (!parsed) return null;

  const ageText = extractAge(rowEl);
  const ageMs = parseAgeToMs(ageText);
  const { symbol, name } = extractSymbolAndName(rowEl);
  const slotIndex = parseInt(slot?.getAttribute("data-index") || "0", 10);

  return {
    chain: parsed.chain,
    address: parsed.address,
    symbol,
    name,
    ageMs,
    slotIndex
  };
}

function inWindowByAge(ageMs) {
  if (ageMs == null) return false;
  return ageMs <= cfg.windowMinutes * 60e3;
}

function getFirstTokenInfo(keys) {
  for (const k of keys) {
    const rec = stableFirstIndex.get(k);
    if (rec) {
      return {
        chain: rec.firstChain,
        address: rec.firstAddr.split(":")[1]
      };
    }
  }
  return null;
}

function gotoFirstToken(chain, address) {
  const url = `https://gmgn.ai/${chain}/token/${address}`;
  window.open(url, "_blank");
}

function isEarlierThan(tokenAgeMs, tokenSlotIndex, recAgeMs, recSlotIndex) {
  if (tokenAgeMs > recAgeMs) return true;
  if (tokenAgeMs < recAgeMs) return false;
  return tokenSlotIndex > recSlotIndex;
}

/**
 * 创建标记容器
 */
function createMarkerContainer(isFirst, keys) {
  const container = document.createElement("div");
  container.className = "gmgn-marker-container";
  container.setAttribute("data-gmgn-marker", "true");
  container.setAttribute("data-marker-type", isFirst ? "first" : "dup");

  const overlay = document.createElement("div");
  overlay.className = isFirst ? "gmgn-overlay gmgn-overlay-first" : "gmgn-overlay gmgn-overlay-dup";
  container.appendChild(overlay);

  const tag = document.createElement("div");
  tag.className = isFirst ? "gmgn-tag gmgn-tag-first" : "gmgn-tag gmgn-tag-dup";
  tag.textContent = isFirst ? t("firstLaunch") : t("notFirst");
  container.appendChild(tag);

  if (isFirst) {
    const sideBar = document.createElement("div");
    sideBar.className = "gmgn-side-bar";
    container.appendChild(sideBar);
  } else {
    const firstInfo = getFirstTokenInfo(keys);
    if (firstInfo) {
      const gotoBtn = document.createElement("button");
      gotoBtn.className = "gmgn-goto-first-btn";
      gotoBtn.type = "button";
      gotoBtn.textContent = t("gotoFirst");
      gotoBtn.setAttribute("data-first-chain", firstInfo.chain);
      gotoBtn.setAttribute("data-first-address", firstInfo.address);

      gotoBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        gotoFirstToken(
          gotoBtn.getAttribute("data-first-chain"),
          gotoBtn.getAttribute("data-first-address")
        );
      });

      container.appendChild(gotoBtn);
    }
  }

  return container;
}

/**
 * 更新标记 - 优化：只在状态真正变化时操作 DOM
 */
function updateMarker(rowEl, isFirst, keys, addrKey, isNewElement) {
  const cachedState = elementStateCache.get(rowEl);
  const newType = isFirst ? "first" : "dup";
  const firstInfo = isFirst ? null : getFirstTokenInfo(keys);
  const firstInfoKey = firstInfo ? `${firstInfo.chain}:${firstInfo.address}` : "";
  
  // 检查是否需要更新
  if (cachedState && 
      cachedState.type === newType && 
      cachedState.lang === currentLang &&
      cachedState.firstInfoKey === firstInfoKey) {
    return false;
  }

  // 如果不是新元素，且状态要变化，稍微延迟以避免闪烁
  // 但新元素立即处理
  const existingContainer = rowEl.querySelector(".gmgn-marker-container");
  if (existingContainer) {
    existingContainer.remove();
  }

  const newContainer = createMarkerContainer(isFirst, keys);

  const computedStyle = window.getComputedStyle(rowEl);
  if (computedStyle.position === "static") {
    rowEl.style.position = "relative";
  }

  rowEl.appendChild(newContainer);

  elementStateCache.set(rowEl, {
    type: newType,
    lang: currentLang,
    firstInfoKey,
    addrKey
  });

  return true;
}

function removeMarker(rowEl) {
  const container = rowEl.querySelector(".gmgn-marker-container");
  if (container) {
    container.remove();
    elementStateCache.delete(rowEl);
  }
}

function relayoutBody(body) {
  const slots = Array.from(body.querySelectorAll("div[data-index]"));
  if (!slots.length) return;

  const slotHeight = 144;
  let visibleTop = 0;

  slots.sort((a, b) => {
    const ai = parseInt(a.getAttribute("data-index") || "0", 10);
    const bi = parseInt(b.getAttribute("data-index") || "0", 10);
    return ai - bi;
  });

  for (const slot of slots) {
    const isHidden = slot.classList.contains("gmgn-slot-hidden");

    if (isHidden) {
      slot.style.top = "-9999px";
      slot.style.height = "0px";
      slot.style.visibility = "hidden";
      slot.style.pointerEvents = "none";
    } else {
      slot.style.top = `${visibleTop}px`;
      slot.style.height = `${slotHeight}px`;
      slot.style.visibility = "";
      slot.style.pointerEvents = "";
      visibleTop += slotHeight;
    }
  }

  const innerContainer = body.querySelector('div[style*="height"]');
  if (innerContainer && visibleTop > 0) {
    innerContainer.style.height = `${visibleTop}px`;
  }
}

function shouldHideSlot(isFirst, keys) {
  const inDupGroup = keys.some((k) => stableDupKeys.has(k));

  switch (cfg.showMode) {
    case "all":
      return false;
    case "onlyFirst":
      return !isFirst;
    case "onlyDup":
      return isFirst;
    case "hideNonSameNameFirst":
      return !inDupGroup;
    default:
      return false;
  }
}

/**
 * 收集所有 token 并标记新元素
 */
function collectTokens(body) {
  const slots = body.querySelectorAll("div[data-index]");
  const tokens = [];

  for (const slot of slots) {
    const rowEl = getRowElement(slot);
    if (!rowEl) continue;

    const token = extractTokenFromRow(rowEl, slot);
    if (!token) continue;

    const addrKey = `${token.chain}:${token.address}`;
    const keys = buildKeys(token);
    if (!keys.length) continue;

    const canCompare = token.ageMs != null && (!cfg.onlyWithinWindow || inWindowByAge(token.ageMs));
    
    // 判断是否为新元素
    const isNewElement = !knownAddresses.has(addrKey);

    tokens.push({
      slot,
      rowEl,
      token,
      addrKey,
      keys,
      canCompare,
      isNewElement
    });
  }

  return tokens;
}

/**
 * 构建首发索引 - 完整重建
 */
function buildFirstIndex(tokens) {
  const newFirstIndex = new Map();
  const newDupKeys = new Set();

  for (const { token, addrKey, keys, canCompare } of tokens) {
    if (!canCompare) continue;

    for (const k of keys) {
      const rec = newFirstIndex.get(k);

      if (rec && rec.firstAddr !== addrKey) {
        newDupKeys.add(k);
      }

      if (!rec || isEarlierThan(token.ageMs, token.slotIndex, rec.firstAgeMs, rec.firstSlotIndex)) {
        newFirstIndex.set(k, {
          firstAddr: addrKey,
          firstAgeMs: token.ageMs,
          firstSlotIndex: token.slotIndex,
          firstChain: token.chain
        });
      }
    }
  }

  return { newFirstIndex, newDupKeys };
}

/**
 * 检查索引是否有变化
 */
function hasIndexChanged(newFirstIndex, newDupKeys) {
  if (newFirstIndex.size !== stableFirstIndex.size) return true;
  if (newDupKeys.size !== stableDupKeys.size) return true;

  for (const [k, v] of newFirstIndex) {
    const old = stableFirstIndex.get(k);
    if (!old || old.firstAddr !== v.firstAddr) return true;
  }

  return false;
}

/**
 * 判断 token 是否为首发
 */
function isTokenFirst(addrKey, keys, firstIndex) {
  for (const k of keys) {
    const rec = firstIndex.get(k);
    if (rec && rec.firstAddr !== addrKey) {
      return false;
    }
  }
  return true;
}

/**
 * 应用标记
 */
function applyMarkers(tokens, firstIndex, dupKeys) {
  let needsRelayout = false;
  const newKnownAddresses = new Set();

  for (const { slot, rowEl, addrKey, keys, canCompare, isNewElement } of tokens) {
    newKnownAddresses.add(addrKey);

    let isFirst = true;
    if (canCompare) {
      isFirst = isTokenFirst(addrKey, keys, firstIndex);
    }

    const shouldHide = shouldHideSlot(isFirst, keys);
    
    if (shouldHide) {
      if (!slot.classList.contains("gmgn-slot-hidden")) {
        slot.classList.add("gmgn-slot-hidden");
        needsRelayout = true;
      }
      removeMarker(rowEl);
    } else {
      if (slot.classList.contains("gmgn-slot-hidden")) {
        slot.classList.remove("gmgn-slot-hidden");
        needsRelayout = true;
      }
      updateMarker(rowEl, isFirst, keys, addrKey, isNewElement);
    }
  }

  // 更新已知地址集合
  knownAddresses = newKnownAddresses;

  return needsRelayout;
}

/**
 * 快速扫描 - 只处理新元素，不重建索引
 */
function quickScanBody(body) {
  const slots = body.querySelectorAll("div[data-index]");
  let hasNewElements = false;

  for (const slot of slots) {
    const rowEl = getRowElement(slot);
    if (!rowEl) continue;

    // 检查是否已有标记
    if (rowEl.querySelector(".gmgn-marker-container")) continue;

    const token = extractTokenFromRow(rowEl, slot);
    if (!token) continue;

    const addrKey = `${token.chain}:${token.address}`;
    
    // 新元素 - 需要完整扫描
    if (!knownAddresses.has(addrKey)) {
      hasNewElements = true;
      break;
    }

    // 已知元素但没标记 - 直接添加
    const keys = buildKeys(token);
    if (!keys.length) continue;

    const canCompare = token.ageMs != null && (!cfg.onlyWithinWindow || inWindowByAge(token.ageMs));
    let isFirst = true;
    if (canCompare) {
      isFirst = isTokenFirst(addrKey, keys, stableFirstIndex);
    }

    const shouldHide = shouldHideSlot(isFirst, keys);
    if (!shouldHide) {
      updateMarker(rowEl, isFirst, keys, addrKey, false);
    }
  }

  return hasNewElements;
}

/**
 * 完整扫描 - 重建索引并应用标记
 */
function fullScanBody(body, generation) {
  if (generation !== scanGeneration) return;

  const tokens = collectTokens(body);
  const { newFirstIndex, newDupKeys } = buildFirstIndex(tokens);

  // 更新稳定索引
  stableFirstIndex = newFirstIndex;
  stableDupKeys = newDupKeys;

  const needsRelayout = applyMarkers(tokens, stableFirstIndex, stableDupKeys);

  if (needsRelayout || cfg.showMode !== "all") {
    relayoutBody(body);
  }
}

/**
 * 智能扫描 - 根据情况选择快速或完整扫描
 */
function smartScan() {
  if (!cfg.enabled) return;
  
  const bodies = document.querySelectorAll(".g-table-body");
  const now = Date.now();
  let needFullScan = false;

  // 快速检查是否有新元素
  for (const body of bodies) {
    if (quickScanBody(body)) {
      needFullScan = true;
      break;
    }
  }

  // 有新元素或距离上次完整扫描时间够长，执行完整扫描
  if (needFullScan || (now - lastFullScanTime > FULL_SCAN_INTERVAL)) {
    lastFullScanTime = now;
    scanGeneration++;
    const currentGeneration = scanGeneration;
    
    bodies.forEach((body) => fullScanBody(body, currentGeneration));
  }
}

/**
 * 扫描所有列
 */
function scanAllColumns() {
  if (!cfg.enabled) return;
  
  if (isProcessing) {
    pendingScan = true;
    return;
  }

  isProcessing = true;

  requestAnimationFrame(() => {
    try {
      smartScan();
    } finally {
      isProcessing = false;
      
      if (pendingScan) {
        pendingScan = false;
        setTimeout(scheduleScan, 100);
      }
    }
  });
}

function resetAll() {
  stableFirstIndex.clear();
  stableDupKeys.clear();
  knownAddresses.clear();
  elementStateCache = new WeakMap();
  lastFullScanTime = 0;

  document.querySelectorAll(".gmgn-marker-container").forEach((el) => el.remove());

  document.querySelectorAll(".gmgn-slot-hidden").forEach((slot) => {
    slot.classList.remove("gmgn-slot-hidden");
    slot.style.height = "144px";
    slot.style.visibility = "";
    slot.style.pointerEvents = "";
  });
}

async function loadCfg() {
  const data = await chrome.storage.sync.get(DEFAULTS);
  cfg = { ...DEFAULTS, ...data };
  currentLang = getCurrentLang();
}

/* ===================== 扫描调度器 ===================== */
let scanScheduled = false;
let lastScanTime = 0;
const MIN_INTERVAL = 100; // 快速响应

function scheduleScan() {
  if (!cfg.enabled) return;
  if (scanScheduled) return;

  const now = Date.now();
  const elapsed = now - lastScanTime;

  if (elapsed >= MIN_INTERVAL) {
    scanScheduled = true;
    requestAnimationFrame(() => {
      lastScanTime = Date.now();
      scanScheduled = false;
      scanAllColumns();
    });
  } else {
    scanScheduled = true;
    setTimeout(() => {
      requestAnimationFrame(() => {
        lastScanTime = Date.now();
        scanScheduled = false;
        scanAllColumns();
      });
    }, MIN_INTERVAL - elapsed);
  }
}

let scrollTimer = null;
function onScroll() {
  if (!cfg.enabled) return;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => scheduleScan(), 80);
}

let mutationTimer = null;
let mutationCount = 0;
const MUTATION_BATCH_THRESHOLD = 5;

function onMutation() {
  if (!cfg.enabled) return;
  
  mutationCount++;
  clearTimeout(mutationTimer);
  
  // 如果短时间内有大量变更，稍微延迟以批量处理
  if (mutationCount >= MUTATION_BATCH_THRESHOLD) {
    mutationTimer = setTimeout(() => {
      mutationCount = 0;
      scheduleScan();
    }, 150);
  } else {
    // 少量变更，快速响应
    mutationTimer = setTimeout(() => {
      mutationCount = 0;
      scheduleScan();
    }, 50);
  }
}

function initObserver() {
  const bodies = document.querySelectorAll(".g-table-body");
  if (!bodies.length) return setTimeout(initObserver, 300);

  const mo = new MutationObserver((mutations) => {
    if (!cfg.enabled) return;
    
    let hasRelevantChange = false;

    for (const mutation of mutations) {
      if (mutation.target.closest?.(".gmgn-marker-container")) continue;
      if (mutation.target.classList?.contains("gmgn-marker-container")) continue;

      if (mutation.type === "childList") {
        let isOurElement = false;
        for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
          if (node.nodeType === 1) {
            if (node.classList?.contains("gmgn-marker-container") ||
                node.querySelector?.(".gmgn-marker-container")) {
              isOurElement = true;
              break;
            }
          }
        }
        if (!isOurElement) {
          hasRelevantChange = true;
          break;
        }
      }
    }

    if (hasRelevantChange) {
      onMutation();
    }
  });

  bodies.forEach((b) => {
    mo.observe(b, { childList: true, subtree: true });
    b.addEventListener("scroll", onScroll, { passive: true });
  });

  window.addEventListener("resize", () => {
    if (cfg.enabled) scheduleScan();
  }, { passive: true });

  if (cfg.enabled) {
    // 初始立即扫描
    scanAllColumns();
  }
}

(async function init() {
  await loadCfg();
  initObserver();

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "sync") return;

    const wasEnabled = cfg.enabled;
    
    if (changes.__gmgn_cmd?.newValue?.type === "reset") {
      await loadCfg();
      resetAll();
      if (cfg.enabled) {
        scanAllColumns();
      }
      return;
    }

    await loadCfg();
    
    if (wasEnabled && !cfg.enabled) {
      resetAll();
      return;
    }
    
    if (cfg.enabled) {
      resetAll();
      scanAllColumns();
    }
  });

  // 定期扫描保持同步
  setInterval(() => {
    if (cfg.enabled) {
      scheduleScan();
    }
  }, 800);

})();