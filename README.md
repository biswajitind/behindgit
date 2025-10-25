# 🧠 BehindGit

**BehindGit** is an interactive web application that visually demonstrates **what happens under the hood when Git commands are executed**.  
It shows the *before and after* state of your repository — including file system changes, diffs, and internal Git objects — helping you truly understand how Git works internally.

---

## 🚀 Features

- 🔍 **Command Visualization** – See what happens when you run commands like `git add`, `git commit`, `git merge`, or `git reset`.
- 🧩 **File System Diff** – Compare the file system state before and after a Git operation.
- 🗂️ **Object View** – Explore how blobs, trees, commits, and refs change.
- 💻 **Interactive UI** – Web-based visualization; no Git CLI required.
- 🧠 **Educational Focus** – Ideal for developers learning Git internals.

---

## 🏗️ Architecture

BehindGit consists of:
- **Frontend:** Web interface (React / Vue / plain JS) for visualization.
- **Backend:** Python or Node.js service simulating Git operations.
- **Storage:** Temporary in-memory or local data to track file state.

---

## 🐳 Run Locally (Using Docker)

```bash
# Clone repository
git clone https://github.com/yourusername/behindgit.git
cd behindgit

# Build and run the container
docker build -t behindgit .
docker run -p 8080:8080 behindgit
