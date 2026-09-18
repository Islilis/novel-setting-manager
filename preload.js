// ============================================================
// 预加载脚本 - 安全暴露 API
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // 项目管理
    getProjects: () => ipcRenderer.invoke('get-projects'),
    loadProject: (filePath) => ipcRenderer.invoke('load-project', filePath),
    saveProject: (filePath, data) => ipcRenderer.invoke('save-project', filePath, data),
    createProject: (name) => ipcRenderer.invoke('create-project', name),
    deleteProject: (filePath) => ipcRenderer.invoke('delete-project', filePath),
    renameProject: (oldPath, newName) => ipcRenderer.invoke('rename-project', oldPath, newName),
    getWorkspace: () => ipcRenderer.invoke('get-workspace'),
    openWorkspace: () => ipcRenderer.invoke('open-workspace'),
    selectImage: () => ipcRenderer.invoke('select-image'),
    readImageData: (relPath) => ipcRenderer.invoke('read-image-data', relPath),
    saveCroppedImage: (payload) => ipcRenderer.invoke('save-cropped-image', payload),
    deleteCacheImage: (relPath) => ipcRenderer.invoke('delete-cache-image', relPath),
    openCacheFolder: () => ipcRenderer.invoke('open-cache-folder'),
    listCacheImages: () => ipcRenderer.invoke('list-cache-images'),
    scanLibraryCache: () => ipcRenderer.invoke('scan-library-cache'),
    backupProject: (data) => ipcRenderer.invoke('backup-project', data),

    // 导入/导出文本
    importTextFile: () => ipcRenderer.invoke('import-text-file'),
    readTextFile: (filePath) => ipcRenderer.invoke('read-text-file', filePath),
    exportMarkdown: (content, defaultName) => ipcRenderer.invoke('export-markdown', content, defaultName),
    exportAllMarkdown: (files) => ipcRenderer.invoke('export-all-markdown', files),

    // 全局书籍回收站
    trashBook: (item) => ipcRenderer.invoke('trash-book', item),
    getBookTrash: () => ipcRenderer.invoke('get-book-trash'),
    restoreBook: (filePath) => ipcRenderer.invoke('restore-book', filePath),
    deleteBookTrash: (filePaths) => ipcRenderer.invoke('delete-book-trash', filePaths),
    emptyBookTrash: () => ipcRenderer.invoke('empty-book-trash'),

    // 退出
    onBeforeQuit: (callback) => ipcRenderer.on('before-quit', callback),
    quitConfirmed: () => ipcRenderer.send('quit-confirmed'),

    // 窗口控制
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    restartApp: () => ipcRenderer.send('restart-app'),
    onMaximizedChange: (callback) => ipcRenderer.on('window-maximized-change', (_e, isMaximized) => callback(isMaximized)),

    // 开发者工具
    openDevTools: () => ipcRenderer.send('open-dev-tools')
});