// ============================================================
// 渲染进程 - 完整版（所有功能整合 + 死机保护 + 引用词条 + 历史返回）
// ============================================================

// ---------- 全局 API ----------
const api = window.electronAPI || {};

// ============================================================
// 工具函数
// ============================================================

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function genId() {
    return 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

function getColor() {
    const colors = ['#e8f5e9','#e3f2fd','#fff3e0','#fce4ec','#f3e5f5','#e0f7fa','#f1f8e9','#fff8e1'];
    return colors[Math.floor(Math.random() * colors.length)];
}

function getBaseName(p) {
    if (!p) return '未保存';
    return p.replace(/^.*[\\/]/, '');
}

function isLocked() {
    return document.getElementById('btnLock').textContent === '🔒';
}

// 根据背景色亮度返回对比度合适的文字颜色（深色模式下用）
function getContrastTextColor(bgColor) {
    const c = bgColor || '#ffffff';
    if (c.startsWith('#')) {
        let hex = c.slice(1);
        if (hex.length === 3) hex = hex.split('').map(h => h + h).join('');
        if (hex.length >= 6) {
            const r = parseInt(hex.substr(0, 2), 16);
            const g = parseInt(hex.substr(2, 2), 16);
            const b = parseInt(hex.substr(4, 2), 16);
            const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            return lum > 0.5 ? '#1a1a2e' : '#ffffff';
        }
    }
    return '#1a1a2e';
}

let toastTimer = null;
function showToast(msg, dur = 2000) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), dur);
}

// 复制文本到剪贴板（优先异步 API，回退 execCommand，兼容 file:// 环境）
function copyToClipboard(text) {
    return new Promise((resolve, reject) => {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(resolve).catch(() => legacyCopy());
        } else {
            legacyCopy();
        }
        function legacyCopy() {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.top = '-1000px';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            document.body.removeChild(ta);
            ok ? resolve() : reject(new Error('copy failed'));
        }
    });
}

// ============================================================
// 全局状态
// ============================================================

let currentProject = {
    nodes: [],
    connections: [],
    trash: [],
    bookTrash: [],
    canvasBg: null,
    detailBg: null
};

let currentFilePath = null;
let currentProjectName = '未命名项目';
let rootNodeId = null;

let mode = 'default';
let connectFrom = null;
let dragData = null;
let selectedIds = new Set();
let isLockedState = false;
// 「防误操作」开关：本次运行内按书记忆（重启软件后重置；在本书里一直有效）
const bookLockState = new Map();
let currentContextId = null;
// 剪切待粘贴的词条 id（渲染时显示为淡灰；粘贴时才真正移走；点空白/退出书籍/撤销则取消）
let cutPendingIds = new Set();
let currentSelectedId = null;
let isMultiselectActive = false;
let isRendering = false;  // 防循环标志
let wasDragging = false;  // 标记本次点击是否为拖拽（拖拽后不触发跳转）


let isHomeBatchMode = false;
let homeSelectedIds = new Set();
let currentProjectsCache = [];

// 词条 zIndex 递增计数器（用于"点击/拖拽即置顶"，不移动 DOM 以免破坏事件）
let nodeZCounter = 10;

// 词条回收站状态
let trashSelectedIds = new Set();
let trashAllSelected = false;

// 书籍回收站状态（独立）
let bookTrashSelectedIds = new Set();
let bookTrashAllSelected = false;
// 全局书籍回收站数据（从主进程加载）
let bookTrashItems = [];

// 浏览历史栈（用于"返回上级"的历史性返回）
let navHistory = [];
// 前进历史栈（配合鼠标侧键前进）
let navForwardHistory = [];


// 是否显示完整路径（默认关闭，可在帮助弹窗中开启）
let showBreadcrumbPath = false;


// ============================================================
// DOM 引用
// ============================================================

const homeView = document.getElementById('homeView');
const editorView = document.getElementById('editorView');
const projectGrid = document.getElementById('projectGrid');
const canvas = document.getElementById('canvas');
const svg = document.getElementById('connections-svg');
const emptyState = document.getElementById('emptyState');
const modalOverlay = document.getElementById('modalOverlay');
const modalContent = document.getElementById('modalContent');
const trashPanel = document.getElementById('trashPanel');
const trashList = document.getElementById('trashList');
const bookTrashPanel = document.getElementById('bookTrashPanel');
const bookTrashList = document.getElementById('bookTrashList');
const editorTitle = document.getElementById('editorTitle');
const fileIndicator = document.getElementById('fileIndicator');
const breadcrumbBar = document.getElementById('breadcrumbBar');
const detailPanel = document.getElementById('detailPanel');
const detailTitle = document.getElementById('detailTitle');
const detailNumber = document.getElementById('detailNumber');
const detailSummary = document.getElementById('detailSummary');
const detailBody = document.getElementById('detailBody');
const jumpInput = document.getElementById('jumpInput');
const jumpSuggestions = document.getElementById('jumpSuggestions');
const btnBackLevel = document.getElementById('btnBackLevel');
const btnHomeRoot = document.getElementById('btnHomeRoot');
const btnExitProject = document.getElementById('btnExitProject');
const btnCancelMode = document.getElementById('btnCancelMode');
const btnLock = document.getElementById('btnLock');
const btnConnect = document.getElementById('btnConnect');
const btnTrash = document.getElementById('btnTrash');
const btnAdd = document.getElementById('btnAdd');
const btnSave = document.getElementById('btnSave');
const btnCanvasBg = document.getElementById('btnCanvasBg');

const multiselectBar = document.getElementById('multiselectBar');
const multiselectCheckbox = document.getElementById('multiselectCheckbox');
const multiselectCount = document.getElementById('multiselectCount');
const multiselectDeleteBtn = document.getElementById('multiselectDeleteBtn');
const multiselectCancelBtn = document.getElementById('multiselectCancelBtn');

const btnHomeBatchMode = document.getElementById('btnHomeBatchMode');

// ----- 标题栏按钮 -----
const titlebarHelp = document.getElementById('titlebarHelp');
const titlebarMinimize = document.getElementById('titlebarMinimize');
const titlebarMaximize = document.getElementById('titlebarMaximize');
const titlebarClose = document.getElementById('titlebarClose');

// 左上角应用图标：icon.png 存在则显示图标并去掉名字前的 emoji；否则隐藏图标保留 emoji
const titlebarIcon = document.getElementById('titlebarIcon');
if (titlebarIcon) {
    const showTitlebarIcon = () => {
        titlebarIcon.style.display = 'inline-block';
        const nameEl = document.getElementById('titlebarAppName');
        if (nameEl) nameEl.textContent = nameEl.textContent.replace('📚 ', '');
    };
    titlebarIcon.onload = showTitlebarIcon;
    titlebarIcon.onerror = () => { titlebarIcon.style.display = 'none'; };
    // 若图片已在绑定 onload 前加载完成（打包后 asar 内加载极快），complete 检查补显示
    if (titlebarIcon.complete && titlebarIcon.naturalWidth > 0) {
        showTitlebarIcon();
    }
}

// ============================================================
// 帮助弹窗（独立于主渲染逻辑，即使界面卡死也能打开）
// ============================================================

function openHelp() {
    const overlay = document.getElementById('helpOverlay');
    if (overlay) overlay.classList.remove('hidden');
    // 同步面包屑路径开关的勾选状态（避免开关状态与实际显示不一致）
    const pathCb = document.getElementById('helpShowPath');
    if (pathCb) pathCb.checked = showBreadcrumbPath;
    // 打开帮助：只同步最上面的开关；小节展开状态和搜索保持上次的样子（重启软件后自然回到全部收起）
}

// ===== 帮助搜索：边打边筛 + 高亮 + 自动跳到第一条 =====
// 放在"开发者工具"那排下面（那排更常用）
let helpOpenSnapshot = null;   // 搜索开始前各小节的展开状态（清空搜索时还原，免得"搜完还剩一堆展开的"）
let helpAllOpen = false;      // 「全部展开/收起」自己的状态（不靠"有没有收起的小节"反推，否则手动收起几个后按钮就失灵）
let helpHitIndex = 0;         // 回车跳到第几个命中（循环）
// 帮助搜索高亮：改用 CSS Custom Highlight API（不改 DOM）
// —— 以前是往正文里插 <mark>，会把文本节点拆碎（"RGB" → "R" + "GB"），
//    结果"先搜 r、再搜 rgb"这种多字符词就跨不了文本节点、搜不到了
function clearHelpHighlight() {
    try {
        if (window.CSS && CSS.highlights) { CSS.highlights.delete('help-find'); CSS.highlights.delete('help-find-cur'); }
        helpHitIndex = 0;
        // 兼容旧内核留下的 <mark>：还原成纯文本，并合并相邻文本节点
        Array.prototype.slice.call(document.querySelectorAll('#helpOverlay mark[data-hit]')).forEach(m => {
            const txt = document.createTextNode(m.textContent);
            if (m.parentNode) m.parentNode.replaceChild(txt, m);
        });
        Array.prototype.slice.call(document.querySelectorAll('#helpOverlay details')).forEach(d => { try { d.normalize(); } catch (e) {} });
    } catch (e) {}
}
// 把第 i 个命中设为"当前项"：单独一组高亮（更醒目）+ 滚到它那儿
// 注意：Range 是逐个文本节点生成的（helpSearchRanges），不经过"整串偏移"，所以翻页永远不会错位
function helpFocusHit(i) {
    const list = window.__helpRanges || [];
    if (!list.length) return;
    const n = list.length;
    helpHitIndex = ((i % n) + n) % n;
    const cur = list[helpHitIndex] || null;
    if (!cur) return;
    try {
        if (window.CSS && CSS.highlights && typeof Highlight === 'function') {
            CSS.highlights.delete('help-find-cur');
            CSS.highlights.set('help-find-cur', new Highlight(cur));
        }
    } catch (e) {}
    try {
        const node = cur.startContainer;
        const el = (node && node.nodeType === 1) ? node : (node ? node.parentElement : null);
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    } catch (e) {}
}
// 回车 / Shift+回车：跳到下一个 / 上一个命中（循环）
function helpSearchStep(dir) {
    if (!(window.__helpRanges && window.__helpRanges.length)) { applyHelpSearch(true); return; }
    helpFocusHit(helpHitIndex + dir);
}
function helpSearchRanges(root, q) {
    const out = [];
    if (!root || !q) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (!n.nodeValue || n.nodeValue.toLowerCase().indexOf(q) < 0) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const lower = node.nodeValue.toLowerCase();
        let i = 0, idx;
        while ((idx = lower.indexOf(q, i)) >= 0) {
            try {
                const r = document.createRange();
                r.setStart(node, idx);
                r.setEnd(node, idx + q.length);
                out.push(r);
            } catch (e) {}
            i = idx + q.length;
        }
    }
    return out;
}
function highlightHelpText(root, q) {
    const ranges = helpSearchRanges(root, q);
    if (!ranges.length) return 0;
    if (window.CSS && CSS.highlights && typeof Highlight === 'function') {
        (window.__helpRanges = window.__helpRanges || []).push.apply(window.__helpRanges, ranges);
    } else {
        // 旧内核回退：插 <mark>（会拆文本节点，但旧内核没别的办法）
        ranges.forEach(r => { try { const m = document.createElement('mark'); m.setAttribute('data-hit', '1'); r.surroundContents(m); } catch (e) {} });
    }
    return ranges.length;
}
function applyHelpSearch(scrollToHit) {
    const input = document.getElementById('helpSearchInput');
    if (!input) return;
    const q = input.value.trim().toLowerCase();
    // 搜索框是 sticky（浮在 #helpScrollBody 顶部），滚动位置交给浏览器管，这里不用管它
    // 搜索开始 / 结束时：记住 / 还原各小节的展开状态（清空搜索后不该留着一堆被搜索展开的小节）
    const allSections = () => Array.prototype.slice.call(document.querySelectorAll('#helpOverlay details'));
    if (q && helpOpenSnapshot === null) {
        helpOpenSnapshot = allSections().map(d => d.open);
    } else if (!q && helpOpenSnapshot) {
        const list0 = allSections();
        helpOpenSnapshot.forEach((was, i) => { if (list0[i]) list0[i].open = !!was; });
        helpOpenSnapshot = null;
    }
    clearHelpHighlight();
    window.__helpRanges = [];
    const list = Array.prototype.slice.call(document.querySelectorAll('#helpOverlay details'));
    let hit = 0, firstHit = null;
    list.forEach(d => {
        const ok = !q || d.textContent.toLowerCase().indexOf(q) >= 0;
        d.style.display = ok ? '' : 'none';
        if (ok) {
            hit++;
            if (!firstHit) firstHit = d;
            if (q) d.open = true;        // 命中就展开
            if (q) highlightHelpText(d, q);
        }
    });
    try {
        if (window.CSS && CSS.highlights && typeof Highlight === 'function' && window.__helpRanges.length) {
            const h = new Highlight();
            window.__helpRanges.forEach(r => { try { h.add(r); } catch (e) {} });
            if (h.size) CSS.highlights.set('help-find', h);
        }
    } catch (e) {}
    const noRes = document.getElementById('helpNoResult');
    if (noRes) noRes.style.display = (hit ? 'none' : 'block');
    const helpClear = document.getElementById('helpClearBtn');
    if (helpClear) helpClear.style.display = q ? 'inline-block' : 'none';
    // 跳到第一条命中的关键词那儿（跳小节顶部往往看不到关键词）
    // 之后在搜索框里按回车就是"下一个命中"（Shift+回车＝上一个），循环
    if (q && window.__helpRanges && window.__helpRanges.length) {
        helpFocusHit(0);
    } else if (!q) {
        helpHitIndex = 0;
    }
    // 按钮永远描述"下一步动作"：搜完（命中都展开）→「全部收起」；清空后是混合状态 →「全部展开」
    const toggleBtnEl = document.getElementById('helpToggleAll');
    if (q) { helpAllOpen = true; if (toggleBtnEl) toggleBtnEl.textContent = '全部收起'; }
    else { helpAllOpen = false; if (toggleBtnEl) toggleBtnEl.textContent = '全部展开'; }
}
function resetHelpSearch() {
    const input = document.getElementById('helpSearchInput');
    if (!input) return;
    input.value = '';
    clearHelpHighlight();
    window.__helpRanges = [];
    Array.prototype.slice.call(document.querySelectorAll('#helpOverlay details')).forEach((d) => {
        d.style.display = '';      // 只恢复显示，不动各小节的展开状态（展开/收起交给用户）
    });
    // 清空搜索：还原搜索前的展开状态
    if (helpOpenSnapshot) {
        const list0 = Array.prototype.slice.call(document.querySelectorAll('#helpOverlay details'));
        helpOpenSnapshot.forEach((was, i) => { if (list0[i]) list0[i].open = !!was; });
        helpOpenSnapshot = null;
    }
    helpAllOpen = false;
    const noRes = document.getElementById('helpNoResult');
    if (noRes) noRes.style.display = 'none';
    const btn = document.getElementById('helpToggleAll');
    if (btn) btn.textContent = '全部展开';
    const cb = document.getElementById('helpClearBtn');
    if (cb) cb.style.display = 'none';
}

const helpSearchInputEl = document.getElementById('helpSearchInput');
if (helpSearchInputEl) {
    helpSearchInputEl.addEventListener('input', () => applyHelpSearch(true));
    const helpClearBtnEl = document.getElementById('helpClearBtn');
    if (helpClearBtnEl) helpClearBtnEl.addEventListener('click', () => { resetHelpSearch(); helpSearchInputEl.focus(); });
    // 在搜索框里按 Esc 只清空搜索，不关帮助弹窗
    helpSearchInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); resetHelpSearch(); helpSearchInputEl.blur(); }
        if (e.key === 'Enter') { e.preventDefault(); helpSearchStep(e.shiftKey ? -1 : 1); }
    });
}
const helpToggleAllBtn = document.getElementById('helpToggleAll');
if (helpToggleAllBtn) {
    helpToggleAllBtn.addEventListener('click', () => {
        helpAllOpen = !helpAllOpen;      // 按自己的状态翻转：手动收起几个之后再点，依然是"收起"
        const list = Array.prototype.slice.call(document.querySelectorAll('#helpOverlay details'));   // 含被搜索隐藏的小节，一起展开/收起
        list.forEach(d => { d.open = helpAllOpen; });
        helpToggleAllBtn.textContent = helpAllOpen ? '全部收起' : '全部展开';
    });
}

// ===== 帮助页的滚动位置在哪儿滚 =====
// 帮助弹窗拆成两块（见 index.html）：弹窗头（含 🔄 重启 / ✕，固定不动）+ #helpScrollBody。
// 只有 #helpScrollBody 会滚；里面的搜索框是纯 CSS 的 position:sticky —— 它浮在正文上方、正文从它下面穿过，
// 所以既不用脚本去"吸顶"，也不用给它垫半透明底座（那层底座就是以前那条白带，见 style.css）。
const helpScrollBodyEl = document.getElementById('helpScrollBody');
// 「❓ 从设置跳进帮助某一节」：只临时展开那一节 —— 和搜索一样不留痕，
// 关掉帮助就把现场还原（下次再打开帮助，还是你原来看到的样子，不会老停在这一节）
let helpJumpBack = null;
function rememberHelpForJump() {
    const secs = Array.prototype.slice.call(document.querySelectorAll('#helpOverlay details'));
    helpJumpBack = {
        open: secs.map(d => !!d.open),
        scroll: helpScrollBodyEl ? (helpScrollBodyEl.scrollTop || 0) : 0
    };
}
function restoreHelpAfterJump() {
    if (!helpJumpBack) return;
    const secs = Array.prototype.slice.call(document.querySelectorAll('#helpOverlay details'));
    helpJumpBack.open.forEach((was, i) => { if (secs[i]) secs[i].open = !!was; });
    if (helpScrollBodyEl) helpScrollBodyEl.scrollTop = helpJumpBack.scroll;
    helpJumpBack = null;
}
function closeHelp() {
    restoreHelpAfterJump();
    const overlay = document.getElementById('helpOverlay');
    if (overlay) overlay.classList.add('hidden');
}

// 标题栏 ❓ 按钮：打开帮助弹窗（帮助弹窗内提供"打开控制台"按钮）
// 规则：帮助与设置互斥；已打开时再点一次即关闭
if (titlebarHelp) {
    titlebarHelp.addEventListener('click', () => {
        const overlay = document.getElementById('helpOverlay');
        if (overlay && !overlay.classList.contains('hidden')) { closeHelp(); return; }
        closeModal();
        openHelp();
    });
}
// 帮助弹窗关闭按钮
const helpCloseBtn = document.getElementById('helpClose');
if (helpCloseBtn) {
    helpCloseBtn.addEventListener('click', closeHelp);
}
// 帮助弹窗中的"打开开发者工具"按钮
const helpOpenDevTools = document.getElementById('helpOpenDevTools');
if (helpOpenDevTools) {
    helpOpenDevTools.addEventListener('click', () => {
        if (api && api.openDevTools) api.openDevTools();
        else showToast('开发者工具不可用', 1500);
    });
}
// 帮助弹窗中的"重启软件"按钮（界面卡住时也能用）
// 点它 = 记下当前所在的书 / 画布位置，重启后自动回到那里（正常关掉再打开不恢复）
const helpRestartBtn = document.getElementById('helpRestart');
if (helpRestartBtn) {
    helpRestartBtn.addEventListener('click', () => {
        saveRestartSession();
        if (api && api.restartApp) api.restartApp();
        else showToast('重启功能不可用', 1500);
    });
}

// ===== 重启后回到原处（只认「重启软件」按钮；手动关闭再打开不读取）=====
const RESTART_STATE_KEY = 'novel-tool-restart-state';
const RESTART_PENDING_KEY = 'novel-tool-restart-pending';

// 点重启按钮时调用：记下"重启前在哪"（只留最近一次，不累计）
function saveRestartSession() {
    try {
        const inBook = !!(currentFilePath && editorView && editorView.style.display !== 'none');
        localStorage.setItem(RESTART_STATE_KEY, JSON.stringify({
            view: inBook ? 'book' : 'home',
            filePath: inBook ? currentFilePath : null,
            contextId: inBook ? (currentContextId || null) : null,      // 在哪个画布层
            selectedId: inBook ? (currentSelectedId || null) : null,    // 选中的词条（详情页）
            canvas: inBook ? { left: canvas.scrollLeft || 0, top: canvas.scrollTop || 0 } : null
        }));
        localStorage.setItem(RESTART_PENDING_KEY, '1');   // 置了这个标记，下次启动才恢复
    } catch (e) {}
}

// 启动时调用：上限就是"回到上次点重启时的那本书 + 那个画布位置"
async function restoreRestartSession() {
    let pending = false, state = null;
    try {
        pending = localStorage.getItem(RESTART_PENDING_KEY) === '1';
        state = JSON.parse(localStorage.getItem(RESTART_STATE_KEY) || 'null');
        localStorage.removeItem(RESTART_PENDING_KEY);   // 只生效一次：之后自己关掉再打开就回书库页
    } catch (e) {}
    if (!pending || !state || state.view !== 'book' || !state.filePath) return;
    await openProject(state.filePath);
    if (currentFilePath !== state.filePath) {           // 书被删了 / 改名了
        showToast('上次打开的书已经找不到了，先回到书库页', 3200);
        return;
    }
    setTimeout(() => {
        const has = (id) => !!(id && currentProject.nodes && currentProject.nodes.some(n => n.id === id));
        if (has(state.contextId)) currentContextId = state.contextId;
        if (has(state.selectedId)) currentSelectedId = state.selectedId;
        renderAll();
        if (state.canvas) {
            canvas.scrollLeft = state.canvas.left || 0;
            canvas.scrollTop = state.canvas.top || 0;
        }
    }, 80);
}
// 点击帮助弹窗遮罩关闭（带拖动检测：从弹窗内开始拖选文字、在遮罩上松手时不误关）
const helpOverlayEl = document.getElementById('helpOverlay');
helpOverlayEl.addEventListener('keydown', (e) => {
    // 帮助里按 Ctrl+A：只全选帮助内容（默认会连带选中后面的工具栏/详情页）
    if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea') return;      // 在搜索框里就按原生行为（选中框内文字）
        const content = document.getElementById('helpContent');
        if (!content) return;
        e.preventDefault();
        const range = document.createRange();
        range.selectNodeContents(content);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
});
if (helpOverlayEl) {
    let helpOverlayDown = null;
    helpOverlayEl.addEventListener('mousedown', (e) => {
        helpOverlayDown = {
            x: e.clientX,
            y: e.clientY,
            inModal: !!(e.target && e.target.closest && e.target.closest('.modal'))
        };
    });
    helpOverlayEl.addEventListener('click', (e) => {
        if (e.target !== helpOverlayEl) return;
        const d = helpOverlayDown;
        helpOverlayDown = null;
        // 起点在弹窗内（在选文字）或发生了明显拖动 → 不关闭
        if (d && (d.inModal || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5)) return;
        closeHelp();
    });
}
// 帮助弹窗中的"显示完整路径"开关
const helpShowPath = document.getElementById('helpShowPath');
if (helpShowPath) {
    helpShowPath.addEventListener('change', () => {
        showBreadcrumbPath = helpShowPath.checked;
        renderBreadcrumb();
    });
}
// 深色模式：标题栏 ☀️/🌙 图标切换（记住选择）
const titlebarTheme = document.getElementById('titlebarTheme');
function applyDarkMode(dark) {
    document.body.classList.toggle('dark', dark);
    if (titlebarTheme) titlebarTheme.textContent = dark ? '🌙' : '☀️';
    try { localStorage.setItem('novel-tool-dark', dark ? '1' : '0'); } catch (e) {}
    // 刷新界面，让详情文字等随主题立即变化
    try { renderAll(); } catch (e) {}
}
if (titlebarTheme) {
    titlebarTheme.addEventListener('click', () => {
        applyDarkMode(!document.body.classList.contains('dark'));
    });
}
// 启动时恢复深色模式
try {
    if (localStorage.getItem('novel-tool-dark') === '1') {
        applyDarkMode(true);
    }
} catch (e) {}


// ============================================================
// 标题栏事件（独立于主线程，卡死时仍可点击）
// ============================================================

if (titlebarMinimize) {
    titlebarMinimize.addEventListener('click', () => {
        if (api && api.minimize) api.minimize();
    });
}
if (titlebarMaximize) {
    titlebarMaximize.addEventListener('click', () => {
        if (api && api.maximize) api.maximize();
    });
}
// 最大化/还原：按钮图标与提示跟随窗口状态切换（内联 SVG，宽高一致、不依赖系统字体）
const TITLEBAR_SVG_MAX = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.55" y="0.55" width="8.9" height="8.9" fill="none" stroke="currentColor" stroke-width="1.1" /></svg>';
const TITLEBAR_SVG_RESTORE = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.55" y="2.55" width="6.9" height="6.9" fill="none" stroke="currentColor" stroke-width="1.1" /><polyline points="2.55,2.55 2.55,0.55 9.45,0.55 9.45,7.45 7.45,7.45" fill="none" stroke="currentColor" stroke-width="1.1" /></svg>';
function applyMaximizedState(isMaximized) {
    if (!titlebarMaximize) return;
    titlebarMaximize.innerHTML = isMaximized ? TITLEBAR_SVG_RESTORE : TITLEBAR_SVG_MAX;
    titlebarMaximize.title = isMaximized ? '还原' : '最大化';
}
if (api && api.onMaximizedChange) {
    api.onMaximizedChange(applyMaximizedState);
}
// 标题栏 ⚙️ 设置：与帮助互斥；已打开时再点一次即关闭（只影响当前这本书的重置项）
const titlebarReset = document.getElementById('titlebarReset');
if (titlebarReset) {
    titlebarReset.addEventListener('click', () => {
        if (modalOverlay && !modalOverlay.classList.contains('hidden')) { closeModal(); return; }
        closeHelp();
        openResetModal();
    });
}
if (titlebarClose) {
    titlebarClose.addEventListener('click', () => {
        if (api && api.close) api.close();
    });
}

// ============================================================
// 书库页批量删除
// ============================================================

btnHomeBatchMode.addEventListener('click', (e) => {
    e.stopPropagation();
    const dropdown = document.getElementById('homeBatchDropdown');
    const isOpen = dropdown.style.display === 'block';
    if (isOpen) {
        dropdown.style.display = 'none';
        isHomeBatchMode = false;
        homeSelectedIds.clear();
        renderProjectList(currentProjectsCache);
    } else {
        dropdown.style.display = 'block';
        isHomeBatchMode = true;
        homeSelectedIds.clear();
        renderProjectList(currentProjectsCache);
        syncHomeBatchSelectAll();   // 刚进批量删除：一个都没选，框自然回到未勾选
        showToast('点击卡片选择/取消，点击「确认删除」执行', 1500);
    }
});

document.getElementById('homeBatchSelectAll').addEventListener('change', (e) => {
    const checked = e.target.checked;
    if (checked) {
        currentProjectsCache.forEach(p => homeSelectedIds.add(p.filePath));
    } else {
        homeSelectedIds.clear();
    }
    renderProjectList(currentProjectsCache);
});

// 「全选」框要和实际选中保持同步：手点卡片一个个选满之后，框也要跟着勾上（以前只有点框才会变）
function syncHomeBatchSelectAll() {
    const cb = document.getElementById('homeBatchSelectAll');
    if (!cb) return;
    cb.checked = currentProjectsCache.length > 0 && homeSelectedIds.size === currentProjectsCache.length;
}

document.getElementById('homeBatchConfirmDelete').addEventListener('click', () => {
    if (homeSelectedIds.size === 0) { showToast('请先选择小说'); return; }
    const names = [];
    currentProjectsCache.forEach(p => {
        if (homeSelectedIds.has(p.filePath)) names.push(p.name);
    });
    const html = `
        <div class="modal-header">
            <h2>🗑️ 批量删除小说</h2>
            <button type="button" class="close-btn">✕</button>
        </div>
        <div class="modal-body">
            <p style="font-size:16px; margin-bottom:8px;">确定要删除以下 <strong>${homeSelectedIds.size}</strong> 本小说吗？</p>
            <ul style="padding-left:20px; margin:8px 0; color:var(--text-secondary);">${names.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
            <p style="font-size:13px; color:var(--text-secondary);">删除后进入书籍回收站，可恢复。</p>
        </div>
        <div class="modal-footer">
            <button class="btn-cancel" onclick="closeModal()">取消</button>
            <button id="confirmHomeBatchDelete" class="btn-delete">🗑️ 确认删除</button>
        </div>
    `;
    openModal(html);
    document.getElementById('confirmHomeBatchDelete').addEventListener('click', async () => {
        const paths = Array.from(homeSelectedIds);
        let success = 0;
        for (const p of paths) {
            try {
                // 批量删除也进入全局书籍回收站（可恢复）
                const loadRes = await api.loadProject(p);
                if (loadRes.success) {
                    await api.trashBook({
                        id: loadRes.data.projectName || p,
                        name: loadRes.data.projectName || getBaseName(p).replace('.json', ''),
                        filePath: p,
                        data: loadRes.data,
                        deletedAt: Date.now()
                    });
                }
                const result = await api.deleteProject(p);
                if (result.success) success++;
            } catch (err) {}
        }
        homeSelectedIds.clear();
        closeModal();
        showToast(`已删除 ${success} 本小说（可在书籍回收站恢复）`);
        document.getElementById('homeBatchDropdown').style.display = 'none';
        isHomeBatchMode = false;
        renderProjectList(currentProjectsCache);
        loadProjects();
        loadBookTrash();  // 批量删除后书籍回收站也实时刷新
    });
});

document.getElementById('homeBatchCancel').addEventListener('click', () => {
    document.getElementById('homeBatchDropdown').style.display = 'none';
    isHomeBatchMode = false;
    homeSelectedIds.clear();
    renderProjectList(currentProjectsCache);
});

document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('homeBatchDropdown');
    const btn = document.getElementById('btnHomeBatchMode');
    if (dropdown && btn && !dropdown.contains(e.target) && !btn.contains(e.target)) {
        // 批量模式下保持下拉框打开（避免点击书籍卡片时下拉框收回）
        if (!isHomeBatchMode) {
            dropdown.style.display = 'none';
        }
    }
});


// ============================================================
// 书库页
// ============================================================

async function loadProjects() {
    try {
        // 加载中占位：避免未加载完先显示"没有小说"的空状态
        if (projectGrid && !currentProjectsCache.length) {
            projectGrid.innerHTML = '<div style="grid-column:1/-1; padding:60px; text-align:center; color:var(--text-secondary); font-size:15px;">⏳ 正在加载书库…</div>';
        }
        const projects = await api.getProjects();
        currentProjectsCache = projects;
        renderProjectList(projects);
        document.getElementById('homeStats').textContent = projects.length + ' 本小说';
    } catch (e) {
        showToast('加载项目失败: ' + e.message, 2000);
    }
}

function renderProjectList(projects) {
    projectGrid.innerHTML = '';
    if (projects.length === 0) {
        projectGrid.innerHTML = `
            <div class="empty-state" style="position:relative;transform:none;top:auto;left:auto;grid-column:1/-1;padding:60px;">
                <div class="icon">📖</div>
                <p>还没有小说，点击「新建小说」开始创作吧</p>
                <div class="hint">小说保存在程序同目录下的「小说库」文件夹中</div>
            </div>
        `;
        return;
    }
    const isMultiselect = isHomeBatchMode;
    projects.forEach(p => {
        const card = document.createElement('div');
        card.className = 'project-card';
        card.dataset.path = p.filePath;
        const timeStr = new Date(p.updatedAt).toLocaleString('zh-CN');
        if (isMultiselect && homeSelectedIds.has(p.filePath)) {
            card.style.border = '2px solid #e74c3c';
            card.style.boxShadow = '0 0 0 4px rgba(231,76,60,0.15)';
        } else {
            card.style.border = '';
            card.style.boxShadow = '';
        }
        card.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="flex:1;">
                    <div class="card-title">${escapeHtml(p.name)}</div>
                    <div class="card-meta">
                        <span>📄 词条: ${p.nodeCount}</span>
                        <span>🕐 ${timeStr}</span>
                    </div>
                </div>
            </div>
            <div class="card-actions">
                <button class="open-btn" data-path="${p.filePath}">📂 打开</button>
                <button class="rename-btn" data-path="${p.filePath}" data-name="${escapeHtml(p.name)}">✎ 重命名</button>
                <button class="del-btn" data-path="${p.filePath}">🗑️ 删除</button>
            </div>
        `;
        card.querySelector('.open-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openProject(p.filePath);
        });
        card.querySelector('.rename-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            showRenameProjectModal(p);
        });
        card.querySelector('.del-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            showDeleteProjectModal(p);
        });
        // 卡片点击：多选模式下切换选中状态（只更新样式，不重建列表，避免点击失效）
        card.addEventListener('click', (e) => {
            if (e.target.closest('.card-actions')) return;
            if (isMultiselect) {
                const path = card.dataset.path || p.filePath;
                if (homeSelectedIds.has(path)) {
                    homeSelectedIds.delete(path);
                } else {
                    homeSelectedIds.add(path);
                }
                if (homeSelectedIds.has(path)) {
                    card.style.border = '2px solid #e74c3c';
                    card.style.boxShadow = '0 0 0 4px rgba(231,76,60,0.15)';
                } else {
                    card.style.border = '';
                    card.style.boxShadow = '';
                }
                syncHomeBatchSelectAll();   // 手点卡片选满之后，「全选」框也要跟着勾上
            }
        });
        card.addEventListener('dblclick', () => openProject(p.filePath));
        // 书库页项目卡片右键菜单
        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(e.clientX, e.clientY, [
                { label: '📂 打开', action: () => openProject(p.filePath) },
                { label: '✎ 重命名', action: () => showRenameProjectModal(p) },
                { label: '📤 导出 Markdown', action: () => exportOneBook(p) },
                { label: '🗑️ 删除', action: () => showDeleteProjectModal(p) }
            ]);
        });
        projectGrid.appendChild(card);
    });
    clearStraySelection();   // 书库页重绘后同样兜底（"退出到书库书名也被选中"就是这一路）
}

// 书库页导出单本小说为 Markdown
async function exportOneBook(project) {
    try {
        const res = await api.loadProject(project.filePath);
        if (!res.success) { showToast('加载失败: ' + res.error); return; }
        const md = buildMarkdownFromData(res.data, project.name);
        const result = await api.exportMarkdown(md, project.name);
        if (result && result.success) showToast('已导出「' + project.name + '」');
    } catch (e) {
        showToast('导出失败: ' + e.message);
    }
}

// ---------- 新建小说 ----------
document.getElementById('btnNewProject').addEventListener('click', () => {
    const html = `
        <form id="createProjectForm">
            <div class="modal-header">
                <h2>📝 创建新小说</h2>
                <button type="button" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <label>小说名称</label>
                <input type="text" id="newProjectName" placeholder="例如：修仙传" autofocus required />
            </div>
            <div class="modal-footer">
                <button type="button" class="btn-cancel" onclick="closeModal()">取消</button>
                <button type="submit" class="btn-save">✨ 创建</button>
            </div>
        </form>
    `;
    openModal(html);
    const nameInput = document.getElementById('newProjectName');
    if (nameInput) setTimeout(() => nameInput.focus(), 100);
    const form = document.getElementById('createProjectForm');
    form.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            form.dispatchEvent(new Event('submit'));
        }
    });
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('newProjectName').value.trim();
        if (!name) { showToast('请输入名称'); return; }
        try {
            const result = await api.createProject(name);
            if (result.success) {
                closeModal();
                showToast('已创建');
                loadProjects();
            } else {
                showToast('创建失败: ' + result.error);
            }
        } catch (err) {
            showToast('创建失败: ' + err.message);
        }
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
});

document.getElementById('btnRefreshProjects').addEventListener('click', loadProjects);
document.getElementById('btnOpenWorkspace').addEventListener('click', async () => {
    try {
        const result = await api.openWorkspace();
        if (!result || !result.success) {
            showToast('无法打开文件夹: ' + (result?.error || '未知错误'), 2000);
        }
    } catch (e) {
        showToast('打开文件夹失败: ' + e.message);
    }
});

// ----- 删除小说（进入书籍回收站）-----
function showDeleteProjectModal(project) {
    const html = `
        <div class="modal-header">
            <h2>🗑️ 删除小说</h2>
            <button type="button" class="close-btn">✕</button>
        </div>
        <div class="modal-body">
            <p style="font-size:16px; margin-bottom:8px;">
                确定要删除 <strong>「${escapeHtml(project.name)}」</strong> 吗？
            </p>
            <p style="font-size:13px; color:var(--text-secondary);">删除后进入书籍回收站，可恢复。</p>
        </div>
        <div class="modal-footer">
            <button class="btn-cancel" onclick="closeModal()">取消</button>
            <button id="confirmDeleteProject" class="btn-delete">🗑️ 确认删除</button>
        </div>
    `;
    openModal(html);
    document.getElementById('confirmDeleteProject').addEventListener('click', async () => {
        try {
            const result = await api.loadProject(project.filePath);
            if (result.success) {
                // 移入全局书籍回收站（实时生效，无需重新打开）
                await api.trashBook({
                    id: project.id || project.filePath,
                    name: project.name,
                    filePath: project.filePath,
                    data: result.data,
                    deletedAt: Date.now()
                });
                await api.deleteProject(project.filePath);
                closeModal();
                showToast('已删除「' + project.name + '」，可在书籍回收站恢复');
                loadProjects();
                loadBookTrash();  // 若书籍回收站面板已打开，立即刷新显示
            } else {
                showToast('删除失败: ' + result.error);
            }
        } catch (e) {
            showToast('删除失败: ' + e.message);
        }
    });
}

// ----- 小说重命名 -----
function showRenameProjectModal(project) {
    const html = `
        <form id="renameProjectForm">
            <div class="modal-header">
                <h2>✎ 重命名小说</h2>
                <button type="button" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <label>新名称</label>
                <input type="text" id="renameProjectInput" value="${escapeHtml(project.name)}" autofocus required />
            </div>
            <div class="modal-footer">
                <button type="button" class="btn-cancel" onclick="closeModal()">取消</button>
                <button type="submit" class="btn-save">💾 确认</button>
            </div>
        </form>
    `;
    openModal(html);
    const input = document.getElementById('renameProjectInput');
    if (input) setTimeout(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);  // 光标放到已有文字末尾，直接输入在末尾追加
    }, 100);
    const form = document.getElementById('renameProjectForm');
    form.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            form.dispatchEvent(new Event('submit'));
        }
    });
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newName = document.getElementById('renameProjectInput').value.trim();
        if (!newName) { showToast('请输入名称'); return; }
        try {
            // 重命名时同步修改磁盘上的 .json 文件名（冲突自动加序号）
            const result = await api.renameProject(project.filePath, newName);
            if (result.success) {
                closeModal();
                showToast('已重命名为「' + newName + '」');
                loadProjects();
            } else {
                showToast('重命名失败: ' + result.error);
            }
        } catch (e) {
            showToast('操作失败: ' + e.message);
        }
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
}

// ============================================================
// 编辑器
// ============================================================

async function openProject(filePath) {
    try {
        // 打开书：大书才浮出开屏（快的话你根本看不到它）
        showSplash('正在打开《' + getBaseName(filePath).replace('.json', '') + '》…');
        const result = await api.loadProject(filePath);
        if (!result.success) { showToast('加载失败: ' + result.error); hideSplash(); return; }
        currentFilePath = filePath;
        currentProject = result.data;
        if (!currentProject.trash) currentProject.trash = [];
        if (!currentProject.bookTrash) currentProject.bookTrash = [];
        currentProjectName = currentProject.projectName || getBaseName(filePath).replace('.json', '');

        ensureRootNode();

        homeView.style.display = 'none';
        editorView.style.display = 'flex';
        hideSplash();     // 已经进到编辑器了 → 开屏可以收了
        // 编辑器内书名限制显示 16 个汉字，超出用 '..' 表示
        editorTitle.textContent = currentProjectName.length > 16 ? currentProjectName.slice(0, 16) + '..' : currentProjectName;
        setFileIndicator('saved');
        projectDirty = false;      // 刚打开的这本书：没有未保存的改动
        leaveWithoutSaving = false;
        // 上一本书留下的运行期历史一律不跟过来（撤销栈 / 剪贴板 / 重置快照 / 前进栈）
        undoStack.length = 0;
        clipboardNodes = [];
        clearResetSnapshots();
        navForwardHistory = [];

        resetModes();
        // 「防误操作」：本次运行内按书记忆（切走再回来仍保持；重启软件后重置）
        isLockedState = !!bookLockState.get(filePath);
        document.body.classList.toggle('locked', isLockedState);
        detailScrollMap.clear();  // 清空详情页滚动位置记忆（避免跨项目残留）
        lastDetailSelectedId = null;
        document.getElementById('btnLock').textContent = isLockedState ? '🔒' : '🔓';
        currentContextId = rootNodeId;
        currentSelectedId = rootNodeId;
        canvas.style.cursor = 'grab';

        // 清空浏览历史
        navHistory = [];

        // 恢复画布背景（统一处理颜色/图片）
        applyCanvasBg();

        renderAll();

        markProjectClean();   // 收尾：打开书时的渲染会触发保存调度，这里重置成"干净"状态（否则刚打开就显示"有未保存内容"）
        showToast('已加载: ' + currentProjectName);
    } catch (e) {
        showToast('打开项目失败: ' + e.message);
    }
}

function ensureRootNode() {
    let root = currentProject.nodes.find(n => n.parentId === '__root__');
    if (!root) {
        root = {
            id: genId(),
            title: currentProjectName,
            summary: '',
            content: '',
            parentId: '__root__',
            isRoot: true,
            x: 0, y: 0, color: '#ffffff', number: '0'
        };
        currentProject.nodes.push(root);
    }
    rootNodeId = root.id;
}

function switchToHomeList(force) {
    // 关掉自动保存 + 还有没写进文件的改动 → 先问用户要不要保存（force=true 表示已在弹窗里确认过，直接走）
    if (!force && currentFilePath && !autoSaveEnabled && hasUnsavedChanges() && editorView && editorView.style.display !== 'none') {
        askSaveBeforeLeave(() => switchToHomeList(true));
        return;
    }
    cancelCutPending();    // 退出书籍：取消"剪切待粘贴"（恢复淡灰词条）
    clipboardNodes = [];   // 清空剪贴板：避免把上一本书复制的词条粘到另一本书
    undoStack.length = 0;  // 清空撤销栈：避免在别的书 / 书库页还能撤回上一本书的修改
    clearResetSnapshots(); // 同理：清掉"重置前"的快照，避免在别的书里点「恢复上次重置」套用上一本书的配置
    if (trashPanel && !trashPanel.classList.contains('hidden')) {
        trashPanel.classList.add('hidden');
    }
    if (bookTrashPanel && !bookTrashPanel.classList.contains('hidden')) {
        bookTrashPanel.classList.add('hidden');
    }
    if (multiselectBar) {
        multiselectBar.classList.remove('visible');
        multiselectBar.style.display = 'none';
    }
    resetModes();
    // 开着自动保存：照旧存一次再走；关着自动保存时上面已经问过用户了，这里不再偷偷写盘
    if (currentFilePath && autoSaveEnabled) saveCurrentProject(true);
    projectDirty = false;
    leaveWithoutSaving = false;
    homeView.style.display = 'flex';
    editorView.style.display = 'none';
    loadProjects();
}
// 退出这本书（回到书库页）
btnExitProject.addEventListener('click', () => switchToHomeList());

// ---------- 保存 ----------
async function saveCurrentProject(silent = false) {
    if (!currentFilePath) return;
    try {
        const result = await api.saveProject(currentFilePath, currentProject);
        if (result.success) {
            projectDirty = false;   // 已经写进文件：退出时不用再问要不要保存
            cleanSnapshot = projectSnapshot();   // 记下"已落盘的样子"，之后拿它判断是不是真有新改动
            setFileIndicator('saved');
            if (!silent) showToast('已保存');
        } else showToast('保存失败: ' + result.error);
    } catch (e) {
        showToast('保存异常: ' + e.message);
    }
}

// 保存状态角标（跟在书名后面）：未保存时显示 ●，已保存则隐藏（类似 VS Code / PS 的标题角标）
function setFileIndicator(state) {
    if (!fileIndicator) return;
    if (state === 'saved') {
        fileIndicator.textContent = '';
        fileIndicator.title = '已保存';
        fileIndicator.style.display = 'none';
        return;
    }
    fileIndicator.textContent = state === 'saving' ? '◉' : '●';
    fileIndicator.title = state === 'saving' ? '保存中…' : '未保存';
    fileIndicator.style.display = 'inline-block';
    fileIndicator.style.opacity = state === 'saving' ? '0.45' : '1';
}

// 打开书 / 保存成功时的数据快照：用来分辨"真改动"和"只是重新渲染了一遍"
// （进出一个子画布、窗口缩放触发的自动排列等都会调用 scheduleSave 把 dirty 置上，
//   但数据可能根本没变——靠快照比较，避免这些情况下也弹"有未保存内容"）
let cleanSnapshot = '';
function projectSnapshot() {
    try { return JSON.stringify(currentProject || null); } catch (e) { return ''; }
}
// 是否真的还有没写进文件的改动（关掉自动保存时，退出项目 / 关软件前用它决定要不要问你）
function hasUnsavedChanges() {
    if (!projectDirty) return false;
    const now = projectSnapshot();
    return !cleanSnapshot || now !== cleanSnapshot;
}
// 标记"当前这本书是干净的"（没有未保存改动）：
// 打开书 / 新建书 / 导入书这类"加载类"流程的最后调用一次——这些流程内部会触发保存调度（scheduleSave），
// 不在收尾处重置的话，刚打开一本书就会被算成"有未保存内容"，退出时会莫名弹窗
function markProjectClean() {
    projectDirty = false;
    leaveWithoutSaving = false;
    cleanSnapshot = projectSnapshot();
    setFileIndicator('saved');
}

// 默认文字颜色（⚙️ 设置 →「🖥️ 全局设置」里可改；空 = 用内置默认 #1a1a2e）
// 它是**全局**设置（所有书共用），但有两处重置会顺手把它清回默认（按老习惯）：
//   ① 「🪟 初始化这本书」——勾着「同时把全局设置恢复默认」时；
//   ② 「🎨 重置本书词条样式」——连它一起回默认（按钮下面那行小字、帮助里都写明了）
const DEFAULT_NODE_TEXT_COLOR_KEY = 'novel-tool-default-node-text-color';
function getDefaultNodeTextColor() { try { return localStorage.getItem(DEFAULT_NODE_TEXT_COLOR_KEY) || ''; } catch (e) { return ''; } }
function setDefaultNodeTextColor(v) { try { if (v) localStorage.setItem(DEFAULT_NODE_TEXT_COLOR_KEY, v); else localStorage.removeItem(DEFAULT_NODE_TEXT_COLOR_KEY); } catch (e) {} }

// 把设置面板里「词条默认文字颜色」的选色框刷新成当前值（面板没开就跳过）
function syncDefaultColorInputs() {
    const a = document.getElementById('defaultNodeTextColor');
    if (!a) return;
    // 没设过（空）时显示内置默认色 #1a1a2e —— 和词条实际用的兜底色一致，
    // 这样"恢复默认"之后色块不会跳成黑色/白色，一看就知道现在是内置默认
    const v = getDefaultNodeTextColor();
    a.value = /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : '#1a1a2e';
    const h = document.getElementById('defaultNodeTextColorHex');   // 旁边那个"能复制/粘贴"的颜色值输入框
    if (h) h.value = a.value;
}

// 自动保存间隔（可在 ⚙️ 设置里调整，单位毫秒）
let saveIntervalMs = (() => {
    const v = parseInt(localStorage.getItem('novel-tool-save-interval') || '', 10);
    return (Number.isFinite(v) && v >= 200 && v <= 60000) ? v : 1500;
})();
function setSaveInterval(ms) {
    saveIntervalMs = ms;
    try { localStorage.setItem('novel-tool-save-interval', String(ms)); } catch (e) {}
}
// 自动保存开关（全局偏好，默认开启）：关掉后不再定时写盘，只有手动保存（Ctrl+S / 工具栏 💾）才保存
// 给喜欢手动保存的人用；「初始化这本书」会把它恢复成默认的"开启"
let autoSaveEnabled = (() => {
    try { return localStorage.getItem('novel-tool-autosave') !== '0'; }
    catch (e) { return true; }
})();
function setAutoSaveEnabled(v) {
    autoSaveEnabled = (v !== false);
    try { localStorage.setItem('novel-tool-autosave', autoSaveEnabled ? '1' : '0'); } catch (e) {}
}
// 当前这本书有没有"还没写进文件"的改动：关掉自动保存时，退出项目 / 关闭软件前用它决定要不要问你
let projectDirty = false;
// 用户在"有改动还没保存"弹窗里选了"不保存"：避免关闭窗口时 beforeunload 又偷偷写一次盘
let leaveWithoutSaving = false;
// 词条背景图的显示方式（全局偏好）：cover 铺满裁切 / contain 完整显示 / stretch 拉伸填充
let nodeBgFit = (() => {
    try {
        const v = localStorage.getItem('novel-tool-bg-fit');
        return (v === 'contain' || v === 'stretch') ? v : 'cover';
    } catch (e) { return 'cover'; }
})();
function setNodeBgFit(v) {
    nodeBgFit = (v === 'contain' || v === 'stretch') ? v : 'cover';
    try { localStorage.setItem('novel-tool-bg-fit', nodeBgFit); } catch (e) {}
}
const NODE_BG_FIT_OPTIONS = [
    { v: 'cover',   short: '铺满裁切', label: '铺满并裁切（默认，不留空白）' },
    { v: 'contain', short: '完整显示', label: '完整显示整张图（可能留白）' },
    { v: 'stretch', short: '拉伸填充', label: '拉伸填满（可能变形）' }
];
// 背景图显示方式：优先用词条自己的设置，没有则用全局默认（⚙️ 里的那个）
function nodeBgSizeCss(fit) {
    const f = fit || nodeBgFit;
    if (f === 'contain') return 'contain';
    if (f === 'stretch') return '100% 100%';
    return 'cover';
}

// 粘贴位置：mouse = 鼠标所在位置（自动避让） / bottom = 目前词条的最后面
let pastePosMode = (() => {
    try { return localStorage.getItem('novel-tool-paste-pos') === 'bottom' ? 'bottom' : 'mouse'; }
    catch (e) { return 'mouse'; }
})();
function setPastePosMode(v) {
    pastePosMode = (v === 'bottom') ? 'bottom' : 'mouse';
    try { localStorage.setItem('novel-tool-paste-pos', pastePosMode); } catch (e) {}
}
const PASTE_POS_OPTIONS = [
    { v: 'mouse',  short: '鼠标位置', label: '粘贴到鼠标所在位置（自动避开已有词条）' },
    { v: 'bottom', short: '最下方',   label: '粘贴到当前词条的最后面' }
];
// 最后一次鼠标在画布内的坐标（画布坐标系，用于"粘贴到鼠标位置"）
let lastCanvasPointer = null;

// 自动保存间隔的候选项（设置面板用一排按钮平铺，比下拉更直观，也没有下拉被裁剪/顶内容的问题）
const SAVE_INTERVAL_OPTIONS = [
    { v: 300,  short: '0.3 秒', label: '改完约 0.3 秒后保存（最保险）' },
    { v: 1500, short: '1.5 秒（默认）', label: '改完约 1.5 秒后保存（默认）' },
    { v: 3000, short: '3 秒', label: '改完约 3 秒后保存' },
    { v: 8000, short: '8 秒', label: '改完约 8 秒后保存（省性能）' }
];

// ---------- 全局设置（⚙️ 设置面板最上面那块「🖥️ 全局设置 · 对所有书生效」）----------
// 「全局」＝ 对所有书都生效的界面偏好（改一次，每本书都跟着变），和「这本书的数据」分开：
//   · 存在 localStorage 里（跟着这台电脑走，不写进书文件）；
//   · 「恢复默认」只把偏好改回默认，**不碰任何书的内容**；
//   · 「🪟 初始化这本书」里可以选择要不要连它们一起恢复默认（默认勾着）。
const GLOBAL_SETTINGS_DEFAULT = {
    dark: false,            // 主题：浅色（默认不开深色模式）
    autoSave: true,         // 自动保存：开
    saveInterval: 1500,     // 自动保存间隔：1.5 秒
    bgFit: 'cover',         // 词条背景图默认显示方式：铺满裁切
    pastePos: 'mouse',      // 词条粘贴位置：鼠标位置
    defaultTextColor: '',   // 词条默认文字颜色：内置默认
    detailWidth: 400,       // 详情页宽度：400px
    cropLock: true          // 🔒 锁定裁剪框：锁定
};
const DETAIL_WIDTH_PRESETS = [
    { v: 300, short: '窄 300' },
    { v: 400, short: '默认 400' },
    { v: 480, short: '宽 480' },
    { v: 560, short: '超宽 560' }
];
let settingsPanelRefresh = null;   // 设置面板打开时被赋值：用来把这一块刷新成最新值（面板没开就是 null）

// 当前是否正处在「书里」：书库页时与书相关的刷新要跳过（免得去动不存在的画布）
function inBookView() {
    return !!(currentFilePath && editorView && editorView.style.display !== 'none');
}

// 收起「🖥️ 全局设置」时，标题下面那行"当前值"小字（收起也能一眼看到现在是哪样）
function globalSettingsSummary() {
    const siOpt = SAVE_INTERVAL_OPTIONS.find(o => o.v === saveIntervalMs);
    const secs = siOpt ? siOpt.short.replace('（默认）', '')
        : (saveIntervalMs % 1000 === 0 ? (saveIntervalMs / 1000) + ' 秒' : (saveIntervalMs / 1000).toFixed(1) + ' 秒');
    const fit = (NODE_BG_FIT_OPTIONS.find(o => o.v === nodeBgFit) || {}).short || nodeBgFit;
    const pos = (PASTE_POS_OPTIONS.find(o => o.v === pastePosMode) || {}).short || pastePosMode;
    const w = (detailPanel && detailPanel.offsetWidth) ? detailPanel.offsetWidth : DETAIL_PANEL_DEFAULT_WIDTH;
    return [
        autoSaveEnabled ? `自动保存 ${secs}` : '自动保存 关',
        document.body.classList.contains('dark') ? '深色' : '浅色',
        fit, pos, `详情页 ${w}px`, `裁剪框${cropLock ? '锁定' : '自由'}`
    ].join(' · ');
}
function renderGlobalSettingsSummary() {
    const el = document.getElementById('gsSummaryText');
    if (el) el.textContent = globalSettingsSummary();
}

// 「↩ 恢复全部默认设置」：把上面这些偏好一次全恢复成默认（**不碰任何书的数据**，所以不用担风险）
function resetAllGlobalSettings() {
    applyDarkMode(GLOBAL_SETTINGS_DEFAULT.dark);
    setAutoSaveEnabled(GLOBAL_SETTINGS_DEFAULT.autoSave);
    setSaveInterval(GLOBAL_SETTINGS_DEFAULT.saveInterval);
    setNodeBgFit(GLOBAL_SETTINGS_DEFAULT.bgFit);
    setPastePosMode(GLOBAL_SETTINGS_DEFAULT.pastePos);
    setDefaultNodeTextColor(GLOBAL_SETTINGS_DEFAULT.defaultTextColor);
    setDetailWidth(GLOBAL_SETTINGS_DEFAULT.detailWidth);
    cropSetLock(GLOBAL_SETTINGS_DEFAULT.cropLock, true);
    syncDefaultColorInputs();
    if (inBookView()) renderCanvas();
    if (settingsPanelRefresh) { try { settingsPanelRefresh(); } catch (e) {} }
}

let saveTimer = null;
function scheduleSave() {
    clearTimeout(saveTimer);
    projectDirty = true;        // 有改动：关掉自动保存后，退出项目 / 关软件会拿这个来判断要不要问你
    setFileIndicator('dirty');  // 有改动即标记未保存（显示角标）
    if (!autoSaveEnabled) return;  // 已关闭自动保存：只标记未保存，等你手动保存（Ctrl+S / 💾）
    saveTimer = setTimeout(() => saveCurrentProject(true), saveIntervalMs);
}

// ---------- 编号 ----------
function updateAllNumbers() {
    // 确保每个节点有稳定的 createdAt：从 id 时间戳提取（id = n_时间戳_随机）
    currentProject.nodes.forEach(n => {
        if (!n.createdAt) {
            const ts = parseInt(String(n.id || '').split('_')[1]) || 0;
            n.createdAt = ts || Date.now();
        }
    });
    // 同一时间戳的节点（如同一毫秒批量导入）按数组顺序补微小偏移，保证顺序稳定且可还原
    const seen = {};
    currentProject.nodes.forEach(n => {
        const key = n.createdAt;
        seen[key] = seen[key] || 0;
        n.createdAt = Number(key) + seen[key] * 0.001;
        seen[key]++;
    });

    currentProject.nodes.forEach(n => delete n.number);
    const root = currentProject.nodes.find(n => n.parentId === '__root__');
    if (root) root.number = '0';

    // 预建 父ID → 子节点列表 映射（并排序）：把原来每个节点都 filter+sort 全表的 O(n²)
    // 降为 O(n log n)。大量词条（几百上千）时这是主要卡顿来源
    const childrenMap = new Map();
    currentProject.nodes.forEach(n => {
        const pid = n.parentId;
        if (pid === undefined || pid === null) return;
        if (!childrenMap.has(pid)) childrenMap.set(pid, []);
        childrenMap.get(pid).push(n);
    });
    childrenMap.forEach(arr => arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));

    const visited = new Set();  // 防止数据异常（父子成环）导致无限递归
    function traverse(parentId, prefix) {
        if (visited.has(parentId)) return;
        visited.add(parentId);
        const children = childrenMap.get(parentId) || [];
        children.forEach((child, idx) => {
            if (visited.has(child.id)) return;
            child.number = prefix + (prefix ? '-' : '') + (idx + 1);
            traverse(child.id, child.number);
        });
    }

    const rootId = root ? root.id : rootNodeId;
    const top = (rootId ? (childrenMap.get(rootId) || []) : []);
    top.forEach((child, idx) => {
        child.number = '' + (idx + 1);
        traverse(child.id, child.number);
    });

    // 兜底：仍无编号的词条（父节点缺失 / 根丢失 / 数据结构异常）按创建顺序补充编号，
    // 避免整页编号退化成 "?"（之前一次性粘贴大量词条时编号会全部变成问号）
    const orphans = currentProject.nodes
        .filter(n => !n.number && n.parentId !== '__root__')
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    let orphanIdx = 0;
    orphans.forEach(child => {
        if (visited.has(child.id)) return;
        orphanIdx++;
        child.number = '' + orphanIdx;
        traverse(child.id, child.number);
    });

    currentProject.nodes.forEach(n => { if (!n.number) n.number = '?'; });
}

// ---------- 回收站全选 checkbox 绑定 ----------
// index.html 中已存在静态 checkbox，必须显式绑定 change 事件，否则点了无效果
function ensureTrashCheckbox() {
    const toggle = document.getElementById('btnTrashToggleSelect');
    let cb = document.getElementById('trashCheckboxAll');
    if (!cb && toggle) {
        toggle.innerHTML = `<input type="checkbox" id="trashCheckboxAll" style="width:16px; height:16px; accent-color:var(--primary);" /> 全选`;
        cb = document.getElementById('trashCheckboxAll');
    }
    if (cb && !cb.dataset.bound) {
        cb.dataset.bound = '1';
        cb.addEventListener('change', () => {
            if (cb.checked) {
                (currentProject.trash || []).forEach(i => trashSelectedIds.add(i.id));
            } else {
                trashSelectedIds.clear();
            }
            renderTrashList();
        });
    }
    return cb;
}

function ensureBookTrashCheckbox() {
    const toggle = document.getElementById('btnBookTrashToggleSelect');
    let cb = document.getElementById('bookTrashCheckboxAll');
    if (!cb && toggle) {
        toggle.innerHTML = `<input type="checkbox" id="bookTrashCheckboxAll" style="width:16px; height:16px; accent-color:var(--primary);" /> 全选`;
        cb = document.getElementById('bookTrashCheckboxAll');
    }
    if (cb && !cb.dataset.bound) {
        cb.dataset.bound = '1';
        cb.addEventListener('change', () => {
            if (cb.checked) {
                bookTrashItems.forEach(i => bookTrashSelectedIds.add(i.id));
            } else {
                bookTrashSelectedIds.clear();
            }
            renderBookTrashList();
        });
    }
    return cb;
}

// ---------- 模式管理 ----------
function resetModes() {
    mode = 'default';
    connectFrom = null;
    selectedIds.clear();
    isMultiselectActive = false;

    if (multiselectBar) {
        multiselectBar.classList.remove('visible');
        multiselectBar.style.display = 'none';
    }
    if (multiselectCount) multiselectCount.textContent = '已选 0 个';
    if (multiselectCheckbox) multiselectCheckbox.checked = false;

    document.querySelectorAll('.actions button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.node').forEach(el => el.classList.remove('highlight', 'connecting', 'selected'));

    if (trashPanel && !trashPanel.classList.contains('hidden')) {
        trashPanel.classList.add('hidden');
    }
    if (bookTrashPanel && !bookTrashPanel.classList.contains('hidden')) {
        bookTrashPanel.classList.add('hidden');
    }

    trashAllSelected = false;
    const trashCb = ensureTrashCheckbox();
    if (trashCb) trashCb.checked = false;
    bookTrashAllSelected = false;
    const bookTrashCb = ensureBookTrashCheckbox();
    if (bookTrashCb) bookTrashCb.checked = false;


    if (isHomeBatchMode) {
        isHomeBatchMode = false;
        homeSelectedIds.clear();
        renderProjectList(currentProjectsCache);
    }
    const dropdown = document.getElementById('homeBatchDropdown');
    if (dropdown) dropdown.style.display = 'none';
}

function setMode(newMode) {
    resetModes();
    mode = newMode;
    if (mode === 'connect') {
        document.getElementById('btnConnect').classList.add('active');
        showToast('点击两个词条创建连接', 1200);
    } else if (mode === 'multiselect') {
        if (editorView.style.display === 'none') {
            resetModes();
            showToast('请在编辑器中操作', 1500);
            return;
        }
        isMultiselectActive = true;
        if (multiselectBar) {
            multiselectBar.style.display = 'flex';
            multiselectBar.classList.add('visible');
        }
        showToast('点击卡片选择/取消，底部栏删除/取消', 1500);
    }
    renderAll();
}

multiselectCheckbox.addEventListener('change', () => {
    const checked = multiselectCheckbox.checked;
    const children = currentProject.nodes.filter(n => n.parentId === getDisplayParentId() && n.parentId !== '__root__');
    if (checked) {
        children.forEach(n => selectedIds.add(n.id));
    } else {
        selectedIds.clear();
    }
    renderCanvas();
    if (multiselectCount) {
        multiselectCount.textContent = `已选 ${selectedIds.size} 个`;
    }
});

multiselectDeleteBtn.addEventListener('click', () => {
    if (selectedIds.size === 0) { showToast('请先选择词条'); return; }
    deleteSelectedNodes();
    // 保持多选模式，不自动取消（可继续选择删除）
    renderAll();
});

// 矩形是否重叠
function rectsOverlap(r1, r2) {
    return !(r1.x + r1.w <= r2.x || r2.x + r2.w <= r1.x || r1.y + r1.h <= r2.y || r2.y + r2.h <= r1.y);
}

// 编号数字比较（"1-10" < "1-2" 按每一段的数字比较，避免字符串排序出现 1,10,11…2,20）
function compareNodeNumbers(a, b) {
    const pa = (a.number || '').split('-').map(Number);
    const pb = (b.number || '').split('-').map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) return na - nb;
    }
    return 0;
}

// 在已占用区域中找一个不重叠的位置（按词条实际尺寸扫描，四周保留 GAP 间隔）
function findFreeSpot(occupied, w, h, maxW, gap) {
    const GAP = (typeof gap === 'number' && gap > 0) ? gap : 26;
    const START_X = 24, START_Y = 24;
    let y = START_Y;
    while (y < 20000) {
        let x = START_X;
        while (x + w <= maxW + 1) {
            const rect = { x, y, w: w + GAP, h: h + GAP };
            if (!occupied.some(o => rectsOverlap(rect, o))) {
                return { x, y };
            }
            x += 1;  // 精确步进，保证词条间距恒为 GAP（与一键排列一致）
        }
        y += GAP;
    }
    return { x: START_X, y: START_Y };
}

// 排列选中的词条（右键菜单调用）：按实际尺寸排列，并避开未选中的词条
function arrangeSelectedNodes() {
    if (selectedIds.size === 0) { showToast('请先选择词条'); return; }
    const parentId = getDisplayParentId();
    const all = currentProject.nodes.filter(n => n.parentId === parentId && n.parentId !== '__root__');
    const sel = sortByVisualPosition(all.filter(n => selectedIds.has(n.id)));  // 按当前位置分行：先上后下，同一行内先左后右（手拖差几像素不再被误判成两行）
    const others = all.filter(n => !selectedIds.has(n.id));
    pushUndo('自动排列');
    renderCanvas();  // 渲染后测量实际尺寸
    // 按词条实际大小流式排列（25px 缝隙），自动避开未选中词条
    const GAP = 25, START_X = 24, START_Y = 24;
    const maxW = canvas.clientWidth - 24;
    // 未选中词条的实际占用矩形（避让）
    const occupied = others.map(o => {
        const el = document.querySelector(`.node[data-id="${o.id}"]`);
        return { x: o.x, y: o.y, w: el ? el.offsetWidth : 160, h: el ? el.offsetHeight : 100 };
    });
    // 排列起点：找"离左上角最近的一个【未选中】词条"作为锚点，把选中的排到它下方，
    // 这样既不会盖住最上面的内容，也符合"选中的那堆该待在它们原本那片区域"的直觉
    let startY = START_Y;
    if (others.length && sel.length) {
        let anchor = null;
        others.forEach(o => {
            const d = (o.x || 0) + (o.y || 0);          // 到左上角的曼哈顿距离
            if (!anchor || d < anchor.d) anchor = { node: o, d };
        });
        if (anchor) {
            const aEl = document.querySelector(`.node[data-id="${anchor.node.id}"]`);
            const ah = aEl ? aEl.offsetHeight : 100;
            startY = (anchor.node.y || 0) + ah + GAP;
        }
    }
    let x = START_X, y = startY, rowH = 0;
    sel.forEach(k => {
        const el = document.querySelector(`.node[data-id="${k.id}"]`);
        const w = el ? el.offsetWidth : 160;
        const h = el ? el.offsetHeight : 100;
        // 在当前流式位置找不重叠的空位（避开未选中词条）
        let px = x, py = y;
        while (occupied.some(o => rectsOverlap({ x: px, y: py, w, h }, o)) && py < 10000) {
            px += GAP;
            if (px + w > maxW) { px = START_X; py += GAP; }
        }
        k.x = px;
        k.y = py;
        occupied.push({ x: px, y: py, w, h });
        // 下一个词条继续流式
        x = px + w + GAP;
        rowH = Math.max(rowH, h);
        if (x + w > maxW) { x = START_X; y = py + rowH + GAP; rowH = 0; }
    });
    renderAll();
    sel.forEach(k => { delete k.manuallyMoved; });  // 手动排列选中后清除标记（下次 resize 视为自动位置）
    showToast(`已排列 ${sel.length} 个词条`);
}

// 多选词条的右键菜单项：左键框选后右键词条 / 右键空白 / 右键框选自动弹出 三处共用，保证功能与顺序完全一致
function getMultiSelectMenuItems(cx, cy, node) {
    const n = selectedIds.size;
    const firstNode = node || currentProject.nodes.find(nd => selectedIds.has(nd.id));
    return [
        { label: `✏️ 批量编辑(${n})`, action: () => openBatchEditModal() },
        { label: '🏷️ 批量重命名', action: () => openBatchRenameModal() },
        { label: '🎨 批量换色', action: () => recolorSelectedNodes(cx, cy) },
        { label: '📍 排列选中', action: () => arrangeSelectedNodes() },
        { label: '📋 复制', action: () => copyNode(firstNode) },
        { label: '✂️ 剪切', action: () => cutSelectedNodes() },
        { label: `🗑️ 删除选中(${n})`, action: () => confirmDeleteSelectedNodes() },
        { label: '✖ 取消选中', action: () => { resetModes(); renderAll(); } }
    ];
}


multiselectCancelBtn.addEventListener('click', () => {
    resetModes();
    renderAll();
});

// ============================================================
// 引用词条辅助函数
// ============================================================

// 获取词条的实际数据源（如果是引用词条，返回源词条；否则返回自身）
function getNodeSource(node) {
    if (!node) return null;
    if (node.refId) {
        const source = currentProject.nodes.find(n => n.id === node.refId);
        if (source) return source;
    }
    return node;
}

// 通用文本截断（超出用省略号）
function truncateText(s, n) {
    const t = String(s == null ? '' : s);
    return t.length > n ? t.slice(0, n) + '…' : t;
}

// 获取词条显示用的标题：
//   引用词条：设了别名就显示别名（最多 20 字）；没别名则显示源词条标题（与源一致，不截断）
//   普通词条：显示自己的标题
function getNodeTitle(node) {
    const isRef = !!(node && node.refId);
    if (isRef && node.alias) return truncateText(node.alias, 20);
    const source = getNodeSource(node);
    return source ? (source.title || '未命名') : (node.title || '未命名');
}

// 获取词条显示用的摘要（引用词条显示源词条摘要）
function getNodeSummary(node) {
    const source = getNodeSource(node);
    return source ? (source.summary || '') : (node.summary || '');
}

// 获取词条显示用的正文（引用词条显示源词条正文）
function getNodeContent(node) {
    const source = getNodeSource(node);
    return source ? (source.content || '') : (node.content || '');
}

// 判断词条是否为引用词条
function isRefNode(node) {
    return !!(node && node.refId);
}

// 获取"显示上下文"的父 ID：
// 如果当前上下文是引用词条，则显示源词条的子节点（引用词条内部的词条同步到源词条下）
function getDisplayParentId() {
    const ctx = currentProject.nodes.find(n => n.id === currentContextId);
    if (ctx && ctx.refId) return ctx.refId;
    return currentContextId;
}

// 计算新建词条的默认位置：从左到右、从上到下网格排列，自动避开已有词条
function getNextNodePosition(parentId, startPos) {
    // 流式排列：新词条放在上一个词条的右边界 + 25px 缝隙外，完全按实际大小排（超右边界换行）
    const GAP = 25, START_X = 24, START_Y = 24;
    const kids = currentProject.nodes.filter(n => n.parentId === parentId && n.parentId !== '__root__');
    // 指定起点（粘贴到鼠标位置）：直接落在鼠标处（和 Windows 一样贴着鼠标，允许与已有词条重叠，拖开即可）
    if (startPos && Number.isFinite(startPos.x) && Number.isFinite(startPos.y)) {
        return { x: Math.max(0, Math.round(startPos.x)), y: Math.max(0, Math.round(startPos.y)) };
    }
    if (kids.length === 0) return { x: START_X, y: START_Y };
    // 找最靠右下的已有词条
    let prev = null;
    kids.forEach(k => {
        if (!prev || (k.y || 0) > (prev.y || 0) || ((k.y || 0) === (prev.y || 0) && (k.x || 0) > (prev.x || 0))) {
            prev = k;
        }
    });
    // 测量上一个词条的实际大小
    const el = document.querySelector(`.node[data-id="${prev.id}"]`);
    const pw = el ? el.offsetWidth : 160;
    const ph = el ? el.offsetHeight : 100;
    const maxW = canvas.clientWidth - 40;
    const estW = 160;
    let nx = prev.x + pw + GAP;
    let ny = prev.y;
    if (nx + estW > maxW) {
        nx = START_X;
        ny = prev.y + ph + GAP;
    }
    // 若新位置与已有词条重叠（换行后撞到左侧词条），向下顺延
    while (kids.some(k => {
        const e = document.querySelector(`.node[data-id="${k.id}"]`);
        const kw = e ? e.offsetWidth : 160;
        const kh = e ? e.offsetHeight : 100;
        return rectsOverlap({ x: nx, y: ny, w: estW, h: 100 }, { x: k.x, y: k.y, w: kw, h: kh });
    }) && ny < 10000) {
        ny += GAP;
    }
    return { x: nx, y: ny };
}

// 更新画布内容层尺寸：节点超出可视区时出现滚动条
function updateCanvasSize() {
    const content = document.getElementById('canvasContent');
    if (!content || !canvas) return;
    const displayParentId = getDisplayParentId();
    const kids = currentProject.nodes.filter(n => n.parentId === displayParentId && n.parentId !== '__root__');
    const measure = () => {
        let maxX = 0, maxY = 0;
        kids.forEach(n => {
            const el = document.querySelector(`.node[data-id="${n.id}"]`);
            const w = el ? el.offsetWidth : 200;
            const h = el ? el.offsetHeight : 140;
            maxX = Math.max(maxX, (n.x || 0) + w);
            maxY = Math.max(maxY, (n.y || 0) + h);
        });
        return { maxX, maxY };
    };
    // 1. 先定高度（底部留白 24px，与顶部起始间距一致）：这一步可能才出现垂直滚动条
    content.style.height = Math.max(canvas.clientHeight, measure().maxY + 24) + 'px';
    // 2. 把超出可视宽度的词条拉回区内：
    //    典型场景——窗口化时把词条拖到最右边框，之后垂直滚动条出现、可视宽度变小，
    //    内容就会"轻微溢出"，出现满格却几乎拖不动的假横向滚动条
    const cw = canvas.clientWidth;
    let pulled = false;
    kids.forEach(n => {
        const el = document.querySelector(`.node[data-id="${n.id}"]`);
        const w = el ? el.offsetWidth : 160;
        const maxNodeX = Math.max(0, cw - w);
        if ((n.x || 0) > maxNodeX + 0.5) {
            n.x = maxNodeX;
            if (el) el.style.left = maxNodeX + 'px';
            pulled = true;
        }
    });
    // 3. 再定宽度：只有在内容真的明显超出（>40px，例如词条比画布还宽）时才允许横向滚动
    const { maxX } = measure();
    const sbw = Math.max(0, canvas.offsetWidth - cw);   // 垂直滚动条占用的宽度
    content.style.width = (maxX <= cw + sbw + 40) ? cw + 'px' : maxX + 'px';
    if (pulled) updateConnectionsPositions();
}

// 计算节点矩形边缘上的点（连接线起点/终点，让箭头露在卡片外面）
function edgePoint(cx, cy, tx, ty, halfW, halfH) {
    let dx = tx - cx, dy = ty - cy;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { x: cx, y: cy };
    const ux = dx / len, uy = dy / len;
    const t = Math.min(
        ux !== 0 ? Math.abs(halfW / ux) : Infinity,
        uy !== 0 ? Math.abs(halfH / uy) : Infinity
    );
    return { x: cx + ux * t, y: cy + uy * t };
}

// ============================================================
// 核心渲染（带防循环保护）
// ============================================================

// ============================================================
// 兜底：把"跑偏成整页"的选区清掉
// 背景：选区（Selection / Range）是**活的** —— 它锚定的节点被重建（打开书、切画布层、渲染刷新、
// 切回书库）之后，边界会自动挪到父节点上，于是可能变成"从工具栏一直连到详情页"这种一眼看去
// 像"整页被全选"的状态（用户没按任何键也会出现，而且退出到书库后还跟着变）。
// 这里只在"选区的共同祖先是**大容器**（body / 整个编辑器视图 / 整个书库视图）"时清掉它；
// 正常选文字（工具栏书名、详情页正文、输入框里）的共同祖先是那一小块，不受影响。
function clearStraySelection() {
    try {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const r = sel.getRangeAt(0);
        const c = r.commonAncestorContainer;
        const el = (c && c.nodeType === 1) ? c : (c ? c.parentElement : null);
        if (!el) { sel.removeAllRanges(); return; }
        const bigOnes = [document.body, document.documentElement];
        ['editorView', 'homeView'].forEach(id => { const e = document.getElementById(id); if (e) bigOnes.push(e); });
        if (bigOnes.indexOf(el) >= 0) sel.removeAllRanges();
    } catch (e) {}
}
let renderPending = false;
function renderAll() {
    if (isRendering) {
        // 记录本次请求，等当前渲染结束后补跑一次（避免渲染被丢弃导致编号/内容不刷新）
        renderPending = true;
        return;
    }
    isRendering = true;
    try {
        updateAllNumbers();
        renderCanvas();
        renderConnections();
        updateEmptyState();
        renderDetailPanel();
        renderBreadcrumb();
        renderTrashList();
        renderBookTrashList();
        clearStraySelection();   // 兜底：打开书 / 切画布层 / 重绘之后，把被浏览器重映射成"整页"的选区清掉
        if (multiselectCount) {
            multiselectCount.textContent = `已选 ${selectedIds.size} 个`;
        }
        scheduleSave();
    } catch (e) {
        console.error('渲染出错:', e);
        showToast('渲染出错，请查看控制台', 2000);
    } finally {
        isRendering = false;
    }
    if (renderPending) {
        renderPending = false;
        renderAll();
    }
}

let lastCanvasContext = null;
const canvasScrollMap = new Map();  // 画布id → {left, top}：记住每个画布上次的滚动位置
function renderCanvas() {
    // 切换画布：此刻 DOM 里还是旧画布的内容，先保存旧画布的滚动位置
    const switchedContext = (lastCanvasContext !== null && lastCanvasContext !== currentContextId);
    if (switchedContext) {
        canvasScrollMap.set(lastCanvasContext, { left: canvas.scrollLeft, top: canvas.scrollTop });
    }
    document.querySelectorAll('.node').forEach(el => el.remove());
    // 防御：当前画布指向的词条如果已不存在（例如它刚被剪切移动走 / 被恢复覆盖），
    // 就回退到根画布 —— 否则会渲染出"空白画布"，看起来像词条全丢了（其实数据还在）
    if (currentContextId && rootNodeId && !currentProject.nodes.find(n => n.id === currentContextId)) {
        currentContextId = rootNodeId;
        currentSelectedId = rootNodeId;
    }
    if (!currentContextId) { lastCanvasContext = currentContextId; return; }
    const displayParentId = getDisplayParentId();
    // 子词条数量映射：一次遍历统计，避免每个词条重复过滤（性能）
    const childCountMap = new Map();
    currentProject.nodes.forEach(n => {
        if (n.parentId && n.parentId !== '__root__') {
            childCountMap.set(n.parentId, (childCountMap.get(n.parentId) || 0) + 1);
        }
    });
    // 浮动层级：选中的词条在最上层，其余按最后修改时间（后修改的靠上）
    const children = currentProject.nodes
        .filter(n => n.parentId === displayParentId && n.parentId !== '__root__')
        .sort((a, b) => {
            const sa = selectedIds.has(a.id) ? 1 : 0;
            const sb = selectedIds.has(b.id) ? 1 : 0;
            if (sa !== sb) return sa - sb;
            return (a.lastModified || 0) - (b.lastModified || 0);
        });
    const isMultiselect = (mode === 'multiselect');
    const connectingId = (mode === 'connect') ? connectFrom : null;
    // 用文档片段批量插入，避免几百个词条逐个 appendChild 触发重复重排（性能）
    const nodeFrag = document.createDocumentFragment();
    children.forEach(node => {
        const el = document.createElement('div');
        el.className = 'node';
        el.dataset.id = node.id;
        el.style.left = node.x + 'px';
        el.style.top = node.y + 'px';
        // 卡片底色：勾了「卡片底色透明」就透出画布（背景图带透明区域时不会露白底）
        el.style.background = node.bgTransparent ? 'transparent' : (node.color || '#ffffff');
        // 按 children 排序（lastModified）顺序递增 zIndex：最后修改的在最上层（封顶 90，永不超过下方 UI 层）
        el.style.zIndex = String(Math.min(nodeZCounter++, 90));
        if (node.bgImage) {
            el.style.backgroundImage = `url("${toFileUrl(node.bgImage)}")`;
            el.style.backgroundSize = nodeBgSizeCss(node.bgFit);   // 用该词条自己的显示方式（没设则用默认）
            el.style.backgroundPosition = 'center';
            el.style.backgroundRepeat = 'no-repeat';
            el.style.borderColor = 'transparent';   // 有背景图时把 1px 边框弄透明，否则图的四条边会多出一圈白线
        } else {
            el.style.backgroundImage = '';
            el.style.borderColor = '';
        }
        const isSelected = selectedIds.has(node.id);
        if (isSelected) el.classList.add('selected');
        if (cutPendingIds.has(node.id)) el.classList.add('cut-pending');   // 剪切待粘贴：淡灰显示
        if (connectingId && node.id === connectingId) el.classList.add('connecting');
        const number = node.number || '?';
        const title = getNodeTitle(node);
        const summary = getNodeSummary(node);
        const isRef = isRefNode(node);
        if (isRef) el.classList.add('ref-node');   // 引用词条：左侧竖条标记（CSS 里画，不占宽度）
        const childCount = childCountMap.get(node.id) || 0;
        // 词条文字：优先用该词条自己的颜色 → 再退到设置里的默认文字颜色 → 最后内置默认（夜间模式不改词条文字）
        const textColor = node.textColor || getDefaultNodeTextColor() || '#1a1a2e';
        const titleStyle = `cursor:${isLocked() ? 'default' : 'grab'};color:${textColor};`;
        const summaryStyle = `color:${textColor};opacity:0.7;`;
        const numberStyle = `color:${textColor};opacity:0.5;`;
        const hintStyle = `color:${textColor};opacity:0.5;`;
        // 引用词条显示 🔗 标记
        const refMark = isRef ? '<span style="font-size:12px; color:var(--primary); font-weight:600;" title="引用词条（内容与源词条同步）">🔗</span>' : '';
        // 内部布局锁定（📌）：该词条作为画布时，内部词条不会被自动排列打乱
        const lockMark = node.layoutLocked ? '<span style="font-size:11px; color:var(--text-secondary);" title="内部布局已锁定（不参与自动排列）">📌</span>' : '';
        el.innerHTML = `
            <div class="node-title" style="${titleStyle}">
                ${refMark}
                ${lockMark}
                ${escapeHtml(title)}
            </div>
            <div class="node-summary" style="${summaryStyle}">${escapeHtml((summary || '').slice(0, 40))}</div>
            <div class="node-number" style="${numberStyle}">${escapeHtml(number)}</div>
            <hr class="node-divider" />
            <div class="node-hint" style="${hintStyle}">双击进入子页面 →</div>
            ${childCount > 0 ? `<div class="node-childcount" title="包含 ${childCount} 个子词条">🧩 ${childCount} 个子词条</div>` : ''}
            <div class="node-actions">
                <button class="edit-btn" title="编辑">✎</button>
                <button class="color-btn" title="换颜色" style="background:none; border:none; border-radius:20px; width:24px; height:24px; font-size:14px; cursor:pointer;">🎨</button>
                <button class="del-btn" title="删除">✕</button>
            </div>
        `;

        // 点击卡片：总是显示详情页（锁定则不跳转，未锁定则跳转子画布）
        // 长按移动是拖拽，点击是跳转（拖拽后不触发跳转）
        el.addEventListener('click', (e) => {
            if (e.target.closest('.node-actions')) return;
            if (wasDragging) { wasDragging = false; return; }
            if (isMultiselect) {
                if (selectedIds.has(node.id)) {
                    selectedIds.delete(node.id);
                } else {
                    selectedIds.add(node.id);
                }
                renderCanvas();
                if (multiselectCount) {
                    multiselectCount.textContent = `已选 ${selectedIds.size} 个`;
                }
                return;
            }
            if (mode === 'connect' || mode === 'delete') {
                handleModeClick(node.id, e);
                return;
            }

            // Ctrl+点击：追加到多选（已选中的再次点击取消）
            if ((e.ctrlKey || e.metaKey) && mode === 'default') {
                if (selectedIds.has(node.id)) {
                    selectedIds.delete(node.id);
                } else {
                    selectedIds.add(node.id);
                }
                mode = 'multiselect';
                isMultiselectActive = true;
                if (multiselectBar) {
                    multiselectBar.style.display = 'flex';
                    multiselectBar.classList.add('visible');
                }
                if (multiselectCount) multiselectCount.textContent = `已选 ${selectedIds.size} 个`;
                renderCanvas();
                return;
            }

            // 单击：只显示详情页，不跳转（双击才进入子画布）
            currentSelectedId = node.id;
            renderDetailPanel();
        });

        // 双击：进入子画布（连接/删除/多选模式下不跳转；「防误操作」不影响跳转）
        el.addEventListener('dblclick', (e) => {
            if (e.target.closest('.node-actions')) return;
            if (mode === 'connect' || mode === 'delete' || mode === 'multiselect') return;
            pushHistory(currentContextId);
            currentContextId = node.id;
            currentSelectedId = node.id;
            renderAll();
        });

        // 拖拽（锁定禁止拖拽；多选模式下拖拽已选中的词条会一起移动）
        el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target.closest('.node-actions')) return;
            if (mode === 'connect' || mode === 'delete') return;
            // 多选模式下只允许拖拽已选中的词条（多个一起移动）
            if (mode === 'multiselect' && !selectedIds.has(node.id)) return;
            // 锁定状态下禁止拖拽（拖拽开关已合并到锁定）
            if (isLocked()) return;

            e.preventDefault();
            // 按下卡片时立即显示对应详情页（拖拽/点击都会刷新详情）
            currentSelectedId = node.id;
            renderDetailPanel();

            wasDragging = false;
            const startX = e.clientX;
            const startY = e.clientY;
            // 多选联动：若该词条被选中且多选数量大于 1，则整组一起移动
            const group = (mode === 'multiselect' && selectedIds.size > 1)
                ? currentProject.nodes.filter(n => selectedIds.has(n.id))
                : [node];
            const origPos = group.map(g => ({ id: g.id, x: g.x, y: g.y }));
            let isDragging = false;

            // 按下即置顶（不移动 DOM，只改 zIndex，避免破坏点击/双击事件）
            group.forEach(g => { g.lastModified = Date.now(); });
            group.forEach(g => {
                const gEl = document.querySelector(`.node[data-id="${g.id}"]`);
                if (gEl) gEl.style.zIndex = String(Math.min(++nodeZCounter, 90));
            });

            // ---- 统一拖拽循环（GPT 建议）：边缘滚动 + 位置更新在同一个 rAF 循环，词条位置用画布坐标直接计算 ----
            // 抓取偏移：按下时 鼠标画布坐标 - 第一个选中词条位置（多选时保持相对位置）
            const pressRect = canvas.getBoundingClientRect();
            const grabOX = (startX - pressRect.left + canvas.scrollLeft) - group[0].x;
            const grabOY = (startY - pressRect.top + canvas.scrollTop) - group[0].y;
            const relOffsets = origPos.map(p => ({ id: p.id, dx: p.x - group[0].x, dy: p.y - group[0].y }));
            let mouseX = startX, mouseY = startY;
            let dragRAF = null;
            const stopDrag = () => { if (dragRAF) { cancelAnimationFrame(dragRAF); dragRAF = null; } };
            const updateDrag = () => {
                const r = canvas.getBoundingClientRect();
                // 1. 边缘自动滚动（只纵向跨页；横向不滚，避免穿透详情页）
                if (mouseY < r.top + 40) canvas.scrollTop -= 18;
                else if (mouseY > r.bottom - 40) canvas.scrollTop += 18;
                // 2. 词条位置 = 鼠标画布坐标 - 抓取偏移（直接计算，无补偿漂移）
                const cX = mouseX - r.left + canvas.scrollLeft;
                const cY = mouseY - r.top + canvas.scrollTop;
                const cw = canvas.clientWidth;
                const contentEl = document.getElementById('canvasContent');
                const ch = contentEl ? contentEl.offsetHeight : canvas.clientHeight;
                const tx = cX - grabOX;
                const ty = cY - grabOY;
                // 3. 更新所有选中词条（保持相对位置；横向限制可视区，纵向限制在现有内容区内——不能新增底部空间）
                group.forEach(g => {
                    const rel = relOffsets.find(p => p.id === g.id);
                    const nx0 = tx + (rel ? rel.dx : 0);
                    const ny0 = ty + (rel ? rel.dy : 0);
                    const gel = document.querySelector(`.node[data-id="${g.id}"]`);
                    const gw = gel ? gel.offsetWidth : 160;
                    const gh = gel ? gel.offsetHeight : 100;
                    const nx = Math.max(0, Math.min(nx0, cw - gw));
                    const ny = Math.max(0, Math.min(ny0, ch - gh));
                    g.x = nx;
                    g.y = ny;
                    g.manuallyMoved = true;  // 标记为手动移动过（resize 自动重排时保持原位）
                    const el2 = document.querySelector(`.node[data-id="${g.id}"]`);
                    if (el2) { el2.style.left = nx + 'px'; el2.style.top = ny + 'px'; }
                });
                // 5. 轻量更新连接线坐标（不重建 svg，流畅跟随）
                updateConnectionsPositions();
                dragRAF = requestAnimationFrame(updateDrag);
            };
            const onMove = (ev) => {
                if (!isDragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
                    isDragging = true;
                    suppressAutoArrange = true;  // 拖拽期间抑制自动重排
                    el.classList.add('dragging');
                    pushUndo('移动词条');
                }
                mouseX = ev.clientX;
                mouseY = ev.clientY;
                if (isDragging && !dragRAF) {
                    dragRAF = requestAnimationFrame(updateDrag);
                }
            };
            const onUp = () => {
                stopDrag();
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                el.classList.remove('dragging');
                if (isDragging) {
                    setTimeout(() => { suppressAutoArrange = false; }, 400);  // 拖拽结束后恢复自动重排
                    dragData = null;
                    wasDragging = true;  // 标记本次为拖拽，阻止后续 click 跳转
                    // 短暂延时后清除标志，避免影响后续点击
                    setTimeout(() => { wasDragging = false; }, 0);
                    group.forEach(g => { g.lastModified = Date.now(); });  // 拖拽视为最近修改
                    scheduleSave();
                    updateCanvasSize();
                    renderCanvas();  // 刷新浮动层级（最后修改的置顶）
                }
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });



        // 编辑按钮：打开编辑弹窗（类似新建，预填内容，保存时同步到源词条）
        el.querySelector('.edit-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openEditNodeModal(node);
        });


        // 换颜色按钮
        el.querySelector('.color-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            showColorPicker(node, e.clientX, e.clientY);
        });

        // 删除按钮：直接删除（不询问；可在回收站找回，或 Ctrl+Z 撤回）
        el.querySelector('.del-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteNode(node.id);
        });

        nodeFrag.appendChild(el);
    });
    canvas.appendChild(nodeFrag);
    // ===== 渲染后：导入词条按实际尺寸排列（此时 DOM 已创建，可实测宽高，按上一个词条真实尺寸流式排列）=====
    const layoutKids = currentProject.nodes.filter(n => n.parentId === displayParentId && n.parentId !== '__root__' && n.needsLayout);
    if (layoutKids.length > 0) {
        const others = currentProject.nodes.filter(n => n.parentId === displayParentId && n.parentId !== '__root__' && !n.needsLayout);
        const occupied = others.map(o => {
            const el = document.querySelector(`.node[data-id="${o.id}"]`);
            return { x: o.x, y: o.y, w: el ? el.offsetWidth : 160, h: el ? el.offsetHeight : 100 };
        });
        const sorted = layoutKids.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const GAP = 25, START_X = 24, START_Y = 24;
        const maxW = canvas.clientWidth - 24;
        let x = START_X, y = START_Y, rowH = 0;
        sorted.forEach(k => {
            const el = document.querySelector(`.node[data-id="${k.id}"]`);
            const w = el ? el.offsetWidth : 160;
            const h = el ? el.offsetHeight : 100;
            if (x + w > maxW && x > START_X) { x = START_X; y += rowH + GAP; rowH = 0; }
            let px = x, py = y;
            // 避让已排好的词条：同一行内重叠则向下顺延（行高照常按本行最高累计）
            while (occupied.some(o => rectsOverlap({ x: px, y: py, w, h }, o)) && py < 20000) {
                py += GAP;
            }
            k.x = px;
            k.y = py;
            if (el) { el.style.left = px + 'px'; el.style.top = py + 'px'; }
            occupied.push({ x: px, y: py, w, h });
            x = px + w + GAP;
            rowH = Math.max(rowH, h);
            if (x + w > maxW) { x = START_X; y = py + rowH + GAP; rowH = 0; }
            delete k.needsLayout;
        });
    }
    updateCanvasSize();
    // 切换画布后，恢复该画布上次的滚动位置（等布局完成，下一帧再设置）
    if (switchedContext) {
        const pos = canvasScrollMap.get(currentContextId);
        requestAnimationFrame(() => {
            canvas.scrollLeft = pos ? pos.left : 0;
            canvas.scrollTop = pos ? pos.top : 0;
        });
    }
    lastCanvasContext = currentContextId;
}

// ---------- 换颜色 ----------
function showColorPicker(node, x, y) {
    // 多选模式下给所有选中词条批量换色/改文字色
    const targets = (mode === 'multiselect' && selectedIds.has(node.id) && selectedIds.size > 1)
        ? currentProject.nodes.filter(n => selectedIds.has(n.id))
        : [node];
    const curColor = (node.color && node.color.startsWith('#')) ? node.color : '#ffffff';
    const curText = node.textColor || '#1a1a2e';
    openColorPopup('🎨 词条颜色', curColor, (val, m) => {
        pushUndo('修改词条颜色/背景');
        targets.forEach(t => {
            if (m === 'text') {
                if (val === null) delete t.textColor;
                else t.textColor = val;
                return;
            }
            if (val === null) {
                const oldBg = t.bgImage;
                t.color = '#ffffff';
                delete t.bgImage;
                delete t.bgTransparent;      // 换成纯色背景 → 透明底自动关掉
                if (oldBg) deleteBgFileIfUnused(oldBg);
            } else if (val.startsWith('#')) {
                const oldBg = t.bgImage;
                t.color = val;
                delete t.bgImage;
                delete t.bgTransparent;      // 换成纯色背景 → 透明底自动关掉
                if (oldBg) deleteBgFileIfUnused(oldBg);
            } else {
                const oldBg = t.bgImage;
                t.bgImage = val;
                t.bgTransparent = true;      // 选了图片背景 → 透明底自动打开（图上有透明区域时不露白底）
                if (oldBg && oldBg !== val) deleteBgFileIfUnused(oldBg);
            }
        });
        pushUndo();
        renderCanvas();
        scheduleSave();
        showToast(m === 'text'
            ? (targets.length > 1 ? `已更新 ${targets.length} 个词条文字颜色` : '文字颜色已更新')
            : (targets.length > 1 ? `已更新 ${targets.length} 个词条背景` : '背景已更新'));
        // 应用后保持弹窗打开，方便继续调整；点弹窗以外的空白处才关闭
    }, { x: x, y: y, showImage: true, allowText: true, textColor: curText, fitTargets: targets });
}


// ---------- 删除确认弹窗（小 x 删除单个词条时弹出确认）----------
function confirmDeleteNode(node) {
    if (!node) return;
    if (node.isRoot) { showToast('不能删除根词条'); return; }
    const html = `
        <div class="modal-header">
            <h2>🗑️ 删除词条</h2>
            <button type="button" class="close-btn">✕</button>
        </div>
        <div class="modal-body">
            <p style="font-size:16px; margin-bottom:8px;">确定要删除 <strong>「${escapeHtml(getNodeTitle(node))}」</strong> 及其子词条吗？</p>
            <p style="font-size:13px; color:var(--text-secondary);">删除后进入词条回收站，可恢复。</p>
        </div>
        <div class="modal-footer">
            <button class="btn-cancel" onclick="closeModal()">取消</button>
            <button id="confirmDeleteNode" class="btn-delete">🗑️ 确认删除</button>
        </div>
    `;
    openModal(html);
    document.getElementById('confirmDeleteNode').addEventListener('click', () => {
        closeModal();
        deleteNode(node.id);
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
}

// ---------- 删除节点（进入词条回收站）----------
function deleteNode(nodeId) {
    pushUndo();
    const node = currentProject.nodes.find(n => n.id === nodeId);
    if (!node) return;
    if (node.isRoot) { showToast('不能删除根词条'); return; }
    // 递归收集子节点
    const toDelete = new Set();
    function collect(id) {
        toDelete.add(id);
        currentProject.nodes.filter(n => n.parentId === id).forEach(c => collect(c.id));
    }
    collect(nodeId);
    // 移入回收站
    toDelete.forEach(id => {
        const n = currentProject.nodes.find(x => x.id === id);
        if (n) {
            currentProject.trash.push({ ...n, deletedAt: Date.now() });
        }
    });
    // 删除节点及连接
    currentProject.nodes = currentProject.nodes.filter(n => !toDelete.has(n.id));
    currentProject.connections = currentProject.connections.filter(c => !toDelete.has(c.from) && !toDelete.has(c.to));
    // 若当前上下文被删除，回到根
    if (toDelete.has(currentContextId)) {
        currentContextId = rootNodeId;
        currentSelectedId = rootNodeId;
    }
    renderAll();
    showToast('已删除，可在回收站恢复');
}

// ---------- 多选删除 ----------
function deleteSelectedNodes() {
    pushUndo();
    const toDelete = new Set(selectedIds);
    // 递归收集子节点
    function collect(id) {
        currentProject.nodes.filter(n => n.parentId === id).forEach(c => {
            if (!toDelete.has(c.id)) {
                toDelete.add(c.id);
                collect(c.id);
            }
        });
    }
    Array.from(toDelete).forEach(id => collect(id));
    toDelete.forEach(id => {
        const n = currentProject.nodes.find(x => x.id === id);
        if (n) {
            currentProject.trash.push({ ...n, deletedAt: Date.now() });
        }
    });
    currentProject.nodes = currentProject.nodes.filter(n => !toDelete.has(n.id));
    currentProject.connections = currentProject.connections.filter(c => !toDelete.has(c.from) && !toDelete.has(c.to));
    if (toDelete.has(currentContextId)) {
        currentContextId = rootNodeId;
        currentSelectedId = rootNodeId;
    }
    selectedIds.clear();
    renderAll();
    showToast(`已删除 ${toDelete.size} 个词条`);
}

// 删除所有选中词条（带确认弹窗）
function confirmDeleteSelectedNodes() {
    if (selectedIds.size === 0) { showToast('请先选择词条'); return; }
    const html = `
        <div class="modal-header">
            <h2>🗑️ 删除选中词条</h2>
            <button type="button" class="close-btn">✕</button>
        </div>
        <div class="modal-body">
            <p style="font-size:16px; margin-bottom:8px;">确定要删除选中的 <strong>${selectedIds.size}</strong> 个词条（含其子词条）吗？</p>
            <p style="font-size:13px; color:var(--text-secondary);">删除后进入词条回收站，可恢复。</p>
        </div>
        <div class="modal-footer">
            <button class="btn-cancel" onclick="closeModal()">取消</button>
            <button id="confirmDeleteSelected" class="btn-delete">🗑️ 确认删除</button>
        </div>
    `;
    openModal(html);
    document.getElementById('confirmDeleteSelected').addEventListener('click', () => {
        closeModal();
        deleteSelectedNodes();
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
}

// 批量重命名：不记住上次用过的模板 / 起始序号（每次从空白开始 —— 这次是第五章，下次多半不是它）

// 数字 → 汉字序号（支持到 9999；超过部分直接用数字）
function numToChinese(n) {
    const D = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (!Number.isFinite(n) || n < 0) return String(n);
    if (n < 10) return D[n];
    if (n < 20) return '十' + (n % 10 ? D[n % 10] : '');
    if (n < 100) return D[Math.floor(n / 10)] + '十' + (n % 10 ? D[n % 10] : '');
    if (n < 1000) {
        const h = Math.floor(n / 100);
        const r = n % 100;
        if (r === 0) return D[h] + '百';
        if (r < 10) return D[h] + '百零' + D[r];
        if (r < 20) return D[h] + '百一十' + (r % 10 ? D[r % 10] : '');   // 115 → 一百一十五
        return D[h] + '百' + numToChinese(r);
    }
    if (n < 10000) {
        const th = Math.floor(n / 1000);
        const r = n % 1000;
        if (r === 0) return D[th] + '千';
        if (r < 100) return D[th] + '千零' + numToChinese(r);
        return D[th] + '千' + numToChinese(r);
    }
    if (n < 100000000) {   // 万级（一亿以内）
        const w = Math.floor(n / 10000);
        const r = n % 10000;
        let s = numToChinese(w) + '万';
        if (r === 0) return s;
        if (r < 1000) return s + '零' + numToChinese(r);
        return s + numToChinese(r);
    }
    return String(n);
}

// 中文数字 → 数值（支持 一 ~ 九千九百九十九，含零的写法如 一百零五）
function chineseToNum(s) {
    if (!s) return NaN;
    const D = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (s === '十') return 10;
    const w = s.match(/^(.*?)万(.*)$/);                      // X万…
    if (w) {
        const wv = chineseToNum(w[1]);
        if (!Number.isFinite(wv)) return NaN;
        const rest = w[2].replace(/^零/, '');
        let r = 0;
        if (rest) { const rv = chineseToNum(rest); if (!Number.isFinite(rv)) return NaN; r = rv; }
        return wv * 10000 + r;
    }
    const th = s.match(/^([零一二三四五六七八九])千(.*)$/);   // X千…
    if (th) {
        const rest = th[2].replace(/^零/, '');
        let r = 0;
        if (rest) { const rv = chineseToNum(rest); if (!Number.isFinite(rv)) return NaN; r = rv; }
        return D[th[1]] * 1000 + r;
    }
    const h = s.match(/^([零一二三四五六七八九])百(.*)$/);    // X百…
    if (h) {
        const rest = h[2].replace(/^零/, '');
        let r = 0;
        if (rest) { const rv = chineseToNum(rest); if (!Number.isFinite(rv)) return NaN; r = rv; }
        return D[h[1]] * 100 + r;
    }
    const m = s.match(/^([零一二三四五六七八九]?)十([零一二三四五六七八九]?)$/);   // 十 / 十一 / 二十 / 二十一
    if (m) {
        const tens = m[1] ? D[m[1]] : 1;
        const ones = m[2] ? D[m[2]] : 0;
        return tens * 10 + ones;
    }
    if (s.length === 1 && D[s] !== undefined) return D[s];
    return NaN;
}

// 找出模板里"最后一个数字"（阿拉伯或汉字），用于自动递增
function findLastNumberInTemplate(tpl) {
    let best = null;
    const arM = tpl.match(/(\d+)(?![\s\S]*\d)/);   // 最后一个阿拉伯数字
    if (arM) best = { index: arM.index, len: arM[0].length, isCn: false };
    const cnM = tpl.match(/([零一二三四五六七八九十百千万]{1,12})(?![\s\S]*[零一二三四五六七八九十百千万])/);  // 最后一个汉字数字
    if (cnM && (!best || cnM.index > best.index) && Number.isFinite(chineseToNum(cnM[0]))) {
        best = { index: cnM.index, len: cnM[0].length, isCn: true };
    }
    return best;
}

// 生成第 seq 个标题（seq = 1、2、3…）
//   startFrom：起始序号（只对"没有占位符、也没有自带数字"的模板生效）
//   规则：
//     1) 含 {n}/{cn} → 用 startFrom 起算（第5个就是 第5章/第五章）
//     2) 模板自带数字（阿拉伯或汉字）→ **以模板里的数字为起点自动递增**
//        输入「第五章」→ 第五章、第六章…；输入「第5章 设定」→ 第5章 设定、第6章 设定…
//     3) 两者都没有 → 第一个用原名，之后末尾追加序号
function buildRenamedTitle(tpl, seq, startFrom) {
    const from = (Number.isFinite(startFrom) && startFrom >= 1) ? startFrom : 1;
    if (tpl.includes('{n}') || tpl.includes('{cn}')) {
        const v = from + seq - 1;
        return tpl.replace(/\{n\}/g, String(v)).replace(/\{cn\}/g, numToChinese(v));
    }
    const num = findLastNumberInTemplate(tpl);
    if (num) {
        const raw = tpl.slice(num.index, num.index + num.len);
        const base = num.isCn ? chineseToNum(raw) : parseInt(raw, 10);
        const v = (Number.isFinite(base) ? base : 1) + seq - 1;   // 以模板里的数字为起点
        const replacement = num.isCn ? numToChinese(v) : String(v);
        return tpl.slice(0, num.index) + replacement + tpl.slice(num.index + num.len);
    }
    const v = from + seq - 1;
    return seq === 1 ? tpl : tpl + v;
}

// 批量重命名：按当前编号顺序给选中词条命名 / 自动加序号（引用词条跳过，因为它显示的是源词条标题）
function openBatchRenameModal() {
    if (selectedIds.size === 0) { showToast('请先选中词条'); return; }
    const all = currentProject.nodes.filter(n => selectedIds.has(n.id));
    const list = all.filter(n => !isRefNode(n)).sort(compareNodeNumbers);
    const skipped = all.length - list.length;
    if (!list.length) { showToast('引用词条无需重命名', 2200); return; }
    const html = `
        <form id="batchRenameForm">
            <div class="modal-header">
                <h2>🏷️ 批量重命名（${list.length} 个）</h2>
                <button type="button" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <label>名称 / 模板</label>
                <input type="text" id="batchRenameInput" placeholder="例：第一章　或　第{n}章" autofocus />
                <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
                    <button type="button" id="batchRenameInsertN" class="btn-cancel btn-auto">插入 {n}（数字）</button>
                    <button type="button" id="batchRenameInsertCN" class="btn-cancel btn-auto">插入 {cn}（汉字）</button>
                </div>
                <div style="display:flex; align-items:center; gap:8px; margin-top:12px;">
                    <label style="margin:0; white-space:nowrap;">起始序号</label>
                    <input type="number" id="batchRenameStart" value="1" min="1" max="9999" style="width:96px;" />
                    <span style="font-size:12px; color:var(--text-secondary);">想从「第五章」开始就填 5</span>
                </div>
                <p id="batchRenamePreview" style="margin-top:12px; font-size:13px; color:var(--text-secondary); line-height:1.9;"></p>
                ${skipped ? `<p style="margin-top:6px; font-size:12px; color:var(--text-secondary);">已自动跳过 ${skipped} 个引用词条（它们显示源词条的标题）</p>` : ''}
            </div>
            <div class="modal-footer">
                <button type="button" class="btn-cancel" onclick="closeModal()">取消</button>
                <button type="submit" class="btn-save">🏷️ 重命名</button>
            </div>
        </form>
    `;
    openModal(html, { plain: true });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
    const input = document.getElementById('batchRenameInput');
    // 同理：打开就把光标放进输入框（动态插入的 autofocus 不总生效）
    if (input) setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 100);
    const previewEl = document.getElementById('batchRenamePreview');
    const startInput = document.getElementById('batchRenameStart');
    const getStart = () => {
        const v = parseInt(startInput ? startInput.value : '1', 10);
        return (Number.isFinite(v) && v >= 1) ? v : 1;
    };
    const updatePreview = () => {
        const tpl = input.value.trim();
        const start = getStart();
        if (!tpl) {
            previewEl.innerHTML = '示例：输入 <b>第{n}章</b> → 第1章、第2章、第3章…<br>（也可以直接输入 <b>如：第五章/第七章等</b>，会自动识别数字并递增）';
            return;
        }
        const samples = list.slice(0, 4).map((n, i) => buildRenamedTitle(tpl, i + 1, start));
        const more = list.length > 4 ? ` …（共 ${list.length} 个）` : '';
        previewEl.innerHTML = `将生成：<b>${samples.map(escapeHtml).join('</b>、<b>')}</b>${more}`;
    };
    updatePreview();
    input.addEventListener('input', () => { lastInserted = null; updatePreview(); });
    if (startInput) startInput.addEventListener('input', updatePreview);
    // 插入占位符：像普通文字一样插在光标处，插完自动选中它（可以插多个）；
    // 但如果插完没动光标、又点了另一个按钮，就直接替换掉刚插入的那个
    let lastInserted = null;
    const insertAtCursor = (txt) => {
        const s = (input.selectionStart === null || input.selectionStart === undefined) ? input.value.length : input.selectionStart;
        const e = (input.selectionEnd === null || input.selectionEnd === undefined) ? input.value.length : input.selectionEnd;
        if (lastInserted && s === e && s === lastInserted.end) {
            input.value = input.value.slice(0, lastInserted.start) + txt + input.value.slice(lastInserted.end);
            const st = lastInserted.start;
            input.focus();
            input.setSelectionRange(st, st + txt.length);
            lastInserted = { start: st, end: st + txt.length };
            updatePreview();
            return;
        }
        input.value = input.value.slice(0, s) + txt + input.value.slice(e);
        input.focus();
        input.setSelectionRange(s, s + txt.length);   // 插入后选中它（替换就等于"换掉这一个"）
        lastInserted = { start: s, end: s + txt.length };
        updatePreview();
    };
    document.getElementById('batchRenameInsertN').addEventListener('click', (e) => { e.preventDefault(); insertAtCursor('{n}'); });
    document.getElementById('batchRenameInsertCN').addEventListener('click', (e) => { e.preventDefault(); insertAtCursor('{cn}'); });
    document.getElementById('batchRenameForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const tpl = input.value.trim();
        if (!tpl) { showToast('请输入名称或模板'); return; }
        const start = getStart();
        pushUndo();
        list.forEach((n, i) => { n.title = buildRenamedTitle(tpl, i + 1, start); });
        closeModal();
        renderAll();
        showToast(`已重命名 ${list.length} 个词条`, 2200);
    });
}

// 批量编辑选中词条（标题/摘要/正文，留空则不变）
function openBatchEditModal() {
    if (selectedIds.size === 0) { showToast('请先选择词条'); return; }
    const html = `
        <form id="batchEditForm">
            <div class="modal-header">
                <h2>✏️ 批量编辑（${selectedIds.size} 个词条）</h2>
                <button type="button" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <label>标题（留空则不变）</label>
                <input type="text" id="batchEditTitle" placeholder="统一设置标题，留空不改" />
                <label>摘要（留空则不变）</label>
                <textarea id="batchEditSummary" placeholder="统一设置摘要，留空不改"></textarea>
                <label>正文（留空则不变）</label>
                <textarea id="batchEditContent" placeholder="统一设置正文，留空不改"></textarea>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn-cancel" onclick="closeModal()">取消</button>
                <button type="submit" class="btn-save">💾 应用</button>
            </div>
        </form>
    `;
    openModal(html);
    // 打开就把光标放进「标题」框（和「编辑词条」一致）。上面只写了 autofocus，但内容是 innerHTML
    // 插进来的 —— 动态插入的 autofocus 不总生效（批量重命名也一样），所以这里显式聚焦一次
    { const t = document.getElementById('batchEditTitle'); if (t) setTimeout(() => { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }, 100); }
    const form = document.getElementById('batchEditForm');
    form.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            form.dispatchEvent(new Event('submit'));
        }
    });
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const title = document.getElementById('batchEditTitle').value.trim();
        const summary = document.getElementById('batchEditSummary').value.trim();
        const content = document.getElementById('batchEditContent').value;
        pushUndo();
        currentProject.nodes.forEach(n => {
            if (!selectedIds.has(n.id)) return;
            const src = getNodeSource(n);
            if (title) src.title = title;
            if (summary) src.summary = summary;
            if (content) src.content = content;
        });
        closeModal();
        renderAll();
        scheduleSave();
        showToast('已批量编辑');
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
}

// ---------- 模式点击处理 ----------
// 连接模式：支持 Ctrl 多选（选中一个起点后，按住 Ctrl 再点多个目标，一次连接多个）
// 点击已连接的两个节点可取消该连接；A→B 与 B→A 是两条独立连接（双向）
function handleModeClick(nodeId, ev) {
    if (mode === 'connect') {

        if (!connectFrom) {
            connectFrom = nodeId;
            document.querySelectorAll('.node').forEach(el => {
                if (el.dataset.id === nodeId) el.classList.add('connecting');
            });
            showToast('再点击一个词条完成连接（Ctrl 可多选）', 1200);
        } else {
            if (connectFrom === nodeId) {
                connectFrom = null;
                renderCanvas();
                showToast('已取消连接', 1000);
                return;
            }
            // 检查 A→B 是否已存在（双向独立，只检查同方向）
            pushUndo('连接词条');
            const exists = currentProject.connections.some(c =>
                c.from === connectFrom && c.to === nodeId
            );
            if (exists) {
                // 已存在则取消该连接
                currentProject.connections = currentProject.connections.filter(c =>
                    !(c.from === connectFrom && c.to === nodeId)
                );
                showToast('已取消连接');
            } else {
                currentProject.connections.push({ from: connectFrom, to: nodeId });
                showToast('已创建连接');
            }
            // 保持连接模式；若按住 Ctrl 则保留起点继续多选，否则重置起点
            if (!ev.ctrlKey && !ev.metaKey) {
                connectFrom = null;
            }

            renderCanvas();
            renderConnections();
            scheduleSave();
        }
    } else if (mode === 'delete') {
        deleteNode(nodeId);
    }
}



// ============================================================
// 连接渲染
// ============================================================

let connNodeSizes = new Map();  // 节点尺寸缓存，供拖拽中轻量更新连接线位置（避免每帧强制布局）

function renderConnections() {
    svg.innerHTML = '';
    const nodes = currentProject.nodes;
    // 只显示当前画布（当前上下文子节点）之间的连接：跳转子画布后旧连接线消失
    const displayParentId = getDisplayParentId();
    const visibleIds = new Set(
        nodes.filter(n => n.parentId === displayParentId && n.parentId !== '__root__').map(n => n.id)
    );

    // 一次性测量所有可见节点的实际尺寸（避免每根连接线重复 querySelector 强制布局，造成拖拽卡顿）
    const nodeSizes = new Map();
    nodes.forEach(n => {
        if (!visibleIds.has(n.id)) return;
        const el = document.querySelector(`.node[data-id="${n.id}"]`);
        nodeSizes.set(n.id, {
            halfW: el ? el.offsetWidth / 2 : 90,
            halfH: el ? el.offsetHeight / 2 : 55
        });
    });

    // 缓存节点尺寸供拖拽中更新连接线位置用（避免每帧重新强制布局）
    connNodeSizes = nodeSizes;

    // 统计双向对（A→B 与 B→A 同时存在），并逐个绘制
    const pairCount = new Map();
    currentProject.connections.forEach(conn => {
        const f = nodes.find(n => n.id === conn.from);
        const t = nodes.find(n => n.id === conn.to);
        if (!f || !t || !visibleIds.has(conn.from) || !visibleIds.has(conn.to)) return;
        const key = [conn.from, conn.to].sort().join('|');
        pairCount.set(key, (pairCount.get(key) || 0) + 1);
    });
    const drawnCount = new Map();

    currentProject.connections.forEach((conn, ci) => {
        const fromNode = nodes.find(n => n.id === conn.from);
        const toNode = nodes.find(n => n.id === conn.to);
        if (!fromNode || !toNode || !visibleIds.has(conn.from) || !visibleIds.has(conn.to)) return;
        const key = [conn.from, conn.to].sort().join('|');
        const isBi = pairCount.get(key) > 1;
        const idx = drawnCount.get(key) || 0;
        drawnCount.set(key, idx + 1);
        // 双向连接垂直错开，避免两条线重叠
        let offX = 0, offY = 0;
        if (isBi) {
            offY = idx === 0 ? -10 : 10;
        }
        drawOneConnection(fromNode, toNode, conn, offX, offY, nodeSizes, ci);
    });
}

// 拖拽中只更新连接线的坐标（不重建 svg，流畅跟随；由 updateDrag 每帧调用）
function updateConnectionsPositions() {
    const nodes = currentProject.nodes;
    const lines = svg.querySelectorAll('.conn-line');
    const hits = svg.querySelectorAll('.conn-hit');
    const arrows = svg.querySelectorAll('.conn-arrow');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const ci = parseInt(line.getAttribute('data-conn-index'), 10);
        const offX = parseFloat(line.getAttribute('data-off-x')) || 0;
        const offY = parseFloat(line.getAttribute('data-off-y')) || 0;
        const conn = currentProject.connections[ci];
        if (!conn) continue;
        const fromNode = nodes.find(n => n.id === conn.from);
        const toNode = nodes.find(n => n.id === conn.to);
        if (!fromNode || !toNode) continue;
        const s1 = connNodeSizes.get(fromNode.id) || { halfW: 90, halfH: 55 };
        const s2 = connNodeSizes.get(toNode.id) || { halfW: 90, halfH: 55 };
        const x1 = fromNode.x + s1.halfW + offX;
        const y1 = fromNode.y + s1.halfH + offY;
        const x2 = toNode.x + s2.halfW + offX;
        const y2 = toNode.y + s2.halfH + offY;
        const start = edgePoint(x1, y1, x2, y2, s1.halfW, s1.halfH);
        let end = edgePoint(x2, y2, x1, y1, s2.halfW, s2.halfH);
        const dx = end.x - start.x, dy = end.y - start.y;
        const segLen = Math.hypot(dx, dy);
        if (segLen > 0) { end.x -= (dx / segLen) * 2; end.y -= (dy / segLen) * 2; }
        const angle = Math.atan2(dy, dx);
        const arrowLen = 14;
        const tip = { x: end.x, y: end.y };
        const b1 = { x: tip.x - arrowLen * Math.cos(angle - 0.42), y: tip.y - arrowLen * Math.sin(angle - 0.42) };
        const b2 = { x: tip.x - arrowLen * Math.cos(angle + 0.42), y: tip.y - arrowLen * Math.sin(angle + 0.42) };
        const lineEnd = { x: tip.x - arrowLen * Math.cos(angle), y: tip.y - arrowLen * Math.sin(angle) };
        const midX = (start.x + lineEnd.x) / 2;
        const d = `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${lineEnd.y}, ${lineEnd.x} ${lineEnd.y}`;
        line.setAttribute('d', d);
        if (hits[i]) hits[i].setAttribute('d', d);
        if (arrows[i]) arrows[i].setAttribute('points', `${tip.x},${tip.y} ${b1.x},${b1.y} ${b2.x},${b2.y}`);
    }
}

// 绘制一条连接线（带手动箭头，方向跟随起点→终点；线连接箭头三角形底部）
function drawOneConnection(fromNode, toNode, conn, offX, offY, nodeSizes, connIdx) {
    // 用节点卡片实际尺寸定位边缘（尺寸在 renderConnections 一次性测量，避免每根线重复 querySelector 强制布局）
    const s1 = nodeSizes.get(fromNode.id) || { halfW: 90, halfH: 55 };
    const s2 = nodeSizes.get(toNode.id) || { halfW: 90, halfH: 55 };
    const halfW1 = s1.halfW, halfH1 = s1.halfH;
    const halfW2 = s2.halfW, halfH2 = s2.halfH;
    const x1 = fromNode.x + halfW1 + offX;
    const y1 = fromNode.y + halfH1 + offY;
    const x2 = toNode.x + halfW2 + offX;
    const y2 = toNode.y + halfH2 + offY;
    // 起点/终点缩到卡片边缘，让箭头露在卡片外面
    const start = edgePoint(x1, y1, x2, y2, halfW1, halfH1);
    let end = edgePoint(x2, y2, x1, y1, halfW2, halfH2);
    const dx = end.x - start.x, dy = end.y - start.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen > 0) {
        end.x -= (dx / segLen) * 2;
        end.y -= (dy / segLen) * 2;
    }
    // 箭头方向
    const angle = Math.atan2(dy, dx);
    const arrowLen = 14;
    // 箭头三角形：尖端在 end，底部两翼往回
    const tip = { x: end.x, y: end.y };
    const b1 = {
        x: tip.x - arrowLen * Math.cos(angle - 0.42),
        y: tip.y - arrowLen * Math.sin(angle - 0.42)
    };
    const b2 = {
        x: tip.x - arrowLen * Math.cos(angle + 0.42),
        y: tip.y - arrowLen * Math.sin(angle + 0.42)
    };
    // 连接线终止在三角形底部中心（而不是尖上）
    const lineEnd = {
        x: tip.x - arrowLen * Math.cos(angle),
        y: tip.y - arrowLen * Math.sin(angle)
    };
    const midX = (start.x + lineEnd.x) / 2;
    const d = `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${lineEnd.y}, ${lineEnd.x} ${lineEnd.y}`;

    // 透明粗的命中线（捕获点击/右键，解决线太细点不到）
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', '14');
    hit.setAttribute('fill', 'none');
    hit.setAttribute('class', 'conn-hit');
    hit.setAttribute('data-conn-index', connIdx);
    hit.setAttribute('data-off-x', offX);
    hit.setAttribute('data-off-y', offY);

    // 可见线
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', '#5b7cfa');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    path.setAttribute('class', 'conn-line');
    path.setAttribute('data-conn-index', connIdx);
    path.setAttribute('data-off-x', offX);
    path.setAttribute('data-off-y', offY);

    // 箭头
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    arrow.setAttribute('points', `${tip.x},${tip.y} ${b1.x},${b1.y} ${b2.x},${b2.y}`);
    arrow.setAttribute('fill', '#5b7cfa');
    arrow.setAttribute('class', 'conn-arrow');
    arrow.setAttribute('data-conn-index', connIdx);
    arrow.setAttribute('data-off-x', offX);
    arrow.setAttribute('data-off-y', offY);

    // 右键：连接模式下直接取消连接，否则弹删除菜单
    const onConnContext = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (mode === 'connect') {
            pushUndo('取消连接');
            currentProject.connections = currentProject.connections.filter(c => c !== conn);
            renderAll();
            showToast('已取消连接');
            return;
        }
        showContextMenu(e.clientX, e.clientY, [
            { label: '🗑️ 删除连接', action: () => {
                pushUndo('删除连接');
                currentProject.connections = currentProject.connections.filter(c => c !== conn);
                renderAll();
                showToast('已删除连接');
            }}
        ]);
    };
    hit.addEventListener('contextmenu', onConnContext);
    arrow.addEventListener('contextmenu', onConnContext);

    // 点击删除连接（确认弹窗）
    const onConnClick = (e) => {
        e.stopPropagation();
        const html = `
            <div class="modal-header">
                <h2>🔗 删除连接</h2>
                <button type="button" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <p style="font-size:16px; margin-bottom:8px;">确定要删除这条连接吗？</p>
            </div>
            <div class="modal-footer">
                <button class="btn-cancel" onclick="closeModal()">取消</button>
                <button id="confirmDeleteConn" class="btn-delete">🗑️ 确认删除</button>
            </div>
        `;
        openModal(html);
        document.getElementById('confirmDeleteConn').addEventListener('click', () => {
            pushUndo('删除连接');
            currentProject.connections = currentProject.connections.filter(c => c !== conn);
            closeModal();
            renderAll();
        });
        document.querySelector('.close-btn').addEventListener('click', closeModal);
    };
    hit.addEventListener('click', onConnClick);
    arrow.addEventListener('click', onConnClick);

    svg.appendChild(hit);
    svg.appendChild(path);
    svg.appendChild(arrow);
}

// ============================================================
// 空状态
// ============================================================


function updateEmptyState() {

    const children = currentProject.nodes.filter(n => n.parentId === getDisplayParentId() && n.parentId !== '__root__');
    if (children.length === 0) {
        emptyState.style.display = 'block';
    } else {
        emptyState.style.display = 'none';
    }
}

// ============================================================
// 面包屑（默认不显示完整路径，可在帮助中开启）
// ============================================================

function renderBreadcrumb() {
    // 默认整个面包屑栏隐藏；只有用户在帮助中打开"显示完整路径"才显示
    if (!showBreadcrumbPath) {
        breadcrumbBar.style.display = 'none';
        return;
    }
    breadcrumbBar.style.display = 'flex';
    breadcrumbBar.innerHTML = '';
    const chain = [];
    let cur = currentProject.nodes.find(n => n.id === currentContextId);
    while (cur) {
        chain.unshift(cur);
        if (cur.parentId === '__root__' || !cur.parentId) break;
        cur = currentProject.nodes.find(n => n.id === cur.parentId);
    }
    // 根
    const rootSpan = document.createElement('span');
    rootSpan.id = 'breadcrumbRoot';
    rootSpan.textContent = '📂 根';
    rootSpan.addEventListener('click', () => {
        pushHistory(currentContextId);
        currentContextId = rootNodeId;
        currentSelectedId = rootNodeId;
        renderAll();
    });
    breadcrumbBar.appendChild(rootSpan);
    // 默认只显示当前词条；开启"显示路径"后才显示完整路径链
    const displayChain = showBreadcrumbPath ? chain : (chain.length > 0 ? [chain[chain.length - 1]] : []);
    displayChain.forEach((n, i) => {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '›';
        breadcrumbBar.appendChild(sep);
        const span = document.createElement('span');
        span.textContent = getNodeTitle(n);
        if (i === displayChain.length - 1) {
            span.classList.add('current');
        } else {
            span.addEventListener('click', () => {
                pushHistory(currentContextId);
                currentContextId = n.id;
                currentSelectedId = n.id;
                renderAll();
            });
        }
        breadcrumbBar.appendChild(span);
    });
}


// ============================================================
// 历史性返回
// ============================================================

function pushHistory(contextId) {
    if (navHistory[navHistory.length - 1] !== contextId) {
        navHistory.push(contextId);
        if (navHistory.length > 100) navHistory.shift();
    }
    // 新的导航会清空前进栈
    navForwardHistory = [];
}

function goBack() {
    if (navHistory.length === 0) {
        showToast('没有可返回的历史', 1200);
        return;
    }
    // 记录当前，供前进
    navForwardHistory.push(currentContextId);
    const prev = navHistory.pop();
    currentContextId = prev;
    currentSelectedId = prev;
    renderAll();
}

function goForward() {
    if (navForwardHistory.length === 0) {
        showToast('没有可前进的历史', 1200);
        return;
    }
    const next = navForwardHistory.pop();
    navHistory.push(currentContextId);
    currentContextId = next;
    currentSelectedId = next;
    renderAll();
}

btnBackLevel.addEventListener('click', goBack);

// 层级返回（上级）：普通词条回到其父词条；引用词条直接跳到源词条本身所在层级
function goToParent() {
    // 基于当前显示层级取父：getDisplayParentId 已把引用词条解析为源词条，普通词条即当前上下文
    // 这样引用词条与普通词条的"上级"走同一逻辑，一步跳到父层级
    const displayParentId = getDisplayParentId();
    const cur = currentProject.nodes.find(n => n.id === displayParentId);
    if (!cur) { showToast('已在最顶层', 1200); return; }
    if (cur.id === rootNodeId || cur.parentId === '__root__' || !cur.parentId) {
        showToast('已在最顶层', 1200);
        return;
    }
    pushHistory(currentContextId);
    currentContextId = cur.parentId;
    currentSelectedId = cur.parentId;
    renderAll();
}
const btnGoParent = document.getElementById('btnGoParent');
if (btnGoParent) {
    btnGoParent.addEventListener('click', goToParent);
}

// 鼠标侧键导航：侧键后退（button 3）返回上级，侧键前进（button 4）进入下一级
document.addEventListener('mouseup', (e) => {
    if (e.button === 3) {
        e.preventDefault();
        goBack();
    } else if (e.button === 4) {
        e.preventDefault();
        goForward();
    }
});


btnHomeRoot.addEventListener('click', () => {
    pushHistory(currentContextId);
    currentContextId = rootNodeId;
    currentSelectedId = rootNodeId;
    renderAll();
    showToast('🏠 已回到词条主页');
});

// ============================================================
// 详情页
// ============================================================

let lastDetailSelectedId = null;  // 记录上次详情词条，切换时清空残留搜索
const detailScrollMap = new Map();  // 每个词条独立记忆详情页滚动位置（切换回来时恢复）
let detailPendingScroll = null;     // 切换词条时待恢复的滚动位置

// 详情页正文字数（底部状态栏）：标点算、换行/空格不算；悬停可看不含标点的口径
const detailWordCount = document.getElementById('detailWordCount');

function countText(text) {
    const compact = String(text || '').replace(/\s+/g, '');  // 去掉换行与空格
    return {
        withPunct: compact.length,                                    // 标点计入（网文平台口径）
        noPunct: compact.replace(/[\p{P}\p{S}]/gu, '').length         // 不含标点/符号
    };
}

function updateDetailWordCount() {
    if (!detailWordCount) return;
    const { withPunct, noPunct } = countText(detailBody ? detailBody.innerText : '');
    // 两个口径都直接显示在软件内（不用系统 tooltip，避免贴边时看不到）
    detailWordCount.innerHTML = `${withPunct} 字<span style="opacity:0.6;">（不含标点 ${noPunct}）</span>`;
    detailWordCount.title = `含标点 ${withPunct} 字 · 不含标点 ${noPunct} 字`;
}

// ---------- 详情页宽度：底部左侧手柄拖拽（其余位置不响应，避免误触）----------
const DETAIL_PANEL_DEFAULT_WIDTH = 400;
// 宽度记忆（全局偏好：所有书共用 —— 这是"界面习惯"，和书的内容无关，所以不跟着书走）
const DETAIL_WIDTH_KEY = 'novel-tool-detail-width';
function saveDetailWidth() {
    if (!detailPanel) return;
    try { localStorage.setItem(DETAIL_WIDTH_KEY, String(detailPanel.offsetWidth)); } catch (e) {}
}
(function restoreDetailWidth() {
    try {
        const v = parseInt(localStorage.getItem(DETAIL_WIDTH_KEY) || '', 10);
        if (Number.isFinite(v) && v >= 200 && v <= 600 && detailPanel) detailPanel.style.width = v + 'px';
    } catch (e) {}
})();
// 详情页宽度：设成指定像素并记住（全局偏好，所有书共用；书库页里只记宽度、不动画布）
function setDetailWidth(w) {
    if (!detailPanel) return;
    const v = Math.max(200, Math.min(600, Math.round(w)));
    detailPanel.style.width = v + 'px';
    saveDetailWidth();
    if (inBookView()) {
        updateCanvasSize();
        scheduleAutoArrange();  // 画布宽度变了 → 重新排列（和拖动结束一致，否则词条会被压住）
    }
}
(function initDetailResize() {
    const handle = document.getElementById('detailResizeHandle');
    const resetBtn = document.getElementById('detailResetWidthBtn');
    if (resetBtn && detailPanel) {
        resetBtn.addEventListener('click', () => {
            setDetailWidth(DETAIL_PANEL_DEFAULT_WIDTH);
            showToast('详情页宽度已重置', 1200);
        });
    }
    if (!handle || !detailPanel) return;
    let dragging = false, startX = 0, startW = 0, resizeRaf = null;
    const endResize = () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        saveDetailWidth();   // 记住这次的宽度（下次打开软件沿用）
        // 画布宽度变了 → 重新排列。
        // 必须先解除"拖拽词条期间的抑制"：否则刚拖过词条（400ms 内）再来拖详情页宽度，
        // 重排会被直接跳过 —— 这就是偶尔失灵的原因
        suppressAutoArrange = false;
        scheduleAutoArrange();
    };
    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startW = detailPanel.offsetWidth;
        handle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        // 鼠标拖到窗口外松开时收不到 mouseup，用 buttons 兜底结束
        if (e.buttons === 0) { endResize(); return; }
        const delta = startX - e.clientX;  // 向左拖 → 正 → 变宽
        const w = Math.max(200, Math.min(600, Math.round(startW + delta)));
        detailPanel.style.width = w + 'px';
        // 画布宽度实时变化：先把超出可视区的词条拉回、更新内容区尺寸，
        // 避免词条被详情页压住看不见（拖动过程中只做轻量更新，不做重排，保证跟手）
        if (!resizeRaf) {
            resizeRaf = requestAnimationFrame(() => {
                resizeRaf = null;
                updateCanvasSize();
            });
        }
    });
    document.addEventListener('mouseup', endResize);
})();

function renderDetailPanel() {
    const detailScrollBox = detailBody.parentElement;  // 详情页滚动容器
    // 切换了详情词条：自动清空残留的搜索关键词与高亮，避免串词条
    if (lastDetailSelectedId !== currentSelectedId) {
        // 保存上一个词条的滚动位置，准备恢复当前词条的滚动位置
        if (lastDetailSelectedId && detailScrollBox) {
            detailScrollMap.set(lastDetailSelectedId, detailScrollBox.scrollTop);
        }
        lastDetailSelectedId = currentSelectedId;
        detailPendingScroll = detailScrollMap.get(currentSelectedId) || 0;
        detailFindInput.value = '';
        syncDetailFindClear();          // 清空了：✕ 也得跟着收起来
        detailFindBar.style.display = 'none';
        detailFindReplaceRow.style.display = 'none';
        if (window.CSS && CSS.highlights) {
            CSS.highlights.delete('find-current');
            CSS.highlights.delete('find-other');
        }
    }
    // 应用详情页背景（独立于画布背景）
    applyDetailBg();
    if (!currentSelectedId) {
        detailTitle.textContent = '未命名';
        detailNumber.textContent = '0';
        detailSummary.textContent = '';
        detailBody.textContent = '';
        updateDetailWordCount();
        return;
    }

    const node = currentProject.nodes.find(n => n.id === currentSelectedId);
    if (!node) {
        detailTitle.textContent = '未命名';
        detailNumber.textContent = '0';
        detailSummary.textContent = '';
        detailBody.textContent = '';
        updateDetailWordCount();
        return;
    }
    const source = getNodeSource(node);
    const isRef = isRefNode(node);
    detailTitle.textContent = source ? (source.title || '未命名') : (node.title || '未命名');
    detailNumber.textContent = node.number || '0';
    detailSummary.textContent = source ? (source.summary || '') : (node.summary || '');
    detailBody.textContent = source ? (source.content || '') : (node.content || '');
    // 兼容旧版本 bug：placeholder 提示文字曾被误写入内容，加载时自动清除
    if (detailSummary.textContent.trim() === '一句话摘要…') detailSummary.textContent = '';
    if (detailBody.textContent.trim() === '正文内容…') detailBody.textContent = '';
    // 引用词条在详情页不显示标记（仅画布卡片上用 🔗 标识）
    if (isRef) {
        detailTitle.textContent = detailTitle.textContent.replace(/^🔗\s*/, '');
    }
    // 恢复 placeholder 效果（灰色可消除文字：不点击时显示，点击输入时消失）
    // 应用详情文字颜色：手动设置优先；未设置时夜间模式自动变白
    const darkNow = document.body.classList.contains('dark');
    detailTitle.style.color = currentProject.detailTextColor ? currentProject.detailTextColor : (darkNow ? '#ffffff' : '');
    applyDetailPlaceholder(detailSummary, '一句话摘要…');
    applyDetailPlaceholder(detailBody, '正文内容…');
    // 绑定编辑事件（不重建 DOM，避免卡死）
    bindDetailEdits(node);
    // 切换词条后重置查找栏状态
    hideDetailDropCaret();   // 换词条：顺手收起可能还挂着的落点竖线
    if (detailFindBar && detailFindBar.style.display === 'flex') {
        findMatches = [];
        findIndex = -1;
        window.getSelection().removeAllRanges();
        detailFindCount.textContent = '';
    }
    // 恢复该词条上次的滚动位置（每个详情页独立记忆，互不影响）
    if (detailPendingScroll !== null && detailScrollBox) {
        const targetScroll = detailPendingScroll;
        detailPendingScroll = null;
        requestAnimationFrame(() => { if (detailScrollBox) detailScrollBox.scrollTop = targetScroll; });
    }
    updateDetailWordCount();
}

// 详情页 placeholder：内容为空时用 CSS 伪元素显示灰色提示（不写入内容、不改文字颜色，避免粘贴文字变灰/污染正文）
function applyDetailPlaceholder(el, placeholderText) {
    if (!el) return;
    const dark = document.body.classList.contains('dark');
    const tc = currentProject.detailTextColor;
    const isEmpty = !el.textContent.trim();
    if (isEmpty) {
        el.dataset.placeholder = placeholderText;
    } else {
        delete el.dataset.placeholder;
    }
    el.style.color = tc ? tc : (dark ? '#ffffff' : '');
}

// 内容变化时刷新 placeholder 显示状态（有内容就隐藏提示）
function refreshPlaceholder(el, placeholderText) {
    if (!el) return;
    if (el.textContent.trim()) delete el.dataset.placeholder;
    else el.dataset.placeholder = placeholderText;
}


// ---------- 详情编辑（不重建 DOM，修复卡死问题）----------
function bindDetailEdits(node) {
    // 标题编辑
    detailTitle.oninput = () => {
        const source = getNodeSource(node);
        if (source) {
            source.title = detailTitle.textContent.replace(/^🔗\s*/, '');
            source.lastModified = Date.now();
            // 同步所有引用该词条的节点标题
            currentProject.nodes.forEach(n => {
                if (n.refId === source.id) {
                    // 引用词条标题跟随源词条
                }
            });
            scheduleSave();
            renderCanvas();
            renderBreadcrumb();
        }
    };
    // 粘贴：只取纯文本，转成浏览器标准换行结构（<br>）插入，避免与浏览器换行结构混用导致空行膨胀
    const pastePlain = (el) => (e) => {
        e.preventDefault();
        const raw = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
        const clean = raw.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
        const html = clean.split('\n').map(line => escapeHtml(line)).join('<br>');
        document.execCommand('insertHTML', false, html);
        if (el) el.dispatchEvent(new Event('input'));
    };
    detailBody.onpaste = pastePlain(detailBody);
    detailSummary.onpaste = pastePlain(detailSummary);
    // 摘要编辑
    detailSummary.oninput = () => {
        const source = getNodeSource(node);
        if (source) {
            source.summary = detailSummary.innerText;  // innerText 保留换行（textContent 会丢失 div 块换行）
            source.lastModified = Date.now();
            scheduleSave();
            renderCanvas();
        }
        refreshPlaceholder(detailSummary, '一句话摘要…');
    };
    // 正文编辑
    detailBody.oninput = (e) => {
        const source = getNodeSource(node);
        if (source) {
            source.content = detailBody.innerText.replace(/\r\n?/g, '\n');
            source.lastModified = Date.now();
            scheduleSave();
        }
        // 搜索栏打开且有关键词时：延后一拍重算匹配 + 重画高亮（见 scheduleDetailFindRefresh 的说明）
        scheduleDetailFindRefresh();
        refreshPlaceholder(detailBody, '正文内容…');
        updateDetailWordCount();
    };
    // Ctrl+Enter：在当前段落（逻辑行）下方新建空行
    // 用浏览器原生 API：光标移到「段落边界」(paragraphboundary，非视觉行) + 插入换行
    detailBody.onkeydown = (e) => {
        if (e.ctrlKey && e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            const sel = window.getSelection();
            if (!sel.rangeCount) return;
            try {
                sel.modify('move', 'forward', 'paragraphboundary');  // 光标移到当前段落末尾（不受自动换行影响）
                document.execCommand('insertLineBreak');              // 在段落末尾插入换行（下方新建空行）
            } catch (err) {}
            detailBody.dispatchEvent(new Event('input'));  // 触发保存
        }
    };
}

// ============================================================
// ---------- 回车：统一插"真正的换行"，不让浏览器造"新段落"块结构 ----------
// 为什么必须拦：浏览器默认把回车做成"新段落"（<div><br></div> 这类块结构），而软件保存时读的是
// innerText —— 它会把"块本身"算一个换行、"块里的 <br>"再算一个换行，于是界面上的一行在存档里
// 变成两行；切走再切回（renderDetailPanel 用 textContent 装载）就凭空多出一行空行。
// 实测（隐藏窗口 + 本文件的 CSS/DOM）：光标停在空行上按一次回车 → 界面 4 行、存档 5 行、切回来 5 行；
// 文末连按 3 次 → 界面 6 行、存档 9 行、切回来 8 行。改成插换行后，DOM 里只有真 \n，
// 界面 = 存档 = 读回来（和 Ctrl+Enter、粘贴完全同一套结构）。
// 注意：① 输入法组合中不拦（否则打不出候选）；② Ctrl/Alt+回车放行（Ctrl+Enter 是"段落末尾新建空行"）；
//       ③ 选区会被自动替换；④ 走的是浏览器自己的编辑命令，所以 Ctrl+Z 仍能撤销。
function bindEnterAsLineBreak(el) {
    if (!el) return;
    el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        document.execCommand('insertLineBreak');
        el.dispatchEvent(new Event('input'));   // 触发保存（oninput 里读 innerText）
    });
}
bindEnterAsLineBreak(detailTitle);
bindEnterAsLineBreak(detailSummary);
bindEnterAsLineBreak(detailBody);
// 详情页查找 / 替换
// ============================================================
let findMatches = [];
let findIndex = -1;
let findQuery = '';

const detailFindBtn = document.getElementById('detailFindBtn');
const detailFindBar = document.getElementById('detailFindBar');
const detailFindInput = document.getElementById('detailFindInput');
const detailFindCount = document.getElementById('detailFindCount');
const detailFindPrev = document.getElementById('detailFindPrev');
const detailFindNext = document.getElementById('detailFindNext');
const detailFindReplaceToggle = document.getElementById('detailFindReplaceToggle');
const detailFindClose = document.getElementById('detailFindClose');
const detailFindReplaceRow = document.getElementById('detailFindReplaceRow');
const detailReplaceInput = document.getElementById('detailReplaceInput');
const detailReplaceOne = document.getElementById('detailReplaceOne');
const detailReplaceAll = document.getElementById('detailReplaceAll');

// 擦掉详情页搜索的高亮（用的 CSS Custom Highlight API），搜索框里的内容保留
// 只擦高亮，不动光标/选区（以前这里还 removeAllRanges，导致"打字打不出匹配"时光标被抹掉）
function clearFindHighlights() {
    try {
        if (window.CSS && CSS.highlights) { CSS.highlights.delete('find-current'); CSS.highlights.delete('find-other'); }
    } catch (e) {}
}



// ===== 详情页搜索：统一基准 =====
// 把正文序列化成"一份权威文本"，并记录每个字符对应到哪个文本节点/哪个位置。
// 搜索、高亮、回车上下、替换全部走这一份基准 —— 不再出现"整串偏移套在单个文本节点上"的错位，
// 也不需要为了搜索去重写 DOM（所以打字不会丢光标）。
function detailTextMap() {
    const map = [];      // map[i] = { node, offset }；合成出来的换行记 null
    let text = '';
    const isBlockEl = (el) => {
        if (!el || el.nodeType !== 1) return false;
        const ln = (el.tagName || '').toLowerCase();
        if (ln === 'br') return false;
        if (ln === 'div' || ln === 'p' || ln === 'li' || ln === 'tr') return true;
        try { return getComputedStyle(el).display === 'block'; } catch (e) { return false; }
    };
    const pushNewline = () => { if (text.length && text[text.length - 1] !== '\n') { text += '\n'; map.push(null); } };
    const walk = (parent) => {
        Array.prototype.slice.call(parent.childNodes).forEach(n => {
            if (n.nodeType === 3) {
                const data = n.nodeValue.replace(/\r\n?/g, '\n');
                for (let k = 0; k < data.length; k++) { text += data[k]; map.push({ node: n, offset: k }); }
            } else if (n.nodeType === 1) {
                if ((n.tagName || '').toLowerCase() === 'br') { text += '\n'; map.push(null); return; }
                const blk = isBlockEl(n);
                if (blk) pushNewline();
                walk(n);
                if (blk) pushNewline();
            }
        });
    };
    walk(detailBody);
    // 结尾多出来的合成换行去掉（对齐 innerText：最后一块后面没有换行）
    while (map.length && map[map.length - 1] === null) { map.pop(); text = text.slice(0, -1); }
    return { text: text, map: map };
}

// 整串偏移 → 真实 DOM Range（落在合成换行上就吸附到最近的真实字符）
function rangeFromOffsets(start, end) {
    const tm = detailTextMap();
    const text = tm.text, map = tm.map;
    if (!text.length || !map.length) return null;
    const realForward = (i) => { for (let k = Math.max(0, i); k < map.length; k++) { if (map[k]) return k; } return -1; };
    const realBackward = (i) => { for (let k = Math.min(i, map.length - 1); k >= 0; k--) { if (map[k]) return k; } return -1; };
    const si = realForward(Math.max(0, Math.min(start, text.length)));
    const ei = realBackward(Math.max(0, Math.min(end, text.length) - 1));
    if (si < 0 || ei < 0 || ei < si) return null;
    const a = map[si], b = map[ei];
    if (!a || !b) return null;
    try {
        const r = document.createRange();
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, Math.min(b.node.nodeValue.length, b.offset + 1));
        return r;
    } catch (e) { return null; }
}

// 高亮用的是 CSS Custom Highlight API，它里面的 Range 是"活的"：在 Range 起点处插字，Range 会自动
// 把新字算进去（实测：搜 abc、在 abc 左边打个 X → 高亮立刻变成 "Xabc"）。所以**任何一次内容变化之后
// 都得重算一遍**才行；而输入法组合期间浏览器给的 input 事件带 isComposing，以前的代码会跳过重算 ——
// 表现就是"用中文打字时，高亮一直把刚打的字吃进去"。
// 这里改成"延后一拍重算"（setTimeout 0）：① 组合期间也重算 ② 等这次输入真正落进 DOM 再算
// ③ quiet 模式只重画高亮、不滚动、不碰 DOM，所以不会打断输入法。
let detailFindRefreshTimer = null;
function scheduleDetailFindRefresh() {
    if (detailFindRefreshTimer) return;
    detailFindRefreshTimer = setTimeout(() => {
        detailFindRefreshTimer = null;
        if (!detailFindBar || detailFindBar.style.display !== 'flex') return;   // 搜索栏没开着就不用管
        if (!detailFindInput || !detailFindInput.value.trim()) return;          // 没关键词就没有高亮
        doFind(false, true);     // quiet：只重算匹配 + 重画高亮，不滚动到匹配处（打字时别让面板乱跳）
    }, 0);
}
// 输入法：组合结束（提交）后再补一次 —— 有些输入法最后一次 input 事件仍带着 isComposing
if (detailBody) detailBody.addEventListener('compositionend', () => scheduleDetailFindRefresh());
function doFind(initial, quiet) {
    const q = detailFindInput.value;
    findQuery = q;
    const text = detailTextMap().text;     // 不再改 DOM：直接用权威文本匹配
    findMatches = [];
    if (q) {
        let idx = text.indexOf(q);
        while (idx !== -1) {
            findMatches.push({ start: idx, end: idx + q.length });
            idx = text.indexOf(q, idx + q.length);
        }
    }
    findIndex = findMatches.length ? (initial ? 0 : Math.min(Math.max(findIndex, 0), findMatches.length - 1)) : -1;
    if (findMatches.length) highlightFind(findMatches[findIndex], quiet);
    else { clearFindHighlights(); detailFindCount.textContent = q ? '无结果' : ''; }
}

function highlightFind(m, quiet) {
    const curRange = rangeFromOffsets(m.start, m.end);
    if (!curRange) {
        detailFindCount.textContent = '位置失效';   // 不再静默失败
        return;
    }
    // 滚动到当前匹配（不抢焦点、不选中正文）；quiet = 打字过程中那次重算 → 不滚，免得面板跟着乱跳
    if (!quiet) {
        try {
            const curRect = curRange.getBoundingClientRect();
            const scrollBox = detailBody.parentElement || detailBody;  // 实际滚动容器是父 div
            const panelRect = scrollBox.getBoundingClientRect();
            if (curRect.top < panelRect.top || curRect.bottom > panelRect.bottom) {
                scrollBox.scrollTop += (curRect.top - panelRect.top) - 40;
            }
        } catch (e) {}
    }
    try {
        if (window.CSS && CSS.highlights && typeof Highlight === 'function') {
            CSS.highlights.delete('find-current');
            CSS.highlights.delete('find-other');
            CSS.highlights.set('find-current', new Highlight(curRange));
            const hOther = new Highlight();
            findMatches.forEach((mm, i) => {
                if (i === findIndex) return;
                const r = rangeFromOffsets(mm.start, mm.end);
                if (r) { try { hOther.add(r); } catch (e) {} }
            });
            if (hOther.size) CSS.highlights.set('find-other', hOther);
        } else {
            // 旧引擎回退：原生选区（仅兼容，会占用焦点）
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(curRange);
        }
        detailFindCount.textContent = `${findIndex + 1}/${findMatches.length}`;
    } catch (e) {}
}

function findNext() {
    if (!findMatches.length) return;
    findIndex = (findIndex + 1) % findMatches.length;
    highlightFind(findMatches[findIndex]);
}
function findPrev() {
    if (!findMatches.length) return;
    findIndex = (findIndex - 1 + findMatches.length) % findMatches.length;
    highlightFind(findMatches[findIndex]);
}

function commitDetailBodyText() {
    const node = currentProject.nodes.find(n => n.id === currentSelectedId);
    if (!node) return;
    const source = getNodeSource(node);
    if (source) {
        source.content = detailBody.innerText.replace(/\r\n?/g, '\n');
        scheduleSave();
    }
    updateDetailWordCount();  // 替换等非输入操作后同步字数
}

function replaceCurrent() {
    if (!findQuery || findIndex < 0) return;
    const m = findMatches[findIndex];
    const r = rangeFromOffsets(m.start, m.end);
    if (!r) { showToast('替换位置失效，重新搜索一下', 2000); return; }
    pushUndo('查找替换');
    const rep = detailReplaceInput.value;
    try {
        r.deleteContents();
        if (rep) r.insertNode(document.createTextNode(rep));
    } catch (e) { showToast('替换失败：' + e.message, 2200); return; }
    detailBody.normalize();          // 合并相邻文本节点，避免碎片越攒越多
    commitDetailBodyText();
    doFind();
    findNext();
}

function replaceAll() {
    if (!findQuery) return;
    pushUndo('查找替换');
    const rep = detailReplaceInput.value;
    let done = 0;
    // 从后往前替换：前面的改动不会影响后面的偏移
    for (let i = findMatches.length - 1; i >= 0; i--) {
        const r = rangeFromOffsets(findMatches[i].start, findMatches[i].end);
        if (!r) continue;
        try {
            r.deleteContents();
            if (rep) r.insertNode(document.createTextNode(rep));
            done++;
        } catch (e) {}
    }
    if (!done) { showToast('没有可替换的内容', 1800); return; }
    detailBody.normalize();
    commitDetailBodyText();
    doFind();
    showToast(`已替换 ${done} 处`, 2000);
}

detailFindBtn.addEventListener('click', () => {
    detailFindBar.style.display = detailFindBar.style.display === 'flex' ? 'none' : 'flex';
    if (detailFindBar.style.display !== 'flex') {   // 收起：替换行一起收，并把高亮擦掉（搜索内容保留）
        detailFindReplaceRow.style.display = 'none';
        clearFindHighlights();
        window.getSelection().removeAllRanges();   // 收起时才清选区
    }
    if (detailFindBar.style.display === 'flex') {
        detailFindInput.focus();
        detailFindInput.select();
        doFind(true);
    }
});
detailFindInput.addEventListener('input', () => doFind(true));
// 搜索框里的 ✕：有内容才出现，点一下清空（同时把高亮擦掉）
const detailFindClearBtn = document.getElementById('detailFindClear');
// 用函数声明（会提升）+ 每次现查元素：因为「从全局搜索跳转过来」「切换词条时清空」这些地方都是**用代码改 value** 的，
// 需要在脚本还没执行到这一行时也能安全调用 —— 否则就是「程序把关键词填进去了、✕ 却不出现」。
function syncDetailFindClear() {
    const btn = document.getElementById('detailFindClear');
    if (btn) btn.style.display = detailFindInput.value ? 'block' : 'none';
}
if (detailFindClearBtn) {
    detailFindClearBtn.addEventListener('click', () => {
        detailFindInput.value = '';
        doFind(true);
        syncDetailFindClear();
        detailFindInput.focus();
    });
}
detailFindInput.addEventListener('input', syncDetailFindClear);
syncDetailFindClear();
detailFindInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); (e.shiftKey ? findPrev() : findNext()); }
});
detailFindNext.addEventListener('click', findNext);
detailFindPrev.addEventListener('click', findPrev);
detailFindReplaceToggle.addEventListener('click', () => {
    detailFindReplaceRow.style.display = detailFindReplaceRow.style.display === 'flex' ? 'none' : 'flex';
});
detailFindClose.addEventListener('click', () => {
    detailFindBar.style.display = 'none';
    detailFindReplaceRow.style.display = 'none';
    clearFindHighlights();
    window.getSelection().removeAllRanges();   // 收起时才清选区
});
detailReplaceOne.addEventListener('click', replaceCurrent);
detailReplaceAll.addEventListener('click', replaceAll);

// ============================================================
// 词条回收站
// ============================================================

function renderTrashList() {
    if (!trashList) return;
    trashList.innerHTML = '';
    // 最后删除的排最上面，最早删除的排最下面
    const items = (currentProject.trash || []).slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    if (items.length === 0) {
        trashList.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-secondary);">回收站为空</div>';
        return;
    }
    items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'trash-item';
        const isChecked = trashSelectedIds.has(item.id);
        if (isChecked) row.classList.add('selected');
        row.innerHTML = `
            <input type="checkbox" ${isChecked ? 'checked' : ''} data-id="${item.id}" />
            <span class="trash-title">${escapeHtml(item.title || '未命名')}</span>
            <div class="trash-actions">
                <button class="restore-btn" data-id="${item.id}" title="恢复">↻</button>
                <button class="delete-btn" data-id="${item.id}" title="永久删除">✕</button>
            </div>
        `;

        // 点击行切换选中（手动多选）
        row.addEventListener('click', (e) => {
            if (e.target.closest('.trash-actions')) return;
            const id = item.id;
            if (trashSelectedIds.has(id)) {
                trashSelectedIds.delete(id);
                row.classList.remove('selected');
                row.querySelector('input[type="checkbox"]').checked = false;
            } else {
                trashSelectedIds.add(id);
                row.classList.add('selected');
                row.querySelector('input[type="checkbox"]').checked = true;
            }
            updateTrashSelectAll();
        });
        row.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
            e.stopPropagation();
            const id = e.target.dataset.id;
            if (e.target.checked) {
                trashSelectedIds.add(id);
                row.classList.add('selected');
            } else {
                trashSelectedIds.delete(id);
                row.classList.remove('selected');
            }
            updateTrashSelectAll();
        });
        row.querySelector('.restore-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            restoreTrashItem(item.id);
        });
        row.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            permanentlyDeleteTrashItem(item.id);
        });
        trashList.appendChild(row);
    });
    updateTrashSelectAll();
}

function updateTrashSelectAll() {
    const items = currentProject.trash || [];
    const allChecked = items.length > 0 && items.every(i => trashSelectedIds.has(i.id));
    const cb = ensureTrashCheckbox();
    if (cb) cb.checked = allChecked;
}


function restoreTrashItem(id) {
    const idx = currentProject.trash.findIndex(i => i.id === id);
    if (idx === -1) return;
    const item = currentProject.trash[idx];
    const doRestore = () => {
        pushUndo();
        const restored = { ...item };
        delete restored.deletedAt;
        // 如果父节点不存在，挂到根
        if (!currentProject.nodes.find(n => n.id === restored.parentId)) {
            restored.parentId = rootNodeId;
        }
        currentProject.nodes.push(restored);
        const i2 = currentProject.trash.findIndex(i => i.id === id);
        if (i2 !== -1) currentProject.trash.splice(i2, 1);
        trashSelectedIds.delete(id);
        renderAll();
        showToast('已恢复');
    };
    // 仅当"引用它的引用词条被单独修改过"（自身有内容 = 源被删期间编辑过）时才提示
    const affected = currentProject.nodes.filter(n => n.refId === id &&
        (((n.title || '').trim()) || ((n.summary || '').trim()) || ((n.content || '').trim())));
    if (affected.length) {
        const html = `
            <div class="modal-header">
                <h2>⚠️ 恢复前提醒</h2>
                <button type="button" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <p style="font-size:15px; line-height:1.8; margin-bottom:10px;">
                    有 <b>${affected.length}</b> 个引用词条曾在「${escapeHtml(item.title || '未命名')}」被删除期间被单独修改过：
                </p>
                <ul style="font-size:13px; color:var(--text-secondary); line-height:1.9; padding-left:20px; max-height:130px; overflow-y:auto;">
                    ${affected.slice(0, 6).map(n => `<li>${escapeHtml(n.title || n.number || '(未命名)')}</li>`).join('')}
                    ${affected.length > 6 ? `<li>…另外 ${affected.length - 6} 个</li>` : ''}
                </ul>
                <p style="font-size:13px; color:var(--text-secondary); margin-top:12px; line-height:1.7;">
                    恢复后这些引用词条会<b>重新显示源词条的内容</b>（它们的修改<b>不会丢</b>，只是暂时不显示）。<br>要继续恢复吗？
                </p>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn-cancel" onclick="closeModal()">取消</button>
                <button type="button" id="confirmRestoreTrash" class="btn-save">继续恢复</button>
            </div>
        `;
        openModal(html);
        document.querySelector('.close-btn').addEventListener('click', closeModal);
        document.getElementById('confirmRestoreTrash').addEventListener('click', () => { closeModal(); doRestore(); });
        return;
    }
    doRestore();
}

function permanentlyDeleteTrashItem(id) {
    const idx = currentProject.trash.findIndex(i => i.id === id);
    if (idx === -1) return;
    const item = currentProject.trash[idx];
    const html = `
        <div class="modal-header">
            <h2>🗑️ 永久删除词条</h2>
            <button type="button" class="close-btn">✕</button>
        </div>
        <div class="modal-body">
            <p style="font-size:16px; margin-bottom:8px;">确定要永久删除 <strong>「${escapeHtml(item.title || '未命名')}」</strong> 吗？</p>
            <p style="font-size:13px; color:#e74c3c; font-weight:500;">⚠️ 此操作不可恢复！</p>
        </div>
        <div class="modal-footer">
            <button class="btn-cancel" onclick="closeModal()">取消</button>
            <button id="confirmDeleteTrashItem" class="btn-delete">🗑️ 确认删除</button>
        </div>
    `;
    openModal(html);
    document.getElementById('confirmDeleteTrashItem').addEventListener('click', () => {
        currentProject.trash.splice(idx, 1);
        trashSelectedIds.delete(id);
        closeModal();
        renderTrashList();
        scheduleSave();
        showToast('已永久删除');
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
}


// 词条回收站按钮
btnTrash.addEventListener('click', () => {
    if (bookTrashPanel && !bookTrashPanel.classList.contains('hidden')) {
        bookTrashPanel.classList.add('hidden');
    }
    const isOpen = !trashPanel.classList.contains('hidden');
    if (isOpen) {
        trashPanel.classList.add('hidden');
    } else {
        trashPanel.classList.remove('hidden');
        renderTrashList();
    }
});

document.getElementById('btnCloseTrash').addEventListener('click', () => {
    trashPanel.classList.add('hidden');
});

document.getElementById('btnEmptyTrash').addEventListener('click', () => {
    if ((currentProject.trash || []).length === 0) { showToast('回收站为空'); return; }
    const html = `
        <div class="modal-header">
            <h2>🗑️ 清空词条回收站</h2>
            <button type="button" class="close-btn">✕</button>
        </div>
        <div class="modal-body">
            <p style="font-size:16px; margin-bottom:8px;">确定要清空词条回收站吗？</p>
            <p style="font-size:13px; color:#e74c3c; font-weight:500;">⚠️ 此操作不可恢复！</p>
        </div>
        <div class="modal-footer">
            <button class="btn-cancel" onclick="closeModal()">取消</button>
            <button id="confirmEmptyTrash" class="btn-delete">🗑️ 确认清空</button>
        </div>
    `;
    openModal(html);
    document.getElementById('confirmEmptyTrash').addEventListener('click', () => {
        currentProject.trash = [];
        trashSelectedIds.clear();
        closeModal();
        renderTrashList();
        scheduleSave();
        showToast('已清空词条回收站');
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
});

document.getElementById('btnTrashDeleteSelected').addEventListener('click', () => {
    if (trashSelectedIds.size === 0) { showToast('请先选择要删除的词条'); return; }
    const html = `
        <div class="modal-header">
            <h2>🗑️ 永久删除选中词条</h2>
            <button type="button" class="close-btn">✕</button>
        </div>
        <div class="modal-body">
            <p style="font-size:16px; margin-bottom:8px;">确定要永久删除选中的 <strong>${trashSelectedIds.size}</strong> 个词条吗？</p>
            <p style="font-size:13px; color:#e74c3c; font-weight:500;">⚠️ 此操作不可恢复！</p>
        </div>
        <div class="modal-footer">
            <button class="btn-cancel" onclick="closeModal()">取消</button>
            <button id="confirmTrashDeleteSelected" class="btn-delete">🗑️ 确认删除</button>
        </div>
    `;
    openModal(html);
    document.getElementById('confirmTrashDeleteSelected').addEventListener('click', () => {
        currentProject.trash = currentProject.trash.filter(i => !trashSelectedIds.has(i.id));
        trashSelectedIds.clear();
        closeModal();
        renderTrashList();
        scheduleSave();
        showToast('已永久删除选中词条');
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
});

// 词条回收站：恢复选中（批量恢复，父词条被删时子词条也一起在回收站里）
document.getElementById('btnTrashRestoreSelected').addEventListener('click', () => {
    if (trashSelectedIds.size === 0) { showToast('请先选择要恢复的词条'); return; }
    const ids = currentProject.trash.filter(i => trashSelectedIds.has(i.id)).map(i => i.id);
    ids.forEach(id => {
        const idx = currentProject.trash.findIndex(i => i.id === id);
        if (idx === -1) return;
        const item = currentProject.trash[idx];
        const restored = { ...item };
        delete restored.deletedAt;
        // 如果父节点不存在，挂到根
        if (!currentProject.nodes.find(n => n.id === restored.parentId)) {
            restored.parentId = rootNodeId;
        }
        currentProject.nodes.push(restored);
        currentProject.trash.splice(idx, 1);
        trashSelectedIds.delete(id);
    });
    renderAll();
    showToast(`已恢复 ${ids.length} 个词条`);
});

// ============================================================
// 书籍回收站（独立面板）
// ============================================================

function renderBookTrashList() {
    if (!bookTrashList) return;
    bookTrashList.innerHTML = '';
    // 最后删除的排最上面，最早删除的排最下面
    const items = (bookTrashItems || []).slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    if (items.length === 0) {
        bookTrashList.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-secondary);">书籍回收站为空</div>';
        return;
    }
    items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'trash-item';
        const isChecked = bookTrashSelectedIds.has(item.id);
        if (isChecked) row.classList.add('selected');
        row.innerHTML = `
            <input type="checkbox" ${isChecked ? 'checked' : ''} data-id="${item.id}" />
            <span class="trash-title">${escapeHtml(item.name || '未命名')}</span>
            <div class="trash-actions">
                <button class="restore-btn" data-id="${item.id}" title="恢复">↻</button>
                <button class="delete-btn" data-id="${item.id}" title="永久删除">✕</button>
            </div>
        `;

        // 点击行切换选中（手动多选）
        row.addEventListener('click', (e) => {
            if (e.target.closest('.trash-actions')) return;
            const id = item.id;
            if (bookTrashSelectedIds.has(id)) {
                bookTrashSelectedIds.delete(id);
                row.classList.remove('selected');
                row.querySelector('input[type="checkbox"]').checked = false;
            } else {
                bookTrashSelectedIds.add(id);
                row.classList.add('selected');
                row.querySelector('input[type="checkbox"]').checked = true;
            }
            updateBookTrashSelectAll();
        });
        row.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
            e.stopPropagation();
            const id = e.target.dataset.id;
            if (e.target.checked) {
                bookTrashSelectedIds.add(id);
                row.classList.add('selected');
            } else {
                bookTrashSelectedIds.delete(id);
                row.classList.remove('selected');
            }
            updateBookTrashSelectAll();
        });
        row.querySelector('.restore-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            restoreBookTrashItem(item.id);
        });
        row.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            permanentlyDeleteBookTrashItem(item.id);
        });
        bookTrashList.appendChild(row);
    });
    updateBookTrashSelectAll();
}

function updateBookTrashSelectAll() {
    const items = bookTrashItems || [];
    const allChecked = items.length > 0 && items.every(i => bookTrashSelectedIds.has(i.id));
    const cb = ensureBookTrashCheckbox();
    if (cb) cb.checked = allChecked;
}


async function restoreBookTrashItem(id) {
    const item = bookTrashItems.find(i => i.id === id);
    if (!item) return;
    try {
        // 调用主进程写回小说库文件
        const result = await api.restoreBook(item.filePath);
        if (result.success) {
            bookTrashItems = bookTrashItems.filter(i => i.id !== id);
            bookTrashSelectedIds.delete(id);
            renderBookTrashList();
            showToast('已恢复小说「' + item.name + '」');
            loadProjects();
        } else {
            showToast('恢复失败: ' + result.error);
        }
    } catch (e) {
        showToast('恢复失败: ' + e.message);
    }
}

function permanentlyDeleteBookTrashItem(id) {
    const item = bookTrashItems.find(i => i.id === id);
    if (!item) return;
    const html = `
        <div class="modal-header">
            <h2>🗑️ 永久删除小说</h2>
            <button type="button" class="close-btn">✕</button>
        </div>
        <div class="modal-body">
            <p style="font-size:16px; margin-bottom:8px;">确定要永久删除 <strong>「${escapeHtml(item.name || '未命名')}」</strong> 吗？</p>
            <p style="font-size:13px; color:#e74c3c; font-weight:500;">⚠️ 此操作不可恢复！</p>
        </div>
        <div class="modal-footer">
            <button class="btn-cancel" onclick="closeModal()">取消</button>
            <button id="confirmDeleteBookTrash" class="btn-delete">🗑️ 确认删除</button>
        </div>
    `;
    openModal(html);
    document.getElementById('confirmDeleteBookTrash').addEventListener('click', async () => {
        await api.deleteBookTrash([item.filePath]);
        bookTrashItems = bookTrashItems.filter(i => i.id !== id);
        bookTrashSelectedIds.delete(id);
        closeModal();
        renderBookTrashList();
        showToast('已永久删除');
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
}


// 书籍回收站按钮（在书库页工具栏添加）
function openBookTrash() {
    if (trashPanel && !trashPanel.classList.contains('hidden')) {
        trashPanel.classList.add('hidden');
    }
    const isOpen = !bookTrashPanel.classList.contains('hidden');
    if (isOpen) {
        bookTrashPanel.classList.add('hidden');
    } else {
        bookTrashPanel.classList.remove('hidden');
        loadBookTrash();
    }
}

// 从主进程加载全局书籍回收站数据（实时显示，无需重新打开）
async function loadBookTrash() {
    try {
        const result = await api.getBookTrash();
        if (result && result.success) {
            bookTrashItems = result.items || [];
            // 清理已不存在的选中项
            bookTrashSelectedIds = new Set(Array.from(bookTrashSelectedIds).filter(id => bookTrashItems.some(i => i.id === id)));
            renderBookTrashList();
        }
    } catch (e) {
        showToast('加载书籍回收站失败: ' + e.message);
    }
}

document.getElementById('btnCloseBookTrash').addEventListener('click', () => {
    bookTrashPanel.classList.add('hidden');
});

document.getElementById('btnEmptyBookTrash').addEventListener('click', () => {
    if (bookTrashItems.length === 0) { showToast('书籍回收站为空'); return; }
    const html = `
        <div class="modal-header">
            <h2>🗑️ 清空书籍回收站</h2>
            <button type="button" class="close-btn">✕</button>
        </div>
        <div class="modal-body">
            <p style="font-size:16px; margin-bottom:8px;">确定要清空书籍回收站吗？</p>
            <p style="font-size:13px; color:#e74c3c; font-weight:500;">⚠️ 此操作不可恢复！</p>
        </div>
        <div class="modal-footer">
            <button class="btn-cancel" onclick="closeModal()">取消</button>
            <button id="confirmEmptyBookTrash" class="btn-delete">🗑️ 确认清空</button>
        </div>
    `;
    openModal(html);
    document.getElementById('confirmEmptyBookTrash').addEventListener('click', async () => {
        await api.emptyBookTrash();
        bookTrashItems = [];
        bookTrashSelectedIds.clear();
        closeModal();
        renderBookTrashList();
        showToast('已清空书籍回收站');
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
});

document.getElementById('btnBookTrashDeleteSelected').addEventListener('click', () => {
    if (bookTrashSelectedIds.size === 0) { showToast('请先选择要删除的小说'); return; }
    const html = `
        <div class="modal-header">
            <h2>🗑️ 永久删除选中小说</h2>
            <button type="button" class="close-btn">✕</button>
        </div>
        <div class="modal-body">
            <p style="font-size:16px; margin-bottom:8px;">确定要永久删除选中的 <strong>${bookTrashSelectedIds.size}</strong> 本小说吗？</p>
            <p style="font-size:13px; color:#e74c3c; font-weight:500;">⚠️ 此操作不可恢复！</p>
        </div>
        <div class="modal-footer">
            <button class="btn-cancel" onclick="closeModal()">取消</button>
            <button id="confirmBookTrashDeleteSelected" class="btn-delete">🗑️ 确认删除</button>
        </div>
    `;
    openModal(html);
    document.getElementById('confirmBookTrashDeleteSelected').addEventListener('click', async () => {
        const paths = bookTrashItems.filter(i => bookTrashSelectedIds.has(i.id)).map(i => i.filePath);
        await api.deleteBookTrash(paths);
        bookTrashItems = bookTrashItems.filter(i => !bookTrashSelectedIds.has(i.id));
        bookTrashSelectedIds.clear();
        closeModal();
        renderBookTrashList();
        showToast('已永久删除选中小说');
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
});

// 书籍回收站：恢复选中（批量恢复）
document.getElementById('btnBookTrashRestoreSelected').addEventListener('click', async () => {
    if (bookTrashSelectedIds.size === 0) { showToast('请先选择要恢复的小说'); return; }
    const ids = (bookTrashItems || []).filter(i => bookTrashSelectedIds.has(i.id)).map(i => i.id);
    let ok = 0, fail = 0;
    for (const id of ids) {
        const item = bookTrashItems.find(i => i.id === id);
        if (!item) continue;
        try {
            const result = await api.restoreBook(item.filePath);
            if (result.success) {
                bookTrashItems = bookTrashItems.filter(i => i.id !== id);
                bookTrashSelectedIds.delete(id);
                ok++;
            } else {
                fail++;
            }
        } catch (e) {
            fail++;
        }
    }
    renderBookTrashList();
    loadProjects();
    showToast(fail ? `已恢复 ${ok} 个，失败 ${fail} 个` : `已恢复 ${ok} 本小说`);
});

// ============================================================
// 新建词条
// ============================================================

btnAdd.addEventListener('click', () => {
    if (!currentContextId) { showToast('请先打开项目'); return; }
    const html = `
        <form id="createNodeForm">
            <div class="modal-header">
                <h2>📝 新建词条</h2>
                <button type="button" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <label>词条标题</label>
                <input type="text" id="newNodeTitle" placeholder="留空则创建「新节点」" autofocus />
                <label>摘要（可选）</label>
                <textarea id="newNodeSummary" placeholder="一句话描述"></textarea>
                <label>正文（可选）</label>
                <textarea id="newNodeContent" placeholder="详细内容"></textarea>
                <label>🔗 引用词条（可选，输入编号）</label>
                <input type="text" id="newNodeRef" placeholder="输入词条编号，如 1、2-1" />
                <div id="newNodeRefSuggest" style="display:none; max-height:120px; overflow-y:auto; border:1px solid var(--border-color); border-radius:8px; margin-top:4px; background:var(--bg-primary);"></div>
                <div id="newNodeRefInfo" style="font-size:12px; color:var(--text-secondary); margin-top:4px;"></div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn-cancel" onclick="closeModal()">取消</button>
                <button type="submit" class="btn-save">✨ 创建</button>
            </div>
        </form>
    `;
    openModal(html);
    const titleInput = document.getElementById('newNodeTitle');
    if (titleInput) setTimeout(() => titleInput.focus(), 100);
    const form = document.getElementById('createNodeForm');
    const refInput = document.getElementById('newNodeRef');
    const refSuggest = document.getElementById('newNodeRefSuggest');
    const refInfo = document.getElementById('newNodeRefInfo');
    let selectedRefId = null;

    // 引用编号输入：实时匹配
    refInput.addEventListener('input', () => {
        const q = refInput.value.trim();
        selectedRefId = null;
        refInfo.textContent = '';
        if (!q) {
            refSuggest.style.display = 'none';
            return;
        }
        const matches = currentProject.nodes.filter(n =>
            n.parentId !== '__root__' &&
            n.id !== currentContextId &&
            n.parentId !== currentContextId &&
            ((n.number && n.number.includes(q)) || (n.title && n.title.toLowerCase().includes(q.toLowerCase())))
        ).slice(0, 6);
        if (matches.length === 0) {
            refSuggest.style.display = 'none';
            refInfo.textContent = '未找到匹配词条';
            return;
        }
        refSuggest.innerHTML = '';
        matches.forEach(n => {
            const item = document.createElement('div');
            item.style.cssText = 'padding:6px 10px; cursor:pointer; font-size:13px; color:var(--text-primary); border-bottom:1px solid var(--border-color);';
            item.textContent = `${n.number || '?'} · ${getNodeTitle(n)}`;
            item.addEventListener('mouseenter', () => { item.style.background = 'var(--primary-light)'; });
            item.addEventListener('mouseleave', () => { item.style.background = ''; });
            item.addEventListener('click', () => {
                selectedRefId = n.id;
                refInput.value = n.number || '';
                refSuggest.style.display = 'none';
                refInfo.textContent = '✅ 已引用：' + getNodeTitle(n);
            });
            refSuggest.appendChild(item);
        });
        refSuggest.style.display = 'block';
    });

    form.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            form.dispatchEvent(new Event('submit'));
        }
    });
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        // 标题留空则默认"新节点"（快速创建）
        const title = document.getElementById('newNodeTitle').value.trim() || '新节点';
        const summary = document.getElementById('newNodeSummary').value.trim();
        const content = document.getElementById('newNodeContent').value;
        // 若未通过点击选择，尝试按编号精确匹配
        let refSource = null;
        if (selectedRefId) {
            refSource = currentProject.nodes.find(n => n.id === selectedRefId);
        } else {
            const q = refInput.value.trim();
            if (q) {
                refSource = currentProject.nodes.find(n =>
                    n.parentId !== '__root__' && n.number === q
                );
            }
        }
        const parentId = getDisplayParentId();  // 引用词条内新建的词条挂到源词条下（内容同步）
        const pos = getNextNodePosition(parentId);  // 自动网格排布
        pushUndo('新建词条');
        const newNode = {
            id: genId(),
            title: refSource ? refSource.title : title,
            summary: refSource ? refSource.summary : summary,
            content: refSource ? refSource.content : content,
            parentId: parentId,
            refId: refSource ? refSource.id : undefined,
            x: pos.x,
            y: pos.y,
            color: refSource ? '#e8ecff' : getColor(),
            number: '?'
        };
        const defText = getDefaultNodeTextColor();     // 设置里的「词条默认文字颜色」
        if (defText) newNode.textColor = defText;
        currentProject.nodes.push(newNode);
        closeModal();
        renderAll();
        showToast(refSource ? '已创建引用词条' : '已创建词条');
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
});



// ============================================================
// 编辑词条弹窗（小铅笔图标：类似新建，预填内容，保存时同步到源词条）
// ============================================================


// ============================================================
// 设置 / 重置（只影响当前这本书）
// 分项按钮，点一下即重置；每次重置前留一份快照，可点「恢复上次重置」还原（不依赖 Ctrl+Z）
// ============================================================
const NODE_GEN_COLORS = ['#e8f5e9','#e3f2fd','#fff3e0','#fce4ec','#f3e5f5','#e0f7fa','#f1f8e9','#fff8e1'];
const resetSnapshotStack = [];  // 最近若干次"重置前"的快照，可连续恢复多次（**只对记下它的那本书有效**）
const RESET_SNAPSHOT_MAX = 10;

// 快照属于哪本书：记进快照里，恢复前再核对一次 —— 重置记录绝不跨书
//   （以前这个栈是全局的、换书也不清：在 A 书点过重置 → 到 B 书点「恢复上次重置」，
//     会把 B 书的词条 / 背景换成 A 书重置前的样子 ✗）
function resetSnapshotOwner() { return currentFilePath || ''; }

// 清空（换书、打开书时调用：和撤销栈一样，运行期的历史不跟着走）
function clearResetSnapshots() {
    if (resetSnapshotStack.length) resetSnapshotStack.length = 0;
    updateResetRestoreBtn();
}

// 只留下属于当前这本书的记录，返回还剩几条（别的书留下的直接丢弃）
function pruneResetSnapshots() {
    const owner = resetSnapshotOwner();
    for (let i = resetSnapshotStack.length - 1; i >= 0; i--) {
        if (resetSnapshotStack[i].file !== owner) resetSnapshotStack.splice(i, 1);
    }
    return resetSnapshotStack.length;
}

function takeResetSnapshot(label) {
    resetSnapshotStack.push({
        label,
        file: resetSnapshotOwner(),   // 归属：这本书
        nodes: JSON.parse(JSON.stringify(currentProject.nodes)),
        connections: JSON.parse(JSON.stringify(currentProject.connections || [])),
        canvasBg: currentProject.canvasBg,
        canvasBgFit: currentProject.canvasBgFit,
        detailBg: currentProject.detailBg,
        detailBgFit: currentProject.detailBgFit,
        detailBgLink: currentProject.detailBgLink,
        detailTextColor: currentProject.detailTextColor,
        panelWidth: detailPanel ? detailPanel.offsetWidth : DETAIL_PANEL_DEFAULT_WIDTH
    });
    if (resetSnapshotStack.length > RESET_SNAPSHOT_MAX) resetSnapshotStack.shift();
}

function updateResetRestoreBtn() {
    const btn = document.getElementById('resetRestoreBtn');
    if (!btn) return;
    const n = pruneResetSnapshots();   // 先丢掉别的书留下的记录再显示（不然会出现"显示还有 N 次可恢复"、其实是别的书的）
    // 说明"最多保留 10 次"的机制
    btn.title = `每执行一次重置，都会先记录一份"重置前"的状态；可以连续回退，最多保留最近 ${RESET_SNAPSHOT_MAX} 次，超出后最早的记录会被自动丢弃。记录只属于当前这本书：换书 / 打开别的书时自动清空，不会把别的书的配置套过来。`;
    if (n > 0) {
        const top = resetSnapshotStack[n - 1];
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        btn.innerHTML = `↩ 恢复上次重置<span style="display:block; font-size:12px; color:var(--text-secondary);">还原到「${escapeHtml(top.label)}」之前 · 还可恢复 ${n} 次</span>`;
    } else {
        btn.disabled = true;
        btn.style.opacity = '0.45';
        btn.style.cursor = 'default';
        btn.innerHTML = `↩ 恢复上次重置<span style="display:block; font-size:12px; color:var(--text-secondary);">暂无可恢复的记录</span>`;
    }
}

function restoreLastReset() {
    if (!resetSnapshotStack.length) { showToast('没有可恢复的重置'); return; }
    // 防串书：只认当前这本书的记录（换书后残留的一律丢弃，绝不套到别的书上）
    const staleCount = resetSnapshotStack.length - pruneResetSnapshots();
    if (!resetSnapshotStack.length) {
        updateResetRestoreBtn();
        showToast(`这里有 ${staleCount} 条重置记录是属于别的书的，已经清掉了（重置记录不跨书）`, 3200);
        return;
    }
    const snap = resetSnapshotStack.pop();
    currentProject.nodes = snap.nodes;
    if (snap.connections) currentProject.connections = snap.connections;  // 连接线一起还原
    const restoreField = (key) => {
        if (snap[key] === undefined || snap[key] === null) delete currentProject[key];
        else currentProject[key] = snap[key];
    };
    restoreField('canvasBg');
    restoreField('canvasBgFit');
    restoreField('detailBg');
    restoreField('detailBgFit');
    restoreField('detailBgLink');
    restoreField('detailTextColor');
    if (snap.panelWidth && detailPanel) detailPanel.style.width = snap.panelWidth + 'px';
    applyCanvasBg();
    applyDetailBg();
    renderAll();
    updateResetRestoreBtn();
    const left = resetSnapshotStack.length;
    showToast(`已恢复到「${snap.label}」之前${left ? `（还可恢复 ${left} 次）` : ''}`, 2500);
}

// 初始化这本书：把**所有样式恢复成默认**（等同刚创建这本书时的样子）
//   + 清空回收站 + 取消所有连接线 + 清除所有模式/锁定 + 重新编号并整体排列
// 注意：不会删除任何正常词条（只清空回收站）
// opts.resetUi === false = 确认框里取消了「同时把全局设置恢复默认」：只重置这本书的数据
function initializeProject(opts) {
    if (!currentFilePath) return;
    const resetUi = !(opts && opts.resetUi === false);
    takeResetSnapshot('初始化这本书');
    pushUndo('初始化这本书');
    // 1) 词条样式全部清掉：文字颜色、背景图、显示方式；卡片颜色按系统配色重新分配
    // 注意：**引用别名不清** —— 那是用户手填的内容（引用词条显示成什么名字），不属于"样式"
    let genIdx = 0;
    currentProject.nodes.forEach(n => {
        delete n.textColor;
        delete n.bgImage;
        delete n.bgFit;
        delete n.bgTransparent;    // 卡片底色透明也一起恢复默认
        // delete n.alias;   // ← 以前初始化会把引用别名一起清掉，现在保留（用户手填的内容）
        if (n.parentId === '__root__') n.color = '#ffffff';
        else { n.color = NODE_GEN_COLORS[genIdx % NODE_GEN_COLORS.length]; genIdx++; }
    });
    // 2) 画布 / 详情页的背景与文字颜色全部恢复默认
    delete currentProject.canvasBg;
    delete currentProject.canvasBgFit;
    delete currentProject.detailBg;
    delete currentProject.detailTextColor;
    delete currentProject.detailBgFit;
    delete currentProject.detailBgLink;    // 「跟随画布背景」也要清掉，不然画布一有背景详情页又跟着变
    if (resetUi) {                         // 词条默认文字颜色是**全局**设置：跟"全局设置要不要一起回默认"一起走
        setDefaultNodeTextColor('');
        syncDefaultColorInputs();
    }
    currentProject.trash = [];          // 清空回收站（里面的词条会被永久删除）
    currentProject.connections = [];    // 取消所有连接线
    currentProject.nodes.forEach(n => { delete n.layoutLocked; });  // 解除所有"内部布局锁定"（📌）
    // 3) 全局设置（对所有书生效的那些）也一起回默认 —— 除非确认框里取消了勾选
    if (resetUi) {
        setDetailWidth(DETAIL_PANEL_DEFAULT_WIDTH);   // 详情页宽度
        setSaveInterval(1500);                        // 自动保存间隔
        setNodeBgFit('cover');                        // 词条背景图默认显示方式
        setPastePosMode('mouse');                     // 粘贴位置（鼠标位置）
        setAutoSaveEnabled(true);                     // 自动保存开关（开启）
        applyDarkMode(false);                         // 主题（浅色）—— 要"回默认"就一起回，别一半回一半不回
        cropSetLock(true, true);                      // 🔒 锁定裁剪框（锁定）；silent：提示统一由下面那条「已初始化全部配置」给
        if (settingsPanelRefresh) { try { settingsPanelRefresh(); } catch (e) {} }
    }
    detailScrollMap.clear();
    lastDetailSelectedId = null;
    resetModes();                       // 清除多选 / 连接等模式
    isLockedState = false;
    if (currentFilePath) bookLockState.set(currentFilePath, false);
    document.body.classList.remove('locked');
    const lockBtn = document.getElementById('btnLock');
    if (lockBtn) lockBtn.textContent = '🔓';
    selectedIds.clear();
    applyCanvasBg();
    applyDetailBg();
    updateAllNumbers();                 // 重新编号（对所有层级生效）
    renderAll();
    autoArrangeAll(true);               // 递归排列整本书所有层级
    updateResetRestoreBtn();
    showToast('已初始化全部配置', 2600);
    offerCacheCleanupAfterInit();       // 顺手问一次要不要清理已经没人引用的背景图（没有就什么都不发生）
}

function openResetModal() {
    // 判断"当前是否正处在书库页"：
    // 注意不能只看 currentFilePath——退出书籍回书库页后它仍有值（用于其他逻辑），
    // 所以要同时确认编辑器视图是可见的
    const hasBook = inBookView();     // 在书库页 / 在书里（很多"与书相关"的刷新只在书里做）
    const connCount = hasBook ? (currentProject.connections || []).length : 0;
    const html = `
        <div class="modal-header">
            <h2>⚙️ ${hasBook ? '设置 / 重置' : '设置'}</h2>
            <button type="button" class="close-btn">✕</button>
        </div>
        <div class="modal-body">
            ${hasBook ? '' : `<p style="font-size:12px; color:var(--text-secondary); margin-bottom:12px; line-height:1.6;">当前在书库页。备份、清理、重置这些<b>针对某一本书</b>的功能，需要先打开一本书。</p>`}
            <!-- 🖥️ 全局设置：对所有书都生效的界面偏好（和"这本书的数据"分开）。默认收起，别一打开就怕一堆 -->
            <details id="globalSettingsGroup" style="margin-bottom:16px;">
                <summary style="cursor:pointer; font-size:15px; font-weight:700; color:var(--text-primary);">
                    🖥️ 全局设置 · 对所有书生效
                    <span id="gsSummaryText" style="display:block; font-size:12px; font-weight:400; color:var(--text-secondary); margin-top:4px; line-height:1.6;"></span>
                </summary>
                <div style="padding-top:10px;">
                    <div style="font-size:12px; color:var(--text-secondary); line-height:1.6; margin-bottom:12px;">
                        下面这些<b>改一次、每本书都跟着变</b>（不是每本书一份）。点「恢复默认」只动设置本身，<b>不会碰任何书的内容</b>。
                    </div>
                    <!-- 顺序和收起时那行"当前值"小字（globalSettingsSummary）保持一致：自动保存 → 主题 → …… -->
                    <!-- 自动保存（开关 + 间隔） -->
                    <div class="gs-row" style="margin-bottom:6px;">
                        <span class="gs-name">自动保存</span>
                        <span class="gs-ctrl">
                            <span id="autoSaveSwitchLabel" class="gs-val"></span>
                            <label class="switch" title="自动保存开关：关掉后不再自动写盘，只有你按 Ctrl+S 或点工具栏 💾 才保存">
                                <input type="checkbox" id="autoSaveSwitch" />
                                <span class="track"></span>
                                <span class="knob"></span>
                            </label>
                            <button type="button" id="gsAutoSaveReset" class="btn-cancel btn-mini" title="恢复成「开 + 1.5 秒」">恢复默认</button>
                        </span>
                    </div>
                    <div class="gs-name" style="margin-bottom:6px;">自动保存间隔</div>
                    <div id="saveIntervalGroup" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:6px;"></div>
                    <div id="autoSaveHint" style="font-size:12px; color:var(--text-secondary); margin-bottom:14px; line-height:1.6;"></div>
                    <!-- 主题 -->
                    <div class="gs-row" style="margin-bottom:14px;">
                        <span class="gs-name">🌙 深色模式</span>
                        <span class="gs-ctrl">
                            <span id="gsDarkLabel" class="gs-val"></span>
                            <label class="switch" title="深色 / 浅色主题（标题栏右上角的 ☀️/🌙 就是同一个开关）">
                                <input type="checkbox" id="gsDarkSwitch" />
                                <span class="track"></span>
                                <span class="knob"></span>
                            </label>
                            <button type="button" id="gsDarkReset" class="btn-cancel btn-mini">恢复默认</button>
                        </span>
                    </div>
                    <!-- 词条背景图默认显示方式 -->
                    <div class="gs-row" style="margin-bottom:6px;">
                        <span class="gs-name">词条背景图默认显示方式</span>
                        <span class="gs-ctrl"><button type="button" id="gsBgFitReset" class="btn-cancel btn-mini">恢复默认</button></span>
                    </div>
                    <div id="nodeBgFitGroup" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px;"></div>
                    <!-- 词条粘贴位置 -->
                    <div class="gs-row" style="margin-bottom:6px;">
                        <span class="gs-name">词条粘贴位置</span>
                        <span class="gs-ctrl"><button type="button" id="gsPastePosReset" class="btn-cancel btn-mini">恢复默认</button></span>
                    </div>
                    <div id="pastePosGroup" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px;"></div>
                    <!-- 词条默认文字颜色 -->
                    <div class="gs-row" style="margin-bottom:6px;">
                        <span class="gs-name">词条默认文字颜色</span>
                        <span class="gs-ctrl"><button type="button" id="defaultNodeTextColorClear" class="btn-cancel btn-mini">恢复默认</button></span>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px;"><div id="defaultNodeTextColorPalette" style="display:flex; gap:6px; flex-wrap:wrap;"></div><input type="color" id="defaultNodeTextColor" title="选色（自定义颜色）" style="flex-shrink:0; width:34px; height:26px; border:1px solid var(--border-color); border-radius:6px; background:none; cursor:pointer;" /><input type="text" id="defaultNodeTextColorHex" class="color-hex" spellcheck="false" autocomplete="off" title="颜色值：可以直接改 / 粘贴，回车生效" style="flex-shrink:0;" /></div>
                    <div style="font-size:12px; color:var(--text-secondary); line-height:1.6; margin-bottom:14px;">没单独设过文字颜色的词条会用它；「🪟 初始化这本书」和「🎨 重置本书词条样式」也会把它恢复成默认</div>
                    <!-- 详情页宽度 -->
                    <div class="gs-row" style="margin-bottom:6px;">
                        <span class="gs-name" id="gsDetailWidthLabel">详情页宽度</span>
                        <span class="gs-ctrl"><button type="button" id="gsDetailWidthReset" class="btn-cancel btn-mini">恢复默认</button></span>
                    </div>
                    <div id="detailWidthGroup" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:6px;"></div>
                    <div style="font-size:12px; color:var(--text-secondary); line-height:1.6; margin-bottom:14px;">也可以拖详情页底部左侧的 ⇔ 自由调（200–600px），宽度会被记住</div>
                    <!-- 🔒 锁定裁剪框 -->
                    <div class="gs-row" style="margin-bottom:4px;">
                        <span class="gs-name">🔒 锁定裁剪框</span>
                        <span class="gs-ctrl">
                            <label class="switch" title="锁定：裁剪框只能框在图片里、图片也拖不出裁剪区（结果不会有透明块）；解除：框能框到图片外（那一块在结果里是透明的）">
                                <input type="checkbox" id="gsCropLockSwitch" />
                                <span class="track"></span>
                                <span class="knob"></span>
                            </label>
                            <button type="button" id="gsCropLockReset" class="btn-cancel btn-mini">恢复默认</button>
                        </span>
                    </div>
                    <div style="font-size:12px; color:var(--text-secondary); line-height:1.6; margin-bottom:16px;">背景图✂️裁剪弹窗里的开关。默认锁定（裁剪框会限制在图片里，裁剪结果不会有透明块）</div>
                    <hr style="border:none; border-top:1px solid var(--border-color); margin:0 0 10px;" />
                    <button type="button" id="gsResetAll" class="btn-cancel" style="width:100%; text-align:left; padding:10px 14px; line-height:1.5; color:#e74c3c;">
                        ↩ 恢复全部默认设置
                        <span style="display:block; font-size:12px; color:var(--text-secondary);">上面这些一次全回默认；只动设置，任何书的内容都不碰</span>
                    </button>
                    <button type="button" id="gsOpenHelp" class="btn-cancel" style="width:100%; text-align:left; padding:10px 14px; line-height:1.5; margin-top:10px;">
                        ❓ 哪些是全局的 / 哪些是每本书的
                        <span style="display:block; font-size:12px; color:var(--text-secondary);">打开帮助里的「🖥️ 全局设置与初始化」一节</span>
                    </button>
                </div>
            </details>
            ${hasBook ? `
            <!-- 分界线：上面是「🖥️ 全局设置」（改一次、所有书通用），下面是"这本书 / 书库"的功能
                 （备份 / 清理缓存 / 重置这本书）—— 两个功能用一条线分开看 -->
            <hr style="border:none; border-top:1px solid var(--border-color); margin:2px 0 14px;" />
            <div style="display:flex; flex-direction:column; gap:10px;">
                <button type="button" id="backupNowBtn" class="btn-cancel" title="备份文件保存在程序目录的「小说库 → 备份」文件夹" style="text-align:left; padding:10px 14px; line-height:1.5;">
                    💾 立即备份当前书
                    <span style="display:block; font-size:12px; color:var(--text-secondary);">存到「小说库 / 备份」，文件名带时间戳</span>
                </button>
                <button type="button" id="cleanCacheBtn" class="btn-cancel" title="扫描整个书库（所有书 + 回收站），只删掉「任何书都没用到」的图片" style="text-align:left; padding:10px 14px; line-height:1.5;">
                    🧹 清理未引用的背景图片
                    <span id="cleanCacheInfo" style="display:block; font-size:12px; color:var(--text-secondary);">扫描整个书库，删掉任何书都没用到的图片（不会动正在用的）</span>
                </button>
                <button type="button" id="openCacheDirBtn" class="btn-cancel" title="在文件管理器里打开整个书库共用的「背景图片缓存」文件夹" style="text-align:left; padding:10px 14px; line-height:1.5;">
                    📂 查看缓存文件夹
                    <span style="display:block; font-size:12px; color:var(--text-secondary);">整个书库共用同一个缓存目录（在「小说库 / 背景图片缓存」）</span>
                </button>
            </div>
            <hr style="border:none; border-top:1px solid var(--border-color); margin:14px 0 10px;" />
            <!-- 这里只说"重置只动这本书"这件事本身；"哪些是全局的 / 哪两处会碰到全局"属于说明文档，
                 统一放帮助 →「🖥️ 全局设置与初始化」（面板里不再铺一段说明书，只留各按钮自己的小字） -->
            <p id="resetScopeNote" style="font-size:13px; color:var(--text-secondary); margin-bottom:12px; line-height:1.6;">
                重置与初始化<b>只影响当前这本书</b>，点一下立即重置。<br>
                重置后可用下方<b>「恢复上次重置」</b>还原（只保留最近一次重置之前的状态）。
            </p>
            <div style="display:flex; flex-direction:column; gap:10px;">
                <button type="button" id="resetNodeStyles" class="btn-cancel" style="text-align:left; padding:10px 14px; line-height:1.5;">
                    🎨 重置本书词条样式
                    <span style="display:block; font-size:12px; color:var(--text-secondary);">按系统配色重新分配颜色（覆盖手动改的颜色），文字颜色与背景图片恢复默认；还会把<b>词条默认文字颜色</b>（全局设置）一起恢复默认</span>
                </button>
                <button type="button" id="resetDetailStyles" class="btn-cancel" style="text-align:left; padding:10px 14px; line-height:1.5;">
                    📄 重置本书详情页样式
                    <span style="display:block; font-size:12px; color:var(--text-secondary);">详情页的背景、文字颜色恢复默认；宽度是<b>全局设置</b>，这一步也会把它恢复成 400px（所有书共用）</span>
                </button>
                <hr style="border:none; border-top:1px solid var(--border-color); margin:4px 0;" />
                <button type="button" id="clearConnectionsBtn" class="btn-cancel" title="删除这本书里的所有连接线（可恢复）" style="text-align:left; padding:10px 14px; line-height:1.5;">
                    🔗 清空所有连接线
                    <span style="display:block; font-size:12px; color:var(--text-secondary);">当前共 ${connCount} 条 · 词条本身不受影响（可恢复）</span>
                </button>
                <hr style="border:none; border-top:1px solid var(--border-color); margin:4px 0;" />
                <button type="button" id="initProjectBtn" class="btn-cancel" style="text-align:left; padding:10px 14px; line-height:1.5; color:#e74c3c;" title="把这本书恢复到刚打开时的状态">
                    🪟 初始化这本书
                    <span style="display:block; font-size:12px; color:var(--text-secondary);">样式与详情页回到刚打开时、清空回收站、取消所有连接线、清除各种模式、重新编号并整体排列（正常词条不会删除）；下一步能勾选要不要连「全局设置」一起恢复默认</span>
                </button>
                <hr style="border:none; border-top:1px solid var(--border-color); margin:4px 0;" />
                <button type="button" id="resetRestoreBtn" class="btn-cancel" style="text-align:left; padding:10px 14px; line-height:1.5;"></button>
            </div>` : ''}
        </div>
        <div class="modal-footer">
            <button type="button" class="btn-cancel" onclick="closeModal()">关闭</button>
        </div>
    `;
    openModal(html, { plain: true, top: true });   // 这份设置面板一律贴偏上出现（展开「🖥️ 全局设置」只往下长、顶边不动）；
                                                   // ⚠ top 是"按次"传的：只有这份面板带 .top，改名 / 帮助 / 确认框都不受影响
    document.querySelector('.close-btn').addEventListener('click', closeModal);
    updateResetRestoreBtn();
    const bind = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', fn); };
    // 自动保存间隔：一排按钮平铺（点一下即生效；无下拉，不会被弹窗裁剪、也不会顶动弹窗内容）
    const siGroup = document.getElementById('saveIntervalGroup');
    const renderSiGroup = () => {
        if (!siGroup) return;
        siGroup.innerHTML = SAVE_INTERVAL_OPTIONS.map(o => {
            const active = (o.v === saveIntervalMs);
            return `<button type="button" data-v="${o.v}" title="${o.label}" style="flex:1 1 88px; padding:8px 10px; border:1px solid ${active ? 'var(--primary)' : 'var(--border-color)'}; border-radius:10px; background:${active ? 'var(--primary-light)' : 'var(--bg-primary)'}; color:${active ? 'var(--primary)' : 'var(--text-primary)'}; font-size:13px; cursor:pointer; ${active ? 'font-weight:600;' : ''}">${o.short}</button>`;
        }).join('');
    };
    renderSiGroup();
    if (siGroup) {
        siGroup.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-v]');
            if (!btn) return;
            const v = parseInt(btn.dataset.v, 10);
            if (!Number.isFinite(v)) return;
            setSaveInterval(v);
            renderSiGroup();
            renderGlobalSettingsSummary();
            showToast(v < 1000 ? `自动保存间隔：${v} 毫秒` : `自动保存间隔：${v / 1000} 秒`, 1600);
        });
    }
    // 自动保存开关（就是上面「自动保存间隔」那一行右边的小开关）；关闭时把间隔按钮整排置灰，表示当前不生效
    const asSwitch = document.getElementById('autoSaveSwitch');
    const asSwitchLabel = document.getElementById('autoSaveSwitchLabel');
    const asHint = document.getElementById('autoSaveHint');
    const renderAsGroup = () => {
        if (asSwitch) asSwitch.checked = !!autoSaveEnabled;
        if (asSwitchLabel) asSwitchLabel.textContent = autoSaveEnabled ? '开' : '关';   // 左边那行名字就是「自动保存」，这里只报状态
        // 关闭自动保存时，上面的"自动保存间隔"整排置灰（点不动，提示它当前不生效）
        if (siGroup) {
            siGroup.style.opacity = autoSaveEnabled ? '1' : '0.45';
            siGroup.style.pointerEvents = autoSaveEnabled ? 'auto' : 'none';
            siGroup.title = autoSaveEnabled ? '' : '自动保存已关闭，这里的间隔暂时不生效';
        }
        if (asHint) {
            asHint.textContent = autoSaveEnabled
                ? '改动后按上面的间隔自动保存；书名后面的 ● 表示还没保存（保存后消失）'
                : '已关闭自动保存：不会自动写盘，按 Ctrl+S 或点工具栏 💾 才保存。退出项目 / 关闭软件时，若还有没保存的改动，会先弹窗问你要不要保存（点右上角 ✕ 关窗口也一样）';
        }
    };
    renderAsGroup();
    if (asSwitch) {
        asSwitch.addEventListener('change', () => {
            setAutoSaveEnabled(asSwitch.checked);
            renderAsGroup();
            renderGlobalSettingsSummary();
            showToast(autoSaveEnabled ? '已开启自动保存' : '已关闭自动保存：按 Ctrl+S 或点 💾 手动保存', 2200);
        });
    }
    // 词条背景图显示方式（一排按钮：铺满裁切 / 完整显示 / 拉伸填充）
    const bgFitGroup = document.getElementById('nodeBgFitGroup');
    const renderBgFitGroup = () => {
        if (!bgFitGroup) return;
        bgFitGroup.innerHTML = NODE_BG_FIT_OPTIONS.map(o => {
            const active = (o.v === nodeBgFit);
            return `<button type="button" data-v="${o.v}" title="${o.label}" style="flex:1 1 88px; padding:8px 10px; border:1px solid ${active ? 'var(--primary)' : 'var(--border-color)'}; border-radius:10px; background:${active ? 'var(--primary-light)' : 'var(--bg-primary)'}; color:${active ? 'var(--primary)' : 'var(--text-primary)'}; font-size:13px; cursor:pointer; ${active ? 'font-weight:600;' : ''}">${o.short}</button>`;
        }).join('');
    };
    renderBgFitGroup();
    if (bgFitGroup) {
        bgFitGroup.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-v]');
            if (!btn) return;
            setNodeBgFit(btn.dataset.v);
            renderBgFitGroup();
            if (inBookView()) renderCanvas();      // 全局设置：书库页里改也行，只是没有画布可刷
            renderGlobalSettingsSummary();
            showToast(`背景显示：${btn.textContent}`, 1600);
        });
    }
    // 「默认值」里的两个默认文字颜色
    const defNodeColorEl = document.getElementById('defaultNodeTextColor');
    syncDefaultColorInputs();
    if (defNodeColorEl) {
        defNodeColorEl.addEventListener('change', () => {
            setDefaultNodeTextColor(defNodeColorEl.value);
            if (inBookView()) { renderCanvas(); scheduleSave(); }   // 全局设置：书库页里改也行（没画布可刷就不刷）
        });
        // 旁边那个颜色值输入框（能选中/复制/粘贴，回车生效）→ 改它等于改这个取色器
        bindColorHexInput(document.getElementById('defaultNodeTextColorHex'), defNodeColorEl);
        // 拖动取色器时，把它同步到输入框里
        defNodeColorEl.addEventListener('input', () => {
            const h = document.getElementById('defaultNodeTextColorHex');
            if (h) h.value = defNodeColorEl.value;
        });
    }
    const defNodeClearEl = document.getElementById('defaultNodeTextColorClear');
    if (defNodeClearEl) {
        defNodeClearEl.addEventListener('click', () => {
            setDefaultNodeTextColor('');
            syncDefaultColorInputs();
            if (inBookView()) { renderCanvas(); scheduleSave(); }
        });
    }
    // 默认文字颜色：给了几个常用色块，点一下就设成它
    const buildDefaultColorPalette = (hostId, setter, after) => {
        const host = document.getElementById(hostId);
        if (!host) return;
        const colors = ['#1a1a2e', '#000000', '#ffffff', '#666666', '#e74c3c', '#5b7cfa'];
        host.innerHTML = colors.map(c => `<button type="button" data-c="${c}" title="${c}" style="width:24px; height:24px; border-radius:6px; border:1px solid var(--border-color); background:${c}; cursor:pointer;"></button>`).join('');
        host.addEventListener('click', (e) => {
            const b = (e.target && e.target.closest) ? e.target.closest('[data-c]') : null;
            if (!b) return;
            setter(b.dataset.c);
            syncDefaultColorInputs();
            after();
        });
    };
    buildDefaultColorPalette('defaultNodeTextColorPalette', setDefaultNodeTextColor, () => { if (inBookView()) { renderCanvas(); scheduleSave(); } });
    // 粘贴位置（一排按钮：鼠标位置 / 最下方）
    const pastePosGroup = document.getElementById('pastePosGroup');
    const renderPastePosGroup = () => {
        if (!pastePosGroup) return;
        pastePosGroup.innerHTML = PASTE_POS_OPTIONS.map(o => {
            const active = (o.v === pastePosMode);
            return `<button type="button" data-v="${o.v}" title="${o.label}" style="flex:1 1 88px; padding:8px 10px; border:1px solid ${active ? 'var(--primary)' : 'var(--border-color)'}; border-radius:10px; background:${active ? 'var(--primary-light)' : 'var(--bg-primary)'}; color:${active ? 'var(--primary)' : 'var(--text-primary)'}; font-size:13px; cursor:pointer; ${active ? 'font-weight:600;' : ''}">${o.short}</button>`;
        }).join('');
    };
    renderPastePosGroup();
    if (pastePosGroup) {
        pastePosGroup.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-v]');
            if (!btn) return;
            setPastePosMode(btn.dataset.v);
            renderPastePosGroup();
            renderGlobalSettingsSummary();
            showToast(`粘贴位置：${btn.textContent}`, 1800);
        });
    }
    // 🌙 深色模式（标题栏右上角的 ☀️/🌙 就是同一个开关，这里只是"也能在设置里改"）
    const gsDarkSwitch = document.getElementById('gsDarkSwitch');
    const gsDarkLabel = document.getElementById('gsDarkLabel');
    const renderDarkRow = () => {
        const dark = document.body.classList.contains('dark');
        if (gsDarkSwitch) gsDarkSwitch.checked = dark;
        if (gsDarkLabel) gsDarkLabel.textContent = dark ? '深色' : '浅色';
    };
    renderDarkRow();
    if (gsDarkSwitch) {
        gsDarkSwitch.addEventListener('change', () => {
            applyDarkMode(gsDarkSwitch.checked);
            renderDarkRow();
            renderGlobalSettingsSummary();
        });
    }
    bind('gsDarkReset', () => {
        applyDarkMode(GLOBAL_SETTINGS_DEFAULT.dark);
        renderDarkRow();
        renderGlobalSettingsSummary();
        showToast('主题已恢复默认（浅色）', 1600);
    });
    // 详情页宽度：一排预设（也能拖详情页底部左侧的手柄自由调）
    const dwGroup = document.getElementById('detailWidthGroup');
    const dwLabel = document.getElementById('gsDetailWidthLabel');
    const renderDetailWidthGroup = () => {
        const cur = (detailPanel && detailPanel.offsetWidth) ? detailPanel.offsetWidth : DETAIL_PANEL_DEFAULT_WIDTH;
        if (dwLabel) dwLabel.textContent = `详情页宽度（当前 ${cur}px）`;
        if (!dwGroup) return;
        dwGroup.innerHTML = DETAIL_WIDTH_PRESETS.map(o => {
            const active = (Math.abs(o.v - cur) <= 2);
            return `<button type="button" data-v="${o.v}" title="把详情页宽度设成 ${o.v}px（所有书共用）" style="flex:1 1 88px; padding:8px 10px; border:1px solid ${active ? 'var(--primary)' : 'var(--border-color)'}; border-radius:10px; background:${active ? 'var(--primary-light)' : 'var(--bg-primary)'}; color:${active ? 'var(--primary)' : 'var(--text-primary)'}; font-size:13px; cursor:pointer; ${active ? 'font-weight:600;' : ''}">${o.short}</button>`;
        }).join('');
    };
    renderDetailWidthGroup();
    if (dwGroup) {
        dwGroup.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-v]');
            if (!btn) return;
            const v = parseInt(btn.dataset.v, 10);
            if (!Number.isFinite(v)) return;
            setDetailWidth(v);
            renderDetailWidthGroup();
            renderGlobalSettingsSummary();
            showToast(`详情页宽度：${v}px`, 1600);
        });
    }
    bind('gsDetailWidthReset', () => {
        setDetailWidth(GLOBAL_SETTINGS_DEFAULT.detailWidth);
        renderDetailWidthGroup();
        renderGlobalSettingsSummary();
        showToast('详情页宽度已恢复默认（400px）', 1800);
    });
    // 🔒 锁定裁剪框（就是 ✂️ 裁剪弹窗右侧那个开关；cropSetLock 会顺手同步那边的勾选状态）
    const gsCropLockSwitch = document.getElementById('gsCropLockSwitch');
    const renderCropLockRow = () => { if (gsCropLockSwitch) gsCropLockSwitch.checked = !!cropLock; };
    renderCropLockRow();
    if (gsCropLockSwitch) {
        gsCropLockSwitch.addEventListener('change', () => {
            cropSetLock(gsCropLockSwitch.checked);   // 带提示音（toast），和裁剪弹窗里操作完全一样
            renderCropLockRow();
            renderGlobalSettingsSummary();
        });
    }
    bind('gsCropLockReset', () => {
        cropSetLock(GLOBAL_SETTINGS_DEFAULT.cropLock, true);
        renderCropLockRow();
        renderGlobalSettingsSummary();
        showToast('🔒 锁定裁剪框已恢复默认（锁定）', 1800);
    });
    // 逐项「恢复默认」
    bind('gsAutoSaveReset', () => {
        setAutoSaveEnabled(GLOBAL_SETTINGS_DEFAULT.autoSave);
        setSaveInterval(GLOBAL_SETTINGS_DEFAULT.saveInterval);
        renderAsGroup();
        renderSiGroup();
        renderGlobalSettingsSummary();
        showToast('自动保存已恢复默认（开 · 1.5 秒）', 2000);
    });
    bind('gsBgFitReset', () => {
        setNodeBgFit(GLOBAL_SETTINGS_DEFAULT.bgFit);
        renderBgFitGroup();
        if (inBookView()) renderCanvas();
        renderGlobalSettingsSummary();
        showToast('背景显示方式已恢复默认（铺满裁切）', 2000);
    });
    bind('gsPastePosReset', () => {
        setPastePosMode(GLOBAL_SETTINGS_DEFAULT.pastePos);
        renderPastePosGroup();
        renderGlobalSettingsSummary();
        showToast('粘贴位置已恢复默认（鼠标位置）', 2000);
    });
    // 「↩ 恢复全部默认设置」：只动设置、不碰任何书，所以确认一下就行（不用像清理图片那样先扫库）
    bind('gsResetAll', () => {
        openModal(`
            <div class="modal-header">
                <h2>↩ 恢复全部默认设置</h2>
                <button type="button" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <p style="font-size:14px; line-height:1.8; margin-bottom:10px;">把「🖥️ 全局设置」里这些一次全恢复默认：</p>
                <p style="font-size:13px; color:var(--text-secondary); line-height:1.9; padding-left:4px;">
                    自动保存（开 · 1.5 秒）· 主题（浅色）· 词条背景图默认显示方式（铺满裁切）·<br>
                    词条粘贴位置（鼠标位置）· 词条默认文字颜色（默认）· 详情页宽度（400px）·<br>
                    🔒 锁定裁剪框（锁定）
                </p>
                <p style="font-size:13px; color:var(--text-secondary); line-height:1.8; margin-top:12px;">✅ 这些是<b>对所有书生效的设置</b>，恢复默认<b>不会改动任何一本书的内容</b>。</p>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn-cancel" onclick="closeModal()">取消</button>
                <button type="button" id="confirmGsResetAll" class="btn-delete">确认恢复默认</button>
            </div>
        `, { plain: true, backToSettings: true });
        document.querySelector('.close-btn').addEventListener('click', closeModal);
        document.getElementById('confirmGsResetAll').addEventListener('click', () => {
            closeModal();     // 关掉后会自动回到设置面板
            resetAllGlobalSettings();
            showToast('全局设置已全部恢复默认', 2600);
        });
    });
    // ❓ 直接跳到帮助里对应的那一节（不用自己在帮助里翻）
    bind('gsOpenHelp', () => {
        closeModal();
        rememberHelpForJump();   // 先记住现场：关掉帮助时还原（和搜索一样不留痕，不会"下次打开还停在这一节"）
        openHelp();
        const box = document.getElementById('helpSearchInput');
        if (box && box.value) { box.value = ''; box.dispatchEvent(new Event('input')); }   // 清掉上次的搜索词，免得那一节被藏起来
        const sec = document.getElementById('helpGlobalSection');
        if (sec) {
            sec.open = true;
            try { sec.scrollIntoView({ block: 'start' }); } catch (e) {}
        }
    });
    // 把这一排渲染函数交出去：面板外（例如「恢复全部默认设置」）改完值后能回来刷新它
    settingsPanelRefresh = () => {
        renderDarkRow(); renderSiGroup(); renderAsGroup(); renderBgFitGroup(); renderPastePosGroup();
        renderDetailWidthGroup(); renderCropLockRow(); renderGlobalSettingsSummary();
    };
    renderGlobalSettingsSummary();   // 收起时标题下面那行"当前值"
    // 立即备份当前书
    bind('backupNowBtn', async () => {
        showSplash('正在备份…');     // 快的话你根本看不到它
        try {
            const r = await api.backupProject(currentProject);
            if (r && r.success) showToast('已备份到「小说库 / 备份」', 2600);
            else showToast('备份失败' + (r && r.error ? '：' + r.error : ''));
        } catch (e) { showToast('备份失败：' + e.message); }
        hideSplash();
    });
    // 清理未被引用的背景图片：扫整个书库（所有书 + 回收站），避免误删别的书在用的图
    bind('cleanCacheBtn', () => { openCleanCacheDialog(true); });
    // 打开缓存文件夹（缓存目录是所有书共用的那个）
    bind('openCacheDirBtn', async () => {
        try {
            if (api && api.openCacheFolder) await api.openCacheFolder();
            else showToast('功能不可用', 1500);
        } catch (e) {}
    });
    bind('resetNodeStyles', () => {
        if (!currentProject.nodes.length) { showToast('本书还没有词条'); return; }
        takeResetSnapshot('重置词条样式');
        pushUndo('重置词条样式');
        // ① 只动这本书的词条：把每个词条自己的文字颜色 / 背景图 / 背景图显示方式清掉。
        // ② 例外：「词条默认文字颜色」是**全局**设置（在 🖥️ 全局设置 里），按老习惯这里也把它一起清回默认
        //    —— 清完之后词条就按内置默认色显示（按钮下面那行小字、帮助里都写明了会碰到它）。
        // 关键：不要只删掉颜色（那样会全变成白色），而是按创建顺序重新分配系统配色，
        // 观感上就是"重新生成一遍"的彩色卡片
        const ordered = currentProject.nodes.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        ordered.forEach((n, i) => {
            delete n.textColor;
            delete n.bgImage;
            delete n.bgTransparent;
            delete n.bgFit;              // 词条自己的"背景图显示方式"也清掉：之后跟着 🖥️ 全局设置里那个默认走
            if (n.parentId === '__root__') { n.color = '#ffffff'; return; }
            n.color = NODE_GEN_COLORS[i % NODE_GEN_COLORS.length];
        });
        setDefaultNodeTextColor('');     // 全局：词条默认文字颜色 → 内置默认
        syncDefaultColorInputs();        // 设置面板开着的话，选色框同步成默认
        renderAll();
        updateResetRestoreBtn();
        if (settingsPanelRefresh) { try { settingsPanelRefresh(); } catch (e) {} }   // 标题下那行"当前值"跟着更新
        showToast('已重置词条样式（文字颜色与背景图回默认），可点「恢复上次重置」还原', 2600);
    });
    bind('resetDetailStyles', () => {
        takeResetSnapshot('重置详情页样式');
        pushUndo('重置详情页样式');
        // ① 只动这本书的详情页：背景、文字颜色、跟随开关。
        // ② 例外：「详情页宽度」是**全局**设置（在 🖥️ 全局设置 里），按老习惯这里也把它恢复成默认 400px
        //    （按钮下面那行小字、帮助里都写明了会碰到它）。
        delete currentProject.detailBg;
        delete currentProject.detailTextColor;
        delete currentProject.detailBgLink;    // 「跟随画布背景」也一起取消（否则只有背景被清、跟随还在）
        delete currentProject.detailBgFit;
        setDetailWidth(DETAIL_PANEL_DEFAULT_WIDTH);   // 全局：详情页宽度 → 默认 400px
        applyDetailBg();
        renderAll();
        updateResetRestoreBtn();
        if (settingsPanelRefresh) { try { settingsPanelRefresh(); } catch (e) {} }   // 宽度按钮与那行"当前值"跟着更新
        showToast('详情页样式已重置（背景与文字颜色回默认，宽度恢复 400px）', 2600);
    });
    // 清空所有连接线（只删连接线，不动词条）
    bind('clearConnectionsBtn', () => {
        const conns = currentProject.connections || [];
        if (!conns.length) { showToast('当前没有连接线'); return; }
        openModal(`
            <div class="modal-header">
                <h2>🔗 清空所有连接线</h2>
                <button type="button" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <p style="font-size:14px; line-height:1.8; margin-bottom:8px;">将删除这本书里的 <b>${conns.length}</b> 条连接线。</p>
                <p style="font-size:13px; color:var(--text-secondary); line-height:1.7;">✅ 词条本身不受影响。<br>执行后可用「恢复上次重置」还原。</p>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn-cancel" onclick="closeModal()">取消</button>
                <button type="button" id="confirmClearConnections" class="btn-delete">确认清空</button>
            </div>
        `, { plain: true, backToSettings: true });
        document.querySelector('.close-btn').addEventListener('click', closeModal);
        document.getElementById('confirmClearConnections').addEventListener('click', () => {
            closeModal();
            takeResetSnapshot('清空所有连接线');
            currentProject.connections = [];
            renderAll();
            updateResetRestoreBtn();
            showToast('连接线已清空', 2200);
        });
    });
    bind('resetRestoreBtn', restoreLastReset);
    // 初始化这本书（带二次确认；明确说明会清空回收站）
    bind('initProjectBtn', () => {
        const trashCount = (currentProject.trash || []).length;
        const connCount = (currentProject.connections || []).length;
        const html = `
            <div class="modal-header">
                <h2>🔄 初始化这本书</h2>
                <button type="button" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <p style="font-size:14px; line-height:1.8; margin-bottom:10px;">将执行以下操作（<b>下面这些只影响当前这本书</b>）：</p>
                <ul style="font-size:13px; color:var(--text-secondary); line-height:1.9; padding-left:20px;">
                    <li>重置画布及详情页配置</li>
                    <li><b style="color:#e74c3c;">清空词条回收站</b>：里面的 ${trashCount} 个词条会被永久删除</li>
                    <li>取消所有连接线（当前 ${connCount} 条）</li>
                    <li>清除当前所有模式（多选 / 连接 / 锁定等）</li>
                    <li>重新编号，并整体重新排列所有层级的词条</li>
                </ul>
                <label style="display:flex; align-items:flex-start; gap:8px; margin-top:12px; font-size:13px; line-height:1.7; cursor:pointer;">
                    <input type="checkbox" id="initResetUiChk" checked style="width:16px; height:16px; accent-color:var(--primary); margin-top:3px; flex-shrink:0;" />
                    <span>同时把<b>全局设置</b>恢复默认（这些<b>对所有书生效</b>，不只这一本）：自动保存（开 · 1.5 秒）、主题（浅色）、词条背景图默认显示方式（铺满裁切）、粘贴位置（鼠标位置）、词条默认文字颜色、详情页宽度（400px）、🔒 锁定裁剪框（锁定）
                    <span style="display:block; color:var(--text-secondary);">不想动它们就取消勾选 —— 那这次只重置这本书。以后也能随时在 ⚙️ 设置 →「🖥️ 全局设置」里单独恢复默认</span></span>
                </label>
                <p style="font-size:13px; color:var(--text-secondary); margin-top:12px; line-height:1.7;">✅ 不会删除正常词条。<br>执行后仍可用「恢复上次重置」还原（全局设置不在还原范围内）。<br>🧹 初始化后还会问一次：要不要顺手清理「已经没有任何书在用」的背景图（不清理也不影响使用）。</p>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn-cancel" onclick="closeModal()">取消</button>
                <button type="button" id="confirmInitProject" class="btn-delete">确认初始化</button>
            </div>
        `;
        openModal(html, { plain: true, backToSettings: true });
        document.querySelector('.close-btn').addEventListener('click', closeModal);
        document.getElementById('confirmInitProject').addEventListener('click', () => {
            const chk = document.getElementById('initResetUiChk');
            const resetUi = chk ? !!chk.checked : true;   // 勾选框状态：没勾就只重置这本书的数据
            closeModal();   // 关闭后会自动回到设置面板（刷新「恢复上次重置」状态）
            initializeProject({ resetUi });
        });
    });
}

// 锁定 / 解除「内部布局」：
// 锁定后，这个词条作为画布时的内部词条不会参与自动排列（缩放窗口、重置、排列全部等），
// 直接进入它、在外面看它都与普通词条一样。与工具栏的 🔒（交互锁：禁拖拽/跳转）是两个概念。
// scope: 'page'（右键画布空白 → 锁定本页） | 'inner'（右键词条 → 锁定内部）
function toggleLayoutLock(node, scope) {
    if (!node) return;
    pushUndo();
    const isPage = (scope === 'page');
    if (node.layoutLocked) {
        delete node.layoutLocked;
        showToast(`📌 已解除${isPage ? '本页' : '内部'}布局锁定`);
    } else {
        node.layoutLocked = true;
        showToast(isPage
            ? '📌 已锁定本页：本页词条不受自动排序影响'
            : '📌 已锁定内部：进入这个词条后，它内部的词条不会被自动排列打乱', 2800);
    }
    renderAll();
}

// 引用关系信息：引用词条显示「引用自哪个词条 + 源词条被引用次数」；源词条显示「被引用 N 次」
function buildRefInfoHtml(node) {
    if (!node) return '';
    const countRefs = (id) => currentProject.nodes.filter(n => n.refId === id).length;
    const line = (inner) => `<div style="font-size:13px; color:var(--text-secondary); margin-bottom:8px; line-height:1.6;">${inner}</div>`;
    const strong = (s) => `<strong style="color:var(--text-primary);">${s}</strong>`;
    if (isRefNode(node)) {
        const direct = currentProject.nodes.find(n => n.id === node.refId);
        if (!direct) return line('🔗 引用已失效（源词条已被删除）');
        // 源本身也可能是引用词条：沿引用链找到最终源（带防环保护）
        let realSrc = direct;
        const guard = new Set([node.id]);
        while (isRefNode(realSrc) && !guard.has(realSrc.id)) {
            guard.add(realSrc.id);
            const next = currentProject.nodes.find(n => n.id === realSrc.refId);
            if (!next) break;
            realSrc = next;
        }
        const cnt = countRefs(realSrc.id);
        // 这里显示的源词条标题限制 10 个字（超出加省略号）——只影响编辑弹窗里的这行说明
        const srcTitle = truncateText(realSrc.title || '未命名', 10);
        const label = `${escapeHtml(realSrc.number || '?')}「${escapeHtml(srcTitle)}」`;
        const via = (realSrc.id !== direct.id) ? `（经由 ${escapeHtml(direct.number || '?')}）` : '';
        return line(`🔗 引用自 ${strong(label)}${via} · 该词条被引用 ${strong(cnt)} 次`);
    }
    const cnt = countRefs(node.id);
    return cnt > 0 ? line(`🔗 被引用 ${strong(cnt)} 次`) : '';
}

function openEditNodeModal(node) {
    if (!node) return;
    const source = getNodeSource(node);
    const isRef = isRefNode(node);
    const title = source ? (source.title || '') : (node.title || '');
    const summary = source ? (source.summary || '') : (node.summary || '');
    const content = source ? (source.content || '') : (node.content || '');
    const childCount = (currentProject.nodes || []).filter(n => n.parentId === node.id).length;
    const refInfoHtml = buildRefInfoHtml(node);
    const html = `
        <form id="editNodeForm">
            <div class="modal-header">
                <h2>✎ 编辑词条${isRef ? '（引用）' : ''}</h2>
                <button type="button" class="close-btn">✕</button>
            </div>
            <div class="modal-body">
                <div style="font-size:13px; color:var(--text-secondary); margin-bottom:8px; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <button type="button" id="copyNodeNumberBtn" title="复制编号" style="background:var(--bg-primary); border:1px solid var(--border-color); border-radius:50%; width:24px; height:24px; padding:0; margin:0; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:12px; line-height:1; color:var(--text-primary); flex-shrink:0;">⧉</button>
                    <span>编号：${escapeHtml(node.number || '?')}</span>
                    ${childCount > 0 ? `<span style="opacity:0.75;">· 子词条 ${childCount} 个</span>` : ''}
                </div>
                ${refInfoHtml}
                ${isRef ? `<label>别名（可选，最多 20 字）</label>
                <input type="text" id="editNodeAlias" maxlength="20" value="${escapeHtml(node.alias || '')}" placeholder="留空则显示源词条的标题" />` : ''}
                <label>标题</label>
                <input type="text" id="editNodeTitle" value="${escapeHtml(title)}" autofocus />
                <label>摘要</label>
                <textarea id="editNodeSummary" placeholder="一句话描述">${escapeHtml(summary)}</textarea>
                <label>正文 <span id="editNodeContentCount" style="font-weight:400; font-size:12px; color:var(--text-secondary);"></span></label>
                <textarea id="editNodeContent" placeholder="详细内容">${escapeHtml(content)}</textarea>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn-cancel" onclick="closeModal()">取消</button>
                <button type="submit" class="btn-save">💾 保存</button>
            </div>
        </form>
    `;

    openModal(html);
    const copyNumBtn = document.getElementById('copyNodeNumberBtn');
    if (copyNumBtn) copyNumBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const num = String(node.number || '');
        copyToClipboard(num).then(() => showToast(`已复制编号：${num}`)).catch(() => showToast('复制失败'));
    });
    // 编辑弹窗里的正文字数（口径同详情页：标点算、换行/空格不算）
    const editContentArea = document.getElementById('editNodeContent');
    const editContentCountEl = document.getElementById('editNodeContentCount');
    const updateEditContentCount = () => {
        if (!editContentCountEl) return;
        const { withPunct, noPunct } = countText(editContentArea ? editContentArea.value : '');
        // 两个口径直接显示（不用系统悬停浮窗，避免飘到软件外面看不见）
        editContentCountEl.textContent = `${withPunct} 字 · 不含标点 ${noPunct}`;
    };
    updateEditContentCount();
    if (editContentArea) editContentArea.addEventListener('input', updateEditContentCount);
    const titleInput = document.getElementById('editNodeTitle');
    if (titleInput) setTimeout(() => {
        titleInput.focus();
        titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);  // 光标放到标题末尾
    }, 100);
    const form = document.getElementById('editNodeForm');
    form.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            form.dispatchEvent(new Event('submit'));
        }
    });
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const newTitle = document.getElementById('editNodeTitle').value.trim() || '未命名';
        const newSummary = document.getElementById('editNodeSummary').value.trim();
        const newContent = document.getElementById('editNodeContent').value;
        // 同步到源词条（引用词条则同步到被引用的源词条）
        if (source) {
            source.title = newTitle;
            source.summary = newSummary;
            source.content = newContent;
        } else {
            node.title = newTitle;
            node.summary = newSummary;
            node.content = newContent;
        }
        // 引用词条的"别名"：设了就优先显示（最多 10 字），留空则回到显示源标题
        if (isRef) {
            const aliasEl = document.getElementById('editNodeAlias');
            const a = aliasEl ? aliasEl.value.trim() : '';
            if (a) node.alias = a.slice(0, 20); else delete node.alias;
        }
        closeModal();
        renderAll();
        showToast('已保存');
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
}

// ============================================================
// 画布背景
// ============================================================


// 将本地文件路径转为可用的 file:// URL（处理 Windows 路径）
function toFileUrl(p) {
    if (!p) return '';
    if (/^file:\/\//i.test(p)) return p;
    if (/^https?:\/\//i.test(p)) return p;
    p = p.replace(/\\/g, '/');
    // 绝对路径（盘符 D:/xxx 或 /xxx）
    if (/^[A-Za-z]:\//.test(p)) return 'file:///' + p;
    if (p.startsWith('/')) return 'file://' + p;
    // 相对路径（背景图片缓存/xxx.png）：基于当前项目文件所在目录解析
    const dir = currentFilePath ? currentFilePath.replace(/\\/g, '/').replace(/[^/]+$/, '') : '';
    return 'file:///' + dir + p;
}

// 清除背景时删除不再被引用的缓存图片（仅相对路径、且位于「背景图片缓存」内的文件）
function deleteBgFileIfUnused(p) {
    if (!p || typeof p !== 'string') return;
    if (/^(file|https?):/i.test(p) || /^[A-Za-z]:[\\/]/.test(p)) return;  // 绝对路径/URL 不删（旧数据或外部图片）
    if (!p.replace(/\\/g, '/').startsWith('背景图片缓存/')) return;
    const stillUsed = currentProject.nodes.some(n => n.bgImage === p) ||
        currentProject.canvasBg === p ||
        currentProject.detailBg === p;
    if (stillUsed) return;
    try {
        if (api && api.deleteCacheImage) api.deleteCacheImage(p);
    } catch (e) {}
}

// 详情页「跟随画布背景」：把画布那张图铺到"画布 + 详情页"整块工作区上，
// 这样详情页看到的就是画布背景延伸过去的那一部分（左右连成一张图）
function applyLinkedBg() {
    const main = document.getElementById('mainArea');
    const wrap = document.getElementById('canvasWrapper');
    const on = !!currentProject.detailBgLink;
    const bg = currentProject.canvasBg;
    const active = on;        // 跟随时整块交给 mainArea（画布是默认背景时用画布的默认底色）
    if (main) {
        if (on && !bg) {                    // 跟随中 + 画布就是默认背景 → 整块用画布的默认底色（这样详情页才真跟着画布）
            main.style.background = 'var(--bg-primary)';
            main.style.backgroundImage = '';
            main.style.backgroundSize = '';
        } else if (on) {
            if (bg.startsWith('#')) {
                main.style.background = bg;
                main.style.backgroundImage = '';
            } else {
                main.style.background = '';
                main.style.backgroundImage = `url("${toFileUrl(bg)}")`;
                main.style.backgroundSize = nodeBgSizeCss(currentProject.canvasBgFit);   // 整块一起铺
                main.style.backgroundPosition = 'center';
                main.style.backgroundRepeat = 'no-repeat';
            }
        } else {
            main.style.background = '';
            main.style.backgroundImage = '';
            main.style.backgroundSize = '';
        }
    }
    if (wrap) wrap.style.background = active ? 'transparent' : 'var(--bg-primary)';
    if (active) {
        if (canvas) { canvas.style.background = 'transparent'; canvas.style.backgroundImage = ''; }
        if (detailPanel) { detailPanel.style.background = 'transparent'; detailPanel.style.backgroundImage = ''; }
    } else {
        // 关掉跟随（含重置、撤回）时，把画布自己的背景还原回来 ——
        // 不然画布会一直停在跟随时的"透明"状态，看起来就像画布背景被清掉了
        applyCanvasOwnBg();
    }
}

// 画布"自己"的背景（单独抽出来，给"跟随关掉后还原"用）
function applyCanvasOwnBg() {
    const bg = currentProject.canvasBg;
    if (!bg) {
        canvas.style.background = '';
        canvas.style.backgroundImage = '';
        return;
    }
    if (bg.startsWith('#')) {
        canvas.style.background = bg;
        canvas.style.backgroundImage = '';
    } else {
        canvas.style.background = '';
        canvas.style.backgroundImage = `url("${toFileUrl(bg)}")`;
        canvas.style.backgroundSize = nodeBgSizeCss(currentProject.canvasBgFit);   // 画布背景也支持 铺满/完整/拉伸
        canvas.style.backgroundPosition = 'center';
        canvas.style.backgroundRepeat = 'no-repeat';
    }
}

// 应用画布背景（统一处理颜色/图片）
function applyCanvasBg() {
    applyCanvasOwnBg();
    applyLinkedBg();
}

// 应用详情页背景（独立于画布背景；勾了「跟随画布背景」就整块交给 applyLinkedBg）
function applyDetailBg() {
    if (currentProject.detailBgLink) {
        // 跟随中：详情页自己不设背景。画布有背景时，由铺在"画布+详情页"整块上的那张图透过来；
        // 画布也是默认背景时，这里要恢复成默认 —— 这才是真的"跟着画布"（以前会留着上一次的背景）
        detailPanel.style.background = '';
        detailPanel.style.backgroundImage = '';
        applyLinkedBg();
        return;
    }
    const bg = currentProject.detailBg;
    if (!bg) {
        detailPanel.style.background = '';
        detailPanel.style.backgroundImage = '';
        applyLinkedBg();
        return;
    }
    if (bg.startsWith('#')) {
        detailPanel.style.background = bg;
        detailPanel.style.backgroundImage = '';
    } else {
        detailPanel.style.background = '';
        detailPanel.style.backgroundImage = `url("${toFileUrl(bg)}")`;
        detailPanel.style.backgroundSize = nodeBgSizeCss(currentProject.detailBgFit);   // 详情页背景也支持 铺满/完整/拉伸
        detailPanel.style.backgroundPosition = 'center';
        detailPanel.style.backgroundRepeat = 'no-repeat';
    }
    applyLinkedBg();
}

// ===== 背景图片缓存：统计 + 清理 =====
// 缓存目录是整个书库共用的（小说库/背景图片缓存），所以清理必须扫全库，
// 否则开着 A 书点清理会把只被 B 书引用的图片删掉。
async function refreshCacheInfo() {
    const els = [document.getElementById('colorPopupCacheInfo'), document.getElementById('detailBgCacheInfo')].filter(Boolean);
    if (!els.length || !api || !api.scanLibraryCache) return;
    let r = null;
    try { r = await api.scanLibraryCache(); } catch (e) { r = null; }
    if (!r || !r.success) { els.forEach(e => { e.textContent = '缓存信息读取失败'; }); return; }
    const files = r.files || [], unused = r.unused || [], missing = r.missing || [];
    const mb = files.reduce((s, f) => s + (f.size || 0), 0) / 1048576;
    const txt = `缓存 ${files.length} 张 · ${mb.toFixed(1)} MB`
        + (unused.length ? ` · 可清理 ${unused.length} 张` : '')
        + (missing.length ? ` · 失效 ${missing.length} 处` : '');
    els.forEach(e => { e.textContent = txt; });
}

// 清理弹窗：列出「没有书在用的图」（可删）+「失效引用」（只提示，不删）
// fromSettings = true 时才是从 ⚙️ 设置里开的（关掉后回到设置）；从背景图面板开的就别跳去设置
async function openCleanCacheDialog(fromSettings) {
    if (!api || !api.scanLibraryCache) { showToast('功能不可用', 1500); return; }
    let r = null;
    try { r = await api.scanLibraryCache(); } catch (e) { r = null; }
    if (!r || !r.success) { showToast('读取缓存失败' + (r && r.error ? '：' + r.error : ''), 2600); return; }
    const unused = r.unused || [], missing = r.missing || [], files = r.files || [];
    const mbAll = files.reduce((s, f) => s + (f.size || 0), 0) / 1048576;
    const mb = unused.reduce((s, f) => s + (f.size || 0), 0) / 1048576;
    const unusedList = unused.slice(0, 6).map(f => `<li>${escapeHtml(f.rel.replace('背景图片缓存/', ''))} <span style="opacity:0.7;">（${(f.size / 1024).toFixed(0)} KB）</span></li>`).join('');
    const moreUnused = unused.length > 6 ? `<li>…… 另外还有 ${unused.length - 6} 张</li>` : '';
    const missList = missing.slice(0, 6).map(m => `<li>${escapeHtml(m.rel.replace('背景图片缓存/', ''))} <span style="opacity:0.7;">（${escapeHtml(m.book || '')}${m.where ? ' · ' + escapeHtml(m.where) : ''}）</span></li>`).join('');
    const moreMiss = missing.length > 6 ? `<li>…… 另外还有 ${missing.length - 6} 处</li>` : '';
    const unusedBlock = unused.length
        ? `<p style="font-size:14px; margin-bottom:8px; line-height:1.7;">🧹 <b>${unused.length}</b> 张图片没有任何书在用（约 <b>${mb.toFixed(1)} MB</b>）：</p>
           <ul style="font-size:13px; color:var(--text-secondary); line-height:1.9; padding-left:20px; max-height:150px; overflow-y:auto; margin-bottom:10px;">${unusedList}${moreUnused}</ul>`
        : `<p style="font-size:14px; margin-bottom:10px; line-height:1.7;">✅ 没有多余图片（共 ${files.length} 张 · ${mbAll.toFixed(1)} MB）</p>`;
    const missBlock = missing.length
        ? `<p style="font-size:14px; margin:12px 0 8px; line-height:1.7;">⚠️ <b>${missing.length}</b> 处引用的图片已丢失：</p>
           <ul style="font-size:13px; color:var(--text-secondary); line-height:1.9; padding-left:20px; max-height:150px; overflow-y:auto; margin-bottom:10px;">${missList}${moreMiss}</ul>
           <p style="font-size:12px; color:var(--text-secondary); line-height:1.7;">这些位置显示不出背景，重新选一张图即可恢复（这里不会删东西）。</p>`
        : '';
    // 弹窗开着的时候，别让"点空白处关悬浮窗"的逻辑把下面的背景面板一起关掉
    suppressPopupClose = true;
    openModal(`
        <div class="modal-header">
            <h2>🧹 背景图片缓存</h2>
            <button type="button" class="close-btn">✕</button>
        </div>
        <div class="modal-body">
            ${unusedBlock}
            ${missBlock}
        </div>
        <div class="modal-footer">
            <button type="button" class="btn-cancel" onclick="closeModal()">关闭</button>
            ${unused.length ? `<button type="button" id="confirmCleanCache" class="btn-delete">确认删除这 ${unused.length} 张</button>` : ''}
        </div>
    `, {
        plain: true,
        backToSettings: !!fromSettings,
        onClose: () => { setTimeout(() => { suppressPopupClose = false; }, 0); }
    });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
    const okBtn = document.getElementById('confirmCleanCache');
    if (okBtn) {
        okBtn.addEventListener('click', async () => {
            closeModal();
            let done = 0;
            for (const f of unused) {
                try { const dr = await api.deleteCacheImage(f.rel); if (dr && dr.success) done++; } catch (e) {}
            }
            showToast(`已清理 ${done} 张图片，释放约 ${mb.toFixed(1)} MB`, 3000);
            refreshCacheInfo();
        });
    }
}

// 🪟 初始化之后顺手问一次「要不要清理没人引用的背景图」
// —— 初始化把词条 / 画布 / 详情页的背景引用都清掉了，这时候"没人用"的图最多；
//    只有真扫出东西才问（没有就不吭声），点「保留」什么都不做，和以前完全一样。
//    注意：删文件的范围是**整个书库**（所有书都没用到的才删），所以必须由人来点，不自动删。
async function offerCacheCleanupAfterInit() {
    if (!api || !api.scanLibraryCache) return;
    let r = null;
    try { r = await api.scanLibraryCache(); } catch (e) { r = null; }
    if (!r || !r.success) return;
    const unused = r.unused || [];
    if (!unused.length) return;                       // 没有可清理的：别打扰
    const n = unused.length;
    const mb = unused.reduce((s, f) => s + (f.size || 0), 0) / 1048576;
    openModal(`
        <div class="modal-header">
            <h2>🧹 顺手清理背景图片？</h2>
            <button type="button" class="close-btn">✕</button>
        </div>
        <div class="modal-body">
            <p style="font-size:14px; line-height:1.8; margin-bottom:8px;">初始化后，有 <b>${n}</b> 张背景图已经没有任何书在用了（约 <b>${mb.toFixed(1)} MB</b>）。</p>
            <p style="font-size:13px; color:var(--text-secondary); line-height:1.8;">只删这些没人引用的图，正在用的（含回收站里引用到的）一张都不动。<br>不清理也不影响任何功能，以后还能在 ⚙️ 设置里点「🧹 清理未引用的背景图片」。</p>
        </div>
        <div class="modal-footer">
            <button type="button" id="initCleanNo" class="btn-cancel">保留</button>
            <button type="button" id="initCleanYes" class="btn-delete">🧹 清理这 ${n} 张</button>
        </div>
    `, { plain: true, backToSettings: true });
    document.querySelector('.close-btn').addEventListener('click', closeModal);
    document.getElementById('initCleanNo').addEventListener('click', closeModal);
    document.getElementById('initCleanYes').addEventListener('click', async () => {
        closeModal();
        let done = 0;
        for (const f of unused) {
            try { const dr = await api.deleteCacheImage(f.rel); if (dr && dr.success) done++; } catch (e) {}
        }
        showToast(`已清理 ${done} 张图片，释放约 ${mb.toFixed(1)} MB`, 3000);
        refreshCacheInfo();
    });
}

// ============================================================
// 详情页背景浮动面板（可拖动、不阻塞交互；右键空白画布打开）
// ============================================================
const DETAIL_BG_COLORS = ['#ffffff','#f0f2f5','#1a1a2e','#2c3e50','#e8f5e9','#e3f2fd','#fff3e0','#fce4ec','#f3e5f5','#fbe9e7'];

let detailBgMode = 'bg';  // 'bg' 背景 | 'text' 文字颜色 | 'image' 背景图

// 刷新详情页的当前显示值（背景/文字/图片）
function updateDetailBgValue() {
    const isImage = (detailBgMode === 'image');
    // 「跟随画布背景」开关：同步状态；跟随中把下面的背景控件整片灰掉（统一去画布背景改）
    const linkChk = document.getElementById('detailBgLinkChk');
    const linkHint = document.getElementById('detailBgLinkHint');
    const linked = !!currentProject.detailBgLink;
    if (linkChk) linkChk.checked = linked;
    if (linkHint) linkHint.style.display = linked ? 'block' : 'none';
    // 图片页：隐藏颜色相关控件，只留图片按钮
    const colorTitle = document.getElementById('detailBgColorTitle');
    const colorsEl = document.getElementById('detailBgColors');
    const customLabel = document.getElementById('detailBgCustomLabel');
    const customRow = document.getElementById('detailBgCustomRow');
    const fitWrap = document.getElementById('detailBgFitWrap');
    const imageRow = document.getElementById('detailBgImageRow');
    if (colorTitle) colorTitle.style.display = isImage ? 'none' : 'block';
    if (colorsEl) colorsEl.style.display = isImage ? 'none' : 'flex';
    if (customLabel) customLabel.style.display = isImage ? 'none' : 'block';
    if (customRow) customRow.style.display = isImage ? 'none' : 'flex';
    if (fitWrap) fitWrap.style.display = isImage ? 'block' : 'none';
    // 「选择图片 / 清除」和以前一样一直在（颜色页也有），位置不变
    if (imageRow) imageRow.style.display = 'flex';
    // 「✂️ 裁剪 / 📂 缓存」只在「背景图」页出现（整行一起显隐；缓存靠右，和裁剪隔开一段）
    const toolRow2 = document.getElementById('detailBgToolRow');
    if (toolRow2) toolRow2.style.display = isImage ? 'flex' : 'none';
    const cropBtn2 = document.getElementById('btnCropDetailBg');
    if (cropBtn2) {
        const hasImg = !!(currentProject && currentProject.detailBg && !String(currentProject.detailBg).startsWith('#'));
        const canCrop = hasImg && !linked;
        cropBtn2.disabled = !canCrop;
        cropBtn2.style.opacity = canCrop ? '1' : '0.45';
        cropBtn2.style.cursor = canCrop ? 'pointer' : 'not-allowed';
        cropBtn2.title = linked
            ? '已跟随画布背景：要裁剪请去画布背景里裁（画布空白处右键 →「画布背景」）'
            : (hasImg
                ? '裁剪详情页背景图'
                : '详情页还没有背景图（先点「🖼️ 选择图片」）');
    }
    // 跟随中：颜色 / 图片 / 显示方式整片锁住（只留最上面的开关和「🧹 清理缓存」）
    [document.getElementById('detailBgTabs'), colorsEl, customLabel, customRow, fitWrap, imageRow]
        .forEach(el => {
            if (!el) return;
            el.style.opacity = linked ? '0.45' : '';
            el.style.pointerEvents = linked ? 'none' : '';
        });
    const bgTab = document.getElementById('detailBgTabBg');
    const textTab = document.getElementById('detailBgTabText');
    const imgTab = document.getElementById('detailBgTabImage');
    if (bgTab) bgTab.classList.toggle('primary', detailBgMode === 'bg');
    if (textTab) textTab.classList.toggle('primary', detailBgMode === 'text');
    if (imgTab) imgTab.classList.toggle('primary', isImage);
    if (isImage) { renderDetailBgFitBtns(); refreshCacheInfo(); return; }
    const cur = detailBgMode === 'text'
        ? (currentProject.detailTextColor || '#1a1a2e')
        : (currentProject.detailBg && currentProject.detailBg.startsWith('#') ? currentProject.detailBg : '#ffffff');
    const picker = document.getElementById('dbgColorPicker2');
    const hex = document.getElementById('dbgColorHex2');
    if (picker) picker.value = cur;
    if (hex) hex.value = cur;   // 现在这两个 id 是输入框（不是文字），要写 value
}

function openDetailBgPanel() {
    const panel = document.getElementById('detailBgPanel');
    if (!panel) return;
    detailBgMode = 'bg';
    // 渲染颜色块
    const colorsEl = document.getElementById('detailBgColors');
    if (colorsEl) {
        colorsEl.innerHTML = '';
        DETAIL_BG_COLORS.forEach(c => {
            const sw = document.createElement('div');
            sw.style.cssText = `width:32px; height:32px; border-radius:8px; background:${c}; border:2px solid var(--border-color); cursor:pointer; transition:var(--transition);`;
            sw.dataset.color = c;
            sw.addEventListener('click', () => {
                pushUndo('修改详情页颜色');
                if (detailBgMode === 'text') {
                    currentProject.detailTextColor = c;
                } else {
                    currentProject.detailBg = c;
                }
                applyDetailBg();
                renderDetailPanel();
                scheduleSave();
                showToast(detailBgMode === 'text' ? '详情文字颜色已更新' : '详情背景已更新');
            });
            colorsEl.appendChild(sw);
        });
    }
    updateDetailBgValue();
    panel.classList.remove('hidden');
    suppressPopupClose = true;
    setTimeout(() => { suppressPopupClose = false; }, 0);  // 当前点击冒泡结束后再允许关闭
    // 每次打开都回到固定位置（清除拖动留下的 left/top，恢复 CSS 默认位置）
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
}

// 详情页背景的显示方式按钮
function renderDetailBgFitBtns() {
    const wrap = document.getElementById('detailBgFitBtns');
    if (!wrap) return;
    const cur = currentProject.detailBgFit || nodeBgFit;
    wrap.innerHTML = NODE_BG_FIT_OPTIONS.map(o => {
        const active = (o.v === cur);
        return `<button type="button" data-dfit="${o.v}" title="${o.label}" class="dbg-btn${active ? ' primary' : ''}">${o.short}</button>`;
    }).join('');
}
const detailBgFitBtnsEl = document.getElementById('detailBgFitBtns');
if (detailBgFitBtnsEl) {
    detailBgFitBtnsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-dfit]');
        if (!btn) return;
        e.stopPropagation();   // 防止冒泡被误判为"点了面板外面"
        pushUndo();
        currentProject.detailBgFit = btn.dataset.dfit;
        applyDetailBg();
        renderDetailBgFitBtns();
        scheduleSave();
        showToast(`详情页背景显示方式：${btn.textContent}`, 1600);
    });
}

// 详情页背景/文字/图片模式切换
const detailBgTabBg = document.getElementById('detailBgTabBg');
const detailBgTabText = document.getElementById('detailBgTabText');
const detailBgTabImage = document.getElementById('detailBgTabImage');
if (detailBgTabBg) {
    detailBgTabBg.addEventListener('click', () => { detailBgMode = 'bg'; updateDetailBgValue(); });
}
if (detailBgTabText) {
    detailBgTabText.addEventListener('click', () => { detailBgMode = 'text'; updateDetailBgValue(); });
}
if (detailBgTabImage) {
    detailBgTabImage.addEventListener('click', () => { detailBgMode = 'image'; updateDetailBgValue(); });
}

function closeDetailBgPanel() {
    const panel = document.getElementById('detailBgPanel');
    if (panel) panel.classList.add('hidden');
}

// 面板头部拖动（不阻塞其他交互）
const detailBgHeader = document.getElementById('detailBgHeader');
const detailBgPanelEl = document.getElementById('detailBgPanel');
if (detailBgHeader && detailBgPanelEl) {
    detailBgHeader.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        const rect = detailBgPanelEl.getBoundingClientRect();
        const offX = e.clientX - rect.left;
        const offY = e.clientY - rect.top;
        const onMove = (ev) => {
            let nx = ev.clientX - offX;
            let ny = ev.clientY - offY;
            nx = Math.max(0, Math.min(nx, window.innerWidth - 60));
            ny = Math.max(0, Math.min(ny, window.innerHeight - 40));
            detailBgPanelEl.style.left = nx + 'px';
            detailBgPanelEl.style.top = ny + 'px';
            detailBgPanelEl.style.right = 'auto';
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

const btnCloseDetailBgPanel = document.getElementById('btnCloseDetailBgPanel');
if (btnCloseDetailBgPanel) {
    btnCloseDetailBgPanel.addEventListener('click', closeDetailBgPanel);
}

const dbgColorPicker2 = document.getElementById('dbgColorPicker2');
const dbgColorHex2 = document.getElementById('dbgColorHex2');
if (dbgColorPicker2) {
    dbgColorPicker2.addEventListener('input', () => {
        if (dbgColorHex2) dbgColorHex2.value = dbgColorPicker2.value;
    });
    dbgColorPicker2.addEventListener('change', () => {
        pushUndo('修改详情页颜色');
        if (detailBgMode === 'text') {
            currentProject.detailTextColor = dbgColorPicker2.value;
        } else {
            currentProject.detailBg = dbgColorPicker2.value;
        }
        applyDetailBg();
        renderDetailPanel();
        scheduleSave();
        showToast(detailBgMode === 'text' ? '详情文字颜色已更新' : '详情背景已更新');
    });
}

const btnSelectDetailBgImage2 = document.getElementById('btnSelectDetailBgImage2');
if (btnSelectDetailBgImage2) {
    btnSelectDetailBgImage2.addEventListener('click', async () => {
        suppressPopupClose = true;   // 选图期间（含文件对话框关闭后一小段）不要自动关掉面板
        try {
            const result = await api.selectImage();
            if (result && result.success) {
                pushUndo('修改详情页背景');
                currentProject.detailBg = result.filePath;
                applyDetailBg();
                renderDetailPanel();
                scheduleSave();
                detailBgMode = 'image';        // 选完自动切到「背景图」页，方便继续看/调整
                updateDetailBgValue();
                showToast('详情背景图片已设置');
            }
        } catch (e) {
            showToast('选择图片失败: ' + e.message);
        } finally {
            setTimeout(() => { suppressPopupClose = false; }, 400);
        }
    });
}

// 详情页背景「✂️ 框选裁剪」：裁完的图直接作为详情页新背景
const btnCropDetailBgEl = document.getElementById('btnCropDetailBg');
if (btnCropDetailBgEl) {
    btnCropDetailBgEl.addEventListener('click', () => {
        const cur = currentProject && currentProject.detailBg;
        if (!cur || String(cur).startsWith('#')) { showToast('详情页还没有背景图，先点「🖼️ 选择图片」'); return; }
        openCropModal(cur, (newRel) => {
            pushUndo('修改详情页背景');
            const oldBg = currentProject.detailBg;
            currentProject.detailBg = newRel;
            if (oldBg && oldBg !== newRel) deleteBgFileIfUnused(oldBg);
            applyDetailBg();
            renderDetailPanel();
            scheduleSave();
            detailBgMode = 'image';        // 裁完停在「背景图」页，方便继续看/调整
            updateDetailBgValue();
            showToast('✂️ 详情页背景已裁剪并应用');
        }, { target: { kind: 'detail' } });   // 比例里会多一个「详情页」＝ 详情页的实际比例
    });
}

const btnClearDetailBg2 = document.getElementById('btnClearDetailBg2');
if (btnClearDetailBg2) {
    btnClearDetailBg2.addEventListener('click', () => {
        pushUndo('清除详情页背景');
        if (detailBgMode === 'text') {
            delete currentProject.detailTextColor;
        } else {
            const oldDetailBg = currentProject.detailBg;
            currentProject.detailBg = null;
            if (oldDetailBg) deleteBgFileIfUnused(oldDetailBg);
        }
        applyDetailBg();
        renderDetailPanel();
        scheduleSave();
        showToast(detailBgMode === 'text' ? '已恢复默认文字颜色' : '已清除详情背景');
    });
}

// 详情页背景的「🧹 清理缓存」：面板里只做"看占用 + 清理"，打开文件夹挪到 ⚙️ 设置里了
const btnDetailBgCleanEl = document.getElementById('btnDetailBgCleanCache');
if (btnDetailBgCleanEl) {
    btnDetailBgCleanEl.addEventListener('click', () => { openCleanCacheDialog(); });
}

// 「跟随画布背景」：勾上 = 详情页整块用画布那张背景（画布 + 详情页连成一张，画布背景延伸过去）
const detailBgLinkChkEl = document.getElementById('detailBgLinkChk');
if (detailBgLinkChkEl) {
    detailBgLinkChkEl.addEventListener('change', () => {
        pushUndo();
        currentProject.detailBgLink = !!detailBgLinkChkEl.checked;
        applyCanvasBg();
        applyDetailBg();
        updateDetailBgValue();
        scheduleSave();
        showToast(currentProject.detailBgLink
            ? '已跟随画布背景'
            : '已取消跟随', 2000);
    });
}


// 右键菜单打开的画布背景：弹窗出现在鼠标点击位置（工具栏按钮已移除，保留此入口）
function openCanvasBgPopup(x, y) {
    openColorPopup('🎨 画布背景', currentProject.canvasBg && currentProject.canvasBg.startsWith('#') ? currentProject.canvasBg : '#f0f2f5', (val) => {
        pushUndo('修改画布背景');
        const oldBg = currentProject.canvasBg;
        currentProject.canvasBg = val;
        if (!val && oldBg) deleteBgFileIfUnused(oldBg);
        applyCanvasBg();
        scheduleSave();
        showToast(val ? '背景已更新' : '已清除背景');
    }, { showImage: true, x: x, y: y, fitScope: 'canvas' });
}

// ============================================================
// 通用颜色悬浮窗（词条/画布背景共用，可拖动、不阻塞交互）
// ============================================================
const COLOR_PRESETS = ['#ffffff','#e8f5e9','#e3f2fd','#fff3e0','#fce4ec','#f3e5f5','#e0f7fa','#f1f8e9','#fff8e1','#ffebee','#e8eaf6','#fbe9e7'];
let colorPopupApply = null;  // 应用回调

let colorPopupMode = 'bg';   // 'bg' 背景颜色 | 'text' 文字颜色 | 'image' 背景图片
let colorPopupState = null;

function openColorPopup(title, currentColor, onApply, opts) {
    const panel = document.getElementById('colorPopup');
    if (!panel) return;
    opts = opts || {};
    document.getElementById('colorPopupTitle').textContent = title;
    // 打开时默认还是「背景颜色」页；如果你点了「选择图片」，会自动切到「背景图」页
    colorPopupMode = 'bg';
    colorPopupState = {
        bgColor: (currentColor && currentColor.startsWith('#')) ? currentColor : '#ffffff',
        textColor: opts.textColor || '#1a1a2e',
        onApply: onApply,
        allowText: !!opts.allowText,
        showImage: !!opts.showImage,
        fitTargets: opts.fitTargets || null,   // 显示方式作用在这些词条上（为空则看 fitScope）
        fitScope: opts.fitScope || (opts.fitTargets ? 'node' : 'global')   // 'node' | 'canvas' | 'global'
    };
    // 页签：按需要显示（allowText → 「文字颜色」页；showImage → 「背景图」页）
    const tabs = document.getElementById('colorPopupTabs');
    const showTabs = !!(opts.allowText || opts.showImage);
    if (tabs) tabs.style.display = showTabs ? 'flex' : 'none';
    const textTabEl = document.getElementById('colorPopupTextTab');
    if (textTabEl) textTabEl.style.display = opts.allowText ? '' : 'none';
    const imgTabEl = document.getElementById('colorPopupImageTab');
    if (imgTabEl) imgTabEl.style.display = opts.showImage ? '' : 'none';
    updateColorPopupValue();
    colorPopupApply = onApply;
    panel.classList.remove('hidden');
    suppressPopupClose = true;
    setTimeout(() => { suppressPopupClose = false; }, 0);  // 当前点击冒泡结束后再允许关闭
    // 定位：词条换色在鼠标右侧；画布背景锚定到背景按钮正下方
    if (opts.anchorEl) {
        const r = opts.anchorEl.getBoundingClientRect();
        panel.style.left = (r.left) + 'px';
        panel.style.top = (r.bottom + 8) + 'px';
        panel.style.right = 'auto';
    } else if (opts.x !== undefined) {
        panel.style.left = (opts.x + 18) + 'px';
        panel.style.top = (opts.y - 20) + 'px';
        panel.style.right = 'auto';
    }
    // 超出屏幕底部/右侧时翻转到另一侧（例如词条在最底部时弹窗出现在上方）
    const rect = panel.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 12) {
        const ny = (opts.y !== undefined ? opts.y : rect.top) - rect.height - 12;
        panel.style.top = Math.max(8, ny) + 'px';
    }
    if (rect.right > window.innerWidth - 12) {
        const nx = (opts.x !== undefined ? opts.x : rect.left) - rect.width - 12;
        panel.style.left = Math.max(8, nx) + 'px';
    }
}

// 文字颜色色板：黑 / 白 / 灰 / 红 / 蓝（基础色）
function getTextPalette() {
    return ['#000000', '#ffffff', '#333333', '#666666', '#999999', '#e74c3c', '#5b7cfa'];
}

// 根据当前模式（背景/文字）渲染色板
function renderColorSwatches() {
    const colorsEl = document.getElementById('colorPopupColors');
    if (!colorsEl) return;
    colorsEl.innerHTML = '';
    const palette = colorPopupMode === 'text' ? getTextPalette() : COLOR_PRESETS;
    palette.forEach(c => {
        const sw = document.createElement('div');
        sw.style.cssText = `width:32px; height:32px; border-radius:8px; background:${c}; border:2px solid var(--border-color); cursor:pointer; transition:var(--transition);`;
        sw.dataset.color = c;
        sw.addEventListener('click', () => { if (colorPopupApply) colorPopupApply(c, colorPopupMode); });
        colorsEl.appendChild(sw);
    });
}

// 根据当前模式（背景/文字/图片）刷新色板和显示值
function updateColorPopupValue() {
    if (!colorPopupState) return;
    const isImage = (colorPopupMode === 'image');
    const colorsEl = document.getElementById('colorPopupColors');
    const customLabel = document.getElementById('colorPopupCustomLabel');
    const customRow = document.getElementById('colorPopupCustomRow');
    const extra = document.getElementById('colorPopupExtra');
    const fitWrap = document.getElementById('colorPopupFitWrap');
    // 图片模式：隐藏颜色相关，只显示图片相关（选择图片 / 清除 / 显示方式）
    if (colorsEl) colorsEl.style.display = isImage ? 'none' : 'flex';
    if (customLabel) customLabel.style.display = isImage ? 'none' : 'block';
    if (customRow) customRow.style.display = isImage ? 'none' : 'flex';
    if (extra) extra.style.display = (isImage || colorPopupState.showImage) ? 'flex' : 'none';
    if (fitWrap) fitWrap.style.display = isImage ? 'block' : 'none';
    const bgTab = document.getElementById('colorPopupBgTab');
    const textTab = document.getElementById('colorPopupTextTab');
    const imgTab = document.getElementById('colorPopupImageTab');
    if (bgTab) bgTab.classList.toggle('primary', colorPopupMode === 'bg');
    if (textTab) textTab.classList.toggle('primary', colorPopupMode === 'text');
    if (imgTab) imgTab.classList.toggle('primary', isImage);
    // 「✂️ 裁剪 / 📂 缓存」整行（含小标题）属于「背景图」页：背景颜色 / 文字颜色两页保持原样（选择图片 + 清除）
    const toolRowEl = document.getElementById('colorPopupToolRow');
    if (toolRowEl) toolRowEl.style.display = isImage ? 'flex' : 'none';
    const cropBtnEl = document.getElementById('colorPopupCrop');
    // 「✂️ 裁剪」按钮：只有当前场景确实有背景图（图片）时才可用
    if (cropBtnEl) {
        const hasImg = !!colorPopupCurrentImage();
        cropBtnEl.disabled = !hasImg;
        cropBtnEl.style.opacity = hasImg ? '1' : '0.45';
        cropBtnEl.style.cursor = hasImg ? 'pointer' : 'not-allowed';
        cropBtnEl.title = hasImg
            ? '裁剪背景图'
            : '当前还没有背景图（先点「🖼️ 选择图片」）';
    }
    if (isImage) {
        renderColorPopupFitBtns();   // 里面会带上「卡片底色透明」（只在词条背景时出现）
        refreshCacheInfo();
        return;
    }   // 图片模式不渲染色板
    renderColorSwatches();
    const cur = colorPopupMode === 'text' ? colorPopupState.textColor : colorPopupState.bgColor;
    const picker = document.getElementById('colorPopupPicker');
    const hex = document.getElementById('colorPopupHex');
    if (picker) picker.value = cur;
    if (hex) hex.value = cur;   // 现在这两个 id 是输入框（不是文字），要写 value
}

// 背景图显示方式按钮：作用在"当前这批词条"上（没传目标词条时改全局默认）
function renderColorPopupFitBtns() {
    const wrap = document.getElementById('colorPopupFitBtns');
    if (!wrap) return;
    const targets = colorPopupState && colorPopupState.fitTargets;
    const scope = colorPopupState && colorPopupState.fitScope;
    let cur = nodeBgFit;
    if (targets && targets.length) cur = targets[0].bgFit || nodeBgFit;
    else if (scope === 'canvas') cur = currentProject.canvasBgFit || nodeBgFit;
    wrap.innerHTML = NODE_BG_FIT_OPTIONS.map(o => {
        const active = (o.v === cur);
        return `<button type="button" data-fit="${o.v}" title="${o.label}" class="dbg-btn${active ? ' primary' : ''}">${o.short}</button>`;
    }).join('') + ((targets && targets.length)
        // 「卡片底色透明」跟按钮同一行（有位置就并排靠右；挤了就紧跟"拉伸填充"后面）
        ? `<label id="colorPopupTransparentLabel" title="卡片底色透明：背景图带透明区域（PNG）或没铺满时，不再露出白底（选了图片背景会自动打开，换成纯色背景会自动关掉）" style="display:inline-flex; align-items:center; gap:4px; margin-left:auto; margin-right:24px; font-size:12px; color:var(--text-secondary); cursor:pointer; white-space:nowrap;">
               <input type="checkbox" id="colorPopupCardTransparent" style="cursor:pointer;"${targets[0] && targets[0].bgTransparent ? ' checked' : ''} />
               <span>卡片底色透明</span>
           </label>`
        : '');
}

// 背景/文字/图片模式切换按钮
const colorPopupBgTab = document.getElementById('colorPopupBgTab');
const colorPopupTextTab = document.getElementById('colorPopupTextTab');
const colorPopupImageTab = document.getElementById('colorPopupImageTab');
if (colorPopupBgTab) {
    colorPopupBgTab.addEventListener('click', () => { colorPopupMode = 'bg'; updateColorPopupValue(); });
}
if (colorPopupTextTab) {
    colorPopupTextTab.addEventListener('click', () => { colorPopupMode = 'text'; updateColorPopupValue(); });
}
if (colorPopupImageTab) {
    colorPopupImageTab.addEventListener('click', () => { colorPopupMode = 'image'; updateColorPopupValue(); });
}
// 显示方式按钮点击
const colorPopupFitBtnsEl = document.getElementById('colorPopupFitBtns');
if (colorPopupFitBtnsEl) {
    colorPopupFitBtnsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-fit]');
        if (!btn) return;
        e.stopPropagation();   // 防止冒泡被误判为"点了弹窗外面"
        const targets = colorPopupState && colorPopupState.fitTargets;
        const scope = colorPopupState && colorPopupState.fitScope;
        if (targets && targets.length) {
            // 只改这些词条（不动其他词条）
            pushUndo();
            targets.forEach(t => { t.bgFit = btn.dataset.fit; t.lastModified = Date.now(); });
            scheduleSave();
            renderColorPopupFitBtns();
            renderCanvas();
            showToast(`背景显示：${btn.textContent}`, 1600);
        } else if (scope === 'canvas') {
            // 画布背景的显示方式（跟随这本书）
            pushUndo();
            currentProject.canvasBgFit = btn.dataset.fit;
            applyCanvasBg();
            scheduleSave();
            renderColorPopupFitBtns();
            showToast(`画布背景显示方式：${btn.textContent}`, 1600);
        } else {
            // 没指定对象：改全局默认
            setNodeBgFit(btn.dataset.fit);
            renderColorPopupFitBtns();
            renderCanvas();
            showToast(`背景显示（默认）：${btn.textContent}`, 1600);
        }
    });
}

function closeColorPopup() {
    const panel = document.getElementById('colorPopup');
    if (panel) panel.classList.add('hidden');
    colorPopupApply = null;
    colorPopupState = null;
}

// 拖动
const colorPopupHeader = document.getElementById('colorPopupHeader');
const colorPopupPanelEl = document.getElementById('colorPopup');
if (colorPopupHeader && colorPopupPanelEl) {
    colorPopupHeader.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        const rect = colorPopupPanelEl.getBoundingClientRect();
        const offX = e.clientX - rect.left;
        const offY = e.clientY - rect.top;
        const onMove = (ev) => {
            let nx = ev.clientX - offX, ny = ev.clientY - offY;
            nx = Math.max(0, Math.min(nx, window.innerWidth - 60));
            ny = Math.max(0, Math.min(ny, window.innerHeight - 40));
            colorPopupPanelEl.style.left = nx + 'px';
            colorPopupPanelEl.style.top = ny + 'px';
            colorPopupPanelEl.style.right = 'auto';
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

const btnCloseColorPopup = document.getElementById('btnCloseColorPopup');
if (btnCloseColorPopup) btnCloseColorPopup.addEventListener('click', closeColorPopup);

// 颜色值输入框（#xxxxxx）：能选中 / 复制 / 粘贴 / 剪切，改完回车（或移开焦点）生效。
// 为什么要自己做：点色块弹出的是**系统取色器**，那是系统/浏览器自己的小窗口，它里面的输入框不吃
// 剪贴板（只能手敲数字），我们改不了它 —— 所以在软件界面里放一个"自己家的"输入框。
function bindColorHexInput(input, picker) {
    if (!input || !picker) return;
    const normalize = (s) => {
        let v = String(s == null ? '' : s).trim().replace(/^#/, '');
        if (/^[0-9a-fA-F]{3}$/.test(v)) v = v.split('').map(c => c + c).join('');
        if (!/^[0-9a-fA-F]{6}$/.test(v)) return null;
        return '#' + v.toLowerCase();
    };
    const commit = () => {
        const v = normalize(input.value);
        if (!v) { input.value = picker.value; return false; }
        input.value = v;
        if (picker.value !== v) {
            picker.value = v;
            picker.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); }
        else if (e.key === 'Escape') { input.value = picker.value; input.blur(); }
    });
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
}
bindColorHexInput(document.getElementById('colorPopupHex'), document.getElementById('colorPopupPicker'));
bindColorHexInput(document.getElementById('dbgColorHex2'), document.getElementById('dbgColorPicker2'));
const colorPopupPickerEl = document.getElementById('colorPopupPicker');
const colorPopupHexEl = document.getElementById('colorPopupHex');
if (colorPopupPickerEl) {
    colorPopupPickerEl.addEventListener('input', () => {
        if (colorPopupHexEl) colorPopupHexEl.value = colorPopupPickerEl.value;
    });
    colorPopupPickerEl.addEventListener('change', () => {
        if (colorPopupApply) colorPopupApply(colorPopupPickerEl.value, colorPopupMode);
    });
}
const colorPopupImageBtn = document.getElementById('colorPopupImage');
if (colorPopupImageBtn) {
    colorPopupImageBtn.addEventListener('click', async () => {
        suppressPopupClose = true;   // 选图期间（含文件对话框关闭后一小段）不要自动关掉弹窗
        try {
            const result = await api.selectImage();
            if (result && result.success && colorPopupApply) {
                colorPopupApply(result.filePath, colorPopupMode);
                // 选完图片后自动切到「背景图」页（方便顺手调显示方式），弹窗保持打开
                colorPopupMode = 'image';
                updateColorPopupValue();
            }
        } catch (e) {
            showToast('选择图片失败: ' + e.message);
        } finally {
            setTimeout(() => { suppressPopupClose = false; }, 400);
        }
    });
}
const colorPopupClearBtn = document.getElementById('colorPopupClear');
if (colorPopupClearBtn) {
    colorPopupClearBtn.addEventListener('click', () => {
        if (colorPopupApply) colorPopupApply(null, colorPopupMode);
    });
}
// 「卡片底色透明」：按钮是每次刷新动态生成的，所以用事件委托（勾选后立即生效，不给 toast 添乱）
const colorPopupTransparentHost = document.getElementById('colorPopupFitBtns');
if (colorPopupTransparentHost) {
    colorPopupTransparentHost.addEventListener('change', (e) => {
        if (!e.target || e.target.id !== 'colorPopupCardTransparent') return;
        const targets = (colorPopupState && colorPopupState.fitTargets) || [];
        if (!targets.length) return;
        pushUndo();
        const on = !!e.target.checked;
        targets.forEach(t => {
            if (on) t.bgTransparent = true; else delete t.bgTransparent;
            t.lastModified = Date.now();
        });
        renderCanvas();
        scheduleSave();
        showToast(on ? '卡片底色：透明' : '卡片底色：原色', 1600);
    });
}

// 「🧹 清理缓存」：面板里只做"看占用 + 清理"（打开文件夹在 ⚙️ 设置里）
const colorPopupCleanCache = document.getElementById('colorPopupCleanCache');
if (colorPopupCleanCache) {
    colorPopupCleanCache.addEventListener('click', () => { openCleanCacheDialog(); });
}

// 「✂️ 框选裁剪」要裁的是哪张图：画布背景看 canvasBg，词条/批量看这些词条的 bgImage
function colorPopupCurrentImage() {
    const pick = (v) => (v && typeof v === 'string' && !v.startsWith('#')) ? v : null;
    if (!colorPopupState) return null;
    if (colorPopupState.fitScope === 'canvas') return pick(currentProject && currentProject.canvasBg);
    const list = colorPopupState.fitTargets || [];
    for (const t of list) {
        const hit = pick(t && t.bgImage);
        if (hit) return hit;
    }
    return null;
}

// ============================================================
// 背景图裁剪（✂️）
// 交互：裁剪框常驻（整条边 / 四个角都能拉，可选锁定比例）
//      + 图片可拖动、可滚轮/按钮缩放（图片在框里自由摆）
//      + Shift 等比、Ctrl 从中心、Alt 拖动重新拉一个框（和 PS 习惯一致）
// 边界：框限制在「图片可见区域」内 —— 和 PS / 系统看图一样，框不会跑到弹窗外面，
//      也不会裁出一片白边（图片缩得比框小时，框会自动收缩到图片范围内）
// 流程：读缓存里那份副本（base64，避开 file:// 图片"污染" canvas 的问题）
//      → canvas 按框内区域裁出新图 → 另存为缓存目录里的新文件
// 安全：只新增文件，原图与缓存里的旧图都不会被改写（旧图不再被引用时会照常回收）
// ============================================================
const cropOverlayEl = document.getElementById('cropOverlay');
const cropStageEl = document.getElementById('cropStage');
const cropImageEl = document.getElementById('cropImage');
const cropFrameEl = document.getElementById('cropFrame');
const cropInfoEl = document.getElementById('cropInfo');
const cropRatioBtnsEl = document.getElementById('cropRatioBtns');
const CROP_MIN_SIZE = 24;      // 裁剪框最小边长（屏幕像素）
const CROP_MAX_OUT = 7000;     // 裁剪结果最长边上限（避免超大的 canvas；超了只砍多余的透明边，不缩图片内容）
const CROP_KEEP_VISIBLE = 56;  // 没锁定时拖图片至少留这么多像素在舞台里，免得把图片拖没了
const CROP_MIN_SCALE = 0.1;    // 没锁定时图片能缩到多小
const CROP_LOCK_KEY = 'novel-tool-crop-lock';   // 「🔒 锁定裁剪框」的选择（跟着人走，不是每本书一份）

// 🔒 锁定裁剪框（裁剪弹窗里的开关，默认开）
//   ON ：① 裁剪框只能在图片里 → 结果不会有透明块
//        ② 图片不会被拖出裁剪区，缩到最小也只到"整张图刚好显示全"（像普通修图软件那样）
//   OFF：① 框可以框到图片外面 → 框外那一块在结果里是透明的
//        （专门用来做"某一块不要图"的背景，比如详情页标题那一条）
//        ② 图片可以随便拖、随便缩（要留透明区就得能把图挪走）
let cropLock = (() => {
    try {
        const v = localStorage.getItem(CROP_LOCK_KEY);
        return v === null ? true : v === '1';      // 没设置过 → 默认锁定
    } catch (e) { return true; }
})();

// 切换锁定：记住选择；锁定时顺手把图片和框都收回图片里
function cropSetLock(v, silent) {
    cropLock = !!v;
    try { localStorage.setItem(CROP_LOCK_KEY, cropLock ? '1' : '0'); } catch (e) {}
    const chk = document.getElementById('cropLockChk');
    if (chk && chk.checked !== cropLock) chk.checked = cropLock;
    if (cropState && cropState.natural) {
        if (cropLock && cropState.scale < cropMinScale()) cropState.scale = cropMinScale();   // 缩太小的先抬回"整图显示"
        cropClampImage();
        if (cropState.frame) cropState.frame = cropClampFrame(cropState.frame, cropState.ratio);
        cropRender();
    }
    if (!silent) showToast(cropLock ? '🔒 已锁定裁剪框' : '🔓 已解除锁定', 1400);
}

let cropState = null;
//  cropState = { srcPath, onDone, natural:{w,h}, base:{w,h}, scale, imgX, imgY,
//                frame:{x,y,w,h}, ratio, ratioHints:[{v,label,title}], target:{kind,ids}, stage:{w,h} }
//  natural：原图像素；base：1 倍缩放时图片在舞台里的显示尺寸；imgX/imgY：图片左上角（舞台坐标）
//  stage：上次记下的裁剪区尺寸（窗口最大化 / 还原时用来按比例挪图片和框）
let cropDrag = null;   // 拖动状态：{ mode:'frame'|'image'|'resize'|'newframe', dir, startX, startY, frame, imgX, imgY }
// 图片盒子的缓存：盒子＝base（1 倍缩放时的显示尺寸），大小没变就不再写一次宽高（省一次重排）
let cropImgBox = { w: -1, h: -1 };
// 滚轮缩放的攒包状态：一串 wheel 事件合并成每帧一次（见 cropWheelZoom）
let cropWheelFactor = 1, cropWheelPos = null, cropWheelRaf = 0, cropWheelTimer = 0;

function cropStageSize() {
    if (!cropStageEl) return { w: 0, h: 0 };
    return { w: cropStageEl.clientWidth, h: cropStageEl.clientHeight };
}

// 图片当前显示尺寸（舞台坐标）
function cropDispSize() {
    if (!cropState) return { w: 0, h: 0 };
    return { w: cropState.base.w * cropState.scale, h: cropState.base.h * cropState.scale };
}

// 舞台像素 → 原图像素 的换算比例
function cropPixelScale() {
    const d = cropDispSize();
    return cropState.natural.w / Math.max(1, d.w);
}

// 裁剪结果的像素尺寸 ＝ 裁剪框对应的原图像素
//   · 图片内容永远是 1:1（原图多少像素就多少像素，绝不缩水）
//   · 最长边超过 CROP_MAX_OUT 时只砍**框里多余的透明边**（clipped），图片内容不跟着缩
//   · 只有原图自身就已经超过上限（巨图）时才不得不整体缩一点（squeezed）
//   ※ 以前是"超上限就把整张（含图片内容）一起等比缩"，于是"缩小 → 应用 → 再缩小"
//     每来一轮图片内容就小一圈（＝用户报的那个"无限缩小"）
function cropOutputSize() {
    const f = cropState && cropState.frame;
    const nat = cropState && cropState.natural;
    if (!f || !nat || !cropState.base.w || !cropState.base.h) return null;
    const k = cropPixelScale();
    const fullW = Math.max(1, Math.round(f.w * k));
    const fullH = Math.max(1, Math.round(f.h * k));
    if (fullW <= CROP_MAX_OUT && fullH <= CROP_MAX_OUT) {
        return { w: fullW, h: fullH, fullW: fullW, fullH: fullH, clipped: false, squeezed: false };
    }
    if (nat.w <= CROP_MAX_OUT && nat.h <= CROP_MAX_OUT) {
        return { w: Math.min(fullW, CROP_MAX_OUT), h: Math.min(fullH, CROP_MAX_OUT), fullW: fullW, fullH: fullH, clipped: true, squeezed: false };
    }
    const s = CROP_MAX_OUT / Math.max(fullW, fullH);
    return { w: Math.max(1, Math.round(fullW * s)), h: Math.max(1, Math.round(fullH * s)), fullW: fullW, fullH: fullH, clipped: true, squeezed: true };
}

// 裁剪框允许活动的范围
//  · 锁定（默认）= 裁剪区 ∩ 图片 → 框只能在图片里，结果不会有透明的空白块
//  · 没锁定 = 整个裁剪区（弹窗里的那块舞台），不要求压在图片上
//    → 框可以框到图片外面：框外那部分在结果里是透明的，用来做"某一块不要图"的背景（比如详情页标题那一条）
function cropFrameBounds() {
    const st = cropStageSize();
    let x = 0, y = 0;
    let w = Math.max(CROP_MIN_SIZE, st.w), h = Math.max(CROP_MIN_SIZE, st.h);
    if (cropLock && cropState && cropState.natural) {
        const d = cropDispSize();
        const ix = Math.max(x, cropState.imgX), iy = Math.max(y, cropState.imgY);
        const iw = Math.min(x + w, cropState.imgX + d.w) - ix;
        const ih = Math.min(y + h, cropState.imgY + d.h) - iy;
        // 图片还在舞台里露着多少，框就只能在这块里面（露得比最小边长还少时给个最小可用范围）
        if (iw >= 1 && ih >= 1) {
            x = ix; y = iy;
            w = Math.max(CROP_MIN_SIZE, iw); h = Math.max(CROP_MIN_SIZE, ih);
        }
    }
    return { x, y, w, h };
}

// 裁剪框限制在活动范围内，且不小于最小尺寸
// ratio > 0（有比例锁：选了比例按钮或按住 Shift 拉角）时整体等比缩回来 ——
//   以前是宽、高各自压到边界里，只要撞一下边比例就废了（"选框固定不住"就是这么来的）
function cropClampFrame(f, ratio) {
    const b = cropFrameBounds();
    const minW = Math.min(CROP_MIN_SIZE, b.w);
    const minH = Math.min(CROP_MIN_SIZE, b.h);
    if (ratio > 0) {
        const k = Math.min(1, b.w / Math.max(1, f.w), b.h / Math.max(1, f.h));
        if (k < 1) { f.w *= k; f.h *= k; }
        if (f.w < minW) { f.w = minW; f.h = f.w / ratio; }
        if (f.h < minH) { f.h = minH; f.w = f.h * ratio; }
    } else {
        f.w = Math.max(minW, Math.min(f.w, b.w));
        f.h = Math.max(minH, Math.min(f.h, b.h));
    }
    f.x = Math.max(b.x, Math.min(f.x, b.x + b.w - f.w));
    f.y = Math.max(b.y, Math.min(f.y, b.y + b.h - f.h));
    return f;
}

// 锁定时图片能缩到多小：刚好整张图显示全
// （图片比例和裁剪区对不上时，两边留一点空白是正常的；但不能缩得比"整图"还小）
function cropMinScale() {
    if (!cropLock || !cropState || !cropState.base.w || !cropState.base.h) return CROP_MIN_SCALE;
    const st = cropStageSize();
    return Math.max(0.02, Math.min(st.w / cropState.base.w, st.h / cropState.base.h));
}

// 没锁定时图片能缩到多小：再缩，裁剪框对应的结果就会超过 CROP_MAX_OUT（上面那个上限）
//   以前这里没有下限（一路缩到 CROP_MIN_SCALE＝一个小点），结果是"缩小 → 应用 → 再缩小"
//   可以让图片内容一轮一轮变小（超上限 → 整体缩 → 内容跟着小）。现在缩到"结果刚好 7000px"就停，
//   图片内容永远是原图像素，那个无限缩小的循环就断了
function cropFreeMinScale() {
    const base = cropState && cropState.base;
    const nat = cropState && cropState.natural;
    const f = cropState && cropState.frame;
    if (!f || !base || !base.w || !base.h || !nat) return CROP_MIN_SCALE;
    const s = Math.max(
        (f.w * nat.w) / (base.w * CROP_MAX_OUT),
        (f.h * nat.h) / (base.h * CROP_MAX_OUT)
    );
    return Math.max(CROP_MIN_SCALE, s);
}

// 图片位置的限制
//  · 锁定：图片必须盖住裁剪区（拖不出去）；某个方向本来就比裁剪区小（整图显示时的那点空白）→ 居中放着不让拖
//  · 没锁定：至少留 CROP_KEEP_VISIBLE 像素在舞台里，免得把图片拖没了
function cropClampImage() {
    if (!cropState) return;
    const st = cropStageSize();
    const d = cropDispSize();
    if (cropLock) {
        cropState.imgX = (d.w >= st.w) ? Math.max(st.w - d.w, Math.min(cropState.imgX, 0)) : (st.w - d.w) / 2;
        cropState.imgY = (d.h >= st.h) ? Math.max(st.h - d.h, Math.min(cropState.imgY, 0)) : (st.h - d.h) / 2;
    } else {
        const keepX = Math.min(CROP_KEEP_VISIBLE, d.w);
        const keepY = Math.min(CROP_KEEP_VISIBLE, d.h);
        cropState.imgX = Math.max(-(d.w - keepX), Math.min(cropState.imgX, st.w - keepX));
        cropState.imgY = Math.max(-(d.h - keepY), Math.min(cropState.imgY, st.h - keepY));
    }
    // 锁定时：图片挪了 / 缩小了，框跟着收回图片里（有比例锁就等比收，不会跑形）
    if (cropLock && cropState.frame) cropState.frame = cropClampFrame(cropState.frame, cropState.ratio);
}

// 画面同步：图片位置/尺寸 + 裁剪框位置/尺寸 + 提示文字
function cropRender() {
    if (!cropState) return;
    if (cropImageEl) {
        // 图片的位置与大小改用 transform 表达（配合 style.css 里的 transform-origin:0 0）：
        // 元素盒子固定成 base（1 倍缩放时的显示尺寸），滚轮缩放只改这一条 transform，
        // 不再动 left/top/width/height → 不触发重排、不重新栅格化，缩放交给合成器做。
        // 以前每个滚轮事件都要改 4 个布局属性 + 把整张（可能很大的、带透明的）位图重新缩一遍，
        // 这就是"缩小过一次之后滚轮缩放会卡顿"的来源。
        if (cropImgBox.w !== cropState.base.w || cropImgBox.h !== cropState.base.h) {
            cropImgBox = { w: cropState.base.w, h: cropState.base.h };
            cropImageEl.style.width = cropImgBox.w + 'px';
            cropImageEl.style.height = cropImgBox.h + 'px';
        }
        cropImageEl.style.transform = `translate(${cropState.imgX}px, ${cropState.imgY}px) scale(${cropState.scale})`;
    }
    const f = cropState.frame;
    if (f && cropFrameEl) {
        cropFrameEl.classList.remove('hidden');
        cropFrameEl.style.left = f.x + 'px';
        cropFrameEl.style.top = f.y + 'px';
        cropFrameEl.style.width = f.w + 'px';
        cropFrameEl.style.height = f.h + 'px';
    }
    if (cropInfoEl && f) {
        const o = cropOutputSize() || { w: 0, h: 0, clipped: false, squeezed: false };
        const capTip = o.clipped
            ? (o.squeezed ? `　·　原图超过 ${CROP_MAX_OUT}px，结果缩到上限内` : `　·　已到 ${CROP_MAX_OUT}px 上限，多出的透明边裁掉`)
            : '';
        // 像素尺寸只在下面这一处报（别的地方不再重复说多少 px）；快捷键只留最常用的三个，其余在「帮助」里
        cropInfoEl.innerHTML = `✂️ 结果 ≈ <b>${o.w} × ${o.h}</b> px${capTip}　·　滚轮缩放 / Shift 等比 / Ctrl 居中<br>`
            + `<span style="opacity:0.8;">${cropLock ? '🔒 框限制在图片内' : '🔓 框可到图片外（透明）'}</span>`;
    }
}

// 比例显示成 1.4:1 / 2:1 这种好读的样子
function cropRatioText(a, b) {
    const r = a / Math.max(1, b);
    if (Math.abs(r - Math.round(r)) < 0.02) return Math.round(r) + ':1';
    return (Math.round(r * 100) / 100) + ':1';
}

// 词条卡片比例：优先用当前正在调背景的那几个词条，其次画布里任意一个词条
// （卡片宽度 160~260 随内容变，只能实测；画布里一个词条都没有就返回 null，不显示这个按钮）
// 注意：卡片是直接挂在 #canvas 下的（不是 #canvasContent 里），两个都兜住
function cropNodeBox() {
    const rectOf = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return (r.width > 8 && r.height > 8) ? { w: r.width, h: r.height } : null;
    };
    const nodes = Array.prototype.slice.call(document.querySelectorAll('#canvas .node, #canvasContent .node'));
    const ids = (cropState && cropState.target && cropState.target.kind === 'node' && cropState.target.ids) ? cropState.target.ids : [];
    for (let i = 0; i < ids.length; i++) {
        const hit = nodes.find(n => n.dataset.id === ids[i]);
        const r = rectOf(hit);
        if (r) return r;
    }
    for (let i = 0; i < nodes.length; i++) {
        const r = rectOf(nodes[i]);
        if (r) return r;
    }
    return null;
}

// 比例按钮：自由 / 1:1 / 自适应（按"你正在调的那块背景的当前实际尺寸"算）
// —— 自适应一个按钮顶好几个：从画布进来就按画布当前可视区（窗口化 / 最大化都跟着当前状态），
//    从详情页进来按详情页栏，从词条进来按词条卡片；开着「跟随画布背景」时按"画布 + 详情页"整块
function cropBuildRatioHints() {
    if (!cropState) return;
    const list = [{ v: 0, label: '自由', title: '不锁比例' }];
    list.push({ v: 1, label: '1:1', title: '正方形' });   // 放在自由右边，最常用的两个挨着
    // 说明：这里**不再**给「原图」单开一个比例按钮 —— 按图片自身比例锁死的场景几乎没有
    // （要整张图请点底下的「🔳 原图」；想按原图的形状框一小块，点完「🔳 原图」后按住 Shift 拉角即可，
    //   Shift = 保持按下那一刻的宽高比，等于临时锁成图片比例）
    const push = (box, label, why) => {
        if (!box || !(box.w > 0) || !(box.h > 0)) return;
        list.push({
            v: box.w / box.h,
            label: label,
            title: `${why}：比例 ${cropRatioText(box.w, box.h)}（约 ${Math.round(box.w)}×${Math.round(box.h)} px，裁完刚好铺满）`
        });
    };
    const rectOf = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return (r.width > 8 && r.height > 8) ? { w: r.width, h: r.height } : null;
    };
    const linked = !!(currentProject && currentProject.detailBgLink && currentProject.canvasBg);
    const kind = (cropState.target && cropState.target.kind) || 'canvas';
    if (linked) {
        // 跟随中：背景是铺在"画布 + 详情页"整块上的
        push(rectOf(document.getElementById('mainArea')), '自适应·全屏', '按「画布 + 详情页」整块工作区当前尺寸');
    } else if (kind === 'node') {
        push(cropNodeBox(), '自适应·词条', '按这个词条卡片当前尺寸');
    } else if (kind === 'detail') {
        push(rectOf(document.getElementById('detailPanel')), '自适应·详情页', '按详情页栏当前尺寸');
    } else {
        push(rectOf(document.getElementById('canvas')), '自适应·画布', '按画布可视区当前尺寸（窗口变了再点一下）');
    }
    cropState.ratioHints = list;
}

function cropRenderRatioBtns() {
    if (!cropRatioBtnsEl || !cropState) return;
    const hints = (cropState.ratioHints && cropState.ratioHints.length) ? cropState.ratioHints : [{ v: 0, label: '自由', title: '' }];
    cropRatioBtnsEl.innerHTML = hints.map(h => {
        const active = Math.abs((cropState.ratio || 0) - h.v) < 0.0001;
        return `<button type="button" data-r="${h.v}" title="${h.title || ''}" class="${active ? 'active' : ''}">${h.label}</button>`;
    }).join('');
}

// 切换裁剪框宽高比（以框中心为基准，超出可用范围就收缩；0 = 自由比例）
function cropSetRatio(ratio) {
    if (!cropState || !cropState.frame) return;
    cropState.ratio = ratio;
    if (ratio > 0) {
        const b = cropFrameBounds();
        const f = cropState.frame;
        const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
        let w = f.w, h = w / ratio;
        if (h > b.h) { h = b.h; w = h * ratio; }
        if (w > b.w) { w = b.w; h = w / ratio; }
        if (w < CROP_MIN_SIZE) { w = Math.min(CROP_MIN_SIZE, b.w); h = w / ratio; }
        if (h < CROP_MIN_SIZE) { h = Math.min(CROP_MIN_SIZE, b.h); w = h * ratio; }
        if (h > b.h) { h = b.h; w = h * ratio; }
        if (w > b.w) { w = b.w; h = w / ratio; }
        f.w = w; f.h = h;
        f.x = cx - w / 2; f.y = cy - h / 2;
        cropClampFrame(f, ratio);
    }
    cropRenderRatioBtns();
    cropRender();
}

// 拉边角改框大小：Shift = 等比缩放、Ctrl = 从中心缩放（和 PS 一样）
// s：按下时的框；dir：控制点方向（n/s/e/w 的组合）；dx/dy：鼠标位移；mods：{ shiftKey, ctrlKey }
function cropResizeFrame(s, dir, dx, dy, mods) {
    mods = mods || {};
    const b = cropFrameBounds();
    const hSign = dir.indexOf('e') >= 0 ? 1 : (dir.indexOf('w') >= 0 ? -1 : 0);
    const vSign = dir.indexOf('s') >= 0 ? 1 : (dir.indexOf('n') >= 0 ? -1 : 0);
    const fromCenter = !!mods.ctrlKey;                 // Ctrl：中心不动，两边一起变
    // 比例：选了固定比例就用它；没选时按住 Shift = 按"按下那一刻的宽高比"等比
    const lock = cropState.ratio > 0
        ? cropState.ratio
        : ((mods.shiftKey && s.h > 0) ? (s.w / s.h) : 0);
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    // 各方向还能长多大
    const roomX = hSign > 0 ? (b.x + b.w - s.x) : (hSign < 0 ? (s.x + s.w - b.x) : s.w);
    const roomY = vSign > 0 ? (b.y + b.h - s.y) : (vSign < 0 ? (s.y + s.h - b.y) : s.h);
    const maxW = fromCenter ? 2 * Math.min(cx - b.x, b.x + b.w - cx) : roomX;
    const maxH = fromCenter ? 2 * Math.min(cy - b.y, b.y + b.h - cy) : roomY;

    let nw = s.w, nh = s.h;
    if (lock > 0) {
        // 有比例锁（选了比例按钮，或按住 Shift）：看"宽 / 高各自缩放了几倍"，谁动得多就听谁的
        // —— 以前是取"大的那边"，导致往里拖也会长回去，只能放大不能缩小
        let scale;
        if (hSign && vSign) {
            const rw = (s.w + (fromCenter ? 2 : 1) * hSign * dx) / Math.max(1, s.w);
            const rh = (s.h + (fromCenter ? 2 : 1) * vSign * dy) / Math.max(1, s.h);
            scale = (Math.abs(rw - 1) >= Math.abs(rh - 1)) ? rw : rh;
        } else if (hSign) {
            scale = (s.w + (fromCenter ? 2 : 1) * hSign * dx) / Math.max(1, s.w);
        } else {
            scale = (s.h + (fromCenter ? 2 : 1) * vSign * dy) / Math.max(1, s.h);
        }
        scale = Math.max(0.02, scale);
        nw = s.w * scale;
        nh = nw / lock;                               // 严格按比例，绝不走形
        // 顶到边界 / 最小尺寸就等比收回来（比例始终不变）
        let k = 1;
        if (nw > maxW) k = Math.min(k, maxW / nw);
        if (nh > maxH) k = Math.min(k, maxH / nh);
        nw *= k; nh *= k;
        if (nw < CROP_MIN_SIZE) { nw = CROP_MIN_SIZE; nh = nw / lock; }
        if (nh < CROP_MIN_SIZE) { nh = CROP_MIN_SIZE; nw = nh * lock; }
        if (nw > b.w) { nw = b.w; nh = nw / lock; }
        if (nh > b.h) { nh = b.h; nw = nh * lock; }
    } else {
        // 自由比例：往哪边拉就改哪条边（两个方向互不影响）
        if (hSign) nw = s.w + (fromCenter ? 2 : 1) * hSign * dx;
        if (vSign) nh = s.h + (fromCenter ? 2 : 1) * vSign * dy;
        nw = Math.max(Math.min(CROP_MIN_SIZE, b.w), Math.min(nw, maxW, b.w));
        nh = Math.max(Math.min(CROP_MIN_SIZE, b.h), Math.min(nh, maxH, b.h));
    }

    // 摆位置：从中心缩放时中心不动；否则被拉的对面那条边（角＝对角）固定
    const f = {
        w: nw, h: nh,
        x: fromCenter ? (cx - nw / 2) : (hSign > 0 ? s.x : (hSign < 0 ? s.x + s.w - nw : s.x + (s.w - nw) / 2)),
        y: fromCenter ? (cy - nh / 2) : (vSign > 0 ? s.y : (vSign < 0 ? s.y + s.h - nh : s.y + (s.h - nh) / 2))
    };
    return cropClampFrame(f, lock);
}

// 缩放图片：anchor 是舞台里的缩放锚点（默认取舞台中心）
function cropZoomImage(factor, anchor) {
    if (!cropState) return;
    const oldScale = cropState.scale;
    // 缩小的下限：锁定＝整张图刚好显示全；没锁定＝再缩结果就超过 7000px 上限了
    const floor = cropLock ? cropMinScale() : cropFreeMinScale();
    const next = Math.max(Math.min(floor, oldScale), Math.min(8, oldScale * factor));
    if (next === oldScale) {
        // 锁定时缩到"整张图刚好显示全"就不动了：这是修图软件的常规行为，画面上一眼就能看出来，不弹提示
        // 没锁定时才提示：不然"滚轮突然缩不动了"会让人以为坏了，得说明是 7000px 上限挡的
        if (factor < 1 && !cropLock && oldScale <= floor + 1e-6) {
            showToast(`🔓 已缩到最小（结果上限 ${CROP_MAX_OUT}px）`, 2400);
        }
        return;
    }
    const st = cropStageSize();
    const ax = anchor ? anchor.x : st.w / 2;
    const ay = anchor ? anchor.y : st.h / 2;
    const k = next / oldScale;
    cropState.imgX = ax - (ax - cropState.imgX) * k;
    cropState.imgY = ay - (ay - cropState.imgY) * k;
    cropState.scale = next;
    cropClampImage();
    // 图片变小了，框跟着收一收，免得框里出现空白（有比例锁就等比收，比例不会跑形）
    if (cropState.frame) cropState.frame = cropClampFrame(cropState.frame, cropState.ratio);
    cropRender();
}

// 「图片内该比例的最大框」，并居中在图片上（给「🖼️ 居中最大」用）
// 框一定整块压在图片里：不会框到图片外面，结果里就不会出现透明的空白块
function cropFrameFitInsideImage(ratio) {
    if (!cropState || !(ratio > 0)) return cropState ? cropState.frame : null;
    const b = cropFrameBounds();
    const d = cropDispSize();
    // 图片与裁剪区的交集：框架最大只能到这里（再大就会框到图片外面）
    const ix = Math.max(b.x, cropState.imgX), iy = Math.max(b.y, cropState.imgY);
    const iw = Math.max(1, Math.min(b.x + b.w, cropState.imgX + d.w) - ix);
    const ih = Math.max(1, Math.min(b.y + b.h, cropState.imgY + d.h) - iy);
    let w = Math.min(iw, ih * ratio);
    let h = w / ratio;
    if (h > ih) { h = ih; w = h * ratio; }
    const minW = Math.min(CROP_MIN_SIZE, iw), minH = Math.min(CROP_MIN_SIZE, ih);
    if (w < minW) { w = minW; h = w / ratio; }
    if (h < minH) { h = minH; w = h * ratio; }
    const cx = cropState.imgX + d.w / 2, cy = cropState.imgY + d.h / 2;   // 图片中心
    cropState.frame = cropClampFrame({ x: cx - w / 2, y: cy - h / 2, w: w, h: h }, ratio);
    return cropState.frame;
}

// 「🖼️ 居中最大」：把图片放大到刚好铺满整个裁剪区（图片一定盖住裁剪区，不会露底色）
//   · 选了比例（自适应·词条 / 自适应·画布 / 1:1…）→ 框按这个比例「在图片里居中放到最大」
//   · 自由比例 → 框＝图片 ∩ 裁剪区（＝你现在看到的这一块，所见即所得）
// 两种情况都**不锁比例**：接着拉边角还是自由的
function cropFitCover() {
    if (!cropState || !cropState.natural) return;
    const st = cropStageSize();
    const d = cropDispSize();
    if (d.w > 0 && d.h > 0) {
        const k = Math.max(st.w / d.w, st.h / d.h);
        cropState.scale = Math.max(CROP_MIN_SCALE, Math.min(8, cropState.scale * k));
    }
    const d2 = cropDispSize();
    cropState.imgX = (st.w - d2.w) / 2;
    cropState.imgY = (st.h - d2.h) / 2;
    cropClampImage();
    if (cropState.ratio > 0) {
        cropFrameFitInsideImage(cropState.ratio);
    } else {
        const b = cropFrameBounds();
        const ix = Math.max(b.x, cropState.imgX), iy = Math.max(b.y, cropState.imgY);
        const iw = Math.max(1, Math.min(b.x + b.w, cropState.imgX + d2.w) - ix);
        const ih = Math.max(1, Math.min(b.y + b.h, cropState.imgY + d2.h) - iy);
        cropState.frame = cropClampFrame({ x: ix, y: iy, w: iw, h: ih }, 0);
    }
    cropRender();
    showToast(cropState.ratio > 0 ? '🖼️ 已铺满裁剪区（框按比例放到最大）' : '🖼️ 已铺满裁剪区', 1600);
}

// 「🔳 原图」兼「刚打开裁剪弹窗时的默认状态」：图片完整显示 + 框刚好框住整张图
//   · 结果＝原图本身（像素尺寸都不变），所以"什么都不改直接点裁剪并应用"不会白裁掉一块
//   · 和「🖼️ 居中最大」正好相反：这个是整图入框（一点不裁），那个是铺满裁剪区（会裁掉一部分）
function cropShowWhole(silent) {
    if (!cropState || !cropState.natural) return;
    const st = cropStageSize();
    const nat = cropState.natural;
    const k = Math.min(st.w / Math.max(1, nat.w), st.h / Math.max(1, nat.h));   // 完整显示（contain）
    cropState.base = { w: nat.w * k, h: nat.h * k };
    cropState.scale = 1;
    cropState.imgX = (st.w - cropState.base.w) / 2;
    cropState.imgY = (st.h - cropState.base.h) / 2;
    cropClampImage();
    cropState.frame = cropClampFrame({
        x: cropState.imgX, y: cropState.imgY,
        w: cropState.base.w, h: cropState.base.h
    });
    // 框＝整张图时它的比例就是图片自身比例，但**不锁**（以前会偷偷锁成图片比例，
    // 界面上却看不出锁了，让人以为"选框固定不住"）。想按原图的形状框一小块：
    // 点完它按住 Shift 拉角即可（Shift = 保持按下那一刻的宽高比）
    cropState.ratio = 0;
    cropState.stage = { w: st.w, h: st.h };
    cropRenderRatioBtns();
    cropRender();
    // 尺寸不在这里再报一遍：弹窗里那行「✂️ 结果 ≈ W × H px」已经写着
    if (!silent) showToast('🔳 原图：框住整张图', 1600);
}

function cropFitWhole() { cropShowWhole(false); }

// 刚打开裁剪弹窗：图片完整显示 + 框刚好框住整张图（＝「🔳 原图」的那个状态，比例「自由」）
// 以前这里是"图片铺满裁剪区 + 框取可用区域的内缩 80%"——等于一打开就悄悄帮你裁掉两成，
// 而且裁的是显示尺寸对应的原图像素（分辨率白降一档）。所以「↺ 重置」这个按钮也一起去掉了：
// 想回到初始状态，点「🔳 原图」就是（两者现在是同一个状态）
function cropResetAll() { cropShowWhole(true); }

// 窗口尺寸变了（最大化 / 还原）：把图片和框按新旧裁剪区的比例一起挪过去
// 尺寸用等比（比例锁不会变形），位置各按各的方向 → 框尽量待在原来那块地方
function cropReflowOnResize() {
    if (!cropState || !cropState.natural) return;
    const st = cropStageSize();
    const old = cropState.stage || st;
    if (!old.w || !old.h || !st.w || !st.h) return;
    const kx = st.w / old.w, ky = st.h / old.h;
    const k = Math.min(kx, ky);
    const d = cropDispSize();
    const cx = (cropState.imgX + d.w / 2) * kx, cy = (cropState.imgY + d.h / 2) * ky;
    cropState.base = { w: cropState.base.w * k, h: cropState.base.h * k };
    cropState.imgX = cx - cropState.base.w * cropState.scale / 2;
    cropState.imgY = cy - cropState.base.h * cropState.scale / 2;
    const f = cropState.frame;
    if (f) {
        const fcx = (f.x + f.w / 2) * kx, fcy = (f.y + f.h / 2) * ky;
        f.w *= k; f.h *= k;
        f.x = fcx - f.w / 2; f.y = fcy - f.h / 2;
    }
    cropState.stage = { w: st.w, h: st.h };
    cropClampImage();
    if (cropState.frame) cropState.frame = cropClampFrame(cropState.frame, cropState.ratio);
    cropRender();
}

// 打开裁剪弹窗
// srcPath：缓存目录里的图片（相对路径）
// onDone ：裁剪完成后拿到新图相对路径
// opts   ：{ target: { kind:'node'|'canvas'|'detail', ids:[词条id] } } —— 用来算「贴合目标」的比例
function openCropModal(srcPath, onDone, opts) {
    if (!cropOverlayEl || !cropImageEl) return;
    if (!srcPath || typeof srcPath !== 'string' || srcPath.startsWith('#')) {
        showToast('当前还不是图片背景，先点「🖼️ 选择图片」');
        return;
    }
    if (!api || !api.readImageData) { showToast('功能不可用', 1500); return; }
    opts = opts || {};
    api.readImageData(srcPath).then((res) => {
        if (!res || !res.success) {
            showToast('读取图片失败' + (res && res.error ? '：' + res.error : ''), 2600);
            return;
        }
        cropState = {
            srcPath: srcPath, onDone: onDone, natural: null,
            base: { w: 0, h: 0 }, scale: 1, imgX: 0, imgY: 0,
            frame: null, ratio: 0, ratioHints: [], target: opts.target || null
        };
        cropDrag = null;
        if (cropFrameEl) cropFrameEl.classList.add('hidden');
        if (cropInfoEl) cropInfoEl.textContent = '正在读取图片…';
        if (cropOkBtnEl) cropOkBtnEl.disabled = true;
        cropImageEl.onload = () => {
            if (!cropState) return;
            cropState.natural = { w: cropImageEl.naturalWidth, h: cropImageEl.naturalHeight };
            cropBuildRatioHints();   // 生成比例按钮：自由 / 1:1 / 自适应（画布、详情页、词条，跟随画布时还有"全屏"）
            cropResetAll();          // 摆好图片与常驻裁剪框
            if (cropOkBtnEl) cropOkBtnEl.disabled = false;
        };
        cropImageEl.onerror = () => {
            if (cropInfoEl) cropInfoEl.textContent = '图片加载失败（文件可能已被移动或删除）';
        };
        // 开关状态按上次的选择回填（localStorage 记着，不用每次重勾）
        const lockChk = document.getElementById('cropLockChk');
        if (lockChk) lockChk.checked = cropLock;
        cropOverlayEl.classList.remove('hidden');   // 先显示，舞台才有真实尺寸可算
        cropImageEl.src = res.dataUrl;
        suppressPopupClose = true;                  // 裁剪期间别把下面的背景悬浮窗关掉
    }).catch((e) => showToast('读取图片失败：' + e.message, 2600));
}

function closeCropModal() {
    if (cropOverlayEl) cropOverlayEl.classList.add('hidden');
    if (cropFrameEl) cropFrameEl.classList.add('hidden');
    if (cropImageEl) {
        cropImageEl.onload = null;
        cropImageEl.onerror = null;
        cropImageEl.src = '';
    }
    cropState = null;
    cropDrag = null;
    cropWheelCancel();                           // 丢掉还在攒的滚轮事件
    cropImgBox = { w: -1, h: -1 };               // 下一张图重新写盒子尺寸
    setTimeout(() => { suppressPopupClose = false; }, 200);
}

// 鼠标在舞台里的坐标
function cropPointerPos(e) {
    const r = cropStageEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// —— 滚轮缩放：把一串滚轮事件攒成"每帧一次" ——
// 触控板 / 高分辨率滚轮滚一下会连发十几个 wheel 事件；以前每个事件都整套走一遍
// （量坐标 → 重算 → 改 8 个样式 → 重排 → 把缩小的整张位图重绘一次），
// 图片大、带透明时就明显卡顿。现在一个事件只累加增量，落地交给每帧一次（rAF 对齐合成器；
// 窗口被遮住 / 最小化时 rAF 不来，用 60ms 定时器兜底，免得"滚了没反应"）。
function cropWheelFlush() {
    if (cropWheelRaf) { cancelAnimationFrame(cropWheelRaf); cropWheelRaf = 0; }
    if (cropWheelTimer) { clearTimeout(cropWheelTimer); cropWheelTimer = 0; }
    const factor = cropWheelFactor, pos = cropWheelPos;
    cropWheelFactor = 1; cropWheelPos = null;
    if (factor === 1 || !pos || !cropState) return;
    const r = cropStageEl.getBoundingClientRect();   // 一次批量里只量一次裁剪区（也就只逼一次布局）
    cropZoomImage(factor, { x: pos.x - r.left, y: pos.y - r.top });
}

function cropWheelZoom(zoomIn, clientX, clientY) {
    cropWheelFactor *= zoomIn ? 1.08 : 1 / 1.08;     // 累乘：合并后的总缩放＝一格一格滚的乘积，手感一样
    cropWheelPos = { x: clientX, y: clientY };       // 锚点取这批里最后一次的鼠标位置
    if (!cropWheelRaf) cropWheelRaf = requestAnimationFrame(cropWheelFlush);
    if (!cropWheelTimer) cropWheelTimer = setTimeout(cropWheelFlush, 60);
}

function cropWheelCancel() {
    cropWheelFactor = 1; cropWheelPos = null;
    if (cropWheelRaf) { cancelAnimationFrame(cropWheelRaf); cropWheelRaf = 0; }
    if (cropWheelTimer) { clearTimeout(cropWheelTimer); cropWheelTimer = 0; }
}

// ---- 交互：拖框 / 拉边角改大小 / 拖图片 / 滚轮缩放图片 ----
if (cropStageEl) {
    cropStageEl.addEventListener('mousedown', (e) => {
        if (!cropState || !cropState.frame || e.button !== 0) return;
        const target = e.target;
        const handle = (target && target.closest) ? target.closest('.crop-handle, .crop-edge') : null;
        const inFrame = (target && target.closest) ? target.closest('#cropFrame') : null;
        const p = cropPointerPos(e);
        // 控制点：8 个小方块 + 4 条整边都能拉；Alt + 拖动 = 重新拉一个框
        const mode = handle ? 'resize'
            : (e.altKey ? 'newframe' : (inFrame ? 'frame' : 'image'));
        cropDrag = {
            mode: mode,
            dir: handle ? (handle.dataset.h || '') : '',
            startX: p.x,
            startY: p.y,
            moved: false,
            frame: { x: cropState.frame.x, y: cropState.frame.y, w: cropState.frame.w, h: cropState.frame.h },
            imgX: cropState.imgX,
            imgY: cropState.imgY
        };
        e.preventDefault();
    });

    // 滚轮缩放图片（以鼠标位置为锚点，想留的地方可以放大细看）
    // 事件只累加，真正缩放交给 cropWheelZoom 攒的"每帧一次"（卡顿的来源与修法都写在那边）
    cropStageEl.addEventListener('wheel', (e) => {
        if (!cropState || !cropState.frame) return;
        e.preventDefault();
        cropWheelZoom(e.deltaY < 0, e.clientX, e.clientY);
    }, { passive: false });

    window.addEventListener('mousemove', (e) => {
        if (!cropDrag || !cropState || !cropState.frame) return;
        const p = cropPointerPos(e);
        const dx = p.x - cropDrag.startX, dy = p.y - cropDrag.startY;
        const s = cropDrag.frame;

        if (Math.abs(dx) + Math.abs(dy) > 3) cropDrag.moved = true;

        if (cropDrag.mode === 'image') {          // 拖动图片（往哪拖都行，只要别整张拖没了）
            cropState.imgX = cropDrag.imgX + dx;
            cropState.imgY = cropDrag.imgY + dy;
            cropClampImage();
            if (cropState.frame) cropState.frame = cropClampFrame(cropState.frame, cropState.ratio);
            cropRender();
            return;
        }
        if (cropDrag.mode === 'newframe') {       // Alt + 拖动：重新拉一个新框
            cropState.frame = cropClampFrame({
                x: Math.min(cropDrag.startX, p.x),
                y: Math.min(cropDrag.startY, p.y),
                w: Math.abs(p.x - cropDrag.startX),
                h: Math.abs(p.y - cropDrag.startY)
            });
            cropRender();
            return;
        }
        if (cropDrag.mode === 'frame') {          // 整体拖动裁剪框
            cropState.frame = cropClampFrame({ x: s.x + dx, y: s.y + dy, w: s.w, h: s.h });
            cropRender();
            return;
        }

        // 拉边 / 拉角改框大小（Shift 等比、Ctrl 从中心）
        cropState.frame = cropResizeFrame(s, cropDrag.dir, dx, dy, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey });
        cropRender();
    });

    // 松开鼠标：Alt 点一下没拖动的话，把原来的框还原（避免误触把框弄没了）
    window.addEventListener('mouseup', () => {
        if (cropDrag && cropDrag.mode === 'newframe' && !cropDrag.moved && cropState && cropDrag.frame) {
            cropState.frame = cropClampFrame({ x: cropDrag.frame.x, y: cropDrag.frame.y, w: cropDrag.frame.w, h: cropDrag.frame.h });
            cropRender();
        }
        cropDrag = null;
    });
}

// ---- 按钮绑定 ----
const cropOkBtnEl = document.getElementById('cropOkBtn');
const cropCloseBtnEl = document.getElementById('cropCloseBtn');
const cropCancelBtnEl = document.getElementById('cropCancelBtn');
const cropLockChkEl = document.getElementById('cropLockChk');   // 🔒 锁定裁剪框
const cropZoomInBtnEl = document.getElementById('cropZoomInBtn');
const cropZoomOutBtnEl = document.getElementById('cropZoomOutBtn');
const cropFitBtnEl = document.getElementById('cropFitBtn');
const cropWholeBtnEl = document.getElementById('cropWholeBtn');

// 裁剪框比例：自由 / 1:1 / 4:3 …（选了比例后拉边角会一直保持这个比例）
if (cropRatioBtnsEl) {
    cropRatioBtnsEl.addEventListener('click', (e) => {
        const btn = (e.target && e.target.closest) ? e.target.closest('[data-r]') : null;
        if (!btn || !cropState || !cropState.frame) return;
        cropSetRatio(parseFloat(btn.dataset.r) || 0);
    });
}
if (cropZoomInBtnEl) cropZoomInBtnEl.addEventListener('click', () => cropZoomImage(1.15));
if (cropZoomOutBtnEl) cropZoomOutBtnEl.addEventListener('click', () => cropZoomImage(1 / 1.15));
if (cropFitBtnEl) cropFitBtnEl.addEventListener('click', cropFitCover);   // 居中最大（铺满裁剪区）
if (cropWholeBtnEl) cropWholeBtnEl.addEventListener('click', cropFitWhole);   // 🔳 原图（框住整图，裁出来就是原图）
// 🔒 锁定裁剪框：锁定后框只能在图片里、图片也拖不出裁剪区；解除后还能框到图片外面做透明区
if (cropLockChkEl) {
    cropLockChkEl.checked = cropLock;   // 回填上次的选择
    cropLockChkEl.addEventListener('change', () => cropSetLock(cropLockChkEl.checked));
}
if (cropCloseBtnEl) cropCloseBtnEl.addEventListener('click', closeCropModal);
if (cropCancelBtnEl) cropCancelBtnEl.addEventListener('click', closeCropModal);
if (cropOkBtnEl) cropOkBtnEl.addEventListener('click', () => { cropApplySelection(); });
// Esc 关掉裁剪弹窗（不保存）
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cropState) closeCropModal();
});
// 窗口尺寸变了（最大化/还原）：舞台尺寸跟着变，比例预设重算一次，图片和框按新旧裁剪区的比例挪过去
window.addEventListener('resize', () => {
    if (cropState && cropState.natural) {
        cropBuildRatioHints();   // 窗口 / 舞台尺寸变了，比例预设要跟着重算
        cropReflowOnResize();    // 图片和框一起挪：比例锁不变形，框尽量还待在原来那块地方
    }
});

// 裁剪结果里有没有真透明像素（决定导 PNG 还是 JPEG）
// 先缩到 256 以内扫一张小图：几千万像素的大图也只扫 6 万多个点，很快；
// 缩图时 alpha 会被平均，所以"有一点点透明"也会被扫出来（宁可用 PNG，也不能把透明填成白底）
function cropOutputHasAlpha(cv) {
    try {
        const w = Math.max(1, Math.min(256, cv.width));
        const h = Math.max(1, Math.min(256, cv.height));
        const sm = document.createElement('canvas');
        sm.width = w; sm.height = h;
        const c2 = sm.getContext('2d');
        c2.drawImage(cv, 0, 0, w, h);
        const px = c2.getImageData(0, 0, w, h).data;
        for (let i = 3; i < px.length; i += 4) { if (px[i] < 250) return true; }
        return false;
    } catch (e) {
        return true;   // 读不到像素（理论上不会）：按"有透明"走 PNG，绝不冒险填白
    }
}

// 按裁剪框裁出新图，交给调用方应用（结果是缓存目录里的新文件）
async function cropApplySelection() {
    if (!cropState) return;
    if (!cropState.natural || !cropState.frame) { showToast('图片还没加载好，稍等一下', 1600); return; }
    const f = cropState.frame;
    const d = cropDispSize();
    const overlapW = Math.min(f.x + f.w, cropState.imgX + d.w) - Math.max(f.x, cropState.imgX);
    const overlapH = Math.min(f.y + f.h, cropState.imgY + d.h) - Math.max(f.y, cropState.imgY);
    if (overlapW < 1 || overlapH < 1) {
        showToast('框里没有图片，结果会是一张全透明的图', 3000);   // 不阻止：确实有人就想要一块透明底
    }
    const k = cropPixelScale();                       // 舞台像素 → 原图像素
    const os = cropOutputSize() || { w: 1, h: 1, fullW: 1, fullH: 1, clipped: false, squeezed: false };
    const outW = os.w, outH = os.h;
    // 裁剪框（舞台坐标）换算成原图上的源区域，三种情况：
    //   · 正常：整块框 → 画布同样大（图片内容 1:1）
    //   · 原图自身就超上限（巨图）：整块框 → 画到更小的画布上（＝把框进来的整块等比缩，一个像素都不丢）
    //   · 只是框比图片大（多出来的是透明边）：源区域缩小 → 砍掉多余的透明边，图片内容仍 1:1
    let sx, sy, sw, sh;
    if (os.clipped && !os.squeezed) {
        const rw = os.fullW > 0 ? outW / os.fullW : 1;   // 留下多少比例（<1）
        const rh = os.fullH > 0 ? outH / os.fullH : 1;
        sw = f.w * k * rw;
        sh = f.h * k * rh;
        // 砍的时候以「框 ∩ 图片」的中心为中心（不是框心）：框里的图片偏在一边时，也不会把图片本身裁掉
        const dd = cropDispSize();
        let cx = f.x + f.w / 2, cy = f.y + f.h / 2;
        const ovw = Math.min(f.x + f.w, cropState.imgX + dd.w) - Math.max(f.x, cropState.imgX);
        const ovh = Math.min(f.y + f.h, cropState.imgY + dd.h) - Math.max(f.y, cropState.imgY);
        if (ovw > 0) cx = Math.max(f.x, cropState.imgX) + ovw / 2;
        if (ovh > 0) cy = Math.max(f.y, cropState.imgY) + ovh / 2;
        const halfW = sw / 2 / k, halfH = sh / 2 / k;    // 源区域在舞台上占多宽（源区域不许跑出框外）
        cx = Math.min(Math.max(cx, f.x + halfW), f.x + f.w - halfW);
        cy = Math.min(Math.max(cy, f.y + halfH), f.y + f.h - halfH);
        sx = (cx - cropState.imgX) * k - sw / 2;
        sy = (cy - cropState.imgY) * k - sh / 2;
    } else {
        sx = (f.x - cropState.imgX) * k;
        sy = (f.y - cropState.imgY) * k;
        sw = f.w * k;
        sh = f.h * k;
    }
    const cv = document.createElement('canvas');
    cv.width = outW; cv.height = outH;
    try {
        const ctx = cv.getContext('2d');
        ctx.drawImage(cropImageEl, sx, sy, sw, sh, 0, 0, outW, outH);   // 不填白：透明的地方就让它保持透明
    } catch (e) {
        showToast('裁剪失败：' + e.message, 2600);
        return;
    }
    let dataUrl = '';
    try {
        // 按"框里到底有没有真透明像素"选格式，而不是按"框有没有超出图片"：
        //   以前是"框在图片里 → 填白 + JPEG"，于是上一轮裁出来的透明区，第二轮进来再裁就被填成白底、
        //   还被 JPEG 压一遍（就是"背景图变白 + 分辨率被拉低"那个 bug）
        dataUrl = cropOutputHasAlpha(cv) ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.95);
    } catch (e) {
        showToast('导出裁剪结果失败：' + e.message, 2600);
        return;
    }
    const srcName = cropState.srcPath.split('/').pop();
    const onDone = cropState.onDone;
    if (cropOkBtnEl) cropOkBtnEl.disabled = true;
    let res = null;
    try {
        res = await api.saveCroppedImage({ dataUrl: dataUrl, sourceName: srcName });
    } finally {
        if (cropOkBtnEl) cropOkBtnEl.disabled = false;
    }
    if (!res || !res.success) {
        showToast('保存裁剪图失败' + (res && res.error ? '：' + res.error : ''), 2600);
        return;
    }
    closeCropModal();
    if (typeof onDone === 'function') onDone(res.filePath);
    if (os.clipped) {
        showToast(os.squeezed
            ? `✂️ 已裁剪并应用（原图超过 ${CROP_MAX_OUT}px，结果缩到上限内）`
            : `✂️ 已裁剪并应用（只砍了多出来的透明边）`, 3600);
    } else {
        showToast('✂️ 已裁剪并应用', 2200);
    }
}

// 悬浮窗里的「✂️ 框选裁剪」：裁完直接作为该场景的新背景图
const colorPopupCropBtn = document.getElementById('colorPopupCrop');
if (colorPopupCropBtn) {
    colorPopupCropBtn.addEventListener('click', () => {
        const src = colorPopupCurrentImage();
        if (!src) { showToast('当前还没有背景图，先点「🖼️ 选择图片」'); return; }
        const scope = colorPopupState && colorPopupState.fitScope;
        const ids = ((colorPopupState && colorPopupState.fitTargets) || []).map(t => t && t.id).filter(Boolean);
        openCropModal(src, (newRel) => {
            if (colorPopupApply) colorPopupApply(newRel, 'image');
            if (colorPopupState) {
                // 同步"当前背景图"，方便接着再裁
                if (colorPopupState.fitScope === 'canvas') currentProject.canvasBg = newRel;
                (colorPopupState.fitTargets || []).forEach(t => { if (t) t.bgImage = newRel; });
            }
            colorPopupMode = 'image';
            updateColorPopupValue();
        }, {
            // 「贴合目标」比例：画布背景 → 画布可视区；词条背景 → 那个词条卡片的实际比例
            target: scope === 'canvas' ? { kind: 'canvas' } : { kind: 'node', ids: ids }
        });
    });
}

// ============================================================
// 复制 / 粘贴词条（支持多选 + Ctrl+C / Ctrl+V）
// ============================================================
let clipboardNodes = [];

function copyNodes(list) {
    if (!list || list.length === 0) return;
    // 按编号顺序进剪贴板（1、2、3…10）—— 粘贴时是照剪贴板的先后依次落位的；
    // 以前直接用 nodes 数组的顺序（＝创建 / 导入顺序），看起来就像"随机"
    clipboardNodes = list.slice().sort(compareNodeNumbers).map(node => {
        const src = getNodeSource(node);
        return {
            title: src ? (src.title || '') : (node.title || ''),
            summary: src ? (src.summary || '') : (node.summary || ''),
            content: src ? (src.content || '') : (node.content || ''),
            // 样式也一起带上（卡片颜色 / 文字颜色 / 背景图片）
            color: node.color || getColor(),
            textColor: node.textColor,
            bgImage: node.bgImage
        };
    });
    showToast(`已复制 ${clipboardNodes.length} 个词条${clipboardNodes.length > 1 ? '（按编号顺序）' : ''}`);
}

// 右键词条复制：多选时复制全部选中，否则复制单个
function copyNode(node) {
    cancelCutPending();   // 复制新内容 = 放弃之前的剪切（否则粘贴时会连带把剪切的词条删掉）
    if (selectedIds.has(node.id) && selectedIds.size > 1) {
        copyNodes(currentProject.nodes.filter(n => selectedIds.has(n.id)));
    } else {
        copyNodes([node]);
    }
}

// 快捷键复制：多选优先，其次当前详情词条（不包含根词条）
function copySelectedNodes() {
    cancelCutPending();   // 同上：复制即放弃之前的剪切
    const list = currentProject.nodes.filter(n =>
        (selectedIds.has(n.id) || n.id === currentSelectedId) && n.parentId !== '__root__');
    copyNodes(list);
}

// 剪切待粘贴：像 Windows 那样先变"淡灰"而不是直接消失；
// 到目标画布 Ctrl+V 时才真正移除原词条
function cancelCutPending() {
    if (!cutPendingIds.size) return;
    cutPendingIds.clear();
    clipboardNodes = [];   // 取消剪切时剪贴板一起清空（否则它会被当成"复制"，还能再粘）
    renderCanvas();
}
function consumeCutPending() {
    if (!cutPendingIds.size) return;
    const ids = new Set(cutPendingIds);
    ids.delete(rootNodeId);   // 双保险：绝不删除根词条
    cutPendingIds.clear();
    currentProject.connections = currentProject.connections.filter(c => !ids.has(c.from) && !ids.has(c.to));
    currentProject.nodes = currentProject.nodes.filter(n => !ids.has(n.id));
    if (ids.has(currentContextId)) { currentContextId = rootNodeId; currentSelectedId = rootNodeId; }
}

// 剪切：内容进剪贴板 + 原词条标记为"待移动"（淡灰显示，不删除、不进回收站）
function cutSelectedNodes() {
    const list = currentProject.nodes.filter(n =>
        (selectedIds.has(n.id) || n.id === currentSelectedId) && n.parentId !== '__root__');   // 根词条不参与
    if (!list.length) { showToast('请先选中词条'); return; }
    copyNodes(list);
    cancelCutPending();                     // 先清掉上一次的待剪切标记（恢复它们）
    list.forEach(n => cutPendingIds.add(n.id));
    selectedIds.clear();
    renderCanvas();                          // 淡灰显示
    showToast(`已剪切 ${list.length} 个词条`, 1800);
}

// 右键单个词条剪切：多选时剪全部，否则剪这一个
function cutNode(node) {
    if (!node) return;
    if (!(selectedIds.has(node.id) && selectedIds.size > 1)) {
        selectedIds.clear();
        selectedIds.add(node.id);
    }
    cutSelectedNodes();
}

function pasteClipboard() {
    if (clipboardNodes.length === 0) { showToast('剪贴板为空'); return; }
    const parentId = getDisplayParentId();
    pushUndo('粘贴词条');
    // 是"剪切粘贴"吗？（剪切是单次的：粘贴成功后剪贴板要清空，不能再粘第二次）
    const wasCut = cutPendingIds.size > 0;
    const cutCount = clipboardNodes.length;
    consumeCutPending();   // 若刚剪切过：此刻才真正移除原词条（即"移动"完成）
    const added = clipboardNodes.map(c => {
        const pos = getNextNodePosition(parentId, (pastePosMode === 'mouse' && lastCanvasPointer) ? lastCanvasPointer : null);
        const newNode = {
            id: genId(),
            title: c.title,
            summary: c.summary || '',
            content: c.content || '',
            parentId: parentId,
            x: pos.x,
            y: pos.y,
            color: c.color || getColor(),
            textColor: c.textColor,      // 样式一起粘过来
            bgImage: c.bgImage,
            lastModified: Date.now(),    // 粘贴的视为最新修改 → 渲染时显示在最上层
            number: '?'
        };
        currentProject.nodes.push(newNode);
        return newNode;
    });
    if (wasCut) clipboardNodes = [];   // 剪切 = 单次（和 Windows 一致）：粘贴一次后结束
    renderAll();
    if (wasCut) showToast(`已移动 ${cutCount} 个词条`, 1800);
    showToast(`已粘贴 ${added.length} 个词条`);
}

// ============================================================
// 撤销（Ctrl+Z）：可撤回删除、移动、换色、连接等操作
// ============================================================
let undoStack = [];
function pushUndo(label) {
    undoStack.push({
        label: label || '',
        nodes: JSON.parse(JSON.stringify(currentProject.nodes)),
        connections: JSON.parse(JSON.stringify(currentProject.connections)),
        trash: JSON.parse(JSON.stringify(currentProject.trash)),
        // 项目级样式设置（画布/详情页背景、文字色、显示方式、跟随开关），
        // 这样"清除背景""重置样式"之后都能 Ctrl+Z 撤回
        canvasBg: currentProject.canvasBg,
        canvasBgFit: currentProject.canvasBgFit,
        detailBg: currentProject.detailBg,
        detailBgFit: currentProject.detailBgFit,
        detailBgLink: currentProject.detailBgLink,
        detailTextColor: currentProject.detailTextColor
    });
    if (undoStack.length > 50) undoStack.shift();
}
function undo() {
    // 若当前有"剪切待粘贴"：Ctrl+Z 先取消剪切（恢复颜色），**不消耗撤销栈**、更不会删词条
    if (cutPendingIds.size) {
        cancelCutPending();
        showToast('已取消剪切', 1600);
        return;
    }
    if (undoStack.length === 0) { showToast('没有可撤回的操作'); return; }
    clipboardNodes = [];     // 清空剪贴板：撤销后不该还能粘贴（避免变成"复制"）
    const snap = undoStack.pop();
    currentProject.nodes = snap.nodes;
    currentProject.connections = snap.connections;
    currentProject.trash = snap.trash;
    // 恢复项目级样式设置（旧快照可能没有这些字段，按"未设置"处理）
    const restoreField = (key, field) => {
        if (snap[key] === undefined || snap[key] === null) delete currentProject[field];
        else currentProject[field] = snap[key];
    };
    restoreField('canvasBg', 'canvasBg');
    restoreField('canvasBgFit', 'canvasBgFit');
    restoreField('detailBg', 'detailBg');
    restoreField('detailBgFit', 'detailBgFit');
    restoreField('detailBgLink', 'detailBgLink');
    restoreField('detailTextColor', 'detailTextColor');
    // 若当前上下文被回滚掉，回到根
    if (!currentProject.nodes.find(n => n.id === currentContextId)) {
        currentContextId = rootNodeId;
        currentSelectedId = rootNodeId;
    }
    selectedIds.clear();
    applyCanvasBg();      // 画布背景（含"跟随"）也要跟着还原，不然只恢复详情页
    applyDetailBg();
    renderAll();
    showToast(snap.label ? ('已撤回：' + snap.label) : '已撤回上一步', 2200);
}

// ============================================================
// 导入 TXT/MD、导出 Markdown
// ============================================================

// 解析 Markdown 标题层级 → 词条树
function parseMarkdown(content) {
    const lines = (content || '').split(/\r?\n/);
    const roots = [];
    const stack = [];
    let currentText = [];
    let intro = [];

    function flushTo(node) {
        const text = currentText.join('\n').trim();
        if (text) {
            if (node) {
                node.content = (node.content ? node.content + '\n\n' : '') + text;
            } else {
                intro.push(text);
            }
        }
        currentText = [];
    }

    lines.forEach(line => {
        const m = line.match(/^(#{1,6})\s+(.*)/);
        if (m) {
            flushTo(stack.length ? stack[stack.length - 1].node : null);
            const level = m[1].length;
            const title = m[2].trim();
            const node = { title: title, content: '', children: [] };
            while (stack.length > 0 && stack[stack.length - 1].level >= level) {
                stack.pop();
            }
            if (stack.length === 0) {
                roots.push(node);
            } else {
                stack[stack.length - 1].node.children.push(node);
            }
            stack.push({ level: level, node: node });
        } else {
            currentText.push(line);
        }
    });
    flushTo(stack.length ? stack[stack.length - 1].node : null);
    return { roots: roots, intro: intro.join('\n\n') };
}

// 在当前画布下递归创建词条树，返回创建数量
function createNodeTreeInCanvas(nodes, parentId) {
    let count = 0;
    nodes.forEach((node) => {
        // 每个父级下的子词条按实际尺寸找空白处（统一 26px 间隔，不重叠）
        const pos = getNextNodePosition(parentId);
        const newNode = {
            id: genId(),
            title: node.title || '未命名',
            summary: '',
            content: node.content || '',
            parentId: parentId,
            x: pos.x,
            y: pos.y,
            color: getColor(),
            number: '?',
            needsLayout: true  // 首次渲染该画布时自动按顺序流式排列
        };
        currentProject.nodes.push(newNode);
        count++;
        count += createNodeTreeInCanvas(node.children, newNode.id);
    });
    return count;
}

// 编辑器内导入 TXT / MD：MD 按标题分级，TXT 整文件一个词条
async function importTextFile() {
    try {
        const result = await api.importTextFile();
        if (!result || !result.success || !result.files || result.files.length === 0) return;
        importFilesInEditor(result.files);
    } catch (e) {
        showToast('导入失败: ' + e.message);
    }
}

// 导入时递归布局：对整棵子树按标题长度估算宽度流式排列（进入各层画布时按实际尺寸再修正）
function layoutSubtree(rootId) {
    const kids = currentProject.nodes.filter(n => n.parentId === rootId && n.parentId !== '__root__');
    const GAP = 25, START_X = 24, START_Y = 24;
    const maxW = canvas ? (canvas.clientWidth - 24) : 1000;
    let x = START_X, y = START_Y;
    kids.forEach(k => {
        const w = Math.max(120, (getNodeTitle(k) || '').length * 15 + 40);  // 按标题长度估算宽度
        const h = 96;
        if (x + w > maxW && x > START_X) { x = START_X; y += h + GAP; }
        k.x = x;
        k.y = y;
        x += w + GAP;
        layoutSubtree(k.id);
    });
}

// 编辑器内导入文件数组（右键菜单和拖拽导入都走这里）
function importFilesInEditor(files) {
    const parentId = getDisplayParentId();
    pushUndo();
    let total = 0;
    files.forEach(f => {
        const isMd = /\.(md|markdown)$/i.test(f.filePath || '');
        if (isMd) {
            const parsed = parseMarkdown(f.content || '');
            const baseTitle = f.name || '导入文件';
            // MD 作为一个新词条（标题=文件名）出现在当前画布，标题层级作为它的子词条树
            const pos = getNextNodePosition(parentId);
            const wrapper = {
                id: genId(),
                title: baseTitle,
                summary: '',
                content: parsed.intro || '',
                parentId: parentId,
                x: pos.x, y: pos.y,
                color: getColor(), number: '?',
                needsLayout: true  // 首次渲染该画布时自动按顺序流式排列
            };
            currentProject.nodes.push(wrapper);
            total++;
            // 若第一个标题与文件名同名，跳过它（避免套壳），其内容并入正文
            let roots = parsed.roots;
            if (roots.length && roots[0].title === baseTitle) {
                const first = roots[0];
                wrapper.content = (parsed.intro ? parsed.intro + '\n\n' : '') + (first.content || '');
                roots = first.children.concat(roots.slice(1));
            }
            total += createNodeTreeInCanvas(roots, wrapper.id);
            layoutSubtree(wrapper.id);  // 一次性递归排列该文件所有层级的子词条（进入画布后按实际尺寸再修正）
        } else {
            const pos = getNextNodePosition(parentId);
            currentProject.nodes.push({
                id: genId(),
                title: f.name || '导入文件',
                summary: '',
                content: f.content || '',
                parentId: parentId,
                x: pos.x, y: pos.y,
                color: getColor(), number: '?',
                needsLayout: true  // 首次渲染该画布时自动按顺序流式排列
            });
            total++;
        }
    });
    renderAll();
    scheduleSave();
    showToast(`已导入 ${total} 个词条`);
}

// 递归生成 Markdown 文本
function buildMarkdownTree() {
    return buildMarkdownFromData(currentProject, currentProjectName);
}

// 从任意项目数据生成 Markdown（支持导出其他小说）
function buildMarkdownFromData(data, projectName) {
    const nodes = data.nodes || [];
    const root = nodes.find(n => n.parentId === '__root__');
    let md = '# ' + (data.projectName || projectName || '未命名项目') + '\n\n';
    function nodeToMd(id, level) {
        const kids = nodes
            .filter(n => n.parentId === id && n.parentId !== '__root__')
            .sort((a, b) => (a.number || '').localeCompare(b.number || ''));
        kids.forEach(k => {
            md += '#'.repeat(level) + ' ' + (k.title || '未命名') + '\n\n';
            if (k.summary) md += k.summary + '\n\n';
            if (k.content) md += k.content + '\n\n';
            nodeToMd(k.id, level + 1);
        });
    }
    nodeToMd(root ? root.id : '__root__', 2);
    return md;
}

// 导出当前项目为 Markdown 文件
async function exportMarkdown() {
    try {
        const md = buildMarkdownTree();
        const result = await api.exportMarkdown(md, currentProjectName);
        if (result && result.success) {
            showToast('已导出 Markdown');
        }
    } catch (e) {
        showToast('导出失败: ' + e.message);
    }
}

// ============================================================
// 书库页批量导入 / 导出
// ============================================================

// 书库页导入：每个文件创建一本新小说（MD 按标题分级）
async function importProjectFromFiles() {
    try {
        const result = await api.importTextFile();
        if (!result || !result.success || !result.files || result.files.length === 0) return;
        let created = 0;
        for (const f of result.files) {
            if (await createProjectFromFile(f)) created++;
        }
        showToast(`已导入 ${created} 本小说`);
        loadProjects();
    } catch (e) {
        showToast('导入失败: ' + e.message);
    }
}

// 创建项目，文件名已存在时自动加编号 (1)(2)…
async function createUniqueProject(name) {
    let n = name;
    let counter = 1;
    let res = await api.createProject(n);
    while (!res.success && counter < 100) {
        counter++;
        n = name + '(' + counter + ')';
        res = await api.createProject(n);
    }
    return { ...res, finalName: n };
}

// 从单个文件数据创建一本新小说（MD 按标题分级；TXT 全文放根详情）
async function createProjectFromFile(f) {
    const isMd = /\.(md|markdown)$/i.test(f.filePath || '');
    const parsed = isMd ? parseMarkdown(f.content || '') : null;
    const createRes = await createUniqueProject(f.name || '导入小说');
    if (!createRes.success) return false;
    const projectName = createRes.finalName || f.name || '导入小说';
    const data = {
        projectName: projectName,
        version: '2.0',
        nodes: [],
        connections: [],
        trash: [],
        bookTrash: [],
        canvasBg: null,
        detailBg: null,
        createdAt: Date.now()
    };
    // 根节点（书名详情 = 无标题文本；TXT 全文放根详情）
    const root = {
        id: genId(),
        title: projectName,
        summary: '',
        content: parsed ? parsed.intro : (f.content || ''),
        parentId: '__root__',
        isRoot: true,
        x: 0, y: 0, color: '#ffffff', number: '0'
    };
    data.nodes.push(root);
    // 每个父级下的子词条按流式排列（新词条放上一个右边界 + 25px 缝隙外，估算 160×100，超右边界换行）
    function nextPos(parent) {
        const GAP = 25, START_X = 24, START_Y = 24;
        const kids = data.nodes.filter(n => n.parentId === parent && n.parentId !== '__root__');
        if (kids.length === 0) return { x: START_X, y: START_Y };
        let prev = null;
        kids.forEach(k => {
            if (!prev || (k.y || 0) > (prev.y || 0) || ((k.y || 0) === (prev.y || 0) && (k.x || 0) > (prev.x || 0))) {
                prev = k;
            }
        });
        const maxW = (canvas.clientWidth || 900) - 40;
        let nx = (prev.x || 0) + 160 + GAP;
        let ny = prev.y || 0;
        if (nx + 160 > maxW) { nx = START_X; ny = (prev.y || 0) + 100 + GAP; }
        return { x: nx, y: ny };
    }
    function addNodeTree(node, parent) {
        const pos = nextPos(parent);
        const newNode = {
            id: genId(),
            title: node.title || '未命名',
            summary: '',
            content: node.content || '',
            parentId: parent,
            x: pos.x, y: pos.y,
            color: getColor(), number: '?',
            needsLayout: true  // 首次打开该画布时自动按顺序流式排列
        };
        data.nodes.push(newNode);
        (node.children || []).forEach(c => addNodeTree(c, newNode.id));
    }
    if (parsed) {
        // 书库页导入：直接把内容层级平铺到根画布——首个 H1 视为书名（有子级时）跳过，内容并入根详情
        let roots = parsed.roots;
        if (roots.length) {
            const first = roots[0];
            if (first.children.length > 0) {
                root.content = (parsed.intro ? parsed.intro + '\n\n' : '') + (first.content || '');
                roots = first.children.concat(roots.slice(1));
                // 保底：跳过书名后没有剩余词条，则保留书名本身（保证画布有内容）
                if (roots.length === 0) {
                    root.content = parsed.intro || '';
                    roots = [first];
                }
            } else {
                // 首个 H1 是叶子（无子标题）→ 保留它，根详情只放 intro
                root.content = parsed.intro || '';
            }
        }
        roots.forEach(r => addNodeTree(r, root.id));
    }
    await api.saveProject(createRes.filePath, data);
    return true;
}

// 书库页批量导出：把小说库所有小说导出为 Markdown 到所选文件夹
async function exportAllBooks() {
    try {
        const files = [];
        for (const p of currentProjectsCache) {
            const res = await api.loadProject(p.filePath);
            if (res.success) {
                files.push({ fileName: p.name, content: buildMarkdownFromData(res.data, p.name) });
            }
        }
        if (files.length === 0) { showToast('没有可导出的小说'); return; }
        const result = await api.exportAllMarkdown(files);
        if (result && result.success) {
            showToast(`已导出 ${result.count} 本小说`);
        }
    } catch (e) {
        showToast('导出失败: ' + e.message);
    }
}

// 多选批量换色
// 多选批量换色/改文字色（右键菜单调用，支持图片背景和文字颜色）
function recolorSelectedNodes(x, y) {
    if (selectedIds.size === 0) { showToast('请先选择词条'); return; }
    const first = currentProject.nodes.find(n => selectedIds.has(n.id));
    const curColor = (first && first.color && first.color.startsWith('#')) ? first.color : '#ffffff';
    const curText = (first && first.textColor) || '#1a1a2e';
    openColorPopup('🎨 批量颜色', curColor, (val, m) => {
        pushUndo('批量修改颜色');
        currentProject.nodes.forEach(n => {
            if (!selectedIds.has(n.id)) return;
            if (m === 'text') {
                if (val === null) delete n.textColor;
                else n.textColor = val;
                return;
            }
            if (val === null) {
                n.color = '#ffffff';
                delete n.bgImage;
                delete n.bgTransparent;
            } else if (val.startsWith('#')) {
                n.color = val;
                delete n.bgImage;
                delete n.bgTransparent;
            } else {
                n.bgImage = val;
                n.bgTransparent = true;      // 选了图片背景 → 透明底自动打开
            }
        });
        renderCanvas();
        scheduleSave();
        showToast(m === 'text' ? `已更新 ${selectedIds.size} 个词条文字颜色` : `已更新 ${selectedIds.size} 个词条背景`);
        // 应用后保持弹窗打开，方便继续调整；点弹窗以外的空白处才关闭
    }, { x: x, y: y, showImage: true, allowText: true, textColor: curText, fitTargets: currentProject.nodes.filter(n => selectedIds.has(n.id)) });
}



// 点击空白处/进行其他交互时关闭背景悬浮窗
// 注意用 mousedown（而不是 click）：弹出层里的按钮点击后可能会重建自身，
// 到 click 阶段 e.target 已脱离 DOM，会被误判为"点了外面"而把弹窗关掉
let suppressPopupClose = false;  // 打开悬浮窗的本次点击不触发关闭（由 setTimeout 清除）
document.addEventListener('mousedown', (e) => {
    if (suppressPopupClose) return;
    const cp = document.getElementById('colorPopup');
    if (cp && !cp.classList.contains('hidden') && !cp.contains(e.target)) {
        cp.classList.add('hidden');
        colorPopupApply = null;
    }
    const dbg = document.getElementById('detailBgPanel');
    if (dbg && !dbg.classList.contains('hidden') && !dbg.contains(e.target)) {
        dbg.classList.add('hidden');
    }
});

// ============================================================
// 工具栏按钮
// ============================================================

btnLock.addEventListener('click', () => {
    isLockedState = !isLockedState;
    if (currentFilePath) bookLockState.set(currentFilePath, isLockedState);   // 按书记住（本次运行内）
    document.body.classList.toggle('locked', isLockedState);  // 开启时词条光标变回普通箭头
    if (isLockedState) {
        btnLock.textContent = '🔒';
        showToast('已开启防误操作（禁止拖拽和框选，跳转不受影响）');
    } else {
        btnLock.textContent = '🔓';
        showToast('已关闭防误操作');
    }
    // 刷新画布，让状态立即生效
    renderCanvas();
});

btnConnect.addEventListener('click', () => {
    if (mode === 'connect') { resetModes(); renderAll(); return; }
    setMode('connect');
});

btnCancelMode.addEventListener('click', () => {
    // 取消模式：同时关闭防误操作、关闭词条/书籍回收站面板
    if (isLockedState) {
        isLockedState = false;
        if (currentFilePath) bookLockState.set(currentFilePath, false);
        btnLock.textContent = '🔓';
        document.body.classList.remove('locked');
    }
    resetModes();  // 会关闭词条回收站/书籍回收站面板
    renderAll();
    showToast('✖ 已退出其他模式');
});

btnSave.addEventListener('click', () => saveCurrentProject(false));

// ============================================================
// 跳转输入
// ============================================================

let jumpMode = 'title';  // 'title' 编号/标题 | 'body' 正文搜索
const jumpModeBtn = document.getElementById('jumpModeBtn');

function updateJumpModeUI() {
    if (jumpMode === 'body') {
        jumpModeBtn.textContent = '📄';
        jumpInput.placeholder = '搜索正文…';        // 图标已在左侧切换按钮上，输入框内不再重复
    } else {
        jumpModeBtn.textContent = '🔢';
        jumpInput.placeholder = '编号 / 标题跳转';
    }
}

jumpModeBtn.addEventListener('click', () => {
    jumpMode = (jumpMode === 'title') ? 'body' : 'title';
    updateJumpModeUI();
    jumpInput.focus();
    // 切换模式后：立即按新模式重新搜索并显示建议（不丢失输入与结果）
    doJumpSearch();
});

// 按当前模式搜索并显示建议列表（输入、切换模式、回车共用）
// 建议列表里一项的标签：根节点是"这本书本身"，用《书名》（本书）表示
// （不写"编号 0"，用户不知道 0 是什么）
function jumpItemLabel(n) {
    if (n && n.isRoot) return `《${getNodeTitle(n) || '未命名'}》（本书）`;
    return `${n.number || '?'} · ${getNodeTitle(n)}`;
}

// 按当前模式搜索并显示建议列表（输入、切换模式、回车共用）
function doJumpSearch() {
    const q = jumpInput.value.trim();
    if (!q) { jumpSuggestions.style.display = 'none'; return; }
    let results;
    // 根节点（词条 0）就是"这本书本身"：它的标题/简介/正文也要能搜到
    // —— 否则搜书名或本书设定内容会"明明有却搜不到"
    if (jumpMode === 'body') {
        const ql = q.toLowerCase();
        results = currentProject.nodes.filter(n =>
            (getNodeTitle(n) + ' ' + getNodeSummary(n) + ' ' + getNodeContent(n)).toLowerCase().includes(ql)
        ).slice(0, 8);
    } else {
        results = currentProject.nodes.filter(n =>
            (n.number && n.number.includes(q)) || (getNodeTitle(n).toLowerCase().includes(q.toLowerCase()))
        ).slice(0, 8);
    }
    if (results.length === 0) { jumpSuggestions.style.display = 'none'; return; }
    jumpSuggestions.innerHTML = '';
    results.forEach(n => {
        const item = document.createElement('div');
        item.style.cssText = 'padding:8px 12px; cursor:pointer; font-size:14px; color:var(--text-primary); border-bottom:1px solid var(--border-color);';
        if (jumpMode === 'body') {
            const content = getNodeContent(n) || '';
            const idx = content.toLowerCase().indexOf(q.toLowerCase());
            const snippet = idx >= 0 ? content.slice(Math.max(0, idx - 20), idx + 30) : (getNodeSummary(n) || '');
            item.innerHTML = `<div style="font-weight:600;">${escapeHtml(jumpItemLabel(n))}</div><div style="font-size:12px; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(snippet)}</div>`;
        } else {
            item.textContent = jumpItemLabel(n);
        }
        item.addEventListener('mouseenter', () => { item.style.background = 'var(--primary-light)'; });
        item.addEventListener('mouseleave', () => { item.style.background = ''; });
        item.addEventListener('click', () => {
            jumpInput.value = '';
            jumpSuggestions.style.display = 'none';
            pushHistory(currentContextId);
            currentContextId = n.id;
            currentSelectedId = n.id;
            renderAll();
            // 正文模式跳转后自动高亮关键词
            if (jumpMode === 'body' && q) {
                setTimeout(() => {
                    detailFindInput.value = q;
                    detailFindBar.style.display = 'flex';
                    doFind(true);
                    syncDetailFindClear();   // 程序填进去的词：✕ 也要跟着出现（以前只有手打才出现）
                }, 120);
            }
        });
        jumpSuggestions.appendChild(item);
    });
    jumpSuggestions.style.display = 'block';
}

jumpInput.addEventListener('input', doJumpSearch);
// 搜索框右边的 ✕：有内容才出现，点一下清空（编号/标题搜索与正文搜索都适用）
const jumpClearBtnEl = document.getElementById('jumpClearBtn');
const syncJumpClear = () => { if (jumpClearBtnEl) jumpClearBtnEl.style.display = jumpInput.value.trim() ? 'inline-block' : 'none'; };
if (jumpClearBtnEl) {
    jumpClearBtnEl.addEventListener('click', () => {
        jumpInput.value = '';
        doJumpSearch();
        syncJumpClear();
        jumpInput.focus();
    });
}
jumpInput.addEventListener('input', syncJumpClear);
syncJumpClear();

// 搜索框右侧的搜索按钮：点击立即按当前模式搜索并显示结果（stopPropagation 防止被外部点击关闭列表）
const jumpSearchBtn = document.getElementById('jumpSearchBtn');
if (jumpSearchBtn) {
    jumpSearchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!jumpInput.value.trim()) { jumpInput.focus(); return; }
        doJumpSearch();
    });
}

jumpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (!jumpInput.value.trim()) return;
        doJumpSearch();  // 回车：按当前模式重新搜索并显示结果列表（不再直接跳转）
        if (jumpSuggestions.style.display === 'none') {
            showToast('未找到匹配词条', 1200);
        }
    }
});

document.addEventListener('click', (e) => {
    if (!jumpSuggestions.contains(e.target) && e.target !== jumpInput) {
        jumpSuggestions.style.display = 'none';
    }
});

// ============================================================
// 模态框
// ============================================================

function openModal(html, opts) {
    modalContent.innerHTML = html;
    modalOverlay.classList.remove('hidden');
    modalOverlay.style.zIndex = '';   // 复位成 CSS 里的默认层级（7000）
    // opts.plain = true：遮罩完全透明（设置/帮助这类需要边看界面边操作的弹窗）
    const plain = !!(opts && opts.plain);
    modalOverlay.classList.toggle('plain', plain);
    modalContent.classList.toggle('glass', plain);  // 配套：弹窗本体用毛玻璃半透明
    // opts.top = true：贴偏上出现（⚙️ 设置面板用它 —— 展开「🖥️ 全局设置」这类长内容时只往下长，
    // 顶边不动；居中时一展开就上下一起撑，顶边往上蹿）；
    // 其余弹窗（改名 / 帮助 / 各种确认框）都居中 —— 见 style.css 的 .modal-overlay。
    // ⚠ 这是"按次"开关：不传 top 的调用一律居中 —— 想只给某一份弹窗换位置，改它的调用参数就行，不会连累别的弹窗
    modalOverlay.classList.toggle('top', !!(opts && opts.top));
    // opts.backToSettings = true：这是从设置面板里开出来的二级弹窗，关闭后要回到设置面板
    modalReturnToSettings = !!(opts && opts.backToSettings);
    // opts.onClose：弹窗关掉后的收尾（比如把"暂时别关下面悬浮窗"的开关放回去）
    modalOnClose = (opts && typeof opts.onClose === 'function') ? opts.onClose : null;
}

let modalReturnToSettings = false;
let modalOnClose = null;
function closeModal() {
    modalOverlay.classList.add('hidden');
    modalOverlay.style.zIndex = '';   // 复位：普通弹窗仍然是 7000

    modalContent.innerHTML = '';
    if (modalOnClose) {
        const fn = modalOnClose;
        modalOnClose = null;
        try { fn(); } catch (e) {}
    }
    if (modalReturnToSettings) {
        modalReturnToSettings = false;
        // 从设置面板进来的二级弹窗（如初始化确认）：取消/点空白关闭后回到设置，而不是整个关掉
        setTimeout(() => { try { openResetModal(); } catch (e) {} }, 0);
    }
}

// 「📜 开源许可」弹窗（帮助面板底部入口）：协议要点 + 第三方组件
// 完整原文随软件一起分发（安装目录下的 LICENSE / THIRD-PARTY-NOTICES.md）
function showLicenseModal() {
    openModal(`
        <div class="modal-header">
            <h2>📜 开源许可</h2>
            <button type="button" class="close-btn" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body" style="font-size:13px; line-height:1.9; color:var(--text-secondary);">
            <p style="font-size:14px; color:var(--text-primary); margin-bottom:4px;">小说设定管理器 — MIT 协议</p>
            <p style="margin-bottom:10px;">Copyright (c) 2026 ysqjl</p>
            <p style="margin-bottom:10px;">你可以自由地使用、复制、修改、合并、发布、分发、再授权甚至销售本软件；<b>唯一的要求是保留上面的版权声明和许可声明</b>。本软件按「原样」提供，作者不对使用中产生的任何损失负责。</p>
            <p style="color:var(--text-primary); margin-bottom:6px;"><b>本软件使用的开源项目</b></p>
            <ul style="padding-left:20px; margin-bottom:10px;">
                <li><b>Electron</b> — MIT License</li>
                <li><b>Chromium</b> — BSD 3-Clause License</li>
                <li><b>Node.js</b> — MIT License</li>
            </ul>
            <p>完整协议原文在软件安装目录：<code>LICENSE</code>（MIT 全文）、<code>THIRD-PARTY-NOTICES.md</code>（第三方组件清单）；Electron / Chromium 的官方许可汇编为同目录的 <code>LICENSE.electron.txt</code> 与 <code>LICENSES.chromium.html</code>。</p>
        </div>
        <div class="modal-footer">
            <button class="btn-cancel" onclick="closeModal()">关闭</button>
        </div>
    `);
    // 帮助面板用的是同一个 z-index(7000) 且 DOM 里更靠后，不抬高就会被帮助盖住
    modalOverlay.style.zIndex = '7100';
}

// 「有改动还没保存」的离开确认弹窗（只在关掉自动保存、且确实有没保存的改动时才会出现）
// onLeave：用户选了「保存并退出」或「不保存」后要继续执行的动作（退出这本书 / 关闭软件）
function askSaveBeforeLeave(onLeave) {
    openModal(`
        <div class="modal-header">
            <h2>⚠️ 有改动还没保存</h2>
            <button type="button" class="close-btn" id="leaveCloseBtn">✕</button>
        </div>
        <div class="modal-body">
            <p style="font-size:14px; line-height:1.8; color:var(--text-primary);">
                有未保存内容，是否保存后再退出？
            </p>
        </div>
        <div class="modal-footer">
            <button type="button" class="btn-delete" id="leaveDiscardBtn">不保存</button>
            <button type="button" class="btn-save" id="leaveSaveBtn">保存并退出</button>
        </div>
    `);
    const stay = () => closeModal();
    const closeBtn = document.getElementById('leaveCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', stay);
    const discardBtn = document.getElementById('leaveDiscardBtn');
    if (discardBtn) discardBtn.addEventListener('click', () => {
        leaveWithoutSaving = true;   // 让 beforeunload 放行，别再写盘
        projectDirty = false;        // 用户明确选择丢弃这些改动
        closeModal();
        onLeave();
    });
    const saveBtn = document.getElementById('leaveSaveBtn');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
        closeModal();
        leaveWithoutSaving = false;
        await saveCurrentProject(false);   // 手动级别的保存（会提示"已保存"）
        onLeave();
    });
}

// 点击遮罩关闭弹窗：带拖动检测，长按选中文字拖出时不误触关闭
let modalOverlayDown = null;
modalOverlay.addEventListener('mousedown', (e) => {
    modalOverlayDown = {
        x: e.clientX,
        y: e.clientY,
        inModal: !!(e.target && e.target.closest && e.target.closest('.modal'))
    };
});
modalOverlay.addEventListener('click', (e) => {
    if (e.target !== modalOverlay) return;
    const d = modalOverlayDown;
    modalOverlayDown = null;
    // 起点在弹窗内（在选文字）或发生了明显拖动（长按选中文字/误触拖拽）→ 不关闭
    if (d && (d.inModal || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5)) return;
    closeModal();
});

// ============================================================
// 快捷键
// ============================================================

// 记录"最后一次鼠标按下是否发生在画布内"：
// 复制/剪切词条只应在画布区域操作时生效（避免在工具栏选中书名、在详情页选文字时误复制词条）
let lastPointerInCanvas = true;
document.addEventListener('mousedown', (e) => {
    lastPointerInCanvas = !!(e.target && e.target.closest && e.target.closest('#canvas'));
}, true);

// 是否有弹窗打开（设置 / 帮助）：弹窗内按快捷键不应触发画布上的词条操作
function isAnyModalOpen() {
    const modalOpen = modalOverlay && !modalOverlay.classList.contains('hidden');
    const help = document.getElementById('helpOverlay');
    const helpOpen = help && !help.classList.contains('hidden');
    return !!(modalOpen || helpOpen);
}

document.addEventListener('keydown', (e) => {
    // Ctrl+A 兜底（故意放在最前面）：只要焦点不在输入框 / 可编辑区里，就先把浏览器默认的"全选整个页面"掐掉。
    // 为什么：下面那些分支各有各的处理，但中间任何一步抛错或提前 return，preventDefault 就会漏掉，
    // 浏览器就会把工具栏 + 详情页 + 书库页的文字整页选中（"有概率出现"就是这个原因）。
    // 输入框 / 可编辑区里不动它：那里的 Ctrl+A 本来就该是"全选这段文字"。
    if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'a') {
        const t0 = e.target || {};
        const tag0 = String(t0.tagName || '').toLowerCase();
        if (tag0 !== 'input' && tag0 !== 'textarea' && !t0.isContentEditable) e.preventDefault();
    }
    // Ctrl+A：输入框/可编辑区域内为正常全选文本；
    // 画布页面（编辑器视图、无弹窗）则全选当前层的所有词条（类似文件管理器）
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        const tag = (e.target.tagName || '').toLowerCase();
        const editable = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
        if (!editable) {
            // 帮助打开时：只全选帮助里的文字（默认 Ctrl+A 会把后面整个文档都选上）
            const helpOv2 = document.getElementById('helpOverlay');
            if (helpOv2 && !helpOv2.classList.contains('hidden')) {
                e.preventDefault();
                const range = document.createRange();
                range.selectNodeContents(document.getElementById('helpContent') || helpOv2);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                return;
            }
            if (isAnyModalOpen()) {
                // 设置等弹窗打开时：也只全选弹窗里的文字（不穿透到后面的画布）
                e.preventDefault();
                const range = document.createRange();
                range.selectNodeContents(modalContent);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                return;
            }
            e.preventDefault();
            const inEditor = editorView && editorView.style.display !== 'none';
            if (inEditor && mode !== 'connect') {
                // 注意：setMode 内部会调用 resetModes() 清空 selectedIds，
                // 所以必须先切到多选模式，再填充选中项，否则选择会被清空
                setMode('multiselect');
                const parentId = getDisplayParentId();
                const list = currentProject.nodes.filter(n => n.parentId === parentId && n.parentId !== '__root__');
                selectedIds.clear();
                list.forEach(n => selectedIds.add(n.id));
                if (multiselectCheckbox) multiselectCheckbox.checked = list.length > 0;
                if (multiselectCount) multiselectCount.textContent = `已选 ${selectedIds.size} 个`;
                renderCanvas();
                showToast(list.length ? `已全选本页 ${list.length} 个词条` : '本页没有词条', 1200);
            }
            return;
        }
    }
    // Ctrl+S 保存
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveCurrentProject(false);
        return;
    }
    // Ctrl+N 新建词条
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        if (isAnyModalOpen()) return;  // 弹窗打开时不新建词条
        e.preventDefault();
        if (editorView.style.display !== 'none') {
            btnAdd.click();
        }
        return;
    }
    // Ctrl+Z 撤销
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) {
            // 例外：详情页里刚"拖动/复制文字"过 → 走应用的撤销栈
            // （那种改动是程序做的，浏览器原生撤销栈不知道它，直接放行会表现为"按了没反应"）
            const topLabel = undoStack.length ? undoStack[undoStack.length - 1].label : '';
            if (detailEditHost(e.target) && (topLabel === '移动文字' || topLabel === '复制文字')) {
                e.preventDefault();
                undo();
            }
            return;
        }
        if (isAnyModalOpen()) return;  // 弹窗内不触发画布撤销
        if (!editorView || editorView.style.display === 'none') return;  // 书库页不撤销书籍里的操作
        e.preventDefault();
        undo();
        return;
    }
    // Ctrl+F 打开详情页查找/替换（仅编辑器内；全局搜索框不加此快捷键）
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        if (isAnyModalOpen()) return;  // 弹窗内不抢 Ctrl+F
        if (editorView.style.display !== 'none') {
            e.preventDefault();
            detailFindBar.style.display = 'flex';
            detailFindInput.focus();
            detailFindInput.select();
            doFind(true);
        }
        return;
    }
    // Ctrl+C 复制选中词条（输入框内 / 弹窗内 / 画布上选中了文字时，都交给系统复制）
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
        if (isAnyModalOpen()) return;  // 设置/帮助弹窗里选中文字复制 → 不穿透到画布词条
        // 关键：画布上如果选中了文字（例如工具栏的书名、词条标题），Ctrl+C 应该复制"文字"而不是"词条"
        const sel = window.getSelection();
        if (sel && sel.toString().trim()) return;
        // 只在画布区域操作时才复制词条（在工具栏/详情页等处按 Ctrl+C 不碰词条）
        if (!lastPointerInCanvas) return;
        e.preventDefault();
        copySelectedNodes();
        return;
    }
    // Ctrl+X 剪切选中词条（规则与 Ctrl+C 一致：有选中文字时交给系统剪切）
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
        if (isAnyModalOpen()) return;
        const sel = window.getSelection();
        if (sel && sel.toString().trim()) return;
        if (!lastPointerInCanvas) return;
        e.preventDefault();
        cutSelectedNodes();
        return;
    }
    // Ctrl+V 粘贴词条
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
        if (isAnyModalOpen()) return;  // 弹窗里粘贴 → 交给系统默认行为
        e.preventDefault();
        pasteClipboard();
        return;
    }
    // Enter：确认删除类弹窗（无输入框时回车确认删除）
    if (e.key === 'Enter' && !modalOverlay.classList.contains('hidden')) {
        const hasInput = modalContent.querySelector('input, textarea');
        if (!hasInput) {
            const confirmBtn = modalContent.querySelector('.btn-delete');
            if (confirmBtn) {
                e.preventDefault();
                confirmBtn.click();
                return;
            }
        }
    }
    // Esc：关闭弹窗 → 关闭帮助 → 取消剪切 → 退出模式 → 退出词条/小说页面
    if (e.key === 'Escape') {
        if (!modalOverlay.classList.contains('hidden')) {
            closeModal();
            return;
        }
        if (!document.getElementById('helpOverlay').classList.contains('hidden')) {
            closeHelp();
            return;
        }
        // 有"剪切待粘贴"的内容时：先取消剪切（恢复淡灰词条）
        if (cutPendingIds.size) {
            cancelCutPending();
            showToast('已取消剪切', 1600);
            return;
        }
        if (mode !== 'default') {
            resetModes();
            renderAll();
            return;
        }
        if (editorView.style.display !== 'none') {
            if (currentContextId && currentContextId !== rootNodeId) {
                pushHistory(currentContextId);
                currentContextId = rootNodeId;
                currentSelectedId = rootNodeId;
                renderAll();
                showToast('已退出到词条主页', 1200);
            } else {
                switchToHomeList();
            }
        }
        return;
    }
    // Delete 删除选中的词条
    if (e.key === 'Delete') {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
        if (isMultiselectActive && selectedIds.size > 0) {
            e.preventDefault();
            deleteSelectedNodes();
            resetModes();
            renderAll();
            return;
        }
        // 删除当前详情选中的词条（带确认）
        if (currentSelectedId && currentSelectedId !== rootNodeId) {
            const n = currentProject.nodes.find(x => x.id === currentSelectedId);
            if (n) {
                e.preventDefault();
                confirmDeleteNode(n);
            }
        }
    }
});

// ============================================================
// 书籍回收站入口（书库页工具栏）
// ============================================================


// 在书库页工具栏添加"书籍回收站"按钮
const btnBookTrashHome = document.createElement('button');
btnBookTrashHome.id = 'btnBookTrashHome';
btnBookTrashHome.textContent = '📚 书籍回收站';
btnBookTrashHome.style.cssText = 'padding:6px 14px; border:none; border-radius:30px; font-size:13px; font-weight:500; cursor:pointer; background:transparent; color:var(--text-secondary); border:1px solid transparent;';
btnBookTrashHome.addEventListener('click', () => {
    openBookTrash();
});
const homeActions = document.getElementById('homeActions');
if (homeActions) {
    homeActions.appendChild(btnBookTrashHome);
}

// ============================================================
// 右键菜单
// ============================================================

let contextMenuEl = null;

function showContextMenu(x, y, items) {
    hideContextMenu();
    contextMenuEl = document.createElement('div');
    contextMenuEl.style.cssText = 'position:fixed; z-index:5000; background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,0.2); padding:6px; min-width:160px;';
    items.forEach(item => {
        const btn = document.createElement('div');
        btn.style.cssText = 'padding:8px 14px; border-radius:8px; cursor:pointer; font-size:14px; color:var(--text-primary); display:flex; align-items:center; gap:8px; transition:background 0.15s;';
        btn.innerHTML = item.label;
        btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--primary-light)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = ''; });
        btn.addEventListener('click', () => {
            hideContextMenu();
            item.action();
        });
        contextMenuEl.appendChild(btn);
    });
    document.body.appendChild(contextMenuEl);
    // 防止超出屏幕
    const rect = contextMenuEl.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    contextMenuEl.style.left = x + 'px';
    contextMenuEl.style.top = y + 'px';
}

function hideContextMenu() {
    if (contextMenuEl) {
        contextMenuEl.remove();
        contextMenuEl = null;
    }
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('contextmenu', (e) => {
    // 右键点在菜单面板上：保持菜单不动（不隐藏、不重开），避免"点一下菜单就消失"
    if (contextMenuEl && contextMenuEl.contains(e.target)) {
        e.preventDefault();
        return;
    }
    hideContextMenu();
});

// 右键点击词条卡片
canvas.addEventListener('contextmenu', (e) => {
    // 阻止冒泡到 document，避免菜单刚显示就被全局 handler 隐藏
    e.stopPropagation();
    // 右键框选后抑制菜单（刚拖完右键框，不弹菜单）
    if (suppressContextMenu) {
        e.preventDefault();
        return;
    }
    const nodeEl = e.target.closest('.node');
    if (nodeEl) {
        e.preventDefault();
        const node = currentProject.nodes.find(n => n.id === nodeEl.dataset.id);
        if (!node) return;
        // 右键词条时也显示对应详情页（和左键一致）
        currentSelectedId = node.id;
        renderDetailPanel();
        // 右键词条菜单（多选状态下改为批量菜单，两处不再重复调用）
        if (selectedIds.size > 1 && selectedIds.has(node.id)) {
            showContextMenu(e.clientX, e.clientY, getMultiSelectMenuItems(e.clientX, e.clientY, node));
        } else {
            showContextMenu(e.clientX, e.clientY, [
                { label: '✎ 编辑', action: () => openEditNodeModal(node) },
                { label: '🎨 换颜色', action: () => showColorPicker(node, e.clientX, e.clientY) },
                { label: '📋 复制', action: () => copyNode(node) },
                { label: '✂️ 剪切', action: () => cutNode(node) },
                { label: '➕ 新建子词条', action: () => {
                    pushHistory(currentContextId);   // 记录历史：这样"← 返回"（含鼠标侧键）能回到刚才那一层
                    currentContextId = node.id;
                    currentSelectedId = node.id;
                    renderAll();
                    btnAdd.click();
                }},
                { label: node.layoutLocked ? '📌 解除锁定' : '📌 锁定内部', action: () => toggleLayoutLock(node, 'inner') },
                { label: '🗑️ 删除', action: () => deleteNode(node.id) }   // 右键词条：直接删除（不询问，可 Ctrl+Z 或去回收站恢复）
            ]);
        }
        return;
    }
    // 右键点击连接线
    const connLine = e.target.closest('.conn-line');
    if (connLine) {
        e.preventDefault();
        const connIdx = parseInt(connLine.getAttribute('data-conn'), 10);
        showContextMenu(e.clientX, e.clientY, [
            { label: '🗑️ 删除连接', action: () => {
                if (!isNaN(connIdx) && currentProject.connections[connIdx]) {
                    pushUndo('删除连接');
                    currentProject.connections.splice(connIdx, 1);
                    renderAll();
                    showToast('已删除连接');
                }
            }}
        ]);
        return;
    }

    // 右键点击画布空白
    const canvasContentEl = document.getElementById('canvasContent');
    if (e.target === canvas || e.target === svg || e.target === emptyState || e.target === canvasContentEl) {
        e.preventDefault();
        const items = [
            { label: '➕ 新建词条', action: () => btnAdd.click() },
            { label: '📥 粘贴', action: () => pasteClipboard() },
            { label: '↩ 撤销（Ctrl+Z）', action: () => undo() },
            { label: '🎨 画布背景', action: () => openCanvasBgPopup(e.clientX, e.clientY) },
            { label: '🖼️ 详情页背景', action: () => openDetailBgPanel() },
            { label: '📐 按编号排列', action: () => autoArrange() },
            { label: '📍 按位置排列', action: () => arrangeByPosition() },
            { label: '📥 导入文件（TXT/MD）', action: () => importTextFile() },
            { label: '📤 导出 Markdown', action: () => exportMarkdown() }
        ];
        // 有选中词条时：只显示针对选中词条的操作菜单（不混入画布空白菜单），与右键框选后完全一致
        if (selectedIds.size > 0) {
            showContextMenu(e.clientX, e.clientY, getMultiSelectMenuItems(e.clientX, e.clientY, null));
            return;
        }
        // 「锁定本页布局」作用于当前这一页（进入的词条；引用词条则对应其源词条）
        const curPageNode = currentProject.nodes.find(n => n.id === getDisplayParentId());
        items.splice(4, 0, { label: (curPageNode && curPageNode.layoutLocked) ? '📌 解除锁定' : '📌 锁定本页', action: () => toggleLayoutLock(curPageNode, 'page') });
        if (mode !== 'default') {
            items.push({ label: '✖ 取消模式', action: () => { resetModes(); renderAll(); } });
        }
        showContextMenu(e.clientX, e.clientY, items);
    }
});

// ============================================================
// 一键排列 + 框选（Windows 11 风格）
// ============================================================

// 位置排序：判断"谁在谁前面"时先按**视觉上的行**分组，不再逐一比 y
//   · 手拖的卡片很难落在同一个 y 上，差几像素就会被判成"上面一行"，排列时会窜位
//   · 这里把"垂直线段重叠 ≥ 较小高度的 50%"的两张卡视作同一行；行内按 x（先左后右），
//     行与行按各行最靠上的 y（先上后下）—— 只影响先后顺序，落位算法一个字没改
//   · 卡片高度取当前渲染出来的实际高度（拿不到就用 100 兜底）
//   · 骑缝卡（横跨两行、跟哪一行都不到一半）：归到它重叠更多的那一行；
//     正好打平则归上面那一行（行是从上往下建的，先跟上面那行比）
// 用法：「📍 按位置排列」和「📍 排列选中」共用这一个排序
// ============================================================
const VISUAL_ROW_OVERLAP = 0.5;   // 同一行的判定阈值：重叠 ≥ 较小高度的这个比例

function sortByVisualPosition(nodes) {
    const items = nodes.map(n => {
        const el = document.querySelector(`.node[data-id="${n.id}"]`);
        const h = (el ? el.offsetHeight : 100) || 100;
        return { node: n, x: n.x || 0, y: n.y || 0, h: h };
    });
    items.sort((a, b) => (a.y - b.y) || (a.x - b.x));   // 先按 y 排：作为分行的起点

    const rows = [];   // 每行记 top / bottom（该行的垂直范围）和成员
    items.forEach(it => {
        const row = rows[rows.length - 1];
        let sameRow = false;
        if (row) {
            const overlap = Math.min(row.bottom, it.y + it.h) - Math.max(row.top, it.y);
            if (overlap > 0 && overlap >= VISUAL_ROW_OVERLAP * Math.min(it.h, row.bottom - row.top)) sameRow = true;
        }
        if (sameRow) {
            row.items.push(it);
            row.bottom = Math.max(row.bottom, it.y + it.h);
        } else {
            rows.push({ top: it.y, bottom: it.y + it.h, items: [it] });
        }
    });

    const order = [];
    rows.forEach(row => {
        row.items.sort((a, b) => (a.x - b.x) || (a.y - b.y));   // 行内：先左后右
        row.items.forEach(it => order.push(it.node));
    });
    return order;
}

// 按词条**当前所在位置**（先上后下、先左后右）重新整理成规整网格：
// 与"按编号排列"的区别是不会改变相互顺序，只把散乱的卡片摆整齐
function arrangeByPosition() {
    const parentId = getDisplayParentId();
    const kids = currentProject.nodes.filter(n => n.parentId === parentId && n.parentId !== '__root__');
    if (!kids.length) { showToast('本页没有词条'); return; }
    pushUndo();
    const ordered = sortByVisualPosition(kids);   // 按「视觉上的行」判先后：同一行内先左后右
    const GAP = 25, START_X = 24, START_Y = 24;
    const maxW = canvas.clientWidth - 24;
    let x = START_X, y = START_Y, rowH = 0;
    ordered.forEach(k => {
        const el = document.querySelector(`.node[data-id="${k.id}"]`);
        const w = el ? el.offsetWidth : 160;
        const h = el ? el.offsetHeight : 100;
        if (x + w > maxW && x > START_X) { x = START_X; y += rowH + GAP; rowH = 0; }
        k.x = x;
        k.y = y;
        x += w + GAP;
        rowH = Math.max(rowH, h);
    });
    renderAll();
    showToast(`已按位置排列 ${kids.length} 个词条`, 2000);
}

// 按编号排列当前画布词条（按编号顺序网格排列）
function autoArrange(silent) {
    const parentId = getDisplayParentId();
    const kids = currentProject.nodes.filter(n => n.parentId === parentId && n.parentId !== '__root__');
    if (kids.length === 0) { if (!silent) showToast('当前画布没有词条'); return; }
    if (!silent) pushUndo('自动排列');  // 排列前保存快照（resize 自动排列不记撤销，避免堆积）
    renderCanvas();  // 渲染后测量词条实际尺寸

    // 自动重排（窗口尺寸变化）与手动排列统一：全部词条按编号流式排列
    // （不再让手动词条当"钉子"，避免它挡住别人导致周围词条被弹开）
    const order = kids.slice().sort(compareNodeNumbers);
    const occupied = [];

    // 按词条实际大小流式排列：上一个词条右边界 + 25px 缝隙外，超右边界换行；自动避开障碍物
    const GAP = 25, START_X = 24, START_Y = 24;
    const maxW = canvas.clientWidth - 24;
    let x = START_X, y = START_Y, rowH = 0;
    order.forEach(k => {
        const el = document.querySelector(`.node[data-id="${k.id}"]`);
        const w = el ? el.offsetWidth : 160;
        const h = el ? el.offsetHeight : 100;
        if (x + w > maxW && x > START_X) { x = START_X; y += rowH + GAP; rowH = 0; }
        let px = x, py = y;
        while (occupied.some(o => rectsOverlap({ x: px, y: py, w, h }, o)) && py < 20000) {
            px += GAP;
            if (px + w > maxW) { px = START_X; py += GAP; }
        }
        k.x = px;
        k.y = py;
        occupied.push({ x: px, y: py, w, h });
        x = px + w + GAP;
        rowH = Math.max(rowH, h);
    });

    if (!silent) {
        kids.forEach(k => { delete k.manuallyMoved; });  // 手动全排后清除手动标记
    }
    // 下一帧再更新 DOM 位置：CSS transition 平滑移动到新位置（不重建 DOM，避免生硬跳变）
    requestAnimationFrame(() => {
        order.forEach(k => {
            const el = document.querySelector(`.node[data-id="${k.id}"]`);
            if (el) { el.style.left = k.x + 'px'; el.style.top = k.y + 'px'; }
        });
        updateCanvasSize();
        renderConnections();
        scheduleSave();
    });
    if (!silent) showToast('已按编号排列');
}

// 递归排列整个项目的所有层级（窗口缩放时调用，一次性整理全部词条与子词条）
function autoArrangeAll(silent) {
    if (!silent) pushUndo();
    const GAP = 25, START_X = 24, START_Y = 24;
    const maxW = canvas.clientWidth - 24;
    const arrangeLevel = (parentId) => {
        // 该画布被锁定（📌）→ 内部布局保持原样，不参与自动排列
        const parentNode = currentProject.nodes.find(n => n.id === parentId);
        if (parentNode && parentNode.layoutLocked) return;
        const kids = currentProject.nodes.filter(n => n.parentId === parentId && n.parentId !== '__root__');
        if (!kids.length) return;
        kids.sort(compareNodeNumbers);
        let x = START_X, y = START_Y, rowH = 0;
        kids.forEach(k => {
            // 子画布词条可能未渲染，用标题长度估算宽度；已渲染的用实际尺寸
            const el = document.querySelector(`.node[data-id="${k.id}"]`);
            const w = el ? el.offsetWidth : Math.max(140, ((getNodeTitle(k) || '').length) * 15 + 40);
            const h = el ? el.offsetHeight : 96;
            if (x + w > maxW && x > START_X) { x = START_X; y += rowH + GAP; rowH = 0; }
            k.x = x;
            k.y = y;
            x += w + GAP;
            rowH = Math.max(rowH, h);
            arrangeLevel(k.id);  // 递归排列子层级
        });
    };
    arrangeLevel(rootNodeId);
    const displayParentId = getDisplayParentId();
    // 非当前画布的子层级：标记 needsLayout，进入该层画布时按实际尺寸精确修正（避免估算偏差导致拥挤）
    currentProject.nodes.forEach(n => {
        if (n.parentId !== displayParentId && n.parentId !== '__root__') {
            n.needsLayout = true;
        }
    });
    // 当前画布：渲染后平滑移动到新位置；其他层级数据已更新（进入时即为新布局）
    renderCanvas();
    const curKids = currentProject.nodes.filter(n => n.parentId === displayParentId && n.parentId !== '__root__');
    requestAnimationFrame(() => {
        curKids.forEach(k => {
            const el = document.querySelector(`.node[data-id="${k.id}"]`);
            if (el) { el.style.left = k.x + 'px'; el.style.top = k.y + 'px'; }
        });
        updateCanvasSize();
        renderConnections();
        scheduleSave();
    });
    if (!silent) showToast('已排列全部层级');
}

// ===== 窗口缩放自动重排（仅响应窗口大小变化；进入画布/拖拽词条都不会触发，拖拽位置保留）=====
let suppressAutoArrange = false;  // 拖拽词条期间抑制（保险）
let resizeArrangeTimer = null;
const scheduleAutoArrange = () => {
    clearTimeout(resizeArrangeTimer);
    if (suppressAutoArrange) return;
    resizeArrangeTimer = setTimeout(() => {
        // 默认 / 多选模式下都重排（重排后选中状态仍保留）；连接模式会与连接线操作冲突，跳过
        if (editorView.style.display !== 'none' && modalOverlay.classList.contains('hidden') && mode !== 'connect') {
            autoArrangeAll(true);  // 静默：递归排列整个书籍所有层级
        }
    }, 300);
};
window.addEventListener('resize', scheduleAutoArrange);

// 长按空白处拖出灰色选框，框住词条即选中（可继续删除/排列）
let boxSelecting = false;
let suppressContextMenu = false;  // 右键框选后抑制随后的右键菜单

// 记录鼠标在画布内的坐标（用于"粘贴到鼠标位置"）
canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    lastCanvasPointer = {
        x: e.clientX - r.left + canvas.scrollLeft,
        y: e.clientY - r.top + canvas.scrollTop
    };
}, { passive: true });

canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    if (e.target.closest('.node') || e.target.closest('.conn-line')) return;
    if (e.target.closest('.detail-bg-panel') || e.target.closest('#colorPopup')) return;
    // 注意：这里**不取消**"剪切待粘贴" —— 否则你切到别的画布粘贴时就会变成"复制"。
    // 要取消剪切请按 Esc（或再次复制/剪切其他内容、或退出书籍）。
    const box = document.getElementById('boxSelect');
    if (!box) return;
    // 多选模式下点击画布空白：取消全部选中并退出多选（统一交互）
    if (mode === 'multiselect') {
        resetModes();
        renderAll();
        return;
    }
    if (mode !== 'default') return;
    // 锁定状态禁止框选
    if (isLocked()) return;
    const isRight = (e.button === 2);
    boxSelecting = true;
    let rightDragged = false;
    const startX = e.clientX, startY = e.clientY;
    // 按下时锁定锚点（画布坐标）。滚动时选框从锚点延伸覆盖跨页内容，已滚过的词条始终留在选框内
    const pressRect = canvas.getBoundingClientRect();
    const anchorCX = startX - pressRect.left + canvas.scrollLeft;
    const anchorCY = startY - pressRect.top + canvas.scrollTop;

    let scrollTimer = null;
    let lastBX = 0, lastBY = 0;
    // 用当前鼠标位置更新选框并标记命中的词条（基于视口坐标，画布滚动后自动重新计算）
    const applyBox = (mx, my) => {
        const r = canvas.getBoundingClientRect();
        // 当前鼠标的画布坐标（滚动后位置变化）；锚点固定不动，选框从锚点延伸到鼠标处
        const cX = mx - r.left + canvas.scrollLeft;
        const cY = my - r.top + canvas.scrollTop;
        const left = Math.min(anchorCX, cX), top = Math.min(anchorCY, cY);
        const w = Math.abs(cX - anchorCX), h = Math.abs(cY - anchorCY);
        // 选框视觉：画布坐标转回视口，滚动时跟随内容延伸（像 Windows 文件管理器）
        box.style.display = 'block';
        box.style.left = (left - canvas.scrollLeft + r.left) + 'px';
        box.style.top = (top - canvas.scrollTop + r.top) + 'px';
        box.style.width = w + 'px';
        box.style.height = h + 'px';
        // 命中：用画布坐标（词条 offsetLeft/offsetTop 相对 canvasContent = 内容坐标）
        const boxRect = { left, top, right: left + w, bottom: top + h };
        document.querySelectorAll('.node').forEach(el => {
            const hit = !(boxRect.right < el.offsetLeft || boxRect.left > el.offsetLeft + el.offsetWidth ||
                boxRect.bottom < el.offsetTop || boxRect.top > el.offsetTop + el.offsetHeight);
            el.classList.toggle('boxing', hit);
        });
    };
    // 鼠标靠近画布边缘时自动滚动：onMove 里先即时滚动一次，再由 setInterval 持续滚动
    const stopAutoScroll = () => {
        if (scrollTimer) { clearInterval(scrollTimer); scrollTimer = null; }
    };
    const scrollByEdge = (mx, my) => {
        const r = canvas.getBoundingClientRect();
        let sx = 0, sy = 0;
        if (my < r.top + 50) sy = -25;
        else if (my > r.bottom - 50) sy = 25;
        if (mx < r.left + 50) sx = -25;
        else if (mx > r.right - 50) sx = 25;
        if (sx || sy) {
            canvas.scrollTop += sy;
            canvas.scrollLeft += sx;
            applyBox(mx, my);  // 滚动后重新命中新进入视口的词条
            return true;
        }
        return false;
    };
    const startAutoScroll = (mx, my) => {
        lastBX = mx; lastBY = my;
        if (!scrollByEdge(mx, my)) return;   // 立即滚动一次（即时反馈）
        console.log('[box-select] 自动滚动中 scrollTop=', canvas.scrollTop);
        if (scrollTimer) return;
        scrollTimer = setInterval(() => {
            if (!scrollByEdge(lastBX, lastBY)) stopAutoScroll();
        }, 30);
    };
    const onMove = (ev) => {
        if (!rightDragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
            rightDragged = true;
        }
        lastBX = ev.clientX; lastBY = ev.clientY;
        const r = canvas.getBoundingClientRect();
        const nearEdge = ev.clientX < r.left + 50 || ev.clientX > r.right - 50 || ev.clientY < r.top + 50 || ev.clientY > r.bottom - 50;
        if (nearEdge) startAutoScroll(ev.clientX, ev.clientY);
        else {
            stopAutoScroll();
            applyBox(ev.clientX, ev.clientY);
        }
    };
    const onUp = () => {
        boxSelecting = false;
        stopAutoScroll();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        box.style.display = 'none';
        // 右键框选后抑制随后的 contextmenu（避免误弹菜单）
        if (isRight && rightDragged) {
            suppressContextMenu = true;
            setTimeout(() => { suppressContextMenu = false; }, 100);
        }
        const hits = [];
        document.querySelectorAll('.node.boxing').forEach(el => {
            hits.push(el.dataset.id);
            el.classList.remove('boxing');
        });
        if (hits.length > 0) {
            selectedIds.clear();
            hits.forEach(id => selectedIds.add(id));
            // 进入多选模式（底部出现全选/删除栏）
            isMultiselectActive = true;
            mode = 'multiselect';
            if (multiselectBar) {
                multiselectBar.style.display = 'flex';
                multiselectBar.classList.add('visible');
            }
            if (multiselectCount) multiselectCount.textContent = `已选 ${hits.length} 个`;
            renderCanvas();
            showToast(`已选中 ${hits.length} 个词条`);
            // 右键框选后自动弹出多选右键菜单（覆盖之前打开的其他菜单）
            if (isRight && rightDragged) {
                // 框选后的菜单：只含针对选中词条的操作（与左键框选后右键完全一致，不含画布空白菜单）
                showContextMenu(e.clientX, e.clientY, getMultiSelectMenuItems(e.clientX, e.clientY, null));
            }
        }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
});


// ============================================================
// 初始化
// ============================================================

// 关闭前保存

window.addEventListener('beforeunload', () => {
    if (!currentFilePath) return;
    if (!editorView || editorView.style.display === 'none') return;  // 在书库页：不用保存
    if (leaveWithoutSaving) return;                  // 用户在弹窗里选了「不保存」：不要在这里又偷偷写盘
    if (!autoSaveEnabled && hasUnsavedChanges()) return;  // 关着自动保存：退出前先问用户，不擅自写盘
    // 同步保存
    try {
        api.saveProject(currentFilePath, currentProject);
    } catch (e) {}
});

// 主进程通知关闭前（点标题栏 ✕ / Alt+F4）
if (api && api.onBeforeQuit) {
    api.onBeforeQuit(() => {
        const quit = () => { if (api.quitConfirmed) api.quitConfirmed(); };
        if (!currentFilePath || !editorView || editorView.style.display === 'none') { quit(); return; }   // 在书库页：直接关
        if (autoSaveEnabled) {
            // 开着自动保存：存一次再退（防丢数据），存完（或失败）都确认退出，否则窗口关不掉
            Promise.resolve(api.saveProject(currentFilePath, currentProject)).then(quit).catch(quit);
            return;
        }
        if (!hasUnsavedChanges()) { quit(); return; }   // 关着自动保存但没有真改动：直接关
        // 关着自动保存 + 有没保存的改动：问用户（不保存 / 保存并退出，点 ✕ 或点弹窗外=不退出）
        askSaveBeforeLeave(quit);
    });
}

// 书库页导入/导出按钮
document.getElementById('btnHomeImport').addEventListener('click', importProjectFromFiles);
document.getElementById('btnHomeExport').addEventListener('click', exportAllBooks);

// 拖拽导入 TXT/MD（书库页=新小说，编辑器=当前画布词条树）
// ── 顺带支持"详情页里拖动选中的文字改位置"（自己做，不依赖浏览器原生行为）──
// 以前为了拖入 TXT/MD 把所有拖拽都 preventDefault 了，把这条一起堵死了；
// 而"靠放行默认行为让浏览器自己移动"实测不可靠（只有拖动效果、文字不动），
// 所以这里改成：识别出"详情页文字拖拽"后，由我们自己按 Range 做"删源 + 插到落点"，确定且可测。
// 其余拖拽（拖文件、外部文字/链接）行为逐字不变。
const DETAIL_EDIT_SEL = '#detailTitle, #detailSummary, #detailBody';
function detailEditHost(node) {
    const el = (node && node.nodeType === 1) ? node : (node && node.parentElement);
    if (!el || !el.closest) return null;
    return el.closest(DETAIL_EDIT_SEL);
}
// 判断"这次拖拽是不是从详情页的可编辑文字开始的"。
// 注意：用选区锚点兜底前必须先确认"拖拽确实发生在详情页里、且不是从输入框开始的"，
// 否则会出现"正文里留着旧选区 + 从别处拖东西"被误判的情况（那会改变原有的拦截行为）。
function isDetailTextDragSource(target) {
    const host = detailEditHost(target);
    if (host) return host;
    const el = (target && target.nodeType === 1) ? target : (target && target.parentElement);
    if (!el || !el.closest) return null;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return null;
    if (!el.closest('#detailPanel')) return null;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    return detailEditHost(sel.anchorNode);
}
let textDragFromDetail = false;    // 本次拖拽是否来自详情页正文/摘要/标题里选中的文字
let textDragSourceRange = null;    // 拖拽开始时那段文字的位置（拖完照它删源）
document.addEventListener('dragstart', (e) => {
    textDragFromDetail = !!isDetailTextDragSource(e.target);
    textDragSourceRange = null;
    detailDropCaretRange = null;   // 关键：每次新拖拽都清掉上一次的落点缓存，免得 drop 用到过期位置
    if (!textDragFromDetail) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) textDragSourceRange = sel.getRangeAt(0).cloneRange();
});
document.addEventListener('dragend', () => {
    textDragFromDetail = false;
    textDragSourceRange = null;
    stopDetailDragAutoScroll();   // 松手就停：否则"拖到边缘自动滚"那颗定时器会一直跑下去，滚动条会被它一直推着
    // 注意：dragend 紧跟在 drop 之后。如果刚在 drop 里留了"落下后的落点竖线"（300ms 内），
    // 这里就别把它收掉，否则等于白留（这个 bug 是实测抓出来的）。
    if (Date.now() - detailCaretBarShownAt >= 300) hideDetailDropCaret();
    applyDetailCaret();      // 拖放彻底结束后浏览器才恢复光标绘制，这里再补设一次
});

// 鼠标位置 → 编辑区里的插入点（Range）
// ① 先用标准接口；② 命中不到"文字"的位置（空行、块首、正文上下方的空白）做兜底：
//    空行/块 → 贴到这一块最前面；正文之外的空白 → 贴到整段最前/最后。
//    （"滑过空行时不管离左边缘多远都自动贴过去"，靠的就是这层兜底）
function detailCaretRangeAt(x, y) {
    let r = null;
    try { if (document.caretRangeFromPoint) r = document.caretRangeFromPoint(x, y); } catch (e) { r = null; }
    if (!r) {
        try {
            if (document.caretPositionFromPoint) {
                const p = document.caretPositionFromPoint(x, y);
                if (p) { r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true); }
            }
        } catch (e) {}
    }
    if (r && detailEditHost(r.startContainer)) return r;      // 命中在可编辑区里 → 直接用
    try {
        const el = document.elementFromPoint(x, y);
        const host = detailEditHost(el);
        if (!host) return r;
        if (el && el !== host) {
            let block = el;
            while (block && block.parentNode && block.parentNode !== host) block = block.parentNode;
            const rr = document.createRange();
            rr.selectNodeContents(block || host);
            rr.collapse(true);                                // 贴到这一块的最前面（空行就是这里生效）
            if (host.contains(rr.startContainer)) return rr;
        } else {
            // 落在编辑区自己的空白里（含"标题/摘要还空着"、以及"空行没有行盒 → 命中落到外层容器"）。
            // 关键：Range 的容器要指向"某一行的块"，不能是 host 本身 —— 否则后面量出来的是整块区域，
            // 会画出"和面板一样长的巨型光标"（实测踩到过，且只在最上面几行出现）。
            const first = host.firstChild, last = host.lastChild;
            const lr = (last && last.getBoundingClientRect) ? last.getBoundingClientRect() : null;
            const below = !!(lr && y >= lr.bottom + 2);        // 在最后一行下方 → 贴最后；否则贴最前
            const block = below ? (last || host) : (first || host);
            const rr = document.createRange();
            if (block === host) { rr.selectNodeContents(host); rr.collapse(below); }
            else if (block.nodeType === 3) { rr.setStart(block, below ? block.nodeValue.length : 0); rr.collapse(true); }
            else { rr.selectNodeContents(block); rr.collapse(below); }
            return rr;
        }
    } catch (e) {}
    return r;
}
// 取出一段选区里的文字：块级元素边界和 <br> 都算一个换行
// （Range.toString() 按标准不会在块边界补换行，跨两行选中会粘成一行，所以自己走一遍）
function rangeTextWithBreaks(srcRange) {
    const frag = srcRange.cloneContents();
    const BLK = { div: 1, p: 1, li: 1, tr: 1, h1: 1, h2: 1, h3: 1 };
    let s = '';
    const walk = (parent) => {
        Array.prototype.slice.call(parent.childNodes).forEach(c => {
            if (c.nodeType === 3) { s += c.nodeValue.replace(/\r\n?/g, '\n'); return; }
            if (c.nodeType !== 1) return;
            const tag = (c.tagName || '').toLowerCase();
            if (tag === 'br') { s += '\n'; return; }
            const blk = !!BLK[tag];
            if (blk && s && s[s.length - 1] !== '\n') s += '\n';
            walk(c);
            if (blk && s && s[s.length - 1] !== '\n') s += '\n';
        });
    };
    walk(frag);
    return s.replace(/^\n+/, '').replace(/\n+$/, '');   // 去掉首尾多出来的换行
}
// 纯文本 → 文档片段（多行用 <br>，和 detailBody.onpaste 的老规矩一致）
function fragFromPlainText(text) {
    const frag = document.createDocumentFragment();
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
        if (i) frag.appendChild(document.createElement('br'));
        if (line) frag.appendChild(document.createTextNode(line));
    });
    return frag;
}
let pendingDetailCaret = null;   // 刚插入那段的位置（拖放彻底结束后再补设一次用）
function applyDetailCaret() {
    const p = pendingDetailCaret;
    if (!p) return;
    try {
        if (p.host && p.host.focus) p.host.focus({ preventScroll: true });
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(p.range);
    } catch (e) {}
}
// 插入收尾：合并相邻文本节点 + 把焦点和"选中/光标"放好
// 1) 选中用的 Range 要在 normalize() **之前**算好：normalize 会合并文本节点，之后再用
//    firstNode/lastNode 就定位不到了（这正是"文字落对了、光标却跑到正文末尾"的原因）。
//    按 DOM 规范，文本节点被合并/移除时 Range 边界会自动调整，所以提前算好的 Range 是安全的。
// 2) 这里刻意把"刚插入的那段文字"**选中**（和 VS Code、记事本一致）：一是落点一眼可见，
//    二是浏览器在拖放后会暂停原生光标的闪烁（位置对、但看不见），而选区底色一定会被画出来，
//    不依赖浏览器画不画光标。
function finishDetailInsert(host, firstNode, lastNode) {
    let range = null;
    try {
        if (firstNode && lastNode && firstNode.parentNode && lastNode.parentNode) {
            range = document.createRange();
            range.setStartBefore(firstNode);
            range.setEndAfter(lastNode);
        }
    } catch (e) { range = null; }
    try { host.normalize(); } catch (e) {}
    if (!range) {
        range = document.createRange();
        range.selectNodeContents(host);
        range.collapse(false);
    }
    pendingDetailCaret = { host: host, range: range };
    applyDetailCaret();
    setTimeout(applyDetailCaret, 0);      // focus 之后浏览器可能还会再修正一次位置
    setTimeout(applyDetailCaret, 120);    // 拖放彻底结束后浏览器才恢复光标绘制，再补一次
    showDetailCaretBarAtRangeEnd(host, range);   // 落下后也留一根落点竖线（点一下/打字/滚动就收起）
    setTimeout(() => { if (pendingDetailCaret && pendingDetailCaret.range === range) pendingDetailCaret = null; }, 2000);
}
// 把纯文本插到指定位置（"从外面拖文字进来"走这条路）
function insertDetailTextAt(targetRange, text, host) {
    if (!targetRange || !host || !host.contains(targetRange.startContainer)) return false;
    if (!String(text || '')) return false;
    pushUndo('插入文字');
    const at = document.createRange();
    at.setStart(targetRange.startContainer, targetRange.startOffset);
    at.collapse(true);
    const frag = fragFromPlainText(text);
    const firstNode = frag.firstChild, lastNode = frag.lastChild;
    at.insertNode(frag);
    finishDetailInsert(host, firstNode, lastNode);
    return true;
}
// 把 srcRange 那段文字"移动"到 targetRange 这个位置（仅同一个可编辑区内）
// 返回 true 表示真的动了（调用方据此决定要不要触发保存）
function moveDetailTextTo(srcRange, targetRange, host, copy) {
    if (!srcRange || !targetRange || !host || srcRange.collapsed) return false;
    // 落点必须也在详情页三块可编辑区里；允许跨块（正文 ⇄ 标题 ⇄ 摘要），但不许落到别处
    const targetHost = detailEditHost(targetRange.startContainer);
    if (!targetHost) return false;
    const srcHost = detailEditHost(srcRange.startContainer);
    const text = rangeTextWithBreaks(srcRange);
    if (!text) return false;
    const at = document.createRange();
    at.setStart(targetRange.startContainer, targetRange.startOffset);
    at.collapse(true);
    // 落点落在源内部 → 移动时不动（否则等于原地复制一份）；复制时允许
    if (!copy && srcRange.compareBoundaryPoints(Range.START_TO_START, at) <= 0 &&
        srcRange.compareBoundaryPoints(Range.END_TO_END, at) >= 0) return false;
    pushUndo(copy ? '复制文字' : '移动文字');   // 拖动前记快照（程序做的改动不进浏览器撤销栈，Ctrl+Z 得能撤）
    // 1) 先用临时标记把"落点"钉住：先删源会让落点偏移失效，而标记会自动跟着走
    const mark = document.createElement('span');
    mark.setAttribute('data-move-mark', '1');
    at.insertNode(mark);
    // 2) 移动时删掉原来那段（复制时保留）
    if (!copy) srcRange.deleteContents();
    // 3) 插到标记处（纯文本；多行用 <br>）
    const frag = fragFromPlainText(text);
    const firstNode = frag.firstChild, lastNode = frag.lastChild;
    const r2 = document.createRange();
    r2.setStartAfter(mark);
    r2.collapse(true);
    r2.insertNode(frag);
    // 4) 去掉标记 → 收尾（选中刚插入的这段 + 焦点；Range 在 normalize 之前算好）
    if (mark.parentNode) mark.parentNode.removeChild(mark);
    finishDetailInsert(host, firstNode, lastNode);
    // 保存链路：跨块移动时源和目标各刷一次（各自的 oninput 会写自己的字段：正文/标题/摘要）
    [srcHost, targetHost].forEach(h => { if (h) { try { h.dispatchEvent(new Event('input')); } catch (e) {} } });
    return true;
}

// ============================================================
// 拖动文字时的"落点光标"（自己画的竖线，思路同 VS Code / Win11 记事本）
// ------------------------------------------------------------
// 为什么必须自己画：浏览器**只要存在非折叠选区就不绘制插入光标**，拖放期间又会抑制光标闪烁，
// 所以"文字保持选中 + 落点看得见"这两件事只能靠一个独立浮层来画。
// 它挂在 document.body 上、不属于正文 DOM：不落盘、不进 innerHTML、不参与撤销/搜索/字数统计。
// ============================================================
let detailDropCaretEl = null;      // 那根竖线
let detailDropCaretRange = null;   // 竖线对应的插入点（drop 时复用它，保证"看到的位置 == 插入的位置"）
function ensureDetailDropCaret() {
    if (detailDropCaretEl && detailDropCaretEl.isConnected) return detailDropCaretEl;
    const el = document.createElement('div');
    el.setAttribute('data-detail-drop-caret', '1');
    el.style.cssText = 'position:fixed; width:2px; background:#4a9eff; pointer-events:none; z-index:2147483647; display:none; border-radius:1px; transform:translateX(-1px); opacity:0.9;';
    document.body.appendChild(el);
    detailDropCaretEl = el;
    return el;
}
function hideDetailDropCaret() {
    if (detailDropCaretEl) detailDropCaretEl.style.display = 'none';
    detailDropCaretRange = null;
}
// 量插入点位置：先用 Range 自己的 rect；退化时（块首/空行处的 collapsed Range 可能是 0×0）
// 就量"相邻那个字符"的 rect 来推算（先看左边一个字符、没有再看右边），**全程不改动 DOM** ——
// 拖动过程中反复往正文里插删探测元素会切碎文本节点，还可能影响正在拖的那个选区。
// 量插入点位置：先用 Range 自己的 rect；退化时（块首/空行处的 collapsed Range 可能是 0×0）
// 就量"相邻那个字符"的 rect 来推算，**全程不改动 DOM** ——
// 拖动过程中反复往正文里插删探测元素会切碎文本节点，还可能影响正在拖的那个选区。
// 【行首特例】光标正好停在"某一行的行首"时（左邻居是换行符 \n，或左邻居在上一行——自动折行的
// 行首也是这种），浏览器给的矩形会落在**上一行**：实测正文用 textContent 装载成"一个文本节点 +
// 真 \n"时，第 2 行及以后的行首竖线全被画到上一行末尾（第 1 行左边没字符，所以只有它是好的），
// 表现就是"拖到第一个字左边看不到光标、只能拖到第二个字前面"。这两种情况直接用**右邻居的左边缘**。
function detailCaretRect(range, host) {
    const node = range.startContainer, off = range.startOffset;
    // 先量左右两个邻居（只有文本节点才有邻居）
    let leftRect = null, rightRect = null;
    if (node && node.nodeType === 3) {
        const len = node.nodeValue.length;
        try {
            if (off > 0) {
                const r = document.createRange();
                r.setStart(node, off - 1);
                r.setEnd(node, off);
                const rc = r.getBoundingClientRect();
                if (rc && (rc.width || rc.height)) leftRect = rc;
            }
        } catch (e) {}
        try {
            if (off < len) {
                const r = document.createRange();
                r.setStart(node, off);
                r.setEnd(node, off + 1);
                const rc = r.getBoundingClientRect();
                if (rc && (rc.width || rc.height)) rightRect = rc;
            }
        } catch (e) {}
    }
    // ① 行首：左邻居是换行符，或者左右邻居不在同一行（折行的行首）→ 用右邻居的左边缘。
    //    注意排除"右邻居是换行符"的情况（那是行尾，不是行首）。
    const atLineStart = !!(rightRect && node && node.nodeType === 3 && off > 0 && (
          node.nodeValue[off - 1] === '\n' ||
          (node.nodeValue[off] !== '\n' && !!leftRect &&
           Math.abs(leftRect.top - rightRect.top) > Math.max(2, (rightRect.height || 18) / 2))
    ));
    if (atLineStart) return { left: rightRect.left, top: rightRect.top, height: rightRect.height };
    // ② 常规情况：collapsed Range 自己的矩形
    try {
        const r = range.getBoundingClientRect();
        if (r && (r.width || r.height)) return r;
    } catch (e) {}
    // ③ 容器是"元素"（空行、空的标题/摘要里，落点就长这样）→ 直接用这个块的 rect，光标画在它左上角。
    // 以前这里直接 return null → showDetailDropCaret 就把竖线隐藏了，表现就是"空行/空标题上没有光标"。
    if (node && node.nodeType === 1) {
        const r = node.getBoundingClientRect();
        if (!r || (!r.width && !r.height)) return null;
        // 高度夹一下：容器如果是"一大块"（比如命中落到了整段/整个编辑区上），直接用它就会画出
        // "和面板一样长的巨型光标" → 超过一行半就压成一行高
        let h = r.height;
        let lh = 0;
        try { lh = parseFloat(getComputedStyle(host).lineHeight); } catch (e) {}
        if (!Number.isFinite(lh) || lh <= 0) lh = 20;
        if (!h || h > lh * 1.6) h = lh;
        return { left: r.left, top: r.top, height: h };
    }
    if (!node || node.nodeType !== 3) return null;
    // ④ 退化情况：用左邻居的右边缘（常规插入点就是它），没有就退到右邻居的左边缘
    if (leftRect) return { left: leftRect.right, top: leftRect.top, height: leftRect.height };
    if (rightRect) return { left: rightRect.left, top: rightRect.top, height: rightRect.height };
    return null;
}
function showDetailDropCaret(range, host, asDropTarget) {
    if (!range) { hideDetailDropCaret(); return; }
    const rect = detailCaretRect(range, host);
    if (!rect) { hideDetailDropCaret(); return; }
    const el = ensureDetailDropCaret();
    try {   // 颜色跟随详情页正文的文字色（深色模式自动适配）
        const c = host ? getComputedStyle(host).color : '';
        if (c) el.style.background = c;
    } catch (e) {}
    let height = rect.height;
    if (!height || height < 2) {
        try {
            const lh = parseFloat(getComputedStyle(host).lineHeight);
            if (Number.isFinite(lh) && lh > 0) height = lh;
        } catch (e) {}
    }
    if (!height || height < 2) height = 18;
    el.style.left = rect.left + 'px';
    el.style.top = rect.top + 'px';
    el.style.height = height + 'px';
    el.style.display = 'block';
    el.style.animation = (asDropTarget === false) ? 'detailDropCaretBlink 1.06s steps(1, end) infinite' : 'none';
    if (asDropTarget === false) return;
    detailDropCaretRange = range.cloneRange();
}
function isRangeInsideRange(outer, inner) {
    try {
        return outer.compareBoundaryPoints(Range.START_TO_START, inner) <= 0 &&
               outer.compareBoundaryPoints(Range.END_TO_END, inner) >= 0;
    } catch (e) { return false; }
}
// 拖动过程中按鼠标位置算插入点并画竖线；返回落点（drop 时优先用它）
function updateDetailDropCaret(x, y, copy) {
    const targetRange = detailCaretRangeAt(x, y);
    if (!targetRange) { hideDetailDropCaret(); return null; }
    const host = detailEditHost(targetRange.startContainer);
    if (!host || !host.contains(targetRange.startContainer)) { hideDetailDropCaret(); return null; }
    targetRange.collapse(true);
    // 移动时"源文字内部"不是有效落点（复制时允许）→ 不画
    if (textDragFromDetail && !copy && textDragSourceRange && isRangeInsideRange(textDragSourceRange, targetRange)) {
        hideDetailDropCaret();
        return null;
    }
    showDetailDropCaret(targetRange, host);
    return targetRange;
}
// drop 时优先用 dragover 缓存的落点；缓存失效（DOM 变过）就按坐标重算
function detailDropTargetRange(x, y) {
    const cached = detailDropCaretRange;
    if (cached && cached.startContainer && document.contains(cached.startContainer)) return cached;
    return detailCaretRangeAt(x, y);
}

// 插入完成后：让落点竖线**继续留一会儿**（停在你接下来要打字的位置），
// 这样松手之后也看得见"我刚才放在哪了"；下一次点击/打字/滚动/切词条就自动收起。
let detailCaretBarShownAt = 0;
let detailCaretBarTimer = null;
function showDetailCaretBarAtRangeEnd(host, range) {
    try {
        const endRange = range.cloneRange();
        endRange.collapse(false);          // 末尾 = 刚插入那段的后面 = 你接下来打字的位置
        showDetailDropCaret(endRange, host, false);
        detailCaretBarShownAt = Date.now();
        if (detailCaretBarTimer) clearTimeout(detailCaretBarTimer);
        detailCaretBarTimer = setTimeout(hideDetailDropCaret, 3000);   // 3 秒后自动收起
    } catch (e) {}
}
// 一次性挂上"该收起竖线"的时机（用捕获阶段，免得被别处 stopPropagation 拦掉）
document.addEventListener('mousedown', () => {
    if (Date.now() - detailCaretBarShownAt < 300) return;   // 刚显示就来的那次鼠标事件不当"点击"处理
    hideDetailDropCaret();
}, true);
document.addEventListener('keydown', () => { hideDetailDropCaret(); }, true);
document.addEventListener('beforeinput', () => { hideDetailDropCaret(); }, true);
window.addEventListener('blur', () => { hideDetailDropCaret(); stopDetailDragAutoScroll(); });
try {
    // 滚动时：如果是我们的"拖到边缘自动滚动"，就把竖线重新贴到缓存落点上（别停在旧坐标）；
    // 其它滚动（用户自己滚、切词条）→ 收起竖线，免得它停在一个过期位置
    if (detailBody && detailBody.parentElement) {
        detailBody.parentElement.addEventListener('scroll', () => {
            if (detailDragScrollTimer) {
                const rr = detailDropCaretRange;
                if (rr && rr.startContainer) {
                    const h = detailEditHost(rr.startContainer);
                    if (h) showDetailDropCaret(rr, h);
                }
                return;
            }
            hideDetailDropCaret();
        }, { passive: true });
    }
} catch (e) {}

// 拖到详情页上/下边缘附近时自动滚动 —— 浏览器只给整页自动滚，不给内部滚动容器自动滚，
// 所以"只能在本页范围内移动"就是这么来的；这里自己滚，就能拖到看不见的地方再松手。
let detailDragScrollTimer = null;
let detailDragScrollDir = 0;
let detailDragScrollSpeed = 0;        // 当前每帧滚多少像素（越靠边越快）
const DETAIL_DRAG_EDGE = 64;          // 进入边缘这么多像素内才开始自动滚
const DETAIL_DRAG_MIN_SPEED = 1.5;    // 刚进边缘区：慢慢走，看得清字
const DETAIL_DRAG_MAX_SPEED = 40;     // 贴到（或越过）边缘：最快（想更快就调这个数）
function detailDragAutoScroll(y) {
    const box = detailBody ? detailBody.parentElement : null;
    if (!box) return;
    let dir = 0, depth = 0;           // depth: 0=刚进边缘区，1=已贴到/越过边缘
    try {
        const r = box.getBoundingClientRect();
        if (y < r.top + DETAIL_DRAG_EDGE) { dir = -1; depth = (r.top + DETAIL_DRAG_EDGE - y) / DETAIL_DRAG_EDGE; }
        else if (y > r.bottom - DETAIL_DRAG_EDGE) { dir = 1; depth = (y - (r.bottom - DETAIL_DRAG_EDGE)) / DETAIL_DRAG_EDGE; }
    } catch (e) { return; }
    depth = Math.max(0, Math.min(1, depth));
    detailDragScrollDir = dir;
    // 速度曲线（平方）：刚进来几乎不动，越贴近边缘越快
    detailDragScrollSpeed = dir ? (DETAIL_DRAG_MIN_SPEED + (DETAIL_DRAG_MAX_SPEED - DETAIL_DRAG_MIN_SPEED) * depth * depth) : 0;
    if (!dir) { stopDetailDragAutoScroll(); return; }
    if (!detailDragScrollTimer) {
        // 注意：定时器只建一次，滚动时读当前的方向/速度 —— 这样"鼠标停在边缘不动"也能持续滚，
        // 而且改速度是渐变的、不会一顿一顿
        detailDragScrollTimer = setInterval(() => {
            if (!detailDragScrollDir) { stopDetailDragAutoScroll(); return; }   // 兜底：没方向了就别空转
            try { box.scrollTop += detailDragScrollDir * detailDragScrollSpeed; } catch (e) {}
        }, 16);
    }
}
function stopDetailDragAutoScroll() {
    if (detailDragScrollTimer) { clearInterval(detailDragScrollTimer); detailDragScrollTimer = null; }
    detailDragScrollDir = 0;
    detailDragScrollSpeed = 0;
}
// 拖动中滚鼠标滚轮也能滚动（多一种办法）
// 注：部分浏览器在"原生拖拽"进行期间不向页面派发 wheel 事件，那这条就只是空转、无害
document.addEventListener('wheel', (e) => {
    if (!textDragFromDetail) return;
    const box = detailBody ? detailBody.parentElement : null;
    if (!box) return;
    try { box.scrollTop += e.deltaY; e.preventDefault(); } catch (err) {}
}, { capture: true, passive: false });

document.addEventListener('dragover', (e) => {
    e.preventDefault();
    // ① 详情页里拖动文字 ② 从外面把文字拖进来 → 画落点竖线；拖到别处/拖文件则收起
    const types = (e.dataTransfer && e.dataTransfer.types) ? Array.from(e.dataTransfer.types) : [];
    const externalText = !textDragFromDetail && types.indexOf('Files') < 0 && types.indexOf('text/plain') >= 0;
    if (textDragFromDetail || externalText) {
        updateDetailDropCaret(e.clientX, e.clientY, !!(e.ctrlKey || e.metaKey || e.altKey));
        detailDragAutoScroll(e.clientY);          // 靠近面板上下边缘 → 自动滚动（可拖到看不见的位置）
    } else {
        hideDetailDropCaret();
        stopDetailDragAutoScroll();
    }
});
document.addEventListener('drop', async (e) => {
    const dtTypes = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
    stopDetailDragAutoScroll();   // 松手（drop）也要停 —— 拖放结束后它就没人管了
    // 详情页里拖动选中的文字：由我们自己移动/复制（这里要 preventDefault，免得和我们的动作重复）
    if (textDragFromDetail && dtTypes.indexOf('Files') < 0) {
        e.preventDefault();
        const src = textDragSourceRange;
        textDragFromDetail = false;
        textDragSourceRange = null;
        if (src) {
            // 按住 Ctrl / Alt 拖 = 复制（和 VS Code、记事本的习惯一致；不按就是移动）
            const copy = !!(e.ctrlKey || e.metaKey || e.altKey);
            // 优先用 dragover 时缓存的那个落点：保证"看到的竖线 == 实际插入的位置"
            const target = detailDropTargetRange(e.clientX, e.clientY);
            // 落点时鼠标不一定压在可编辑区上（例：贴到面板最左那条留白、接近分界线），那时 e.target
            // 是外层容器 → 以前这里 host 为 null 就**静默什么都不做**（表现：竖线明明画在行首，松手却不生效）。
            // 落点 Range 已经算在可编辑区里了，所以以它为准来定 host。
            const host = detailEditHost(e.target) || (target ? detailEditHost(target.startContainer) : null);
            hideDetailDropCaret();
            if (host && target) moveDetailTextTo(src, target, host, copy);   // 保存链路已在里面派发（跨块时源/目标各一次）
        } else {
            hideDetailDropCaret();
        }
        return;
    }
    // 从外面（浏览器/记事本/别的软件）把文字拖进详情页：也按纯文本插到落点。
    // 只认"落点在详情页可编辑区 + 带 text/plain + 不带文件"，其它一律保持原样（包括防止链接把页面带走）；
    // 这里同样 preventDefault，所以拖链接进来只会变成一段文字，不会触发跳转。
    if (!textDragFromDetail && dtTypes.indexOf('Files') < 0 && dtTypes.indexOf('text/plain') >= 0) {
        const raw = (e.dataTransfer && e.dataTransfer.getData) ? (e.dataTransfer.getData('text/plain') || '') : '';
        if (raw) {
            const target = detailDropTargetRange(e.clientX, e.clientY);
            // 同上：鼠标压在留白/分界线上时 e.target 不是可编辑区，改用落点 Range 反推
            const host2 = detailEditHost(e.target) || (target ? detailEditHost(target.startContainer) : null);
            if (host2 && target) {
                e.preventDefault();
                hideDetailDropCaret();
                if (insertDetailTextAt(target, raw, host2)) {
                    host2.dispatchEvent(new Event('input'));
                }
                return;
            }
        }
    }
    hideDetailDropCaret();
    e.preventDefault();
    if (!modalOverlay.classList.contains('hidden')) return;  // 弹窗打开时不处理
    const files = Array.from(e.dataTransfer.files || []);
    const textFiles = files.filter(f => f.path && /\.(txt|md|markdown)$/i.test(f.path));
    if (files.length > 0 && textFiles.length === 0) {
        showToast('不支持的文件格式，仅支持 TXT / MD', 2000);
        return;
    }
    if (textFiles.length === 0) return;
    const fileData = [];
    for (const f of textFiles) {
        const res = await api.readTextFile(f.path);
        if (res && res.success) fileData.push(res);
    }
    if (fileData.length === 0) return;
    if (homeView.style.display !== 'none') {
        // 书库页：拖入 → 创建新小说
        let created = 0;
        for (const fd of fileData) {
            if (await createProjectFromFile(fd)) created++;
        }
        showToast(`已导入 ${created} 本小说`);
        loadProjects();
    } else {
        // 编辑器：拖入 → 在当前画布创建词条树
        importFilesInEditor(fileData);
    }
});

// ============================================================
// 开屏（splash）：默认**不显示**（纯 CSS 藏着）。
// 只有"启动/加载超过 SPLASH_DELAY 还没就绪"时才浮出来；快的话你根本看不到它，
// 也就绝对不会"为了看开屏多等一会儿"。
// 用法：showSplash('正在打开《书名》…')  →  hideSplash()
//      showSplash('正在备份…', 0)        // 第二参数是延迟毫秒，传 0 = 立刻显示
// ============================================================
const SPLASH_DELAY = 400;      // 超过这么久还没就绪，才显示开屏
let splashShowTimer = null;
let splashVisible = false;
function splashNow(text) {
    const el = document.getElementById('splash');
    if (!el) return;
    const sub = document.getElementById('splashSub');
    if (sub && text) sub.textContent = text;
    el.classList.add('splash-show');
    splashVisible = true;
}
function showSplash(text, delay) {
    const d = (delay === undefined) ? SPLASH_DELAY : delay;
    if (splashShowTimer) { clearTimeout(splashShowTimer); splashShowTimer = null; }
    if (d <= 0) { splashNow(text); return; }
    splashShowTimer = setTimeout(() => { splashShowTimer = null; splashNow(text); }, d);
}
function hideSplash() {
    if (splashShowTimer) { clearTimeout(splashShowTimer); splashShowTimer = null; }
    if (!splashVisible) return;                 // 还没显示过 → 什么都不做（快启动就是这条）
    splashVisible = false;
    const el = document.getElementById('splash');
    if (el) el.classList.remove('splash-show');
}

// 启动：先渲染书库页；如果上次是点「重启软件」退出的，再自动回到原来的书和位置
// （慢的时候开屏才浮出来；快的时候一路看不见它）
showSplash('正在启动…');
loadProjects().then(() => restoreRestartSession()).finally(() => hideSplash());

