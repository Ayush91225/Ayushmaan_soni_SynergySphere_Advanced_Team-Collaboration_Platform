class FileManager {
    constructor() {
        this.fileSystem = {};
        this.openTabs = [];
        this.activeTab = null;
        this.currentFolderPath = '';
        this.directoryHandle = null;
        this.debug = true;
        
        this.log('FileManager initialized');
        this.loadFromStorage();
    }
    
    saveToStorage() {
        const state = {
            folderPath: this.currentFolderPath,
            openTabs: this.openTabs.map(tab => ({ path: tab.path, name: tab.name, modified: tab.modified })),
            activeTab: this.activeTab,
            expandedFolders: this.getExpandedFolders()
        };
        localStorage.setItem('synergy-editor-state', JSON.stringify(state));
        this.updateURL();
    }
    
    updateURL() {
        if (this.currentFolderPath) {
            const url = new URL(window.location);
            url.searchParams.set('repo', this.currentFolderPath);
            window.history.replaceState({}, '', url);
        }
    }
    
    getRepoFromURL() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('repo');
    }
    
    getExpandedFolders(obj = this.fileSystem, path = '') {
        const expanded = [];
        for (const [name, item] of Object.entries(obj)) {
            if (item.type === 'folder' && item.expanded) {
                const fullPath = path ? `${path}/${name}` : name;
                expanded.push(fullPath);
                expanded.push(...this.getExpandedFolders(item.children, fullPath));
            }
        }
        return expanded;
    }
    
    async loadFromStorage() {
        // Check URL parameter first
        const repoFromURL = this.getRepoFromURL();
        if (repoFromURL) {
            this.currentFolderPath = repoFromURL;
            this.updatePathDisplay(repoFromURL);
            this.log(`Found repo in URL: ${repoFromURL}`);
            const folderNameEl = document.querySelector('.folder-name');
            if (folderNameEl) {
                folderNameEl.textContent = repoFromURL;
            }
            this.log('Please select the folder to load your workspace', 'warning');
            return;
        }
        
        // Fallback to localStorage
        const savedState = localStorage.getItem('synergy-editor-state');
        if (savedState) {
            try {
                const state = JSON.parse(savedState);
                if (state.folderPath) {
                    this.currentFolderPath = state.folderPath;
                    this.updatePathDisplay(state.folderPath);
                    this.log(`Restored editor state for: ${state.folderPath}`);
                    const folderNameEl = document.querySelector('.folder-name');
                    if (folderNameEl) {
                        folderNameEl.textContent = state.folderPath;
                    }
                    this.log('Please select the same folder to restore your workspace', 'warning');
                }
            } catch (err) {
                this.log(`Error loading saved state: ${err.message}`, 'error');
            }
        }
    }
    
    updatePathDisplay(path) {
        const pathEl = document.getElementById('current-path');
        if (pathEl) {
            pathEl.textContent = path || 'No folder selected';
        }
        
        // Update terminal header path
        const terminalPath = document.querySelector('.terminal-header span');
        if (terminalPath && path) {
            terminalPath.textContent = `~/${path}`;
        }
    }
    
    log(message, type = 'info') {
        if (this.debug) {
            console.log(`[FileManager] ${message}`);
        }
        if (window.logToTerminal) {
            window.logToTerminal(message, type);
        }
    }
    
    async selectFolder() {
        try {
            this.log('Opening folder picker...');
            this.directoryHandle = await window.showDirectoryPicker();
            this.currentFolderPath = this.directoryHandle.name;
            
            const folderNameEl = document.querySelector('.folder-name');
            if (folderNameEl) {
                folderNameEl.textContent = this.directoryHandle.name;
            }
            
            this.updatePathDisplay(this.currentFolderPath);
            
            this.log(`Selected folder: ${this.directoryHandle.name}`);
            this.log('Loading directory structure...');
            
            this.fileSystem = {};
            await this.loadDirectory(this.directoryHandle, this.fileSystem, '');
            this.renderFileSystem();
            
            this.log(`✓ Loaded ${Object.keys(this.fileSystem).length} root items`);
            
            // Check if this matches the saved folder and restore state
            const savedState = localStorage.getItem('synergy-editor-state');
            const repoFromURL = this.getRepoFromURL();
            const expectedFolder = repoFromURL || (savedState ? JSON.parse(savedState).folderPath : null);
            
            if (expectedFolder && expectedFolder === this.currentFolderPath) {
                this.log(`Folder matches expected: ${expectedFolder}`);
                await this.restoreState();
            } else {
                this.log(`New workspace started for: ${this.currentFolderPath}`);
            }
            
            // Always save the new state
            this.saveToStorage();
        } catch (err) {
            if (err.name !== 'AbortError') {
                this.log(`✗ Error selecting folder: ${err.message}`, 'error');
            }
        }
    }
    
    async loadDirectory(dirHandle, target, currentPath) {
        this.log(`Loading directory: ${currentPath || 'root'}`);
        let itemCount = 0;
        
        try {
            for await (const [name, handle] of dirHandle.entries()) {
                const fullPath = currentPath ? `${currentPath}/${name}` : name;
                
                if (handle.kind === 'directory') {
                    target[name] = {
                        type: 'folder',
                        expanded: false,
                        children: {},
                        handle: handle,
                        path: fullPath,
                        loaded: false
                    };
                    this.log(`  📁 ${name} -> ${fullPath}`);
                } else {
                    target[name] = {
                        type: 'file',
                        handle: handle,
                        path: fullPath,
                        content: null,
                        loaded: false
                    };
                    this.log(`  📄 ${name} -> ${fullPath}`);
                }
                itemCount++;
            }
            this.log(`Loaded ${itemCount} items from ${currentPath || 'root'}`);
        } catch (err) {
            this.log(`Error loading directory ${currentPath}: ${err.message}`, 'error');
        }
    }
    
    async toggleFolder(path) {
        this.log(`Toggle folder clicked: ${path}`);
        
        const pathParts = path.split('/').filter(p => p);
        this.log(`Path parts: [${pathParts.join(', ')}]`);
        
        let current = this.fileSystem;
        
        for (let i = 0; i < pathParts.length; i++) {
            const part = pathParts[i];
            
            this.log(`Looking for part "${part}" in:`, Object.keys(current));
            
            if (current[part]) {
                current = current[part];
                this.log(`Found "${part}" - type: ${current.type}`);
                
                // If we're not at the last part and this is a folder, move to its children
                if (i < pathParts.length - 1 && current.type === 'folder') {
                    if (!current.loaded) {
                        this.log(`Need to load children for "${part}" first`);
                        await this.loadDirectory(current.handle, current.children, current.path);
                        current.loaded = true;
                    }
                    current = current.children;
                    this.log(`Moving to children of "${part}"`);
                }
            } else {
                this.log(`❌ Part "${part}" not found in current level`, 'error');
                this.log(`Available keys: [${Object.keys(current).join(', ')}]`, 'error');
                return;
            }
        }
        
        if (current && current.type === 'folder') {
            this.log(`Toggling folder: expanded=${current.expanded} -> ${!current.expanded}`);
            current.expanded = !current.expanded;
            
            if (current.expanded && !current.loaded) {
                this.log(`Loading children for: ${path}`);
                await this.loadDirectory(current.handle, current.children, current.path);
                current.loaded = true;
                this.log(`✓ Loaded ${Object.keys(current.children).length} children for ${path}`);
            }
            
            this.renderFileSystem();
            this.saveToStorage();
        } else {
            this.log(`❌ Item is not a folder or not found: ${path}`, 'error');
        }
    }
    
    async openFile(path, saveState = true) {
        this.log(`Open file clicked: ${path}`);
        
        const pathParts = path.split('/').filter(p => p);
        this.log(`File path parts: [${pathParts.join(', ')}]`);
        
        let current = this.fileSystem;
        
        for (let i = 0; i < pathParts.length; i++) {
            const part = pathParts[i];
            
            this.log(`Looking for file part "${part}" in:`, Object.keys(current));
            
            if (current[part]) {
                current = current[part];
                this.log(`Found "${part}" - type: ${current.type}`);
                
                // If we're not at the last part and this is a folder, move to its children
                if (i < pathParts.length - 1 && current.type === 'folder') {
                    if (!current.loaded) {
                        this.log(`Need to load children for "${part}" first`);
                        await this.loadDirectory(current.handle, current.children, current.path);
                        current.loaded = true;
                    }
                    current = current.children;
                    this.log(`Moving to children of "${part}"`);
                }
            } else {
                this.log(`❌ File part "${part}" not found`, 'error');
                this.log(`Available keys: [${Object.keys(current).join(', ')}]`, 'error');
                return;
            }
        }
        
        if (current && current.type === 'file') {
            this.log(`Loading file content for: ${path}`);
            await this.loadFileContent(current);
            
            const fileName = pathParts[pathParts.length - 1];
            const existingTab = this.openTabs.find(tab => tab.path === path);
            
            if (!existingTab) {
                this.openTabs.push({
                    path,
                    name: fileName,
                    content: current.content,
                    modified: false
                });
                this.log(`✓ Opened file: ${fileName}`);
            } else {
                this.log(`File already open: ${fileName}`);
            }
            
            this.activeTab = path;
            this.renderTabs();
            if (window.renderEditor) {
                window.renderEditor();
            }
            if (saveState) this.saveToStorage();
        } else {
            this.log(`❌ Item is not a file: ${path}`, 'error');
        }
    }
    
    async loadFileContent(fileItem) {
        if (!fileItem.loaded && fileItem.handle) {
            try {
                this.log(`Reading file content...`);
                const file = await fileItem.handle.getFile();
                fileItem.content = await file.text();
                fileItem.loaded = true;
                this.log(`✓ File content loaded (${fileItem.content.length} chars)`);
            } catch (err) {
                fileItem.content = `Error loading file: ${err.message}`;
                fileItem.loaded = true;
                this.log(`❌ Error loading file content: ${err.message}`, 'error');
            }
        }
    }
    
    closeTab(path, event) {
        if (event) {
            event.stopPropagation();
        }
        
        const tabIndex = this.openTabs.findIndex(tab => tab.path === path);
        if (tabIndex >= 0) {
            const tab = this.openTabs[tabIndex];
            this.openTabs.splice(tabIndex, 1);
            this.log(`Closed tab: ${tab.name}`);
            
            if (this.activeTab === path) {
                if (this.openTabs.length > 0) {
                    const newIndex = tabIndex < this.openTabs.length ? tabIndex : this.openTabs.length - 1;
                    this.activeTab = this.openTabs[newIndex].path;
                } else {
                    this.activeTab = null;
                }
            }
        }
        
        this.renderTabs();
        if (window.renderEditor) {
            window.renderEditor();
        }
        this.saveToStorage();
    }
    
    getFileIcon(fileName) {
        const ext = fileName.split('.').pop().toLowerCase();
        const iconMap = {
            'js': 'ph-file-js',
            'jsx': 'ph-file-jsx',
            'ts': 'ph-file-ts',
            'tsx': 'ph-file-tsx',
            'html': 'ph-file-html',
            'css': 'ph-file-css',
            'scss': 'ph-file-css',
            'sass': 'ph-file-css',
            'json': 'ph-brackets-curly',
            'md': 'ph-file-md',
            'py': 'ph-file-py',
            'java': 'ph-coffee',
            'xml': 'ph-file-xml',
            'yaml': 'ph-file-yml',
            'yml': 'ph-file-yml',
            'txt': 'ph-file-text',
            'pdf': 'ph-file-pdf',
            'zip': 'ph-file-zip',
            'png': 'ph-file-image',
            'jpg': 'ph-file-image',
            'jpeg': 'ph-file-image',
            'gif': 'ph-file-image',
            'svg': 'ph-file-svg'
        };
        return iconMap[ext] || 'ph-file';
    }
    
    renderFileSystem() {
        this.log('Rendering file system...');
        const container = document.getElementById('file-explorer');
        if (!container) {
            this.log('❌ File explorer container not found', 'error');
            return;
        }
        
        container.innerHTML = '';
        
        const renderItem = (name, item, level = 0) => {
            const div = document.createElement('div');
            
            if (item.type === 'folder') {
                div.className = `file-item folder ${item.expanded ? 'expanded' : ''}`;
                div.style.paddingLeft = `${12 + level * 16}px`;
                
                const caretIcon = item.expanded ? 'ph-caret-down' : 'ph-caret-right';
                const folderIcon = item.expanded ? 'ph-folder-open' : 'ph-folder';
                
                const folderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#f59e0b" viewBox="0 0 256 256"><path d="M245,110.64A16,16,0,0,0,232,104H216V88a16,16,0,0,0-16-16H130.67L102.94,51.2a16.14,16.14,0,0,0-9.6-3.2H40A16,16,0,0,0,24,64V208h0a8,8,0,0,0,8,8H211.1a8,8,0,0,0,7.59-5.47l28.49-85.47A16.05,16.05,0,0,0,245,110.64ZM93.34,64,123.2,86.4A8,8,0,0,0,128,88h72v16H69.77a16,16,0,0,0-15.18,10.94L40,158.7V64Zm112,136H43.1l26.67-80H232Z"></path></svg>`;
                
                div.innerHTML = `
                    <i class="ph ${caretIcon} folder-icon" style="color: var(--muted); width: 16px;"></i>
                    ${folderSvg}
                    <span>${name}</span>
                `;
                
                div.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.log(`Folder clicked: ${name} (${item.path})`);
                    this.toggleFolder(item.path);
                };
                
                container.appendChild(div);
                
                if (item.expanded && item.children) {
                    Object.entries(item.children)
                        .sort(([aName, a], [bName, b]) => {
                            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
                            return aName.localeCompare(bName);
                        })
                        .forEach(([childName, childItem]) => {
                            renderItem(childName, childItem, level + 1);
                        });
                }
            } else {
                const isActive = this.activeTab === item.path;
                div.className = `file-item ${isActive ? 'active' : ''}`;
                div.style.paddingLeft = `${28 + level * 16}px`;
                
                const icon = this.getFileIcon(name);
                const fileSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#64748b" viewBox="0 0 256 256"><path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Z"></path></svg>`;
                
                div.innerHTML = `
                    ${fileSvg}
                    <span>${name}</span>
                `;
                
                div.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.log(`File clicked: ${name} (${item.path})`);
                    this.openFile(item.path);
                };
                
                container.appendChild(div);
            }
        };
        
        const rootItems = Object.entries(this.fileSystem)
            .sort(([aName, a], [bName, b]) => {
                if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
                return aName.localeCompare(bName);
            });
        
        this.log(`Rendering ${rootItems.length} root items`);
        rootItems.forEach(([name, item]) => {
            renderItem(name, item);
        });
    }
    
    renderTabs() {
        const container = document.getElementById('tab-container');
        if (!container) return;
        
        container.innerHTML = '';
        
        this.openTabs.forEach(tab => {
            const div = document.createElement('div');
            div.className = `tab ${this.activeTab === tab.path ? 'active' : ''}`;
            
            const icon = this.getFileIcon(tab.name);
            const modifiedIndicator = tab.modified ? '●' : '';
            
            const tabFileSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="#569cd6" viewBox="0 0 256 256"><path d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Z"></path></svg>`;
            
            div.innerHTML = `
                ${tabFileSvg}
                <span>${tab.name}${modifiedIndicator}</span>
                <i class="ph ph-x close-tab"></i>
            `;
            
            div.onclick = (e) => {
                if (e.target.classList.contains('ph-x')) {
                    this.closeTab(tab.path, e);
                } else {
                    this.activeTab = tab.path;
                    this.renderTabs();
                    if (window.renderEditor) {
                        window.renderEditor();
                    }
                }
            };
            
            container.appendChild(div);
        });
    }
    
    showSaveConfirmation(fileName, onConfirm) {
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
    }
    
    async saveFileToSystem(filePath, content) {
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
    }
    async restoreState() {
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
    }
    
    async expandFolderByPath(path) {
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
    }
}

window.FileManager = FileManager;