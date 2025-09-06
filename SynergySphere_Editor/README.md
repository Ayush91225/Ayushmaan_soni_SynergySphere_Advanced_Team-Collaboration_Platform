# SynergySphere Editor

A GitHub-integrated code editor with OAuth authentication.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create GitHub OAuth App:**
   - Go to GitHub Settings > Developer settings > OAuth Apps
   - Create new OAuth App with:
     - Application name: SynergySphere Editor
     - Homepage URL: http://localhost:3001
     - Authorization callback URL: http://localhost:3001/login/

3. **Configure environment:**
   - Update `.env` with your GitHub OAuth credentials:
   ```
   GITHUB_CLIENT_ID=your_actual_client_id
   GITHUB_CLIENT_SECRET=your_actual_client_secret
   ```

4. **Start the server:**
   ```bash
   npm start
   ```

5. **Access the application:**
   - Open http://localhost:3001
   - Login with GitHub
   - Load repositories and start coding!

## Features

- GitHub OAuth authentication
- Browse user's repositories
- Load any public repository
- File editing with Monaco Editor
- Commit changes (owner repos only)
- Commit history in terminal
- Theme switching
- Tab management