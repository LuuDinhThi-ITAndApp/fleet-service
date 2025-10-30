# GitHub Actions CI/CD

Repo này sử dụng GitHub Actions để tự động build, test và publish Docker images lên GitHub Container Registry (ghcr.io).

## 📋 Workflows

### 1. **CI - Build and Test** (`ci.yml`)

Chạy khi:
- Push lên branch `main` hoặc `develop`
- Tạo Pull Request vào `main` hoặc `develop`

**Các bước:**
- ✅ Lint code (ESLint)
- ✅ Build TypeScript
- ✅ Run tests
- ✅ Build Docker image
- ✅ Security scan với Trivy

### 2. **Publish Docker Image** (`publish.yml`)

Chạy khi:
- Push tag `v*.*.*` (ví dụ: `v1.0.0`)
- Push lên branch `main`
- Release được publish
- Trigger thủ công (workflow_dispatch)

**Các bước:**
- 🐳 Build multi-platform Docker image (amd64, arm64)
- 📦 Push lên `ghcr.io`
- 🏷️ Tự động tag images:
  - `latest` (cho main branch)
  - `v1.0.0` (version tag)
  - `v1.0`, `v1` (semver)
  - `main-sha123` (branch-commit)

### 3. **Release** (`release.yml`)

Chạy khi:
- Push tag `v*` (ví dụ: `v1.0.0`, `v2.1.3`)

**Các bước:**
- 📝 Tự động tạo GitHub Release
- 📋 Generate changelog từ git commits
- 🔗 Link tới Docker image

## 🚀 Cách sử dụng

### Publish Docker Image lên GHCR

#### Option 1: Sử dụng Git Tags (Recommended)

```bash
# Tạo tag mới
git tag v1.0.0

# Push tag lên GitHub
git push origin v1.0.0

# GitHub Actions sẽ tự động:
# 1. Build Docker image
# 2. Push lên ghcr.io/luudinhth-itandapp/fleet-service:v1.0.0
# 3. Push lên ghcr.io/luudinhth-itandapp/fleet-service:latest
# 4. Tạo GitHub Release
```

#### Option 2: Push lên Main Branch

```bash
# Push code lên main
git push origin main

# Image sẽ được publish với tags:
# - ghcr.io/luudinhth-itandapp/fleet-service:main
# - ghcr.io/luudinhth-itandapp/fleet-service:latest
```

#### Option 3: Manual Trigger

1. Vào GitHub repo
2. Click **Actions** tab
3. Chọn **Publish Docker Image**
4. Click **Run workflow**
5. Chọn branch và click **Run workflow**

## 📦 Pull Docker Image

Sau khi publish, bạn có thể pull image:

```bash
# Pull latest version
docker pull ghcr.io/luudinhth-itandapp/fleet-service:latest

# Pull specific version
docker pull ghcr.io/luudinhth-itandapp/fleet-service:v1.0.0

# Pull by commit SHA
docker pull ghcr.io/luudinhth-itandapp/fleet-service:main-abc123
```

## 🔐 Permissions

GitHub Actions tự động có quyền push lên GHCR khi sử dụng `GITHUB_TOKEN`. Không cần thêm secrets.

### Để pull image từ GHCR (public):

```bash
docker pull ghcr.io/luudinhth-itandapp/fleet-service:latest
```

### Để pull image từ GHCR (private):

```bash
# Login vào GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin

# Pull image
docker pull ghcr.io/luudinhth-itandapp/fleet-service:latest
```

## 🏷️ Image Tags

Các image tags được tạo tự động:

| Trigger | Tags |
|---------|------|
| Push tag `v1.2.3` | `v1.2.3`, `v1.2`, `v1`, `latest` |
| Push to `main` | `main`, `main-<sha>`, `latest` |
| Push to `develop` | `develop`, `develop-<sha>` |
| Pull Request #123 | `pr-123` |

## 📊 View Published Images

1. Vào GitHub repo
2. Click vào **Packages** (bên phải)
3. Xem tất cả published images và tags

Hoặc truy cập trực tiếp:
```
https://github.com/LuuDinhThi-ITAndApp/fleet-service/pkgs/container/fleet-service
```

## 🔧 Troubleshooting

### Workflow failed?

```bash
# Xem logs trong GitHub Actions tab
# Hoặc re-run failed jobs
```

### Permission denied khi push image?

Kiểm tra:
1. Repository Settings > Actions > General
2. Workflow permissions: chọn **Read and write permissions**
3. Allow GitHub Actions to create and approve pull requests: ✅

### Image quá lớn?

Dockerfile đã tối ưu với multi-stage build (~150-200MB).
Nếu vẫn lớn, kiểm tra:
- `.dockerignore` file
- Dependencies trong `package.json`

## 📚 Resources

- [GitHub Container Registry Docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [GitHub Actions Docker](https://docs.github.com/en/actions/publishing-packages/publishing-docker-images)
- [Docker Build Push Action](https://github.com/docker/build-push-action)
