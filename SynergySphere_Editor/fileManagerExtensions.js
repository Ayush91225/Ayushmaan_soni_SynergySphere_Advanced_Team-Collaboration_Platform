// Extensions for FileManager - State persistence and file saving
FileManager.prototype.saveToStorage = function() {
    const state = {
        folderPath: this.currentFolderPath,
        openTabs: this.openTabs.map(tab => ({ path: tab.path, name: tab.name, modified: tab.modified })),
        activeTab: this.activeTab,
        expandedFolders: this.getExpandedFolders()
    };
    localStorage.setItem('synergy-editor-state', JSON.stringify(state));
};

FileManager.prototype.getExpandedFolders = function(obj = this.fileSystem, path = '') {
    const expanded = [];
    for (const [name, item] of Object.entries(obj)) {
        if (item.type === 'folder' && item.expanded) {
            const fullPath = path ? `${path}/${name}` : name;
            expanded.push(fullPath);
            expanded.push(...this.getExpandedFolders(item.children, fullPath));
        }
    }
    return expanded;
};

FileManager.prototype.loadFromStorage = async function() {
    const savedState = localStorage.getItem('synergy-editor-state');
    if (savedState) {
        try {
            const state = JSON.parse(savedState);
            if (state.folderPath) {
                this.updatePathDisplay(state.folderPath);
                this.log(`Restored editor state for: ${state.folderPath}`);
                const folderNameEl = document.querySelector('.folder-name');
                if (folderNameEl) folderNameEl.textContent = state.folderPath;
            }
        } catch (err) {
            this.log(`Error loading saved state: ${err.message}`, 'error');
        }
    }
};

FileManager.prototype.restoreState = async function() {
    const savedState = localStorage.getItem('synergy-editor-state');
    if (savedState && this.directoryHandle) {
        try {
            const state = JSON.parse(savedState);
            if (state.expandedFolders) {
                for (const folderPath of state.expandedFolders) {
                    await this.expandFolderByPath(folderPath);
                }
            }
            if (state.openTabs) {
                for (const tabInfo of state.openTabs) {
                    await this.openFile(tabInfo.path, false);
                }
            }
            if (state.activeTab) {
                this.activeTab = state.activeTab;
                this.renderTabs();
                if (window.renderEditor) window.renderEditor();
            }
            this.log(`✓ Restored ${state.openTabs?.length || 0} tabs and ${state.expandedFolders?.length || 0} expanded folders`);
        } catch (err) {
            this.log(`Error restoring state: ${err.message}`, 'error');
        }
    }
};

FileManager.prototype.expandFolderByPath = async function(path) {
    const pathParts = path.split('/').filter(p => p);
    let current = this.fileSystem;
    for (let i = 0; i < pathParts.length; i++) {
        const part = pathParts[i];
        if (current[part] && current[part].type === 'folder') {
            current = current[part];
            if (!current.expanded) {
                current.expanded = true;
                if (!current.loaded) {
                    await this.loadDirectory(current.handle, current.children, current.path);
                    current.loaded = true;
                }
            }
            if (i < pathParts.length - 1) current = current.children;
        }
    }
};

FileManager.prototype.saveFileToSystem = async function(filePath, content) {
    try {
        const pathParts = filePath.split('/').filter(p => p);
        let current = this.fileSystem;
        for (let i = 0; i < pathParts.length; i++) {
            const part = pathParts[i];
            if (current[part]) {
                current = current[part];
                if (i < pathParts.length - 1 && current.type === 'folder') {
                    if (!current.loaded) {
                        await this.loadDirectory(current.handle, current.children, current.path);
                        current.loaded = true;
                    }
                    current = current.children;
                }
            }
        }
        if (current && current.type === 'file' && current.handle) {
            const writable = await current.handle.createWritable();
            await writable.write(content);
            await writable.close();
            current.content = content;
            this.log(`✓ File saved: ${filePath}`);
            return true;
        }
        return false;
    } catch (err) {
        this.log(`❌ Error saving file: ${err.message}`, 'error');
        return false;
    }
};

FileManager.prototype.showSaveConfirmation = function(fileName, onConfirm) {
    const modal = document.getElementById('save-modal');
    const filenameEl = document.getElementById('save-filename');
    const confirmBtn = document.getElementById('save-confirm');
    const cancelBtn = document.getElementById('save-cancel');
    
    if (modal && filenameEl && confirmBtn && cancelBtn) {
        filenameEl.textContent = fileName;
        modal.style.display = 'flex';
        
        const handleConfirm = () => {
            modal.style.display = 'none';
            onConfirm();
            cleanup();
        };
        
        const handleCancel = () => {
            modal.style.display = 'none';
            cleanup();
        };
        
        const cleanup = () => {
            confirmBtn.removeEventListener('click', handleConfirm);
            cancelBtn.removeEventListener('click', handleCancel);
            document.removeEventListener('keydown', handleEscape);
        };
        
        const handleEscape = (e) => {
            if (e.key === 'Escape') handleCancel();
        };
        
        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);
        document.addEventListener('keydown', handleEscape);
    }
};