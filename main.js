// ============================================================
// 主进程 - 无边框窗口 + 窗口控制 + 开发者工具快捷
// ============================================================
const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');

const path = require('path');
const fs = require('fs');

let mainWindow;
let currentProjectPath = null;
let isQuitting = false;

// 禁用 GPU 着色器磁盘缓存，避免缓存目录不可写时在控制台刷出 cache 相关报错（不影响任何功能）
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// ----- 工作区 -----
function getWorkspaceRoot() {
    if (app.isPackaged) {
        return path.dirname(app.getPath('exe'));
    } else {
        return process.cwd();
    }
}
const LIBRARY_DIR = path.join(getWorkspaceRoot(), '小说库');

function ensureLibraryExists() {
    if (!fs.existsSync(LIBRARY_DIR)) {
        fs.mkdirSync(LIBRARY_DIR, { recursive: true });
    }
    // 预置教程：首次运行若小说库还没有「使用教程」，则从程序目录复制一份
    // 旧版本里它叫「教程演示」—— 老用户的库里已经有那本了，就别再塞一本新的进去
    try {
        const tutorialSource = path.join(__dirname, '小说库', '使用教程.json');
        const tutorialDest = path.join(LIBRARY_DIR, '使用教程.json');
        const tutorialLegacy = path.join(LIBRARY_DIR, '教程演示.json');
        if (fs.existsSync(tutorialSource) && !fs.existsSync(tutorialDest) && !fs.existsSync(tutorialLegacy)) {
            fs.copyFileSync(tutorialSource, tutorialDest);
        }
    } catch (e) {}
}

// ----- 启动 / 退出时自动清理临时文件（调试脚本、日志、临时导出…）-----
// 说明：正常使用的软件本身不写任何日志文件，这里清理的是开发/调试时留在
//      程序目录（以及打包后的 exe 同目录）顶层的一些垃圾文件。
// 安全：只删"顶层文件"、且文件名必须命中下面的规则；目录（尤其是「小说库」）
//      和小说库里的任何数据文件都不会被碰。
const TEMP_NAME_PATTERNS = [
    /^_test/i,                       // _test_crop.js / _test_out.txt …
    /^_chk/i,                        // _chk_something.js
    /^_tmp/i,
    /^_debug/i,
    /^_dbg/i,
    /^_b\d+\.txt$/i,                 // _b1.txt / _b10.txt（调试用的片段）
    /^_.*_out\d*\.(txt|log|json)$/i,
    /^_[\w-]+\.(log|tmp)$/i,         // _xxx.log（我们自己可能留下的日志）
    /^npm-debug\.log/i,
    /^electron.*\.log$/i,
    /^novel.*\.log$/i,
    /\.tmp$/i,
    /^~\$/                           // Office / 系统临时文件 ~$xxx
];

function cleanTempFiles() {
    const dirs = [__dirname];
    const ws = getWorkspaceRoot();
    if (path.resolve(ws) !== path.resolve(__dirname)) dirs.push(ws);
    let removed = 0;
    dirs.forEach(dir => {
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;                       // 目录不可读就跳过，不影响启动
        }
        entries.forEach(ent => {
            try {
                if (!ent.isFile()) return;                        // 目录一律不动（小说库 / 备份 / node_modules…）
                if (ent.name.startsWith('小说库') || ent.name === '_book_trash.json') return;
                if (!TEMP_NAME_PATTERNS.some(re => re.test(ent.name))) return;
                fs.unlinkSync(path.join(dir, ent.name));
                removed++;
            } catch (e) { /* 被占用或没权限：忽略，下次启动再试 */ }
        });
    });
    if (removed > 0) console.log(`[临时文件清理] 已删除 ${removed} 个临时文件 / 日志`);
    return removed;
}

// ----- 创建窗口（无边框）-----
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        frame: false,                     // 去掉原生标题栏
        // titleBarStyle 是 macOS 专用；Windows 上同时设置会引发最大化后标题栏异常，故仅 darwin 生效
        titleBarStyle: (process.platform === 'darwin') ? 'hidden' : undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: true,
        },
        backgroundColor: (require('electron').nativeTheme.shouldUseDarkColors ? '#1a1a2e' : '#f0f2f5'),
        show: false,
    });
    // 使用绝对路径加载页面，避免打包后相对路径失效
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });
    mainWindow.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            mainWindow.webContents.send('before-quit');
        }
    });
    // 最大化状态变化 → 通知渲染进程（标题栏按钮的提示与图标要跟着切换，否则最大化后仍显示"最大化"）
    mainWindow.on('maximize', () => {
        if (mainWindow) mainWindow.webContents.send('window-maximized-change', true);
    });
    mainWindow.on('unmaximize', () => {
        if (mainWindow) mainWindow.webContents.send('window-maximized-change', false);
    });
}

app.whenReady().then(() => {
    cleanTempFiles();          // 每次打开软件先清一次临时文件（调试脚本 / 日志）
    ensureLibraryExists();
    createWindow();
    Menu.setApplicationMenu(null); // 隐藏默认菜单
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// 退出时再清一次（顺手收掉本次运行留下的临时文件）
app.on('will-quit', () => {
    try { cleanTempFiles(); } catch (e) {}
});

// ============================================================
// IPC 通信
// ============================================================

// ----- 项目管理 -----
// 项目元数据缓存：filePath -> { mtimeMs, name, nodeCount }（文件未修改时直接用缓存，避免重复解析大 JSON）
const projectMetaCache = new Map();

ipcMain.handle('get-projects', async () => {
    try {
        const files = (await fs.promises.readdir(LIBRARY_DIR))
            .filter(f => f.endsWith('.json') && !f.startsWith('_'));   // 排除 _book_trash.json 等内部文件
        const projects = await Promise.all(files.map(async f => {
            const filePath = path.join(LIBRARY_DIR, f);
            let stats;
            try { stats = await fs.promises.stat(filePath); } catch (e) { return null; }
            let name = f.replace('.json', '');
            let nodeCount = 0;
            const cached = projectMetaCache.get(filePath);
            if (cached && cached.mtimeMs === stats.mtimeMs) {
                name = cached.name;
                nodeCount = cached.nodeCount;
            } else {
                try {
                    const content = await fs.promises.readFile(filePath, 'utf8');
                    const data = JSON.parse(content);
                    nodeCount = data.nodes ? data.nodes.length : 0;
                    if (data.projectName) name = data.projectName;
                    projectMetaCache.set(filePath, { mtimeMs: stats.mtimeMs, name, nodeCount });
                } catch (e) {}
            }
            return {
                id: f,
                name: name,
                filePath: filePath,
                updatedAt: stats.mtimeMs,
                nodeCount: nodeCount,
                createdAt: stats.birthtimeMs || stats.mtimeMs
            };
        }));
        return projects.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (e) {
        return [];
    }
});

ipcMain.handle('load-project', (event, filePath) => {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(data);
        currentProjectPath = filePath;
        return { success: true, data: parsed, filePath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('save-project', (event, filePath, data) => {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        currentProjectPath = filePath;
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('create-project', (event, projectName) => {
    try {
        const safeName = projectName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
        const filePath = path.join(LIBRARY_DIR, safeName + '.json');
        if (fs.existsSync(filePath)) {
            return { success: false, error: '文件已存在' };
        }
        const newData = {
            projectName: projectName,
            version: '2.0',
            nodes: [],
            connections: [],
            trash: [],
            bookTrash: [],
            canvasBg: null,
            createdAt: Date.now()
        };
        fs.writeFileSync(filePath, JSON.stringify(newData, null, 2), 'utf8');
        return { success: true, filePath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-project', (event, filePath) => {
    try {
        fs.unlinkSync(filePath);
        if (currentProjectPath === filePath) currentProjectPath = null;
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 重命名小说：同步修改 .json 文件名（冲突时自动加序号）
ipcMain.handle('rename-project', (event, oldPath, newName) => {
    try {
        const dir = path.dirname(oldPath);
        const safeName = newName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
        let newPath = path.join(dir, safeName + '.json');
        if (newPath === oldPath) {
            return { success: true, filePath: oldPath };
        }
        // 冲突时自动加序号
        let counter = 2;
        while (fs.existsSync(newPath)) {
            newPath = path.join(dir, safeName + '(' + counter + ').json');
            counter++;
        }
        // 更新项目内的 projectName 后写新文件、删旧文件
        const data = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
        data.projectName = newName;
        fs.writeFileSync(newPath, JSON.stringify(data, null, 2), 'utf8');
        fs.unlinkSync(oldPath);
        if (currentProjectPath === oldPath) currentProjectPath = newPath;
        return { success: true, filePath: newPath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-workspace', () => {
    return LIBRARY_DIR;
});

ipcMain.handle('open-workspace', () => {
    try {
        shell.openPath(LIBRARY_DIR);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 选择本地图片：复制到项目目录下的「背景图片缓存」文件夹，返回相对路径（随项目整体移动）
// 文件名用的时间戳：本地时间精确到分钟，形如 20260917-0240（人看得懂，也天然按时间排序）
function formatStamp(d = new Date()) {
    const p = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// 文件名里"我们自己加过的"那段时间戳：_20260917-0240（可带 _裁剪、可带同名序号 _1）
// 拼新文件名前先剥掉它，免得反复导入 / 裁剪后名字里叠出两三个时间戳、越接越长
const OWN_STAMP_RE = /(?:_裁剪)?_\d{8}-\d{4}(?:_\d+)?$/;
function stripOwnStamp(name) {
    return String(name).replace(OWN_STAMP_RE, '');
}


ipcMain.handle('select-image', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择背景图片',
        filters: [
            { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'] }
        ],
        properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return { success: false };
    if (!currentProjectPath) return { success: false, error: '未打开项目' };
    try {
        const projectDir = path.dirname(currentProjectPath);
        const cacheDir = path.join(projectDir, '背景图片缓存');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        const src = result.filePaths[0];
        const ext = path.extname(src);
        // 文件名 = 原图名 + 导入时间戳（例：风景_20260917-0240.jpg）
        // 好处：一眼看出导入顺序；即使旧图被清理，新导入的同名图也不会占用旧文件名而让旧引用指错图
        // 先剥掉旧名字里我们自己加过的时间戳：重新导入旧图也不会变成"两个时间戳"
        let base = stripOwnStamp(path.basename(src, ext)) || 'bg';
        const stamp = formatStamp();
        let dest = path.join(cacheDir, `${base}_${stamp}${ext}`);
        let n = 1;
        while (fs.existsSync(dest)) {
            dest = path.join(cacheDir, `${base}_${stamp}_${n}${ext}`);
            n++;
        }
        fs.copyFileSync(src, dest);
        // 返回相对项目目录的路径（统一正斜杠）
        const rel = path.relative(projectDir, dest).split(path.sep).join('/');
        return { success: true, filePath: rel };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 读取图片文件内容（base64 dataURL）：框选裁剪用——避免渲染进程直接引用 file:// 图片时 canvas 被"污染"而无法导出
// 只读不写；相对路径必须在当前项目目录内，绝对路径只允许读取图片文件
ipcMain.handle('read-image-data', (event, p) => {
    try {
        if (!p || typeof p !== 'string') return { success: false, error: '路径无效' };
        let abs;
        if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')) {
            abs = p;   // 绝对路径（旧数据 / 外部图片）：只读
        } else {
            if (!currentProjectPath) return { success: false, error: '未打开项目' };
            const projectDir = path.dirname(currentProjectPath);
            abs = path.resolve(projectDir, p.split('/').join(path.sep));
            if (!abs.startsWith(projectDir)) return { success: false, error: '路径不在项目目录内' };
        }
        if (!/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(abs)) return { success: false, error: '该图片格式不支持裁剪' };
        if (!fs.existsSync(abs)) return { success: false, error: '图片文件不存在' };
        const buf = fs.readFileSync(abs);
        const ext = path.extname(abs).toLowerCase();
        const mime = ext === '.png' ? 'image/png'
            : ext === '.gif' ? 'image/gif'
            : ext === '.webp' ? 'image/webp'
            : ext === '.bmp' ? 'image/bmp'
            : 'image/jpeg';
        return { success: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 保存框选裁剪的结果：把渲染进程裁好的图片（base64 dataURL）写进「背景图片缓存」，返回新的相对路径
// 注意：只新增文件，绝不删除/覆盖任何已有图片（原图与缓存里那份原副本都原样留着）
ipcMain.handle('save-cropped-image', (event, payload) => {
    try {
        if (!currentProjectPath) return { success: false, error: '未打开项目' };
        const dataUrl = payload && payload.dataUrl;
        const sourceName = (payload && payload.sourceName) || 'bg';
        if (!dataUrl || typeof dataUrl !== 'string') return { success: false, error: '没有图片数据' };
        const m = /^data:image\/(png|jpeg|jpg|webp);base64,([\s\S]+)$/i.exec(dataUrl);
        if (!m) return { success: false, error: '图片格式不支持' };
        const rawExt = m[1].toLowerCase();
        const ext = (rawExt === 'jpeg' || rawExt === 'jpg') ? 'jpg' : rawExt;
        const buf = Buffer.from(m[2], 'base64');
        const projectDir = path.dirname(currentProjectPath);
        const cacheDir = path.join(projectDir, '背景图片缓存');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        // 文件名 = 原图名 + _裁剪 + 时间戳（例：风景_裁剪_20260917-0240.jpg；重名再加序号）
        // 同一张原图反复裁剪/当背景只会不断新增文件，绝不覆盖任何已有图片
        // 先剥掉旧名字里我们自己加过的时间戳（可能还带 _裁剪 / _1）：
        // 反复裁剪同一张图 → 永远是「风景_裁剪_时间戳」，不会叠成两个时间戳、也不会越接越长
        let base = stripOwnStamp(path.basename(String(sourceName), path.extname(String(sourceName)))) || 'bg';
        base = base.replace(/[\\/:*?"<>|]/g, '_');
        const stamp = formatStamp();
        let dest = path.join(cacheDir, `${base}_裁剪_${stamp}.${ext}`);
        let n = 1;
        while (fs.existsSync(dest)) { dest = path.join(cacheDir, `${base}_裁剪_${stamp}_${n}.${ext}`); n++; }
        fs.writeFileSync(dest, buf);
        const rel = path.relative(projectDir, dest).split(path.sep).join('/');
        return { success: true, filePath: rel };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 删除背景图片缓存文件（仅限项目目录内，防止误删其他文件）
ipcMain.handle('delete-cache-image', (event, relPath) => {
    try {
        if (!currentProjectPath || !relPath) return { success: false };
        const projectDir = path.dirname(currentProjectPath);
        const abs = path.resolve(projectDir, relPath.split('/').join(path.sep));
        if (!abs.startsWith(projectDir)) return { success: false };
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 列出「背景图片缓存」内的文件（设置面板统计 / 清理未引用图片用）
ipcMain.handle('list-cache-images', () => {
    try {
        if (!currentProjectPath) return { success: false, files: [] };
        const projectDir = path.dirname(currentProjectPath);
        const cacheDir = path.join(projectDir, '背景图片缓存');
        if (!fs.existsSync(cacheDir)) return { success: true, files: [] };
        const files = fs.readdirSync(cacheDir)
            .filter(f => { try { return fs.statSync(path.join(cacheDir, f)).isFile(); } catch (e) { return false; } })
            .map(f => {
                let size = 0;
                try { size = fs.statSync(path.join(cacheDir, f)).size; } catch (e) {}
                return { rel: '背景图片缓存/' + f, size };
            });
        return { success: true, files };
    } catch (e) {
        return { success: false, files: [], error: e.message };
    }
});

// 备份当前书：复制一份 JSON 到「小说库/备份/」（文件名带时间戳）
ipcMain.handle('backup-project', (event, data) => {
    try {
        if (!currentProjectPath || !data) return { success: false, error: '未打开项目' };
        const backupDir = path.join(LIBRARY_DIR, '备份');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const base = path.basename(currentProjectPath, '.json');
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        const dest = path.join(backupDir, `${base}_${stamp}.json`);
        fs.writeFileSync(dest, JSON.stringify(data, null, 2), 'utf-8');
        return { success: true, filePath: dest };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 扫描整个书库的「背景图片缓存」：谁在用、谁没用、谁失效
// —— 缓存目录是整个书库共用的，所以清理必须看所有书，否则会误删别的书正在用的图
// 返回：{ files:[{rel,size}], refs:[{rel,book,where}], unused:[{rel,size}], missing:[{rel,book,where}] }
ipcMain.handle('scan-library-cache', async () => {
    try {
        const cacheDir = path.join(LIBRARY_DIR, '背景图片缓存');
        let files = [];
        if (fs.existsSync(cacheDir)) {
            files = fs.readdirSync(cacheDir)
                .filter(f => { try { return fs.statSync(path.join(cacheDir, f)).isFile(); } catch (e) { return false; } })
                .map(f => {
                    let size = 0;
                    try { size = fs.statSync(path.join(cacheDir, f)).size; } catch (e) {}
                    return { rel: '背景图片缓存/' + f, size };
                });
        }
        const fileSet = new Set(files.map(f => f.rel.toLowerCase()));   // 大小写不敏感：Windows 上 xxx.JPG 和 xxx.jpg 是同一个文件
        const refs = [];        // 所有引用（含回收站等，只用于"别误删"）
        const liveRefs = [];    // 真正在用的引用（词条 / 画布 / 详情页），"失效"提示只看这些
        const pushRef = (p, book, where, live) => {
            if (typeof p !== 'string') return;
            const rel = p.replace(/\\/g, '/');
            if (!rel.startsWith('背景图片缓存/')) return;      // 只看缓存目录里的图（外部绝对路径不归我们管）
            const item = { rel, book, where, live: !!live };
            refs.push(item);
            if (live) liveRefs.push(item);
        };
        // ① 真正在用的：所有书的 画布背景 / 详情页背景 / 每个词条的背景图
        const collectLive = (data, book) => {
            pushRef(data.canvasBg, book, '画布背景', true);
            pushRef(data.detailBg, book, '详情页背景', true);
            (data.nodes || []).forEach(n => pushRef(n.bgImage, book, n.title ? '词条「' + n.title + '」' : '词条背景', true));
        };
        // ② 别的地方（回收站词条、快照副本…）也扫一遍：这些图片先算"还在用"，免得被误删
        const collectAny = (obj, book) => {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj)) { obj.forEach(o => collectAny(o, book)); return; }
            Object.keys(obj).forEach(k => {
                const v = obj[k];
                if (k === 'canvasBg') pushRef(v, book, '画布背景', false);
                else if (k === 'detailBg') pushRef(v, book, '详情页背景', false);
                else if (k === 'bgImage') pushRef(v, book, (obj.title ? '词条「' + obj.title + '」' : '词条背景'), false);
                else if (v && typeof v === 'object') collectAny(v, book);
            });
        };
        const books = (await fs.promises.readdir(LIBRARY_DIR)).filter(f => f.endsWith('.json'));  // 含 _book_trash.json：回收站里的也算引用，别误删
        for (const f of books) {
            let data = null;
            try { data = JSON.parse(await fs.promises.readFile(path.join(LIBRARY_DIR, f), 'utf8')); } catch (e) { continue; }
            const bookName = (data && data.projectName) || f.replace('.json', '');
            collectLive(data, bookName);
            collectAny(data, bookName);
        }
        const used = new Set(refs.map(r => r.rel.toLowerCase()));
        const unused = files.filter(f => !used.has(f.rel.toLowerCase()));
        // 失效引用：只看"真正在用"的那些，去重后报告（换过图/删过词条后就会自动消失）
        const missing = [];
        const missSeen = new Set();
        liveRefs.forEach(r => {
            if (fileSet.has(r.rel.toLowerCase())) return;
            const k = (r.rel + '|' + r.book + '|' + r.where).toLowerCase();
            if (missSeen.has(k)) return;
            missSeen.add(k);
            missing.push({ rel: r.rel, book: r.book, where: r.where });
        });
        return { success: true, files, refs, unused, missing };
    } catch (e) {
        return { success: false, error: e.message, files: [], refs: [], unused: [], missing: [] };
    }
});

// 打开「背景图片缓存」文件夹
ipcMain.handle('open-cache-folder', () => {
    try {
        if (!currentProjectPath) return { success: false };
        const cacheDir = path.join(path.dirname(currentProjectPath), '背景图片缓存');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        shell.openPath(cacheDir);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 导入 TXT / Markdown 文件（可多选）
ipcMain.handle('import-text-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入 TXT / Markdown 文件（可多选）',
        filters: [
            { name: '文本文件', extensions: ['txt', 'md', 'markdown'] }
        ],
        properties: ['openFile', 'multiSelections']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        const files = result.filePaths.map(filePath => {
            const content = fs.readFileSync(filePath, 'utf8');
            const name = path.basename(filePath).replace(/\.(txt|md|markdown)$/i, '');
            return { name: name, content: content, filePath: filePath };
        });
        return { success: true, files: files };
    }
    return { success: false };
});

// 读取指定文本文件（拖拽导入用）
ipcMain.handle('read-text-file', (event, filePath) => {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const name = path.basename(filePath).replace(/\.(txt|md|markdown)$/i, '');
        return { success: true, name: name, content: content, filePath: filePath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 导出为 Markdown
ipcMain.handle('export-markdown', async (event, content, defaultName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出为 Markdown',
        defaultPath: (defaultName || '导出') + '.md',
        filters: [
            { name: 'Markdown', extensions: ['md'] }
        ]
    });
    if (!result.canceled && result.filePath) {
        fs.writeFileSync(result.filePath, content, 'utf8');
        return { success: true, filePath: result.filePath };
    }
    return { success: false };
});

// 批量导出多本小说为 Markdown 到所选文件夹
ipcMain.handle('export-all-markdown', async (event, files) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择导出文件夹',
        properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        const dir = result.filePaths[0];
        let count = 0;
        (files || []).forEach(f => {
            fs.writeFileSync(path.join(dir, (f.fileName || '导出') + '.md'), f.content, 'utf8');
            count++;
        });
        return { success: true, count: count };
    }
    return { success: false };
});

// ----- 全局书籍回收站（独立于单个项目，所有被删书籍统一存放）-----
const BOOK_TRASH_FILE = path.join(LIBRARY_DIR, '_book_trash.json');

function readBookTrash() {
    try {
        if (fs.existsSync(BOOK_TRASH_FILE)) {
            return JSON.parse(fs.readFileSync(BOOK_TRASH_FILE, 'utf8'));
        }
    } catch (e) {}
    return [];
}

function writeBookTrash(items) {
    fs.writeFileSync(BOOK_TRASH_FILE, JSON.stringify(items, null, 2), 'utf8');
}

// 删除书籍 -> 移入全局书籍回收站（实时生效）
ipcMain.handle('trash-book', (event, item) => {
    try {
        const items = readBookTrash();
        if (!items.some(i => i.filePath === item.filePath)) {
            items.push(item);
        }
        writeBookTrash(items);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 读取书籍回收站
ipcMain.handle('get-book-trash', () => {
    return { success: true, items: readBookTrash() };
});

// 恢复书籍（从回收站写回小说库）
ipcMain.handle('restore-book', (event, filePath) => {
    try {
        const items = readBookTrash();
        const idx = items.findIndex(i => i.filePath === filePath);
        if (idx === -1) return { success: false, error: '未找到该书籍' };
        const item = items[idx];
        fs.writeFileSync(item.filePath, JSON.stringify(item.data, null, 2), 'utf8');
        items.splice(idx, 1);
        writeBookTrash(items);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 永久删除回收站中的书籍
ipcMain.handle('delete-book-trash', (event, filePaths) => {
    try {
        const items = readBookTrash().filter(i => !filePaths.includes(i.filePath));
        writeBookTrash(items);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 清空书籍回收站
ipcMain.handle('empty-book-trash', () => {
    try {
        writeBookTrash([]);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ----- 退出 -----
ipcMain.on('quit-confirmed', () => {
    isQuitting = true;
    app.quit();
});

// ----- 窗口控制（标题栏按钮）-----
ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
});
ipcMain.on('window-maximize', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
    }
});
ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
});

// ----- 重启软件（帮助里的按钮；即使界面卡住也能用）-----
ipcMain.on('restart-app', () => {
    isQuitting = true;          // 跳过"是否保留数据"的退出询问，直接重启
    app.relaunch();
    app.exit(0);
});

// ----- 开发者工具（帮助按钮触发）-----
ipcMain.on('open-dev-tools', () => {
    if (mainWindow) {
        mainWindow.webContents.openDevTools();
    }
});

// ----- 关闭前保存 -----
ipcMain.on('before-quit', (event) => {
    // 由渲染进程处理
});