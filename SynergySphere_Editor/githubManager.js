class GitHubManager {
    constructor() {
        this.repoData = null;
        this.currentRepo = '';
        this.defaultBranch = 'main';
        this.fileSystem = {};
        this.commits = [];
        this.debug = true;
        this.sessionId = localStorage.getItem('github-session');
        this.user = JSON.parse(localStorage.getItem('github-user') || 'null');
        this.userRepos = [];
        this.isOwner = false;
        this.hasWriteAccess = false;
        this.API_BASE = 'http://localhost:3001';
    }

    log(message, type = 'info') {
        if (this.debug) console.log(`[GitHub] ${message}`);
        if (window.logToTerminal) window.logToTerminal(message, type);
    }

    getRepoFromURL() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('repo');
    }

    updateURL(repo) {
        const url = new URL(window.location);
        url.searchParams.set('repo', repo);
        window.history.replaceState({}, '', url);
    }

    async fetchRepo(repoUrl) {
        try {
            const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/) || repoUrl.match(/^([^\/]+)\/([^\/]+)$/);
            if (!match) throw new Error('Invalid repository format');
            
            const [, owner, repo] = match;
            this.currentRepo = `${owner}/${repo}`;
            this.isOwner = this.user && this.user.login === owner;
            
            this.log(`Fetching repository: ${this.currentRepo}`);
            
            // Use authenticated requests if we have a session
            const headers = await this.getAuthHeaders();
            
            // Get repository info to find default branch and check permissions
            const repoResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
            if (!repoResponse.ok) {
                if (repoResponse.status === 404) {
                    throw new Error('Repository not found');
                } else if (repoResponse.status === 403) {
                    throw new Error('Repository is private or access denied');
                } else {
                    throw new Error(`Failed to access repository (${repoResponse.status})`);
                }
            }
            
            const repoData = await repoResponse.json();
            this.defaultBranch = repoData.default_branch;
            
            // Check write permissions
            this.hasWriteAccess = repoData.permissions && 
                (repoData.permissions.push || repoData.permissions.admin);
            
            this.log(`Repository permissions - Push: ${repoData.permissions?.push}, Admin: ${repoData.permissions?.admin}`);
            
            const treeResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${this.defaultBranch}?recursive=1`, { headers });
            if (!treeResponse.ok) throw new Error('Failed to fetch repository tree');
            
            const treeData = await treeResponse.json();
            this.buildFileSystem(treeData.tree);
            
            await this.fetchCommits(owner, repo);
            
            localStorage.setItem('github-repo', this.currentRepo);
            this.updateURL(this.currentRepo);
            this.updateRepoDisplay();
            
            this.log(`✅ Loaded ${treeData.tree.length} items from ${this.currentRepo} (${this.defaultBranch})`);
            return true;
        } catch (err) {
            this.log(`❌ Error fetching repo: ${err.message}`, 'error');
            return false;
        }
    }

    buildFileSystem(tree) {
        this.fileSystem = {};
        
        tree.forEach(item => {
            if (item.type === 'blob') { // file
                this.setNestedPath(this.fileSystem, item.path, {
                    type: 'file',
                    path: item.path,
                    sha: item.sha,
                    content: null,
                    loaded: false
                });
            } else if (item.type === 'tree') { // directory
                this.setNestedPath(this.fileSystem, item.path, {
                    type: 'folder',
                    path: item.path,
                    expanded: false,
                    children: {}
                });
            }
        });
    }

    setNestedPath(obj, path, value) {
        const parts = path.split('/');
        let current = obj;
        
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (!current[part]) {
                current[part] = {
                    type: 'folder',
                    path: parts.slice(0, i + 1).join('/'),
                    expanded: false,
                    children: {}
                };
            }
            current = current[part].children;
        }
        
        const fileName = parts[parts.length - 1];
        current[fileName] = value;
    }

    async fetchCommits(owner, repo) {
        try {
            const headers = await this.getAuthHeaders();
            const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=20`, { headers });
            if (!response.ok) throw new Error('Failed to fetch commits');
            
            this.commits = await response.json();
            this.displayCommits();
            this.log(`✅ Loaded ${this.commits.length} commits`);
        } catch (err) {
            this.log(`❌ Error fetching commits: ${err.message}`, 'error');
        }
    }

    displayCommits() {
        const output = document.getElementById('logs-output');
        if (!output) return;
        
        let accessStatus = ' (Read-only)';
        if (this.hasWriteAccess) {
            accessStatus = this.isOwner ? ' (Owner)' : ' (Collaborator)';
        }
        
        output.innerHTML = `<span style="color:#10b981">✅</span> Repository: ${this.currentRepo}${accessStatus}\n\n<span style="color:#f59e0b">Recent Commits:</span>\n`;
        
        this.commits.forEach((commit, i) => {
            const date = new Date(commit.commit.author.date).toLocaleDateString();
            const shortSha = commit.sha.substring(0, 7);
            const message = commit.commit.message.split('\n')[0];
            const author = commit.commit.author.name;
            
            output.innerHTML += `<span style="color:#64748b">${shortSha}</span> ${message} <span style="color:#94a3b8">- ${author} (${date})</span>\n`;
        });
        
        output.innerHTML += `\n<span style="color:#10b981">$</span> <span style="background:rgba(16,185,129,0.1);padding:2px 4px;border-radius:3px">▊</span>`;
    }

    async loadFileContent(filePath, sha) {
        try {
            const [owner, repo] = this.currentRepo.split('/');
            const headers = await this.getAuthHeaders();
            const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`, { headers });
            if (!response.ok) throw new Error('Failed to fetch file content');
            
            const data = await response.json();
            return atob(data.content); // Decode base64
        } catch (err) {
            this.log(`❌ Error loading file: ${err.message}`, 'error');
            return `Error loading file: ${err.message}`;
        }
    }

    async loadFromStorage() {
        if (!this.sessionId) {
            this.log('No session found, redirecting to login');
            window.location.href = '/login/';
            return false;
        }
        
        // Validate session first
        const isValid = await this.validateSession();
        if (!isValid) {
            this.log('Session invalid, redirecting to login');
            localStorage.removeItem('github-session');
            localStorage.removeItem('github-user');
            window.location.href = '/login/';
            return false;
        }
        
        await this.loadUserRepos();
        
        const savedRepo = localStorage.getItem('github-repo');
        const urlRepo = this.getRepoFromURL();
        
        const repoToLoad = urlRepo || savedRepo;
        if (repoToLoad) {
            this.log(`Restoring repository: ${repoToLoad}`);
            await this.fetchRepo(repoToLoad);
            return true;
        }
        return false;
    }
    
    async validateSession() {
        try {
            const response = await fetch(`${this.API_BASE}/api/user`, {
                headers: { 'Authorization': `Bearer ${this.sessionId}` }
            });
            return response.ok;
        } catch (error) {
            return false;
        }
    }
    
    async loadUserRepos() {
        try {
            const response = await fetch(`${this.API_BASE}/api/user/repos`, {
                headers: { 'Authorization': `Bearer ${this.sessionId}` }
            });
            
            if (!response.ok) throw new Error('Failed to load repositories');
            
            this.userRepos = await response.json();
            this.log(`✅ Loaded ${this.userRepos.length} repositories`);
        } catch (error) {
            this.log(`❌ Error loading repositories: ${error.message}`, 'error');
        }
    }
    
    updateRepoDisplay() {
        const folderNameEl = document.querySelector('.folder-name');
        if (folderNameEl) {
            folderNameEl.textContent = this.currentRepo || 'No repository selected';
        }
        
        const pathEl = document.getElementById('current-path');
        if (pathEl) {
            pathEl.textContent = this.currentRepo || 'No repository selected';
        }
        
        const terminalPathEl = document.getElementById('terminal-path');
        if (terminalPathEl) {
            terminalPathEl.textContent = this.currentRepo ? `~/${this.currentRepo}` : '{path}';
        }
    }
    
    async commitFile(filePath, content, message) {
        // Check permissions before attempting commit
        if (!this.hasWriteAccess) {
            this.log('❌ Cannot commit - you don\'t have write access to this repository', 'error');
            return false;
        }

        const maxRetries = 3;
        let attempt = 0;

        while (attempt < maxRetries) {
            try {
                this.log(`Attempting to commit ${filePath} (attempt ${attempt + 1}/${maxRetries})`);
                
                const response = await fetch(`${this.API_BASE}/api/commit`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.sessionId}`
                    },
                    body: JSON.stringify({
                        repo: this.currentRepo,
                        path: filePath,
                        content,
                        message,
                        branch: this.defaultBranch
                    })
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    
                    if (response.status === 401) {
                        this.log('Session expired, redirecting to login', 'error');
                        window.location.href = '/login/';
                        return false;
                    } else if (response.status === 403) {
                        this.log(`❌ Permission denied: ${errorData.error}`, 'error');
                        return false;
                    } else if (response.status === 404) {
                        this.log(`❌ Repository not found: ${errorData.error}`, 'error');
                        return false;
                    } else if (response.status === 422) {
                        this.log(`❌ Invalid request: ${errorData.error}`, 'error');
                        return false;
                    }
                    
                    throw new Error(errorData.error || `HTTP ${response.status}`);
                }

                this.log(`✅ Successfully committed ${filePath}`);
                
                // Refresh the repository data to get the new commit
                setTimeout(() => {
                    this.fetchRepo(this.currentRepo);
                }, 1000);
                
                return true;
                
            } catch (error) {
                attempt++;
                this.log(`❌ Commit attempt ${attempt} failed: ${error.message}`, 'error');
                
                if (attempt === maxRetries) {
                    this.log(`❌ All commit attempts failed. Error: ${error.message}`, 'error');
                    return false;
                }
                
                this.log(`Retrying commit... (attempt ${attempt + 1}/${maxRetries})`, 'warning');
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
        return false;
    }

    async getAuthHeaders() {
        const headers = {};
        if (this.sessionId) {
            try {
                const response = await fetch(`${this.API_BASE}/api/user`, {
                    headers: { 'Authorization': `Bearer ${this.sessionId}` }
                });
                if (response.ok) {
                    const userData = await response.json();
                    if (userData.accessToken) {
                        headers['Authorization'] = `token ${userData.accessToken}`;
                    }
                }
            } catch (error) {
                this.log(`Warning: Could not get auth headers: ${error.message}`, 'warning');
            }
        }
        return headers;
    }

    // Debug method to check token scopes
    async debugTokenScopes() {
        try {
            const response = await fetch(`${this.API_BASE}/api/debug/token`, {
                headers: { 'Authorization': `Bearer ${this.sessionId}` }
            });
            
            if (response.ok) {
                const data = await response.json();
                this.log(`Token scopes: ${data.scopes.join(', ')}`);
                this.log(`Required scopes: ${data.acceptedScopes.join(', ')}`);
                return data;
            }
        } catch (error) {
            this.log(`Error checking token scopes: ${error.message}`, 'error');
        }
    }
}

window.GitHubManager = GitHubManager;