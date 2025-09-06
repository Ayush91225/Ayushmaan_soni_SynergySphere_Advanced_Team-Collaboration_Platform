const express = require('express');
const cors = require('cors');
const path = require('path');
const { Octokit } = require('@octokit/rest');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// GitHub OAuth config
require('dotenv').config();
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    console.error('Missing GitHub OAuth credentials!');
    process.exit(1);
}

// Store user sessions (use Redis/DB in production)
const sessions = new Map();

// Auth endpoints
app.get('/auth/github', (req, res) => {
    // More explicit scope - ensure we have write access
    const redirectUri = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=repo,user:email`;
    res.json({ redirectUri });
});

app.post('/auth/callback', async (req, res) => {
    try {
        const { code } = req.body;
        
        // Exchange code for access token
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                client_id: GITHUB_CLIENT_ID,
                client_secret: GITHUB_CLIENT_SECRET,
                code
            })
        });
        
        const tokenData = await tokenResponse.json();
        const accessToken = tokenData.access_token;
        
        if (!accessToken) {
            throw new Error('Failed to get access token');
        }
        
        // Get user info
        const octokit = new Octokit({ auth: accessToken });
        const { data: user } = await octokit.rest.users.getAuthenticated();
        
        // Get user emails to find primary email
        let userEmail = user.email;
        if (!userEmail) {
            try {
                const { data: emails } = await octokit.rest.users.listEmailsForAuthenticatedUser();
                const primaryEmail = emails.find(email => email.primary);
                userEmail = primaryEmail ? primaryEmail.email : `${user.login}@users.noreply.github.com`;
            } catch (error) {
                console.log('Could not fetch emails, using fallback');
                userEmail = `${user.login}@users.noreply.github.com`;
            }
        }
        
        // Create session
        const sessionId = Math.random().toString(36).substring(7);
        sessions.set(sessionId, { 
            accessToken, 
            user: { ...user, email: userEmail } 
        });
        
        res.json({ sessionId, user: { ...user, email: userEmail } });
    } catch (error) {
        console.error('Auth callback error:', error);
        res.status(400).json({ error: error.message });
    }
});

// API endpoints
app.get('/api/user/repos', async (req, res) => {
    try {
        const sessionId = req.headers.authorization?.replace('Bearer ', '');
        console.log('Session ID:', sessionId);
        console.log('Available sessions:', Array.from(sessions.keys()));
        
        const session = sessions.get(sessionId);
        
        if (!session) {
            console.log('No session found for ID:', sessionId);
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        const octokit = new Octokit({ auth: session.accessToken });
        
        // Get both user repos and organization repos
        const [userRepos, orgRepos] = await Promise.all([
            octokit.rest.repos.listForAuthenticatedUser({
                sort: 'updated',
                per_page: 50,
                affiliation: 'owner'
            }),
            octokit.rest.repos.listForAuthenticatedUser({
                sort: 'updated', 
                per_page: 50,
                affiliation: 'collaborator'
            })
        ]);
        
        const allRepos = [...userRepos.data, ...orgRepos.data];
        const uniqueRepos = allRepos.filter((repo, index, self) => 
            index === self.findIndex(r => r.id === repo.id)
        );
        
        res.json(uniqueRepos.map(repo => ({
            name: repo.name,
            full_name: repo.full_name,
            private: repo.private,
            updated_at: repo.updated_at,
            permissions: repo.permissions
        })));
    } catch (error) {
        console.error('Repos error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/commit', async (req, res) => {
    try {
        const sessionId = req.headers.authorization?.replace('Bearer ', '');
        console.log('Commit session ID:', sessionId);
        
        const session = sessions.get(sessionId);
        
        if (!session) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        const { repo, path, content, message, branch = 'main' } = req.body;
        
        if (!repo || !path || !content || !message) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const [owner, repoName] = repo.split('/');
        
        console.log('Commit request:', { repo, path, message, branch, owner, repoName });
        
        const octokit = new Octokit({ auth: session.accessToken });
        
        // First check if user has write permissions to the repo
        try {
            const { data: repoData } = await octokit.rest.repos.get({
                owner,
                repo: repoName
            });
            
            console.log('Repository permissions:', repoData.permissions);
            
            if (!repoData.permissions || (!repoData.permissions.push && !repoData.permissions.admin)) {
                return res.status(403).json({ 
                    error: 'You do not have write permissions to this repository' 
                });
            }
        } catch (error) {
            console.error('Error checking repo permissions:', error.message);
            if (error.status === 404) {
                return res.status(404).json({ error: 'Repository not found' });
            }
            return res.status(403).json({ error: 'Cannot access repository' });
        }
        
        // Get current file SHA if it exists
        let sha;
        try {
            const { data: fileData } = await octokit.rest.repos.getContent({
                owner,
                repo: repoName,
                path,
                ref: branch
            });
            sha = fileData.sha;
            console.log('Found existing file with SHA:', sha);
        } catch (error) {
            if (error.status === 404) {
                console.log('File does not exist, creating new file');
            } else {
                console.error('Error checking file existence:', error.message);
                throw error;
            }
        }
        
        // Prepare commit data
        const user = session.user;
        const commitData = {
            owner,
            repo: repoName,
            path,
            message,
            content: Buffer.from(content).toString('base64'),
            branch,
            committer: {
                name: user.name || user.login,
                email: user.email
            },
            author: {
                name: user.name || user.login,
                email: user.email
            }
        };
        
        if (sha) {
            commitData.sha = sha;
        }
        
        console.log('Attempting commit with data:', {
            ...commitData,
            content: `[${content.length} characters]` // Don't log full content
        });
        
        const result = await octokit.rest.repos.createOrUpdateFileContents(commitData);
        
        console.log('Commit successful:', result.data.commit.sha);
        res.json({ success: true, sha: result.data.commit.sha });
        
    } catch (error) {
        console.error('Detailed commit error:', {
            message: error.message,
            status: error.status,
            response: error.response?.data,
            stack: error.stack
        });
        
        if (error.status === 403) {
            res.status(403).json({ 
                error: 'Permission denied. You may not have write access to this repository.' 
            });
        } else if (error.status === 404) {
            res.status(404).json({ 
                error: 'Repository or file not found.' 
            });
        } else if (error.status === 422) {
            res.status(422).json({ 
                error: 'Invalid request. Check if the file path and content are valid.' 
            });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/api/user', (req, res) => {
    const sessionId = req.headers.authorization?.replace('Bearer ', '');
    const session = sessions.get(sessionId);
    
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    
    res.json({ ...session.user, accessToken: session.accessToken });
});

// Debug endpoint to check token permissions
app.get('/api/debug/token', async (req, res) => {
    try {
        const sessionId = req.headers.authorization?.replace('Bearer ', '');
        const session = sessions.get(sessionId);
        
        if (!session) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        const response = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `token ${session.accessToken}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        const scopes = response.headers.get('X-OAuth-Scopes') || '';
        const acceptedScopes = response.headers.get('X-Accepted-OAuth-Scopes') || '';
        
        res.json({
            scopes: scopes.split(',').map(s => s.trim()),
            acceptedScopes: acceptedScopes.split(',').map(s => s.trim()),
            user: session.user
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});